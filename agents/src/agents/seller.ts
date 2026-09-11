// The Scout (spec §5.4): holds a handful of pre-public facts, commits + bonds each one, delivers on
// purchase, withdraws bonds after resolveBy, delists what nobody bought. No LLM: dossiers are seed data.
//
// Listing plan: `all` (pnpm demo:full) lists every dossier on the first tick so the six scenes overlap;
// `sequential` (pnpm demo) lists one dossier at a time and lists the next only once the previous one has
// settled on-chain, so a sale and a dispute play out one after the other. Everything else stays tick-driven.
import { parseEther, type Address, type Hex } from 'viem'
import type { Wallet } from '../chain.js'
import { canonicalize, newSalt, commitmentOf, encryptFor } from '../crypto.js'
import { ATTESTATIONS, ATTEST_ALL, LabelSchema, PayloadSchema, categoryIndex, forbiddenContentScan, type DossierEntry, type Label } from '../schema.js'
import { sendTx, RevertError } from '../tx.js'
import { MARGIN, statusName, type MarketState, type Listing } from '../market.js'
import { say, warn, kv, short, eth, clock, nb } from '../say.js'
import { env } from '../env.js'

/** Demo timing (seconds after the latest block): buyers must buy within EXPIRES_IN; the bond stays
 *  locked and outcome disputes stay open until RESOLVE_IN (production: the claim's own event date plus a
 *  grace period - the date the fact should be on a price board or marketplace). Overridable for local tests.
 *  RESOLVE_IN must leave the buyers a real outcome window: they refuse listings with
 *  resolveBy - now < deliverTimeout + qualityWindow + MIN_OUTCOME_WINDOW (180 + 90 + 10 on the demo
 *  deployment), so 330 gives ~50 s of slack for the listing and purchase transactions to land. */
const EXPIRES_IN = BigInt(env.DEMO_EXPIRES_IN ?? '180')
const RESOLVE_IN = BigInt(env.DEMO_RESOLVE_IN ?? '330')

export type Plan = 'all' | 'sequential'
export type SellerOptions = {
  plan: Plan
  /** Withdraw unlocked bonds and delist what nobody bought inside the run (full demo). Off in the short demo: `pnpm sweep` does it later. */
  housekeeping: boolean
}

// expiresAt/resolveBy are fixed at prepare() time and reused on every retry, so the on-chain resolveBy
// always equals the ISO resolveBy baked into the label (the buyers check that they agree).
type Prepared = { entry: DossierEntry; canon: string; salt: Hex; commitment: Hex; label: Label; labelJson: string; price: bigint; expiresAt: bigint; resolveBy: bigint }

const TERMINAL = (l: Listing) => {
  const s = statusName(l.status)
  return s === 'RuledBuyer' || s === 'Unadjudicated' || s === 'Refunded' || s === 'Delisted' ||
    ((s === 'Released' || s === 'RuledSeller') && l.bondWithdrawn)
}
/** The listing's outcome is decided: the price is paid out (or refunded / ruled). The bond may still be locked. */
const SETTLED = (l: Listing) => {
  const s = statusName(l.status)
  return s === 'Released' || s === 'RuledBuyer' || s === 'RuledSeller' || s === 'Unadjudicated' || s === 'Refunded' || s === 'Delisted'
}

export class SellerAgent {
  readonly me: Address
  private prepared = new Map<Hex, Prepared>() // by commitment: how this run recognises its own listings
  private idOfEntry = new Map<string, bigint>() // "D1" -> listing id
  private preparedByEntry = new Map<string, Prepared>()
  private listedEntries = new Set<string>()
  private settledSeen = new Set<string>() // sequential plan: entries observed settled on an EARLIER tick
  private ghostAnnounced = new Set<bigint>()
  private introduced = false
  private delisted = false
  readonly opts: SellerOptions

  constructor(private wallet: Wallet, private entries: DossierEntry[], opts: Partial<SellerOptions> = {}) {
    this.me = wallet.account.address
    this.opts = { plan: 'all', housekeeping: true, ...opts }
  }

  /** Listing id for a dataset entry ("D1"…), once listed. */
  idOf(entryId: string): bigint | undefined { return this.idOfEntry.get(entryId) }
  entryOf(id: bigint): DossierEntry | undefined {
    for (const [eid, lid] of this.idOfEntry) if (lid === id) return this.entries.find((e) => e.id === eid)
    return undefined
  }
  /** Total bond the scout must hold to list everything (2x each price). */
  bondsRequired(): bigint { return this.entries.reduce((a, e) => a + 2n * parseEther(e.price), 0n) }
  get pendingListings(): number { return this.entries.length - this.listedEntries.size }

