'use client'

import { describeEvent } from '@/lib/describe'
import { agentOf, bytesLen, fmtEth, fmtTime, parseReasons, REASON_HELP, reasonName, shortHex, statusName, STATUS_HELP, verifiabilityClass, VERIFIABILITY_HELP, type Label } from '@/lib/format'
import { chainNow, priceInEscrow, type Listing, type MarketEvent, type MarketState } from '@/lib/market'
import { Countdown } from './MarketTable'
import { AddrLink, StatusPill, TxLink } from './ui'

// Everything about one deal, reconstructed from its events + the current struct.
export default function DealTimeline({ l, m, nowMs, label }: { l: Listing; m: MarketState; nowMs: number; label: Label }) {
  const events = m.events.filter((e) => e.listingId === l.id)
  const listed = events.find((e) => e.eventName === 'Listed')
  const now = chainNow(m.head, nowMs)
  let burned = 0n
  for (const e of events) {
    if (e.eventName === 'Released') burned += e.args.feeBurned
    if (e.eventName === 'Ruled') burned += e.args.burned
  }
  const rawLabel = listed?.eventName === 'Listed' ? listed.args.label : ''
  const cls = verifiabilityClass(label.category, label.claimType)

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      {/* Left: the black box (label) + money panel */}
      <div className="space-y-4">
        <div className="rounded-md border border-line bg-card p-4">
          <div className="flex items-baseline justify-between">
            <div className="eyebrow">the black box: exactly what the buyer saw before paying</div>
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <L k="category" v={label.category} />
            <L k="claim type" v={label.claimType} mono />
            <L k="verifiability class" v={cls ? VERIFIABILITY_HELP[cls] : undefined} />
            <L k="accelerator" v={label.accelerator} mono />
            <L k="GPUs (bucket)" v={label.gpuCountBucket} mono />
            <L k="region" v={label.region} />
            <L k="interconnect" v={label.interconnect} />
            <L k="availability (months)" v={label.availabilityWindow} mono />
            <L k="price band ($/GPU-hr)" v={label.priceBand} mono />
            <L k="observed at (month)" v={label.observedAt} mono />
            <L k="source basis" v={label.sourceBasis} />
            <L k="confidence" v={label.confidence !== undefined ? `${label.confidence}/100` : undefined} mono />
            <L k="resolves via" v={label.resolutionSource} />
            <L k="resolve by" v={fmtTime(l.resolveBy)} mono />
            <L k="expires" v={fmtTime(l.expiresAt)} mono />
            <div className="col-span-2">
              <dt className="eyebrow">novelty assertion</dt>
              <dd className="text-ink-2">{label.noveltyAssertion ?? '-'}</dd>
            </div>
            <div className="col-span-2">
              <dt className="eyebrow">attestations (required by the contract)</dt>
              <dd className="font-mono text-xs text-ink-2">{label.attestations?.join(' · ') ?? '-'}</dd>
            </div>
          </dl>
          <div className="mt-3 rounded border border-amber/30 bg-amber/5 px-3 py-2 text-xs">
            <span className="eyebrow text-amber">seller’s proof of possession</span>
            <div className="mt-0.5 font-mono text-ink">listedAt {fmtTime(l.listedAt)}</div>
            <div className="text-ink-3">The block timestamp of the commitment is the seller’s evidence they held this fact on that date.</div>
          </div>
          <div className="mt-3 text-xs text-ink-3">
            commitment <span className="font-mono text-ink-2" title={l.contentHash}>{shortHex(l.contentHash, 10, 8)}</span>{' '}
            = keccak256(abi.encode(seller, canonicalDossierJson, salt)) · label {rawLabel ? `${new TextEncoder().encode(rawLabel).length} bytes` : ''}
            {!label.category && rawLabel && <span className="text-amber"> · label did not parse as JSON</span>}
          </div>
        </div>

        <div className="rounded-md border border-line bg-card p-4">
          <div className="eyebrow">money</div>
          <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <L k="price" v={fmtEth(l.price)} mono />
            <L k="price in escrow?" v={priceInEscrow(l) ? 'yes, held by the contract' : 'no'} />
            <L k="seller bond remaining" v={`${fmtEth(l.bond)}${l.bondWithdrawn ? ' (settled)' : l.bond > 0n ? ' · locked until resolveBy' : ''}`} mono />
            <L k="dispute bond" v={l.status === 4 ? `${fmtEth(l.disputeBond)} (held)` : l.disputeBond > 0n ? fmtEth(l.disputeBond) : '-'} mono />
            <L k="burned on this deal" v={fmtEth(burned)} mono />
            <L k="buyer attested" v={l.confirmed ? 'yes (display only)' : 'no'} />
          </dl>
          <div className="mt-3 flex items-center gap-3 text-xs">
            <StatusPill status={l.status} />
            <span className="text-ink-3">{STATUS_HELP[statusName(l.status)]}</span>
          </div>
          <Countdown l={l} m={m} now={now} className="!mt-2 !text-xs" />
        </div>
      </div>

      {/* Right: vertical timeline */}
      <ol className="relative space-y-4 border-l border-line-2 pl-5">
        {events.map((e) => (
          <Step key={e.key} e={e} l={l} />
        ))}
        {events.length === 0 && <li className="text-sm text-ink-3">No events for this listing yet.</li>}
      </ol>
    </div>
  )
}

