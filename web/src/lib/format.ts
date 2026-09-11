import { formatEther } from 'viem'
import { knownAgents } from './generated/contract'

// ---------- enum names (must match the Solidity enum order in Undercloud.sol) ----------

export const STATUS_NAMES = [
  'Listed', 'Paid', 'Delivered', 'Released', 'Disputed',
  'RuledBuyer', 'RuledSeller', 'Unadjudicated', 'Refunded', 'Delisted',
] as const
export type StatusName = (typeof STATUS_NAMES)[number]

export const CATEGORY_NAMES = ['CapacityRelease', 'NewSupply', 'PriceMove', 'DemandSignal', 'ProviderReference'] as const
export const REASON_NAMES = ['NotAsCommitted', 'NotAsLabeled', 'AlreadyPublic', 'Incoherent', 'ForbiddenContent', 'DidNotHappen'] as const

export const statusName = (s: number): StatusName => STATUS_NAMES[s] ?? (`Status#${s}` as StatusName)
export const categoryName = (c: number) => CATEGORY_NAMES[c] ?? `Category#${c}`
export const reasonName = (r: number) => REASON_NAMES[r] ?? `Reason#${r}`

/** Human explanation of each status, shown in tooltips and the timeline. */
export const STATUS_HELP: Record<StatusName, string> = {
  Listed: 'Seller committed a salted hash and locked a bond of 2x price. Waiting for a buyer.',
  Paid: 'Buyer paid the exact price into escrow with a fresh one-time public key. Seller must deliver.',
  Delivered: 'Ciphertext is on-chain, sealed to the buyer’s one-time key. Quality window is open.',
  Released: 'Price paid to the seller (minus 2% burn). Bond stays locked until resolveBy.',
  Disputed: 'Buyer posted a dispute bond and sealed its key to the arbiter. Waiting for a ruling.',
  RuledBuyer: 'Arbiter sided with the buyer: refund + damages paid, rest of the bond burned.',
  RuledSeller: 'Arbiter sided with the seller: seller keeps the dispute bond; bond locked until resolveBy.',
  Unadjudicated: 'Arbiter was silent past its timeout: no-fault unwind, recorded as unadjudicated.',
  Refunded: 'Seller never delivered: buyer refunded plus 10% of the bond.',
  Delisted: 'Seller withdrew the listing before anyone bought; bond returned.',
}

export const REASON_HELP: Record<(typeof REASON_NAMES)[number], string> = {
  NotAsCommitted: 'Ciphertext does not decrypt to the committed hash (objective; no LLM involved).',
  NotAsLabeled: 'Dossier contradicts the public label (category, claim type, accelerator, region, interconnect, GPU count, price band, or an event date outside the availability window).',
  AlreadyPublic: 'The substance was on a marketplace, price board, rental index, provider page or in press before listedAt.',
  Incoherent: 'Generic or self-contradictory; fewer than two concrete, checkable details.',
  ForbiddenContent: 'Credentials, NDA’d contract text or contact data of provider staff. Truth is not a defense.',
  DidNotHappen: 'After release, before resolveBy: the buyer’s evidence shows the block, price or site was contradicted on its own dates.',
}

/** Human meaning of each category, shown as the category chip tooltip. */
export const CATEGORY_HELP: Record<(typeof CATEGORY_NAMES)[number], string> = {
  CapacityRelease: 'A specific block of accelerators is coming free (reservation ending, tenant churn, cluster rebalance) before it is listed anywhere.',
  NewSupply: 'New accelerators, power or a site are coming online (go-live, phase, anchor tenant) before press or a provider page says so.',
  PriceMove: 'A provider’s on-demand or reserved rate is about to change before the price page or index shows it. The magnitude is the good, so the label carries no band.',
  DemandSignal: 'An identified organization is shopping for a specified block (RFQs out, term, region, target price). Usually never public.',
  ProviderReference: 'A structured yes/no reference on a provider from a tenant that rented a specified block: fabric delivered as promised, SLA credits honored, would rent again.',
}

// ---------- verifiability class ----------

/** How soon (if ever) a claim of this shape can be checked against something public. Mirrors
 *  VERIFIABILITY_CLASS in agents/src/schema.ts - a local copy because the web package does not import agents.
 *    A: surfaces on a board or desk quote in days (CapacityRelease, every PriceMove except reserved-rate-change);
 *    B: surfaces late (NewSupply: press, region page; reserved-rate-change: per-deal quote);
 *    C: never public (DemandSignal, ProviderReference) - the bond lock is the whole warranty. */