  /** This run's listings (matched by commitment, so an earlier run's listings are ignored). */
  own(state: MarketState): Listing[] {
    const own = state.listings.filter((l) => l.seller === this.me && this.prepared.has(l.contentHash))
    for (const l of own) this.idOfEntry.set(this.prepared.get(l.contentHash)!.entry.id, l.id)
    return own
  }

  /** The entries this tick would list (the orchestrator prints a scene banner before the first of them). Pure. */
  nextToList(state: MarketState): DossierEntry[] {
    const pending = this.entries.filter((e) => !this.listedEntries.has(e.id))
    if (!pending.length) return []
    if (this.opts.plan === 'all') return pending
    // Sequential: the next entry waits until every earlier entry has settled - and was seen settled on a
    // previous tick (noteSettled), so the buyer's own follow-up (attest) lands in the earlier scene, not the next one.
    for (const e of this.entries) {
      if (!this.listedEntries.has(e.id)) break
      if (!this.settledSeen.has(e.id)) return []
    }
    return [pending[0]!]
  }
  private noteSettled(own: Listing[]): void {
    for (const l of own) if (SETTLED(l)) this.settledSeen.add(this.prepared.get(l.contentHash)!.entry.id)
  }

  async act(state: MarketState): Promise<void> {
    const toList = this.nextToList(state)
    if (toList.length) { await this.list(state, toList); return }
    const own = this.own(state)
    this.noteSettled(own)
    for (const l of own) {
      const p = this.prepared.get(l.contentHash)!
      const s = statusName(l.status)
      try {
        if (s === 'Paid') await this.deliver(state, l, p)
        else if (s === 'Delivered' && state.now >= l.deliveredAt + state.params.qualityWindow + 2n * MARGIN) {
          // release() is permissionless so the seller is never hostage to a buyer that walks away without
          // releasing. The buyer gets a full extra tick (one MARGIN) first, so an attentive buyer always
          // releases and the seller only steps in for a buyer that walked away.
          await say('SCOUT', `${p.entry.id} (#${l.id}): quality window closed with no complaint - releasing my own payment (the buyer did not)`)
          await sendTx(this.wallet, { functionName: 'release', args: [l.id] })
        } else if (this.opts.housekeeping && (s === 'Released' || s === 'RuledSeller') && !l.bondWithdrawn && state.now >= l.resolveBy + MARGIN) {
          await say('SCOUT', `${p.entry.id} (#${l.id}) passed resolveBy - the fact had its chance to hit the board; withdrawing the ${eth(l.bond)} bond`)
          await sendTx(this.wallet, { functionName: 'withdrawBond', args: [l.id] })
        }
      } catch (err) {
        if (err instanceof RevertError) warn(`SCOUT ${err.message} - will retry next tick`)
        else throw err
      }
    }
    if (!this.opts.housekeeping) return
    // Delist whatever is still Listed once every other listing of this run is terminal.
    const stillListed = own.filter((l) => statusName(l.status) === 'Listed')
    const others = own.filter((l) => statusName(l.status) !== 'Listed')
    if (!this.delisted && stillListed.length && others.length > 0 && others.every(TERMINAL)) {
      for (const l of stillListed) {
        const p = this.prepared.get(l.contentHash)!
        await say('SCOUT', `${p.entry.id} (#${l.id}, ${p.label.category}) found no buyer - delisting to recover the ${eth(l.bond)} bond`)
        try { await sendTx(this.wallet, { functionName: 'delist', args: [l.id] }) }
        catch (err) { if (err instanceof RevertError) { warn(`SCOUT ${err.message}`); return } ; throw err }
      }
      this.delisted = true
    }
  }

