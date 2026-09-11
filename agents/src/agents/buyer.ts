// Buyer agents (spec §5.5): Brineholt Labs (AI-lab compute procurement) and Sounding Compute(GPU-broker
// sourcing), same code, different Thesis. Score labels blind → buy with a fresh one-time key → decrypt →
// mechanical checks → (optional Claude grade) → dispute with the key sealed to the arbiter, or release + attest.
import { formatEther, parseEther, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { Wallet } from '../chain.js'
import { decryptWith, commitmentOf, sealKeyForArbiter } from '../crypto.js'
import { CLASS_C_MIN_LOCK_SECONDS, GPU_BUCKETS, LabelSchema, REASONS, VERIFIABILITY_CLASS, mechanicalGround, reasonIndex, redactNames, type Category, type Label, type PublicRecord, type Reason } from '../schema.js'
import { sendTx, RevertError } from '../tx.js'
import { MARGIN, statusName, type MarketState, type Listing } from '../market.js'
import { judge } from '../llm.js'
import { say, warn, kv, short, eth, clock, scoreTable, nb, type Actor, type ScoreRow } from '../say.js'
import { AGENTS_DIR } from '../data.js'
import { env, DEMO_MODE } from '../env.js'

/** Minimum outcome-dispute window the buyer insists on (seconds). The contract only enforces
 *  resolveBy > expiresAt, so a seller could pick a resolveBy that falls before the price is even
 *  released, leaving zero seconds "on the hook". The buyer therefore refuses any listing where
 *  resolveBy - now < deliverTimeout + qualityWindow + MIN_OUTCOME_WINDOW: even a last-second delivery
 *  then leaves at least MIN_OUTCOME_WINDOW for a DidNotHappen dispute. Demo default 10 s; days in production. */
const MIN_OUTCOME_WINDOW = BigInt(env.MIN_OUTCOME_WINDOW ?? '10')
/** The label's human-readable resolveBy must agree with the on-chain uint64 (seconds of tolerance). */
const LABEL_RESOLVE_TOLERANCE = 60

export type Thesis = {
  name: string; actor: Actor
  categories: Category[]; accelerators: RegExp; regions: string[]; interconnects: string[] | null; minBucket: (typeof GPU_BUCKETS)[number]
  maxPrice: bigint; budget: bigint
  pitch: string
}

export const LAB: Thesis = {
  name: 'Brineholt Labs', actor: 'LAB',
  categories: ['CapacityRelease', 'NewSupply', 'PriceMove'],
  accelerators: /^(H100|H200|B200|GB200)$/i,
  regions: ['US-West', 'US-East'],
  interconnects: ['InfiniBand', 'NVLink'],
  minBucket: '256-1023',
  maxPrice: parseEther('0.001'), budget: parseEther('0.002'),
  pitch: 'compute-procurement agent for an AI lab: training blocks of 256+ H100/H200/B200/GB200; a block coming off contract, a site going live or a price about to move before it is on a board is worth a first call, because a 512-GPU block is about a million dollars a month and clears in hours. US only, InfiniBand or NVLink only; by policy never buys never-public (class C) categories',
}
export const BROKER: Thesis = {
  name: 'Sounding Compute', actor: 'BROKER',
  categories: ['CapacityRelease', 'PriceMove', 'DemandSignal'],
  accelerators: /^(H100|H200|MI300X|L40S)$/i,
  regions: ['EU-West', 'EU-North', 'APAC'],
  interconnects: null,
  minBucket: '64-255',
  maxPrice: parseEther('0.0006'), budget: parseEther('0.001'),
  pitch: 'sourcing agent for a GPU broker placing European and APAC clients: a block coming free, a price cut or an RFQ in flight in those regions is a spread; US blocks are out of thesis',
}

const FitSchema = z.object({ fit: z.number().int().min(0).max(100), buy: z.boolean(), why: z.array(z.string()) })
const QUALITY_REASONS = ['NotAsLabeled', 'AlreadyPublic', 'Incoherent', 'ForbiddenContent'] as const
const GradeSchema = z.object({ keep: z.boolean(), reason: z.enum(QUALITY_REASONS).nullable(), note: z.string() })

type Opened = { canon: string; payload: unknown; label: Label }

export class BuyerAgent {
  readonly me: Address
  private scored = new Set<bigint>()
  private keys = new Map<bigint, Hex>() // listing id -> one-time purchase private key (this run)
  private opened = new Map<bigint, Opened>()
  private evaluated = new Map<bigint, 'keep' | 'disputed'>()
  private attested = new Set<bigint>()
  private spent = 0n
  private stateFile: string

  constructor(
    private wallet: Wallet,
    readonly thesis: Thesis,
    private opts: { runId: string; publicRecord: PublicRecord[]; laterSurfaced: Map<string, string>; since: bigint },
  ) {
    this.me = wallet.account.address
    this.stateFile = resolve(AGENTS_DIR, '.state', `${opts.runId}.json`)
  }

  get remainingBudget(): bigint { return this.thesis.budget - this.spent }
  /** Listings bought by this buyer in this run (we hold the purchase key). */
  own(state: MarketState): Listing[] { return state.listings.filter((l) => l.buyer === this.me && this.keys.has(l.id)) }

  async act(state: MarketState): Promise<void> {
    await this.scoreAndBuy(state)
    for (const l of this.own(state)) {
      const s = statusName(l.status)
      try {
        if (s === 'Delivered' && !this.evaluated.has(l.id)) await this.evaluate(state, l)
        else if (s === 'Delivered' && this.evaluated.get(l.id) === 'keep' && state.now >= l.deliveredAt + state.params.qualityWindow + MARGIN) {
          await say(this.thesis.actor, `#${l.id}: quality window closed with no complaint - releasing the ${eth(l.price)} in escrow to the seller`)
          const res = await sendTx(this.wallet, { functionName: 'release', args: [l.id] })
          const released = res.logs.find((e) => e.eventName === 'Released')
          if (released && released.eventName === 'Released') {
            kv('money', `seller ${eth(released.args.sellerPayout)} (98%) · burned ${eth(released.args.feeBurned)} (2% fee, burned for good)`)
            kv('bond', `${eth(l.bond)} (2x) stays locked until ${clock(l.resolveBy)} - DidNotHappen disputes stay open until then; ${DEMO_MODE === 'short' ? 'pnpm sweep frees it later' : 'then the scout withdraws it'}`)
          }
        } else if (s === 'Released' && !l.confirmed && !this.attested.has(l.id)) {
          const uri = this.opened.get(l.id) && this.opts.laterSurfaced.get(this.opened.get(l.id)!.canon)
          if (uri) {
            this.attested.add(l.id)
            await say(this.thesis.actor, `#${l.id}: (synthetic fast-forward) the block later shows up on a public board - attesting on-chain so the scout's counter reads confirmed, not just unchallenged`)
            kv('source', uri)
            await sendTx(this.wallet, { functionName: 'attest', args: [l.id, uri] })
          }
        } else if (s === 'Paid' && state.now >= l.paidAt + state.params.deliverTimeout + MARGIN) {
          await say(this.thesis.actor, `#${l.id}: paid ${eth(l.price)} ${state.now - l.paidAt}s ago and nothing was delivered - claiming refund + 10% of the seller's bond`)
          const res = await sendTx(this.wallet, { functionName: 'refundUndelivered', args: [l.id] })
          const refunded = res.logs.find((e) => e.eventName === 'Refunded')
          if (refunded && refunded.eventName === 'Refunded') kv('money', `buyer ${eth(refunded.args.buyerPayout)} (price back + 10% of the bond) · seller ${eth(refunded.args.sellerPayout)} (rest of the bond; marked ghosted)`)
        } else if (s === 'Disputed' && state.now >= l.disputedAt + state.params.arbiterTimeout + MARGIN) {
          await say(this.thesis.actor, `#${l.id}: the arbiter has been silent for ${state.params.arbiterTimeout}s - unwinding no-fault (silence is not evidence)`)
          await sendTx(this.wallet, { functionName: 'timeoutDispute', args: [l.id] })
        }
      } catch (err) {
        if (err instanceof RevertError) warn(`${this.thesis.actor} ${err.message} - will retry next tick`)
        else throw err
      }
    }
  }

  // ---- 1. Score every new, unexpired listing against the thesis, then buy. ----
  private async scoreAndBuy(state: MarketState): Promise<void> {
    const fresh = state.listings.filter((l) => statusName(l.status) === 'Listed' && l.listedAt >= this.opts.since && l.expiresAt > state.now + MARGIN && l.seller !== this.me && !this.scored.has(l.id))
    if (!fresh.length) return
    for (const l of fresh) this.scored.add(l.id)
    const rows: ScoreRow[] = []
    let source = 'deterministic'
    const toBuy: { l: Listing; label: Label }[] = []
    const results = await Promise.all(fresh.map(async (l) => {
      const listed = state.find(l.id, 'Listed')
      const parsed = listed ? LabelSchema.safeParse(safeJson(listed.args.label)) : undefined
      if (!parsed?.success) {
        warn(`${this.thesis.actor} #${l.id}: malformed label (${parsed?.error.issues[0]?.message ?? 'no Listed event'}) - skipped`)
        return null
      }
      const label = parsed.data
      // Outcome-window gate: "paid on delivery, on the hook until the outcome" is only true if resolveBy is
      // comfortably after the latest possible release (see MIN_OUTCOME_WINDOW above).
      const minResolveBy = state.now + state.params.deliverTimeout + state.params.qualityWindow + MIN_OUTCOME_WINDOW
      if (l.resolveBy < minResolveBy) {
        warn(`${this.thesis.actor} #${l.id}: skipped - outcome window too short (resolveBy in ${l.resolveBy - state.now}s; I need >= deliverTimeout ${state.params.deliverTimeout}s + qualityWindow ${state.params.qualityWindow}s + ${MIN_OUTCOME_WINDOW}s so a DidNotHappen dispute stays possible after release)`)
        return null
      }
      // The label advertises a resolveBy date; the chain enforces a different one if the seller lies. Compare.
      const labelResolveBy = Date.parse(label.resolveBy) / 1000
      if (!Number.isFinite(labelResolveBy) || Math.abs(labelResolveBy - Number(l.resolveBy)) > LABEL_RESOLVE_TOLERANCE) {
        warn(`${this.thesis.actor} #${l.id}: skipped - label says resolveBy ${label.resolveBy} but the contract enforces ${new Date(Number(l.resolveBy) * 1000).toISOString()}`)
        return null
      }
      // Stale-block gate: prices move daily. A window that ended before the chain's current month describes a block,
      // price or site that has already passed (ProviderReference is exempt: a completed tenancy is in the past by definition).
      const [windowStart, windowEnd] = label.availabilityWindow.split('/') as [string, string]
      const chainMonth = new Date(Number(state.now) * 1000).toISOString().slice(0, 7)
      if (label.category !== 'ProviderReference' && windowEnd < chainMonth) {
        warn(`${this.thesis.actor} #${l.id}: skipped - stale: availability window ${label.availabilityWindow} ended before the chain's current month ${chainMonth}`)
        return null
      }
      // Class-C minimum lock: nothing public can ever refute a DemandSignal or ProviderReference, so the bond lock is the
      // whole warranty. The contract only requires resolveBy > expiresAt; the buyer requires a real lock.
      const cls = VERIFIABILITY_CLASS(label.category, label.claimType)
      if (cls === 'C') {
        const minLock = l.listedAt + BigInt(CLASS_C_MIN_LOCK_SECONDS)
        const windowStartTs = BigInt(Math.floor(Date.parse(`${windowStart}-01T00:00:00Z`) / 1000))
        const floor = label.category === 'DemandSignal' && windowStartTs < minLock ? windowStartTs : minLock
        if (l.resolveBy < floor) {
          warn(`${this.thesis.actor} #${l.id}: skipped - class-C listing (${label.category}) with a bond lock shorter than my floor (resolveBy ${new Date(Number(l.resolveBy) * 1000).toISOString()} < ${new Date(Number(floor) * 1000).toISOString()}); the lock is the whole warranty here`)
          return null
        }
      }
      const rep = state.sellerRep.get(l.seller)
      const refuted = rep?.refuted ?? 0
      const fit = await judge({
        system: `You are the ${this.thesis.name} buying agent in a sealed market for compute-capacity intelligence. Thesis: ${this.thesis.pitch}. Categories: ${this.thesis.categories.join(', ')}; accelerators matching ${this.thesis.accelerators}; regions ${this.thesis.regions.join(', ')} (hard gate); interconnects ${this.thesis.interconnects ? this.thesis.interconnects.join(', ') + ' (hard gate)' : 'any'}; minimum GPU-count bucket ${this.thesis.minBucket}. Max price ${formatEther(this.thesis.maxPrice)} ETH; remaining budget ${formatEther(this.remainingBudget)} ETH. Never buy a category or region outside your lists. Never-public categories (DemandSignal, ProviderReference) are worth less because nothing can ever refute them. Sellers with refuted > 0 are never bought; unchallenged is not confirmed. Score fit 0-100 and decide whether to buy this label blind.`,
        user: `LABEL: ${JSON.stringify(label)}\nPRICE_ETH: ${formatEther(l.price)}\nSELLER_RECORD: ${JSON.stringify(rep ?? {}, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
        schema: FitSchema,
        effort: 'low',
        fallback: () => {
          let fit = 0
          if (this.thesis.categories.includes(label.category)) fit += 40
          if (this.thesis.accelerators.test(label.accelerator)) fit += 25
          if (this.thesis.regions.includes(label.region)) fit += 20
          if (GPU_BUCKETS.indexOf(label.gpuCountBucket) >= GPU_BUCKETS.indexOf(this.thesis.minBucket)) fit += 15
          if (cls === 'C') fit -= 10 // nothing public can ever refute it
          if (!this.thesis.regions.includes(label.region)) fit -= 100 // hard gate ('undisclosed' never matches)
          if (this.thesis.interconnects && !this.thesis.interconnects.includes(label.interconnect)) fit -= 100 // hard gate (LAB only)
          if (refuted > 0 || l.price > this.thesis.maxPrice) fit -= 100
          fit = Math.max(0, Math.min(100, fit))
          return { fit, buy: fit >= 60, why: [] }
        },
      })
      return { l, label, cls, refuted, fit }
    }))
    for (const r of results) {
      if (!r) continue
      const buy = r.fit.value.buy && r.fit.value.fit >= 60 && r.refuted === 0 && r.l.price <= this.thesis.maxPrice
      rows.push({ id: Number(r.l.id), category: r.label.category, block: `${r.label.accelerator} x ${r.label.gpuCountBucket}`, region: `${r.label.region}${r.label.interconnect === 'unknown' ? '' : ` ${r.label.interconnect}`}`, price: eth(r.l.price), fit: r.fit.value.fit, buy })
      source = r.fit.source
      if (buy) toBuy.push({ l: r.l, label: r.label })
    }
    if (!rows.length) return
    if (!toBuy.length) { await say(this.thesis.actor, `passed on ${rows.map((r) => `#${r.id} (${r.category}, ${r.region}, fit ${r.fit})`).join(', ')} - outside my thesis; not buying`); return }
    await say(this.thesis.actor, `scored ${rows.length} new label${rows.length === 1 ? '' : 's'} against my thesis (${source} scoring). I see only the label and the seller's on-chain record - never the provider, site or exact price:`)
    scoreTable(rows)
    for (const { l, label } of toBuy) {
      if (l.price > this.remainingBudget) { await say(this.thesis.actor, `#${l.id} fits but ${eth(l.price)} exceeds my remaining budget ${eth(this.remainingBudget)} - skipping`); continue }
      const pk = generatePrivateKey() // one-time key per purchase; never the wallet key
      const pub = privateKeyToAccount(pk).publicKey
      this.keys.set(l.id, pk)
      this.saveKey(l.id, pk)
      await say(this.thesis.actor, `buying #${l.id} (${label.category}: ${nb(`${label.accelerator} x ${label.gpuCountBucket}`)} @ ${label.region}) blind - ${eth(l.price)} into escrow`)
      kv('one-time key', `${short(pub, 8)} - fresh for this purchase; the delivery is sealed to it, never to my wallet key`)
      try {
        await sendTx(this.wallet, { functionName: 'buy', args: [l.id, pub], value: l.price })
        this.spent += l.price
      } catch (err) {
        if (err instanceof RevertError) { warn(`${this.thesis.actor} ${err.message}`); this.keys.delete(l.id) } else throw err
      }
    }
  }

  // ---- 3/4. Decrypt, verify the commitment, run the mechanical rubric, then (maybe) grade. ----
  private async evaluate(state: MarketState, l: Listing): Promise<void> {
    const key = this.keys.get(l.id)!
    const delivered = state.find(l.id, 'Delivered')
    const listed = state.find(l.id, 'Listed')
    if (!delivered || !listed) return
    let canon: string | undefined, payload: unknown, recomputed: Hex | undefined
    try {
      const open = JSON.parse(decryptWith(key, delivered.args.ciphertext)) as { canon?: unknown; salt?: unknown }
      if (typeof open.canon !== 'string' || typeof open.salt !== 'string') throw new Error('bad envelope')
      if (!/^0x[0-9a-f]{64}$/i.test(open.salt)) throw new Error('salt is not 32 bytes')
      // Any defect in the envelope (bad salt, unparsable JSON) ends here as recomputed = undefined → NotAsCommitted.
      recomputed = commitmentOf(l.seller, open.canon, open.salt as Hex)
      canon = open.canon
      payload = JSON.parse(canon)
    } catch (err) {
      await say(this.thesis.actor, `#${l.id}: ciphertext does not open with my one-time key (${(err as Error).message})`)
    }
    if (recomputed !== l.contentHash) {
      await say(this.thesis.actor, `#${l.id}: commitment MISMATCH (on-chain ${short(l.contentHash)}, recomputed ${recomputed ? short(recomputed) : 'n/a'}) - disputing NotAsCommitted`)
      return this.dispute(state, l, 'NotAsCommitted', 'ciphertext does not open to the commitment', payload)
    }
    await say(this.thesis.actor, `#${l.id}: decrypted ${(delivered.args.ciphertext.length - 2) / 2} bytes with my one-time key`)
    kv('commitment', `OK - keccak256(seller, dossier, salt) = ${short(l.contentHash, 8)}, the hash the scout committed before I paid`)
    const label = LabelSchema.parse(safeJson(listed.args.label))
    this.opened.set(l.id, { canon: canon!, payload, label })

    const mech = mechanicalGround(label, payload, l.listedAt, this.opts.publicRecord)
    if (mech) {
      await say(this.thesis.actor, `#${l.id}: mechanical check failed → ${mech.reason}`)
      mech.detail.forEach((d, i) => kv(i === 0 ? 'detail' : '', d))
      return this.dispute(state, l, mech.reason, mech.evidence, payload)
    }
    const grade = await judge({
      system: `You grade a dossier a buyer just paid for in a sealed market for compute-capacity intelligence. Decide keep=true unless the dossier is clearly not specific, plausibly already on a marketplace, price board, index, provider page or in press as of listedAt, inconsistent with the label, or carries credentials, contract text or contact data of provider staff. Set keep=false ONLY if you can cite a concrete inconsistency or a public source dated before LISTED_AT in "note" - a dispute costs a bond and the arbiter puts the burden of proof on the buyer, so a hunch is not enough. If keep=false pick the reason. Name no provider, site or individual in "note": refer to "the provider" / "the site" / "the organization".`,
      user: `LABEL: ${JSON.stringify(label)}\nDOSSIER: ${canon}\nLISTED_AT: ${new Date(Number(l.listedAt) * 1000).toISOString()}\nIs this specific, plausibly not yet on any board as of listedAt, consistent with the label, free of credentials/contract text/contact data, provider-level only?`,
      schema: GradeSchema,
      effort: 'low',
      fallback: () => ({ keep: true, reason: null, note: 'mechanical checks passed' }),
    })
    if (!grade.value.keep && grade.value.reason) {
      await say(this.thesis.actor, `#${l.id}: grader (${grade.source}) rejects → ${grade.value.reason}: ${grade.value.note}`)
      // The note (provider-free by prompt) is the evidence the arbiter will read; the bare reason code would lose by default.
      return this.dispute(state, l, grade.value.reason, (grade.value.note || grade.value.reason).slice(0, 480), payload)
    }
    this.evaluated.set(l.id, 'keep')
    const p = payload as { claim?: { what?: string } }
    await say(this.thesis.actor, `#${l.id}: keeping it - ${grade.value.note} (${grade.source})`)
    // First ~90 characters of the claim, cut at a word boundary: enough to show it is real, never the whole thing.
    const what = String(p.claim?.what ?? '')
    const cut = what.length > 90 ? `${what.slice(0, 90).replace(/\s+\S*$/, '')}…` : what
    kv('claim', `"${cut}" (read locally, never posted)`)
  }

  private async dispute(state: MarketState, l: Listing, reason: Reason, evidence: string, payload: unknown): Promise<void> {
    const key = this.keys.get(l.id)!
    const sealedKey = sealKeyForArbiter(state.params.arbiterPubKey, key)
    const bond = (l.price + 1n) / 2n
    // The evidence string is public calldata forever: dispute() forbids provider or site names in it.
    const publicEvidence = redactNames(evidence, payload)
    await say(this.thesis.actor, `#${l.id}: filing dispute ${reason} with a ${eth(bond)} dispute bond; my one-time key goes to the judge sealed, never in the clear`)
    kv('sealed key', `${(sealedKey.length - 2) / 2} bytes, encrypted to the judge's pubkey`)
    kv('evidence', publicEvidence)
    await sendTx(this.wallet, { functionName: 'dispute', args: [l.id, reasonIndex(reason), sealedKey, publicEvidence], value: bond })
    this.evaluated.set(l.id, 'disputed')
  }

  /** Purchase keys are written to agents/.state/<runId>.json (gitignored) so a crashed run can be inspected. */
  private saveKey(id: bigint, pk: Hex): void {
    try {
      mkdirSync(resolve(AGENTS_DIR, '.state'), { recursive: true, mode: 0o700 })
      const cur = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : {}
      cur[this.thesis.name] ??= {}
      cur[this.thesis.name][id.toString()] = pk
      writeFileSync(this.stateFile, JSON.stringify(cur, null, 2), { mode: 0o600 }) // private keys: owner-only, like .env
    } catch (err) { warn(`could not write ${this.stateFile}: ${(err as Error).message}`) }
  }
}

function safeJson(s: string): unknown { try { return JSON.parse(s) } catch { return undefined } }
export const REASON_NAMES = REASONS
