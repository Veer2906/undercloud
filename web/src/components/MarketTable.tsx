'use client'

import { Fragment, useState } from 'react'
import { agentOf, fmtDuration, fmtEth, parseLabel, verifiabilityClass, type Label } from '@/lib/format'
import { chainNow, nextDeadline, type Listing, type MarketState } from '@/lib/market'
import DealTimeline from './DealTimeline'
import { AddrLink, Card, CategoryChip, Empty, StatusPill, TxLink, VerifiabilityChip } from './ui'

// Lower-priority columns drop out as the table's container narrows (container queries, not viewport),
// so a half-screen recording layout or a laptop never needs to side-scroll to see the state column.
const COL = {
  claim: 'hidden @2xl:table-cell',
  resolves: 'hidden @4xl:table-cell',
  seller: 'hidden @3xl:table-cell',
  tx: 'hidden @4xl:table-cell',
}

export default function MarketTable({ m, nowMs }: { m: MarketState; nowMs: number }) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const toggle = (id: bigint) =>
    setOpen((s) => {
      const n = new Set(s)
      const k = id.toString()
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

  // Label text comes only from the Listed event (calldata, never storage).
  const labels = new Map<string, Label>()
  const lastTx = new Map<string, string>()
  for (const e of m.events) {
    if (e.eventName === 'Listed') labels.set(e.listingId.toString(), parseLabel(e.args.label).label)
    lastTx.set(e.listingId.toString(), e.transactionHash)
  }
  const now = chainNow(m.head, nowMs)
  const rows = [...m.listings].sort((a, b) => (a.id < b.id ? 1 : -1))

  return (
    <Card eyebrow="market" title="Listings" aside={<span className="font-mono text-xs text-ink-3">click a row to open the deal</span>}>
      {m.loading && rows.length === 0 ? (
        <Empty>Scanning contract events from the deploy block…</Empty>
      ) : rows.length === 0 ? (
        <Empty>No listings yet. Run <span className="font-mono text-ink">pnpm demo</span> and watch this table fill up.</Empty>
      ) : (
        // `@container` lets the expanded deal panel size itself to the VISIBLE width (100cqw) instead of the
        // table's scroll width, and `sticky left-0` keeps it pinned while the wide row scrolls underneath.
        <div className="@container overflow-x-auto">
          <table className="market w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className="px-2 py-2">#</th>
                <th className="px-2 py-2">category</th>
                <th className="px-2 py-2">block (provider-free)</th>
                <th className="px-2 py-2">state</th>
                <th className={`px-2 py-2 ${COL.claim}`}>claim · observed</th>
                <th className={`px-2 py-2 ${COL.resolves}`}>resolves by · via</th>
                <th className="px-2 py-2 text-right">price · bond</th>
                <th className={`px-2 py-2 ${COL.seller}`}>seller</th>
                <th className={`px-2 py-2 ${COL.tx}`}>tx</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const k = l.id.toString()
                const label = labels.get(k) ?? {}
                const isOpen = open.has(k)
                return (
                  <Fragment key={k}>
                    <tr
                      onClick={() => toggle(l.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(l.id) } }}
                      tabIndex={0}
                      role="button"
                      aria-expanded={isOpen}
                      className={`cursor-pointer border-b border-line align-top transition-colors hover:bg-card-2 focus:outline-none focus-visible:bg-card-2 ${isOpen ? 'bg-card-2' : ''}`}
                    >
                      <td className="px-2 py-2.5 font-mono text-ink-3">{k}</td>
                      <td className="px-2 py-2.5">
                        <div className="flex items-center gap-1.5">
                          <CategoryChip category={l.category} />
                          <VerifiabilityChip cls={verifiabilityClass(label.category, label.claimType)} />
                        </div>
                      </td>
                      {/* The whole public label, as coarse as it is on-chain: no provider, site, exact count, price or day. */}
                      <td className="px-2 py-2.5">
                        <div className="text-ink">{label.accelerator && label.gpuCountBucket ? `${label.accelerator} × ${label.gpuCountBucket}` : label.accelerator ?? '-'}</div>
                        <div className="text-xs text-ink-3">@ {label.region ?? '-'}{label.interconnect ? ` · ${label.interconnect}` : ''}</div>
                        {(label.priceBand || label.availabilityWindow) && (
                          <div className="font-mono text-xs text-ink-2" title="price band in $/GPU-hour · availability window (months)">
                            {label.priceBand ?? '-'} $/GPU-hr · availability (months) {label.availabilityWindow ?? '-'}
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2.5">
                        <StatusPill status={l.status} />
                        <Countdown l={l} m={m} now={now} />
                      </td>
                      <td className={`px-2 py-2.5 ${COL.claim}`}>
                        <div className="font-mono text-xs text-ink-2">{label.claimType ?? '-'}</div>
                        <div className="font-mono text-xs text-ink-3" title="observedAt (month the seller says it saw the fact)">{label.observedAt ?? '-'}</div>
                      </td>
                      <td className={`px-2 py-2.5 text-xs ${COL.resolves}`}>
                        <div className="font-mono text-ink-2">{new Date(Number(l.resolveBy) * 1000).toISOString().slice(0, 16).replace('T', ' ')}Z</div>
                        <div className="max-w-[11rem] truncate text-ink-3" title={label.resolutionSource}>{label.resolutionSource ?? '-'}</div>
                      </td>
                      <td className="px-2 py-2.5 text-right font-mono">
                        <div className="text-ink">{fmtEth(l.price, { unit: false })}</div>
                        <div className="text-xs text-ink-3" title="Seller bond = 2 × price, locked until resolveBy">
                          {l.bondWithdrawn || l.bond === 0n ? <span title="bond returned or consumed">bond settled</span> : <>bond {fmtEth(l.bond, { unit: false })}</>}
                        </div>
                      </td>
                      <td className={`px-2 py-2.5 ${COL.seller}`}><SellerChip m={m} addr={l.seller} /></td>
                      <td className={`px-2 py-2.5 ${COL.tx}`}>{lastTx.get(k) ? <TxLink hash={lastTx.get(k)!} /> : '-'}</td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-line bg-paper-2">
                        <td colSpan={9} className="p-0">
                          <div className="sticky left-0 w-[100cqw]">
                            <DealTimeline l={l} m={m} nowMs={nowMs} label={label} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}

function SellerChip({ m, addr }: { m: MarketState; addr: string }) {
  const rep = m.sellerReps[addr.toLowerCase()]
  const a = agentOf(addr)
  return (
    <div className="min-w-[7.5rem]">
      <AddrLink addr={addr} />
      {rep && (
        <div
          className="mt-0.5 font-mono text-[0.68rem] text-ink-3"
          title={`${a.name}: settled ${rep.settled} · confirmed ${rep.confirmed} · refuted ${rep.refuted} · unadjudicated ${rep.unadjudicated} · ghosted ${rep.ghosted} · volume ${fmtEth(rep.volume)}`}
        >
          <span className="text-green">{rep.settled}</span>·<span className="text-green">{rep.confirmed}</span>·
          <span className="text-red">{rep.refuted}</span>·<span>{rep.unadjudicated}</span>·<span className="text-orange">{rep.ghosted}</span>
          <span className="ml-1.5">{fmtEth(rep.volume, { unit: false })}Ξ</span>
        </div>
      )}
    </div>
  )
}

export function Countdown({ l, m, now, className = '' }: { l: Listing; m: MarketState; now: number; className?: string }) {
  const d = nextDeadline(l, m.params)
  if (!d || !m.head) return null
  const left = d.at - now
  return (
    <div className={`mt-1 font-mono text-[0.68rem] ${left > 0 ? 'text-ink-2' : 'text-amber'} ${className}`}>
      {left > 0 ? `${d.label} ${fmtDuration(left)}` : d.after}
    </div>
  )
}