  private async list(state: MarketState, entries: DossierEntry[]): Promise<void> {
    if (!this.introduced) {
      this.introduced = true
      const n = this.entries.length
      await say('SCOUT', `I hold ${n} pre-public compute fact${n === 1 ? '' : 's'} (synthetic). Each lists as a salted hash + provider-free label with a 2x bond locked until the boards should show it${this.opts.plan === 'sequential' && n > 1 ? ' - one at a time' : ''}.`)
    }
    for (const entry of entries) {
      if (this.listedEntries.has(entry.id)) continue
      // Same salt on a retry: if the earlier attempt actually landed, the chain answers DuplicateContent instead of listing twice.
      if (entry.rogue && !this.preparedByEntry.has(entry.id)) await say('SCOUT', `${entry.id}: this time I am the rogue seller - skipping the honest seller's checks (schema + forbidden-content scan) on purpose; the market has to catch me`)
      const p = this.preparedByEntry.get(entry.id) ?? this.prepare(entry, state.now)
      this.preparedByEntry.set(entry.id, p)
      this.prepared.set(p.commitment, p)
      const { expiresAt, resolveBy } = p
      await say('SCOUT', `${entry.id}: ${p.label.category} / ${p.label.claimType} - ${nb(`${p.label.accelerator} x ${p.label.gpuCountBucket}`)} @ ${p.label.region}, ${p.label.interconnect}, ${nb(`${p.label.priceBand} $/GPU-hr`)}`)
      kv('price', `${eth(p.price)} · buy within ${expiresAt - state.now}s`)
      kv('bond', `${eth(2n * p.price)} (2x) · locked until ${clock(resolveBy)}`)
      kv('commitment', `${p.commitment} = keccak256(seller, canonicalJson, ${nb(`salt ${short(p.salt)}`)})`)
      let res
      try {
        res = await sendTx(this.wallet, {
          functionName: 'list',
          args: [p.commitment, categoryIndex(p.label.category), p.price, expiresAt, resolveBy, ATTEST_ALL, p.labelJson],
          value: 2n * p.price,
        })
      } catch (err) {
        if (err instanceof RevertError && err.errorName === 'DuplicateContent') { warn(`SCOUT ${entry.id} was already listed by an earlier attempt`); this.listedEntries.add(entry.id); continue }
        throw err
      }
      this.listedEntries.add(entry.id)
      const listed = res.logs.find((l) => l.eventName === 'Listed')
      if (listed && listed.eventName === 'Listed') {
        this.idOfEntry.set(entry.id, listed.args.id)
        kv('listing', `#${listed.args.id} - label ${p.labelJson.length} bytes in calldata; no provider, site or exact price in the clear`)
      }
    }
  }

  private prepare(entry: DossierEntry, now: bigint): Prepared {
    if (!entry.rogue) {
      // An honest seller never lists what it would lose on: schema first, then the same credential / contract-text /
      // contact-data scan the buyer and the arbiter run.
      const check = PayloadSchema.safeParse(entry.payload)
      if (!check.success) throw new Error(`dossier ${entry.id} fails PayloadSchema: ${check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
      const hits = forbiddenContentScan(entry.payload)
      if (hits.length) throw new Error(`dossier ${entry.id} carries forbidden content: ${hits.join('; ')}`)
    }
    const canon = canonicalize(entry.payload) // the exact string that is hashed AND later encrypted
    const salt = newSalt()
    const commitment = commitmentOf(this.me, canon, salt)
    const expiresAt = now + EXPIRES_IN
    const resolveBy = now + RESOLVE_IN
    const label = LabelSchema.parse({
      ...entry.label,
      resolveBy: new Date(Number(resolveBy) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      attestations: [...ATTESTATIONS],
    })
    return { entry, canon, salt, commitment, label, labelJson: JSON.stringify(label), price: parseEther(entry.price), expiresAt, resolveBy }
  }

  private async deliver(state: MarketState, l: Listing, p: Prepared): Promise<void> {
    if (p.entry.ghost) {
      if (!this.ghostAnnounced.has(l.id)) {
        this.ghostAnnounced.add(l.id)
        await say('SCOUT', `${p.entry.id} (#${l.id}) was bought… and I am not delivering (ghosting on purpose - the buyer can claim a refund + 10% of my bond after ${state.params.deliverTimeout}s)`)
      }
      return
    }
    const purchased = state.find(l.id, 'Purchased')
    if (!purchased) { warn(`SCOUT #${l.id} is Paid but no Purchased event seen yet`); return }
    const ciphertext = encryptFor(purchased.args.buyerPubKey, JSON.stringify({ canon: p.canon, salt: p.salt }))
    await say('SCOUT', `${p.entry.id} (#${l.id}) bought by ${short(purchased.args.buyer)} - encrypting ${nb('{dossier, salt}')} to their one-time key ${short(purchased.args.buyerPubKey, 8)}; the ciphertext (${(ciphertext.length - 2) / 2} bytes) goes into calldata`)
    await sendTx(this.wallet, { functionName: 'deliver', args: [l.id, ciphertext] })
  }
}
