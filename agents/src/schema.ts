// Data schemas (spec §5.1) and the MECHANICAL checks that both the buyer and the arbiter run.
// One module on purpose: a buyer that disputes on a rule the arbiter does not apply would lose its bond.
import { z } from 'zod'

// ---- Enums: index == the contract's uint8 value. Never reorder. ----
export const CATEGORIES = ['CapacityRelease', 'NewSupply', 'PriceMove', 'DemandSignal', 'ProviderReference'] as const
export const REASONS = ['NotAsCommitted', 'NotAsLabeled', 'AlreadyPublic', 'Incoherent', 'ForbiddenContent', 'DidNotHappen'] as const
export type Category = (typeof CATEGORIES)[number]
export type Reason = (typeof REASONS)[number]
export const categoryIndex = (c: Category): number => CATEGORIES.indexOf(c)
export const reasonIndex = (r: Reason): number => REASONS.indexOf(r)
export const categoryName = (i: number): Category => CATEGORIES[i] ?? (`Category${i}` as Category)
export const reasonName = (i: number): Reason => REASONS[i] ?? (`Reason${i}` as Reason)

export const ATTESTATIONS = ['NO_NDA', 'NO_CREDENTIALS', 'PROVIDER_LEVEL_ONLY', 'SYNTHETIC'] as const
export const ATTEST_ALL = 15 // 1|2|4|8 - the contract rejects anything else

/** Fixed claimType menu per category - no free text, so a label cannot smuggle a provider or site in. */
export const CLAIM_TYPES: Record<Category, readonly string[]> = {
  CapacityRelease: ['reservation-ending-within-30d', 'tenant-churn-block-freeing', 'cluster-rebalance-block-freeing'],
  NewSupply: ['go-live-date-set', 'power-energized', 'anchor-tenant-signed', 'delivery-slipped'],
  PriceMove: ['on-demand-cut', 'on-demand-raise', 'reserved-rate-change', 'promo-block-pricing'],
  DemandSignal: ['rfq-in-market', 'term-extension-sought', 'client-shedding-capacity'], // a block actually being returned is supply: CapacityRelease/tenant-churn-block-freeing
  ProviderReference: ['structured-reference'],
}

// ---- Fixed value menus: every label field is an enum or a bucket, never a provider, site, exact count or exact price. ----
export const ACCELERATORS = ['H100', 'H200', 'B200', 'GB200', 'MI300X', 'TPU-v5e', 'L40S'] as const
export const GPU_BUCKETS = ['64-255', '256-1023', '1024-4095', '4096+'] as const // ordered; index = rank
export const REGIONS = ['US-West', 'US-East', 'EU-West', 'EU-North', 'APAC', 'ME'] as const // payload.provider.region
export const LABEL_REGIONS = [...REGIONS, 'undisclosed'] as const // label.region; 'undisclosed' only when category === 'ProviderReference'
export const INTERCONNECTS = ['InfiniBand', 'NVLink', 'RoCE', 'Ethernet', 'unknown'] as const
export const PRICE_BANDS = ['<1.00', '1.00-1.49', '1.50-1.99', '2.00-2.49', '2.50-2.99', '3.00-3.99', '4.00-5.99', '6.00-9.99', '10.00+', 'n/a'] as const // USD per GPU-hour
export type GpuBucket = (typeof GPU_BUCKETS)[number]
export type PriceBand = (typeof PRICE_BANDS)[number]

export const bucketOf = (n: number): GpuBucket | null => (n >= 4096 ? '4096+' : n >= 1024 ? '1024-4095' : n >= 256 ? '256-1023' : n >= 64 ? '64-255' : null)
/** Money is integer milli-USD per GPU-hour everywhere (1950 = $1.95); null = no price in the claim. */
export const bandOf = (milli: number | null | undefined): PriceBand =>
  milli == null ? 'n/a'
  : milli < 1000 ? '<1.00' : milli < 1500 ? '1.00-1.49' : milli < 2000 ? '1.50-1.99' : milli < 2500 ? '2.00-2.49'
  : milli < 3000 ? '2.50-2.99' : milli < 4000 ? '3.00-3.99' : milli < 6000 ? '4.00-5.99' : milli < 10000 ? '6.00-9.99' : '10.00+'

/** How the fact surfaces: A on a board or desk quote in days; B late (press, region page, per-deal quote);
 *  C never - the bond lock is the whole warranty, so class-C facts trade at a discount. */