export type VerifiabilityClass = 'A' | 'B' | 'C'
export function verifiabilityClass(category: string | undefined, claimType: string | undefined): VerifiabilityClass | undefined {
  if (!category) return undefined
  if (category === 'DemandSignal' || category === 'ProviderReference') return 'C'
  if (category === 'NewSupply' || claimType === 'reserved-rate-change') return 'B'
  return 'A'
}
export const VERIFIABILITY_HELP: Record<VerifiabilityClass, string> = {
  A: 'A: surfaces on a board or desk quote in days',
  B: 'B: surfaces late (press, region page, per-deal quote)',
  C: 'C: never public; the bond lock is the whole warranty',
}
export const VERIFIABILITY_TITLE =
  'A: surfaces on a board or desk quote in days · B: surfaces late (press, region page, per-deal quote) · C: never public; the bond lock is the whole warranty'

// ---------- money ----------

/** ETH with up to 6 significant decimals, trailing zeros trimmed. */
export function fmtEth(wei: bigint | undefined | null, opts: { unit?: boolean } = {}): string {
  if (wei === undefined || wei === null) return '-'
  const s = formatEther(wei)
  const [int, frac = ''] = s.split('.')
  const trimmed = frac.replace(/0+$/, '').slice(0, 6)
  const num = trimmed ? `${int}.${trimmed}` : int
  return opts.unit === false ? num : `${num} ETH`
}

// ---------- addresses / hashes ----------

export const shortHex = (h: string, head = 6, tail = 4) =>
  h.length <= head + tail + 2 ? h : `${h.slice(0, head + 2)}…${h.slice(-tail)}`

export const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase()

/** Display name for an address: known agent name, else short hex. */
export function agentOf(addr: string | undefined): { name: string; role: string; known: boolean } {
  if (!addr) return { name: '-', role: '', known: false }
  const hit = Object.entries(knownAgents).find(([k]) => k.toLowerCase() === addr.toLowerCase())
  if (hit) return { name: hit[1].name, role: hit[1].role, known: true }
  return { name: shortHex(addr), role: 'unknown address', known: false }
}

export const bytesLen = (hex: string) => Math.max(0, (hex.length - 2) / 2)

// ---------- time ----------

export function fmtTime(ts: number | bigint | undefined): string {
  if (ts === undefined || ts === null) return '-'
  const n = Number(ts)
  if (!n) return '-'
  return new Date(n * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC')
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function fmtAgo(seconds: number): string {
  if (seconds < 5) return 'just now'
  return `${fmtDuration(seconds)} ago`
}

// ---------- label ----------

/** The provider-free public label the buyer sees before paying (JSON string in the Listed event).
 *  By construction it carries coarse buckets only: no provider, site, exact GPU count, exact price or day. */
export type Label = {
  v?: number
  synthetic?: boolean
  category?: string
  claimType?: string
  accelerator?: string
  gpuCountBucket?: string
  region?: string
  interconnect?: string
  availabilityWindow?: string
  priceBand?: string
  observedAt?: string
  sourceBasis?: string
  confidence?: number
  noveltyAssertion?: string
  resolutionSource?: string
  resolveBy?: string
  attestations?: string[]
}

const LABEL_STRINGS = ['category', 'claimType', 'accelerator', 'gpuCountBucket', 'region', 'interconnect', 'availabilityWindow', 'priceBand', 'observedAt', 'sourceBasis', 'noveltyAssertion', 'resolutionSource', 'resolveBy'] as const

/** Labels are free-form calldata from ANY address on a public contract; never trust them to parse or to
 *  have the right shapes. Each field is kept only if it has the expected primitive type (an object where a
 *  string is expected would crash React), and strings are capped so a 2 KB label cannot blow up a cell.
 *  Missing fields render as "-". */
export function parseLabel(raw: string): { label: Label; ok: boolean } {
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      const label: Label = {}
      for (const k of LABEL_STRINGS) if (typeof o[k] === 'string') label[k] = (o[k] as string).slice(0, 400)
      if (typeof o.v === 'number' && Number.isFinite(o.v)) label.v = o.v
      if (typeof o.confidence === 'number' && Number.isFinite(o.confidence)) label.confidence = o.confidence
      if (typeof o.synthetic === 'boolean') label.synthetic = o.synthetic
      if (Array.isArray(o.attestations)) label.attestations = o.attestations.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 64))
      return { label, ok: true }
    }
  } catch {
    /* fall through */
  }
  return { label: {}, ok: false }
}

/** The arbiter's reasons JSON. Only the arbiter can emit it, but shapes are still checked before render. */
export function parseReasons(raw: string): { model?: string; ground?: string; reasons: string[]; rubricHash?: string } | null {
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      const str = (x: unknown) => (typeof x === 'string' ? x : undefined)
      const reasons = Array.isArray(o.reasons) ? o.reasons.map(String) : o.reasons !== undefined && o.reasons !== null ? [String(o.reasons)] : []
      return { model: str(o.model), ground: str(o.ground), rubricHash: str(o.rubricHash), reasons }
    }
  } catch {
    /* not JSON */
  }
  return null
}
