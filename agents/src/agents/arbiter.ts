// The Judge (spec §5.6): the one committed arbiter key. Mechanical checks first (objective, no LLM),
// the rubric second (Claude, or the deterministic burden-of-proof fallback). Rules on-chain with
// provider-redacted reasons. Never abstains.
import { keccak256, stringToBytes, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Wallet } from '../chain.js'
import { unsealKey, decryptWith, commitmentOf } from '../crypto.js'
import { LabelSchema, mechanicalGround, redactNames, reasonName, type LabelLike, type PublicRecord } from '../schema.js'
import { sendTx, RevertError } from '../tx.js'
import { statusName, type MarketState, type Listing, type Params } from '../market.js'
import { judge, hasLLM, MODEL } from '../llm.js'
import { say, warn, kv, short, eth } from '../say.js'
import { REPO_DIR } from '../data.js'

const GROUNDS = ['NotAsLabeled', 'AlreadyPublic', 'Incoherent', 'ForbiddenContent', 'DidNotHappen', 'NoGround', 'NoMechanicalGround'] as const
const RulingSchema = z.object({ buyerWins: z.boolean(), ground: z.enum(GROUNDS), reasons: z.array(z.string()).min(1).max(4) })
type Verdict = { buyerWins: boolean; ground: string; reasons: string[]; model: string }

export class ArbiterAgent {
  readonly me: Address
  private rubric = ''
  private rubricHash: Hex = '0x'
  private inProgress = new Set<bigint>()

  constructor(private wallet: Wallet, private privateKey: Hex, private publicRecord: PublicRecord[]) {
    this.me = wallet.account.address
  }

  /** Refuses to start unless the local rubric hashes to the on-chain commitment and the model matches. */
  async startup(params: Params): Promise<void> {
    this.rubric = readFileSync(resolve(REPO_DIR, 'contracts/rubric.md'), 'utf8')
    this.rubricHash = keccak256(stringToBytes(this.rubric))
    if (this.rubricHash !== params.rubricHash)
      throw new Error(`rubric mismatch: contracts/rubric.md hashes to ${this.rubricHash} but the contract committed ${params.rubricHash}. Refusing to judge with a rubric the chain did not commit to.`)
    if (hasLLM && MODEL !== params.arbiterModelId)
      throw new Error(`LLM_MODEL=${MODEL} but the contract commits the arbiter to ${params.arbiterModelId}. Refusing to start.`)
    if (this.me !== params.arbiter)
      throw new Error(`ARBITER_PRIVATE_KEY derives ${this.me} but the contract's arbiter is ${params.arbiter}`)
    await say('JUDGE', hasLLM ? `judge: ${MODEL} (rubric ${short(this.rubricHash, 8)} matches the contract)` : `judge: deterministic (no ANTHROPIC_API_KEY); rubric ${short(this.rubricHash, 8)} matches the contract`)
  }

  async act(state: MarketState): Promise<void> {
    for (const l of state.listings) {
      if (statusName(l.status) !== 'Disputed' || this.inProgress.has(l.id)) continue
      this.inProgress.add(l.id)
      try {
        const v = await this.decide(state, l)
        const reasonsJson = JSON.stringify({ model: v.model, ground: v.ground, reasons: v.reasons, rubricHash: this.rubricHash })
        await say('JUDGE', `#${l.id}: ruling ${v.buyerWins ? 'BUYER wins' : 'SELLER wins'} - ground ${v.ground}`)
        v.reasons.forEach((d, i) => kv(i === 0 ? 'detail' : '', d))
        const res = await sendTx(this.wallet, { functionName: 'rule', args: [l.id, v.buyerWins, reasonsJson] })
        const ruled = res.logs.find((e) => e.eventName === 'Ruled')
        if (ruled && ruled.eventName === 'Ruled') {
          const dBond = (l.price + 1n) / 2n
          if (v.buyerWins) {
            kv('money', `buyer ${eth(ruled.args.buyerPayout)} = price ${eth(l.price)} back + dispute bond ${eth(dBond)} + damages ${eth(ruled.args.buyerPayout - l.price - dBond)}`)
            kv('burned', `${eth(ruled.args.burned)} (1.5x the price: what is left of the seller's 2x bond after damages)`)
            kv('seller', `0 ETH and marked refuted - both buyers now refuse this address for good`)
          } else {
            kv('money', `seller ${eth(ruled.args.sellerPayout)} (price minus 2% fee + the buyer's dispute bond) · burned ${eth(ruled.args.burned)}`)
            kv('buyer', `0 ETH and one dispute lost on its record`)
          }
        }
      } catch (err) {
        if (err instanceof RevertError) warn(`JUDGE ${err.message} - will retry next tick`)
        else throw err
      } finally {
        this.inProgress.delete(l.id)
      }
    }
  }