export const VERIFIABILITY_CLASS = (category: Category, claimType: string): 'A' | 'B' | 'C' =>
  category === 'DemandSignal' || category === 'ProviderReference' ? 'C'
  : category === 'NewSupply' || claimType === 'reserved-rate-change' ? 'B' : 'A'
/** Minimum bond lock buyers demand on class-C listings (30 d in production; demo.ts sets 200 s before this module loads). */
export const CLASS_C_MIN_LOCK_SECONDS = Number(process.env.CLASS_C_MIN_LOCK_SECONDS ?? 30 * 86400)
/** A public record older than this before listedAt does not make a listing AlreadyPublic: providers reprice monthly. */
export const PUBLIC_RECORD_LOOKBACK_SECONDS = 90 * 86400

const claimTypeMatchesCategory = (v: { category: Category; claimType: string }, ctx: z.RefinementCtx) => {
  if (!CLAIM_TYPES[v.category].includes(v.claimType))
    ctx.addIssue({ code: 'custom', path: ['claimType'], message: `claimType "${v.claimType}" is not in the ${v.category} menu` })
}
const labelRules = (v: { category: Category; region: string; priceBand: string }, ctx: z.RefinementCtx) => {
  if (v.region === 'undisclosed' && v.category !== 'ProviderReference')
    ctx.addIssue({ code: 'custom', path: ['region'], message: 'region "undisclosed" is allowed only on a ProviderReference label' })
  // The new price IS the good on a PriceMove: direction is in claimType, magnitude stays sealed.
  if (v.category === 'PriceMove' && v.priceBand !== 'n/a')
    ctx.addIssue({ code: 'custom', path: ['priceBand'], message: 'PriceMove labels carry priceBand "n/a"' })
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
const isoDateTime = z.string().datetime()
const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, 'YYYY-MM')
// Month-granularity interval: day precision leaked the good and the site (a go-live date, the day after a contract end).
const monthWindow = z.string().regex(/^\d{4}-\d{2}\/\d{4}-\d{2}$/, 'YYYY-MM/YYYY-MM').refine((w) => w.split('/')[0]! <= w.split('/')[1]!, 'window start must not be after its end')

// ---- Public label: the ONLY thing about a block that is ever on-chain in plaintext. ----
// .strict(): keys like provider / site / gpuCount / priceMilliUsdPerGpuHour cannot exist, by construction.
const labelDraftShape = {
  v: z.literal(1),
  synthetic: z.literal(true),
  category: z.enum(CATEGORIES),
  claimType: z.string(),
  accelerator: z.enum(ACCELERATORS),
  gpuCountBucket: z.enum(GPU_BUCKETS),
  region: z.enum(LABEL_REGIONS),
  interconnect: z.enum(INTERCONNECTS),
  availabilityWindow: monthWindow,
  priceBand: z.enum(PRICE_BANDS),
  observedAt: isoMonth,
  sourceBasis: z.enum(['firsthand', 'secondhand']),
  confidence: z.number().int().min(0).max(100),
  noveltyAssertion: z.string().min(1),
  resolutionSource: z.string().min(1),
}
export const LabelSchema = z
  .object({
    ...labelDraftShape,
    resolveBy: isoDateTime,
    attestations: z.tuple([z.literal('NO_NDA'), z.literal('NO_CREDENTIALS'), z.literal('PROVIDER_LEVEL_ONLY'), z.literal('SYNTHETIC')]),
  })
  .strict()
  .superRefine(claimTypeMatchesCategory)
  .superRefine(labelRules)
export type Label = z.infer<typeof LabelSchema>

/** What dossiers.json carries: the label minus the two fields the seller adds at listing time. */
export const LabelDraftSchema = z.object(labelDraftShape).strict().superRefine(claimTypeMatchesCategory).superRefine(labelRules)
export type LabelDraft = z.infer<typeof LabelDraftSchema>

// ---- Sealed payload: never on-chain in plaintext. ----
export const ReferenceSchema = z
  .object({
    deliveredInterconnectAsPromised: z.boolean(),
    honoredSlaCredits: z.boolean(),
    wouldRentAgain: z.boolean(),
    notes: z.null(), // structured yes/no only - no free-text judgments of a provider, ever
  })
  .strict()

export const ClaimSchema = z
  .object({
    what: z.string(),
    when: z.string(),
    priceMilliUsdPerGpuHour: z.number().int().nullable(),
    contractEndOrGoLive: z.string().nullable(),
    counterparties: z.array(z.string()).optional(), // roles, never names ("outgoing tenant (AI lab)")
    termMonths: z.number().int().nullable(),
    stage: z.string().nullable(),
  })
  .strict()

