'use client'

import { describeEvent } from '@/lib/describe'
import { fmtAgo, fmtTime } from '@/lib/format'
import { chainNow, type MarketState } from '@/lib/market'
import { AddrLink, Card, Empty, TxLink } from './ui'

const TONE: Record<string, string> = { neutral: 'text-blue', good: 'text-green', bad: 'text-red', warn: 'text-amber' }

// Reverse-chronological, one line per event. This is what the demo video points at.
export default function LiveFeed({ m, nowMs, compact = false }: { m: MarketState; nowMs: number; compact?: boolean }) {
  const now = chainNow(m.head, nowMs)
  const events = [...m.events].reverse()
  return (
    <Card
      eyebrow="live feed"
      title="Events"
      className={compact ? '' : '2xl:sticky 2xl:top-4 2xl:self-start'}
      aside={<span className="font-mono text-xs text-ink-3">{events.length} on-chain</span>}
    >
      <ol className={`${compact ? 'max-h-[22rem]' : 'max-h-[70vh]'} divide-y divide-line overflow-y-auto`}>
        {events.length === 0 && <Empty>{m.loading ? 'Loading…' : 'Nothing has happened on this contract yet.'}</Empty>}
        {events.map((e) => {
          const d = describeEvent(e)
          return (
            <li key={e.key} className="px-4 py-2.5 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className={`font-mono text-xs ${TONE[d.tone]}`}>{d.verb}</span>
                <span className="font-mono text-xs text-ink-3">#{e.listingId.toString()}</span>
                <span className="ml-auto font-mono text-[0.68rem] text-ink-3" title={fmtTime(e.timestamp)}>
                  {m.head && nowMs ? fmtAgo(now - e.timestamp) : fmtTime(e.timestamp)}
                </span>
              </div>
              <div className="mt-0.5 text-xs leading-relaxed text-ink-2">{d.detail}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[0.7rem] text-ink-3">
                {d.actor && <span>by <AddrLink addr={d.actor} /></span>}
                <TxLink hash={e.transactionHash} />
              </div>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