  private async decide(state: MarketState, l: Listing): Promise<Verdict> {
    const model = hasLLM ? MODEL : 'deterministic'
    const purchased = state.find(l.id, 'Purchased')
    const delivered = state.find(l.id, 'Delivered')
    const disputed = state.eventsFor(l.id).filter((e) => e.eventName === 'Disputed').at(-1)
    const listed = state.find(l.id, 'Listed')
    if (!purchased || !disputed || disputed.eventName !== 'Disputed' || !listed) throw new Error(`#${l.id}: missing events for a Disputed listing`)
    const filed = reasonName(disputed.args.reason)
    await say('JUDGE', `#${l.id}: dispute ${filed}${disputed.args.afterRelease ? ' (after release)' : ''} from ${short(disputed.args.buyer)} - opening the sealed key with my arbiter key`)

    // 1. The revealed key must be THE purchase key (its pubkey is in the Purchased event).
    let recovered: Hex
    try {
      recovered = unsealKey(this.privateKey, disputed.args.sealedKey)
      if (privateKeyToAccount(recovered).publicKey !== purchased.args.buyerPubKey) throw new Error('pubkey mismatch')
      kv('key check', `OK - re-derives the purchase pubkey ${short(purchased.args.buyerPubKey, 8)} from the Purchased event`)
    } catch (err) {
      return { model, buyerWins: false, ground: 'InvalidReveal', reasons: [`revealed key does not match the purchase key (${(err as Error).message})`] }
    }

    // 2. The ciphertext must open to the committed hash - objective, regardless of the filed reason.
    let canon = '', payload: unknown
    try {
      if (!delivered) throw new Error('nothing was delivered')
      const open = JSON.parse(decryptWith(recovered, delivered.args.ciphertext)) as { canon: string; salt: Hex }
      if (typeof open.canon !== 'string' || typeof open.salt !== 'string') throw new Error('bad envelope')
      if (commitmentOf(l.seller, open.canon, open.salt) !== l.contentHash) throw new Error('hash mismatch')
      canon = open.canon
      payload = JSON.parse(canon)
      kv('hash check', `OK - the delivered ciphertext opens to the committed hash ${short(l.contentHash, 8)}`)
    } catch (err) {
      return { model, buyerWins: true, ground: 'NotAsCommitted', reasons: [`delivered ciphertext does not open to the committed hash (${(err as Error).message})`] }
    }
    // 3. A NotAsCommitted claim against a ciphertext that opened correctly is simply false.
    if (filed === 'NotAsCommitted')
      return { model, buyerWins: false, ground: 'NoGround', reasons: ['ciphertext decrypts with the revealed key and matches the commitment; the NotAsCommitted claim is false'] }

    // 4. Mechanical rubric: the same functions the buyer ran.
    const labelRaw = safeJson(listed.args.label) as Record<string, unknown>
    const labelParsed = LabelSchema.safeParse(labelRaw)
    // A malformed label still gets the mechanical comparison on whatever fields it carries.
    const label: LabelLike = labelParsed.success ? labelParsed.data : {
      category: String(labelRaw?.category) as LabelLike['category'], claimType: String(labelRaw?.claimType),
      accelerator: String(labelRaw?.accelerator) as LabelLike['accelerator'], region: String(labelRaw?.region) as LabelLike['region'],
      interconnect: String(labelRaw?.interconnect) as LabelLike['interconnect'], gpuCountBucket: String(labelRaw?.gpuCountBucket) as LabelLike['gpuCountBucket'],
      priceBand: String(labelRaw?.priceBand) as LabelLike['priceBand'], availabilityWindow: String(labelRaw?.availabilityWindow),
    }
    const mech = mechanicalGround(label, payload, l.listedAt, this.publicRecord)
    if (mech) return { model, buyerWins: true, ground: mech.reason, reasons: mech.detail.slice(0, 4).map((d) => redactNames(d, payload)) }

    // 5. No mechanical ground: apply the rubric with Claude, or the burden-of-proof fallback.
    const verdict = await judge({
      system: this.rubric,
      user: [
        `LABEL: ${listed.args.label}`,
        `DOSSIER: ${canon}`,
        `REASON: ${filed}${disputed.args.afterRelease ? ' (filed after release)' : ' (filed inside the quality window)'}`,
        `EVIDENCE: ${disputed.args.evidence}`,
        `LISTED_AT: ${new Date(Number(l.listedAt) * 1000).toISOString()}`,
        `RESOLVE_BY: ${new Date(Number(l.resolveBy) * 1000).toISOString()}`,
        `PUBLIC_RECORD: ${JSON.stringify(this.publicRecord)}`,
      ].join('\n'),
      schema: RulingSchema,
      effort: 'high',
      fallback: () => ({ buyerWins: false, ground: 'NoMechanicalGround' as const, reasons: ['buyer bears the burden of proof; deterministic mode'] }),
    })
    // 6. Redact: no provider, site or counterparty name reaches the chain, even in a ruling.
    return { model: verdict.source === 'claude' ? MODEL : 'deterministic', buyerWins: verdict.value.buyerWins, ground: verdict.value.ground, reasons: verdict.value.reasons.map((r) => redactNames(r, payload)) }
  }
}

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return undefined } }