/** `provider` is the organization the claim is about: the provider for CapacityRelease / NewSupply / PriceMove /
 *  ProviderReference, the organization that is shopping for a DemandSignal. The payload always carries the real
 *  region even when the label says `undisclosed`. */
export const PayloadSchema = z
  .object({
    v: z.literal(1),
    synthetic: z.literal(true),
    category: z.enum(CATEGORIES),
    claimType: z.string(),
    provider: z.object({ name: z.string().min(1), site: z.string().min(1), region: z.enum(REGIONS) }).strict(),
    accelerator: z.enum(ACCELERATORS),
    gpuCount: z.number().int().min(64), // bucketOf() is null below 64: a smaller block could only ever be NotAsLabeled
    interconnect: z.enum(INTERCONNECTS),
    claim: ClaimSchema,
    sourceBasis: z.string().min(1),
    confidence: z.number().int().min(0).max(100),
    introPath: z.string().regex(/^via .+\(.+ role\)$/, 'a ROLE ("via the provider\'s capacity desk (Head of Cloud Sales role)"), never an individual').nullable(),
    reference: ReferenceSchema.nullable(),
  })
  .strict()
  .superRefine(claimTypeMatchesCategory)
  .superRefine((v, ctx) => {
    if (v.category === 'ProviderReference' && v.reference === null)
      ctx.addIssue({ code: 'custom', path: ['reference'], message: 'ProviderReference category needs the structured reference block' })
  })
export type Payload = z.infer<typeof PayloadSchema>

// ---- Dataset entry (agents/data/dossiers.json). Payload stays loosely typed here: rogue entries
// deliberately violate PayloadSchema and the seller validates honest ones explicitly. ----
export const DossierEntrySchema = z
  .object({
    id: z.string(),
    demo: z.boolean(),
    rogue: z.boolean(),
    ghost: z.boolean(),
    price: z.string().regex(/^\d+(\.\d+)?$/, 'price in ETH'),
    label: LabelDraftSchema,
    payload: z.record(z.string(), z.unknown()),
    laterSurfaced: z.string().optional(),
  })
  .strict()
export type DossierEntry = z.infer<typeof DossierEntrySchema>
export const DossiersSchema = z.array(DossierEntrySchema)

// ---- Synthetic public record: what the price boards / marketplaces / indices / press "already show". ----
// `source` is a provider-free slug: it becomes dispute calldata.
export const PublicRecordSchema = z
  .object({
    provider: z.string(),
    category: z.string(),
    accelerator: z.enum(ACCELERATORS).optional(),
    region: z.enum(REGIONS).optional(),
    claimType: z.string().optional(),
    fact: z.string(),
    publishedAt: isoDate.or(isoDateTime),
    source: z.string(),
  })
  .strict()
export type PublicRecord = z.infer<typeof PublicRecordSchema>
export const PublicRecordsSchema = z.array(PublicRecordSchema)

// =====================================================================================
// Mechanical checks. Pure functions over the decrypted payload; no LLM, no network.
// =====================================================================================

// Credentials / access material, NDA'd contract text, and contact data of provider staff.
const FORBIDDEN_KEY = /^(api[_-]?key|access[_-]?key|secret[_-]?key|secrets?|tokens?|bearer|auth|password|passwd|pwd|ssh[_-]?key|private[_-]?key|credentials?|login|kubeconfig|vpn|contract[_-]?excerpt|contract[_-]?text|nda|nda[_-]?text|msa|sow|exhibit|e-?mail|phone|mobile|cell|whatsapp|signal|telegram|contact|contacts|home[_-]?address|address|personal)$/i
const SECRET_VALUES: [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{8,}/, 'API-key-like value'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/-----BEGIN [A-Z ]*(PRIVATE KEY|CERTIFICATE)-----/, 'PEM block'],
  [/\bssh-(rsa|ed25519|ecdsa)\s+[A-Za-z0-9+/=]{20,}/, 'SSH public key'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/, 'Slack token'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
  [/\bhf_[A-Za-z0-9]{20,}\b/, 'Hugging Face token'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/i, 'bearer token'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, 'Google API key'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, 'email-like value'],
  // 7+ digits separated only by phone punctuation; tested after DATE_TOKEN strip. "256 nodes, 8 GPUs per node",
  // "3.2 Tb/s", "1,890" (comma excluded) and "USD 1,200,000" cannot fire.
  [/\+?(?:\d[\s().-]*){6,}\d/, 'phone-number-like value'],
  [/\b(confidential|non-disclosure|nondisclosure|whereas|hereinafter|the parties agree|subject to the (nda|msa|agreement))\b/i, 'contract-language value (NDA text)'],
  [/\bsection\s+\d+(\.\d+)*\b/i, 'contract-language value (section reference)'], // do NOT add 'take-or-pay' or 'shall': both appear in honest compute prose
]
// ISO dates, months and month intervals ("2026-10/2027-03") would otherwise satisfy the phone pattern; strip them before testing.
const DATE_TOKEN = /\d{4}-\d{2}(-\d{2})?(T[\d:.]+Z?)?(\/\d{4}-\d{2}(-\d{2})?)?/g