function L({ k, v, mono }: { k: string; v?: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{k}</dt>
      <dd className={`break-words ${mono ? 'font-mono text-xs' : ''} ${v ? 'text-ink' : 'text-ink-3'}`}>{v ?? '-'}</dd>
    </div>
  )
}

const TONE: Record<string, string> = { neutral: 'bg-blue', good: 'bg-green', bad: 'bg-red', warn: 'bg-amber' }

function Step({ e, l }: { e: MarketEvent; l: Listing }) {
  const d = describeEvent(e)
  const actor = actorOf(e, l)
  return (
    <li className="relative">
      <span className={`absolute -left-[1.55rem] top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-paper-2 ${TONE[d.tone]}`} />
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-serif text-lg text-ink">{d.verb}</span>
        <span className="font-mono text-xs text-ink-3">{fmtTime(e.timestamp)} · block {e.blockNumber.toString()}</span>
        <TxLink hash={e.transactionHash} />
      </div>
      <div className="mt-0.5 text-xs text-ink-3">
        by {actor.addr ? <AddrLink addr={actor.addr} /> : <span className="text-ink-2">{actor.label}</span>}
        {actor.addr && <span> · {agentOf(actor.addr).role || actor.label}</span>}
      </div>
      <div className="mt-1 text-sm text-ink-2">{d.detail}</div>
      <Extra e={e} />
    </li>
  )
}

function actorOf(e: MarketEvent, l: Listing): { addr?: string; label: string } {
  switch (e.eventName) {
    case 'Listed': return { addr: e.args.seller, label: 'seller' }
    case 'Purchased': return { addr: e.args.buyer, label: 'buyer' }
    case 'Disputed': return { addr: e.args.buyer, label: 'buyer' }
    case 'Attested': return { addr: l.buyer, label: 'buyer' }
    case 'Delivered':
    case 'Delisted':
    case 'BondWithdrawn': return { addr: l.seller, label: 'seller' }
    case 'Ruled': return { label: 'the arbiter (only address allowed to rule)' }
    default: return { label: 'anyone; keeper call after the deadline' }
  }
}

/** Event-specific detail blocks: sealed key notice, reasons JSON, payouts. */
function Extra({ e }: { e: MarketEvent }) {
  switch (e.eventName) {
    case 'Purchased':
      return (
        <div className="mt-1 font-mono text-[0.7rem] text-ink-3" title={e.args.buyerPubKey}>
          one-time pubkey {shortHex(e.args.buyerPubKey, 10, 8)}, generated for this purchase only, never the wallet key
        </div>
      )
    case 'Delivered':
      return (
        <div className="mt-1 text-[0.7rem] text-ink-3">
          ECIES ciphertext of {'{dossier, salt}'} · {bytesLen(e.args.ciphertext).toLocaleString()} bytes · the buyer decrypts locally and recomputes the commitment
        </div>
      )
    case 'Disputed': {
      const r = reasonName(e.args.reason)
      return (
        <div className="mt-1 space-y-1 text-xs">
          <div className="text-ink-2">
            <span className="font-mono text-amber">{r}</span>: {REASON_HELP[r as keyof typeof REASON_HELP] ?? ''}
          </div>
          {e.args.evidence && <div className="text-ink-2">evidence: <span className="italic">“{e.args.evidence}”</span></div>}
          <div className="rounded border border-line bg-paper px-2 py-1 font-mono text-[0.7rem] text-ink-3">
            key sealed to the arbiter · not public · {bytesLen(e.args.sealedKey)} bytes · dispute bond ⌈price/2⌉ posted
          </div>
        </div>
      )
    }
    case 'Ruled': {
      const r = parseReasons(e.args.reasons)
      return (
        <div className="mt-1 space-y-1 text-xs">
          <div className="grid grid-cols-3 gap-2 font-mono">
            <Pay k="buyer" v={e.args.buyerPayout} />
            <Pay k="seller" v={e.args.sellerPayout} />
            <Pay k="burned" v={e.args.burned} />
          </div>
          {r ? (
            <div className="rounded border border-line bg-paper px-3 py-2">
              <div className="font-mono text-[0.7rem] text-ink-3">
                model {r.model ?? '?'} · ground {r.ground ?? '?'} {r.rubricHash ? `· rubric ${shortHex(r.rubricHash, 8, 6)}` : ''}
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-ink-2">
                {r.reasons.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
              <div className="mt-1 text-[0.7rem] text-ink-3">provider-redacted reasons, published on-chain</div>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap rounded border border-line bg-paper px-3 py-2 font-mono text-[0.7rem] text-ink-2">{e.args.reasons}</pre>
          )}
        </div>
      )
    }
    case 'Unadjudicated':
    case 'Refunded':
      return (
        <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-xs">
          <Pay k="buyer" v={e.args.buyerPayout} />
          <Pay k="seller" v={e.args.sellerPayout} />
        </div>
      )
    case 'Released':
      return (
        <div className="mt-1 grid grid-cols-3 gap-2 font-mono text-xs">
          <Pay k="seller" v={e.args.sellerPayout} />
          <Pay k="burned" v={e.args.feeBurned} />
        </div>
      )
    default:
      return null
  }
}

function Pay({ k, v }: { k: string; v: bigint }) {
  return (
    <div className="rounded border border-line bg-paper px-2 py-1">
      <div className="eyebrow">{k}</div>
      <div className="text-ink">{fmtEth(v)}</div>
    </div>
  )
}