/** Recursive scan for credentials, contract text and contact data of provider staff. Returns the hits (empty = clean).
 *  Truth is not a defense: a correct dossier with a working API key in it is still ForbiddenContent. */
export function forbiddenContentScan(payload: unknown, path = '$'): string[] {
  const hits: string[] = []
  if (Array.isArray(payload)) {
    payload.forEach((v, i) => hits.push(...forbiddenContentScan(v, `${path}[${i}]`)))
  } else if (payload && typeof payload === 'object') {
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (FORBIDDEN_KEY.test(k)) hits.push(`forbidden key ${path}.${k}`)
      hits.push(...forbiddenContentScan(v, `${path}.${k}`))
    }
  } else if (typeof payload === 'string') {
    const stripped = payload.replace(DATE_TOKEN, ' ')
    for (const [re, name] of SECRET_VALUES) if (re.test(stripped)) hits.push(`${name} at ${path}`)
  }
  return hits
}

export type LabelLike = Pick<Label, 'category' | 'claimType' | 'accelerator' | 'region' | 'interconnect' | 'gpuCountBucket' | 'priceBand' | 'availabilityWindow'>

const prevMonth = (ym: string): string => {
  const [y, m] = ym.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** The label/payload fields that must agree. Returns the mismatches (empty = consistent). */
export function labelPayloadConsistency(label: LabelLike, payload: unknown): string[] {
  const p = (payload ?? {}) as Record<string, any>
  const out: string[] = []
  if (p.category !== label.category) out.push(`category: label ${label.category}, payload ${p.category}`)
  if (p.claimType !== label.claimType) out.push(`claimType: label ${label.claimType}, payload ${p.claimType}`)
  if (p.accelerator !== label.accelerator) out.push(`accelerator: label ${label.accelerator}, payload ${p.accelerator}`)
  if (label.region !== 'undisclosed' && p.provider?.region !== label.region) out.push(`region: label ${label.region}, payload ${p.provider?.region}`)
  if (p.interconnect !== label.interconnect) out.push(`interconnect: label ${label.interconnect}, payload ${p.interconnect}`)
  const bucket = typeof p.gpuCount === 'number' ? bucketOf(p.gpuCount) : null
  if (bucket !== label.gpuCountBucket) out.push(`bucket: label ${label.gpuCountBucket}, payload ${p.gpuCount} GPUs (${bucket ?? 'below 64'})`)
  // PriceMove labels carry n/a by rule (the magnitude is the good); every other category must band-match, so a seller
  // cannot hide the band by labelling n/a nor sell a priceless claim under a numeric band.
  if (label.category !== 'PriceMove') {
    const band = bandOf(p.claim?.priceMilliUsdPerGpuHour)
    if (band !== label.priceBand) out.push(`priceBand: label ${label.priceBand}, payload ${band}`)
  }
  // Window fit: the claim's own event month must sit inside the label's availability window (one month early is fine -
  // a block frees the day after a contract ends).
  const event = String(p.claim?.contractEndOrGoLive ?? p.claim?.when ?? '').slice(0, 7)
  const [start, end] = String(label.availabilityWindow ?? '/').split('/') as [string, string]
  if (!/^\d{4}-\d{2}$/.test(event) || !start || !end || event < prevMonth(start) || event > end)
    out.push(`availabilityWindow: label ${label.availabilityWindow}, payload event month ${event || 'missing'}`)
  return out
}

/** Number of non-empty fields in payload.claim (what/when/price/contractEndOrGoLive/counterparties/termMonths/stage). */
export function claimFieldCount(payload: unknown): number {
  const claim = (payload as any)?.claim
  if (!claim || typeof claim !== 'object') return 0
  return Object.values(claim as Record<string, unknown>).filter((v) =>
    Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== 0 && String(v).trim() !== '',
  ).length
}

/** A public-record entry about the same provider + category (+ accelerator / region / claimType where the record
 *  carries them), published BEFORE the listing and inside the 90-day lookback. */
export function findPriorPublicRecord(records: PublicRecord[], payload: unknown, listedAt: bigint): PublicRecord | undefined {
  const p = payload as any
  const provider = p?.provider?.name, category = p?.category
  if (!provider || !category) return undefined
  return records.find((r) => {
    if (r.provider !== provider || r.category !== category) return false
    if (r.accelerator !== undefined && r.accelerator !== p?.accelerator) return false
    if (r.region !== undefined && r.region !== p?.provider?.region) return false
    if (r.claimType !== undefined && r.claimType !== p?.claimType) return false
    const at = BigInt(Math.floor(Date.parse(r.publishedAt) / 1000))
    return at < listedAt && at >= listedAt - BigInt(PUBLIC_RECORD_LOOKBACK_SECONDS)
  })
}

export type MechanicalVerdict = { reason: Reason; evidence: string; detail: string[] }

/** Runs the mechanical rubric in the spec's order. `null` = no mechanical ground (LLM / burden of proof). */
export function mechanicalGround(label: LabelLike, payload: unknown, listedAt: bigint, records: PublicRecord[]): MechanicalVerdict | null {
  const forbidden = forbiddenContentScan(payload)
  if (forbidden.length) return { reason: 'ForbiddenContent', evidence: 'ForbiddenContent: credentials, contract text or contact data in sealed payload', detail: ['credentials, NDA text or contact data of provider staff inside the sealed payload; truth is not a defense', ...forbidden] }
  const mismatch = labelPayloadConsistency(label, payload)
  if (mismatch.length) return { reason: 'NotAsLabeled', evidence: 'NotAsLabeled: payload disagrees with the public label', detail: ['the delivered dossier disagrees with the public label the buyer paid for', ...mismatch] }
  const prior = findPriorPublicRecord(records, payload, listedAt)
  if (prior) return { reason: 'AlreadyPublic', evidence: prior.source, detail: ['the substance of the claim was on the public record before the listing timestamp', `${prior.source} (published ${prior.publishedAt})`] }
  const n = claimFieldCount(payload)
  if (n < 2) return { reason: 'Incoherent', evidence: 'Incoherent: fewer than 2 concrete claim fields', detail: [`the claim carries ${n} non-empty field(s); at least two concrete, checkable details are required`] }
  return null
}

// Generic words inside provider names ("Halyard Cloud", "Marlstone DC") that must survive in a ruling.
const PROVIDER_STOPLIST = new Set(['cloud', 'compute', 'data', 'center', 'centers', 'dc', 'ai', 'labs', 'lab', 'research', 'foundry', 'networks', 'systems'])

/** Replace provider / site / counterparty names in free text so nothing on-chain ever names a provider. */
export function redactNames(text: string, payload: unknown): string {
  const p = payload as any
  let out = text
  const swaps: [string | undefined, string][] = [
    [p?.provider?.name, '[provider]'],
    [p?.provider?.site, '[site]'],
    ...((p?.claim?.counterparties as string[] | undefined) ?? []).flatMap((c): [string, string][] => [[c, '[counterparty]'], [c.split(' (')[0]!, '[counterparty]']]),
  ]
  for (const [needle, repl] of swaps) {
    if (!needle || typeof needle !== 'string') continue
    out = out.split(needle).join(repl)
    // also catch single-word mentions of the provider ("Halyard"), but never the generic half ("Cloud")
    if (repl === '[provider]') for (const part of needle.split(/\s+/)) if (part.length > 2 && !PROVIDER_STOPLIST.has(part.toLowerCase())) out = out.split(part).join(repl)
    // and site sub-tokens ("Hillsboro", "PDX2", "HLY") so an LLM-written ruling cannot leak the site piecewise; lowercase
    // generic words ("target", "hosted") and 2-letter state codes survive
    if (repl === '[site]') for (const part of needle.split(/[\s(),:-]+/)) if (part.length > 2 && /[A-Z]/.test(part) && !PROVIDER_STOPLIST.has(part.toLowerCase())) out = out.split(part).join(repl)
  }
  return out
}
