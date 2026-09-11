'use client'

import { knownAgents } from '@/lib/generated/contract'
import { agentOf, fmtEth, sameAddr } from '@/lib/format'
import type { BuyerRep, MarketState, SellerRep } from '@/lib/market'
import { AddrLink, Card } from './ui'

// One card per address that matters: the four known agents, the arbiter, and anyone else who
// showed up on-chain. Reputation is counts, not a score - the hit rate is derived here, not stored.
export default function AgentsPanel({ m }: { m: MarketState }) {
  const addrs = new Map<string, { addr: string; name: string; role: string }>()
  const add = (addr: string, fallbackRole: string) => {
    const k = addr.toLowerCase()
    if (addrs.has(k)) return
    const a = agentOf(addr)
    addrs.set(k, { addr, name: a.name, role: a.known ? a.role : fallbackRole })
  }
  Object.keys(knownAgents).forEach((a) => add(a, ''))
  if (m.params) add(m.params.arbiter, 'arbiter (judge)')
  Object.keys(m.sellerReps).forEach((a) => add(a, 'seller (unknown address)'))
  Object.keys(m.buyerReps).forEach((a) => add(a, 'buyer (unknown address)'))

  // Buyers and the judge are always shown (they are the market's standing participants). Everyone
  // else - the deployer, the scout treasury, pre-derived per-run scout identities - only appears
  // once it has actually done something on-chain, so the panel never fills with empty cards.
  const isActive = (addr: string) => {
    const k = addr.toLowerCase()
    const s = m.sellerReps[k]
    const b = m.buyerReps[k]
    return (s && s.listed > 0) || (b && b.bought > 0)
  }
  const cards = [...addrs.values()].filter(
    (c) => sameAddr(c.addr, m.params?.arbiter) || /buyer/i.test(c.role) || isActive(c.addr),
  )

  return (
    <Card title="Agents">
      {cards.length === 0 ? (
        <div className="px-4 py-6 text-sm text-ink-3">No agents seen yet.</div>
      ) : (
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => (
            <AgentCard
              key={c.addr}
              {...c}
              isArbiter={sameAddr(c.addr, m.params?.arbiter)}
              seller={m.sellerReps[c.addr.toLowerCase()]}
              buyer={m.buyerReps[c.addr.toLowerCase()]}
            />
          ))}
        </div>
      )}
    </Card>
  )
}

function AgentCard({ addr, name, role, isArbiter, seller, buyer }: { addr: string; name: string; role: string; isArbiter: boolean; seller?: SellerRep; buyer?: BuyerRep }) {
  const judged = seller ? seller.confirmed + seller.refuted : 0
  const hit = judged > 0 && seller ? `${Math.round((seller.confirmed / judged) * 100)}%` : 'n/a'
  const showSeller = seller && (seller.listed > 0 || !buyer)
  const showBuyer = buyer && buyer.bought > 0
  return (
    <div className="rounded-md border border-line bg-paper-2 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-serif text-lg text-ink">{name}</div>
          <div className="text-xs text-ink-3">{role || (isArbiter ? 'arbiter (judge)' : 'agent')}</div>
        </div>
        <AddrLink addr={addr} name={false} />
      </div>
      {isArbiter && (
        <div className="mt-2 text-xs text-ink-3">Rules only on Disputed listings; its model id and rubric hash are fixed in the contract. Silence past the timeout is recorded as unadjudicated, never as a win.</div>
      )}
      {showSeller && seller && (
        <div className="mt-3">
          <div className="eyebrow">as seller</div>
          <div className="mt-1 grid grid-cols-4 gap-x-2 gap-y-1 font-mono text-xs">
            <C k="listed" v={seller.listed} />
            <C k="sold" v={seller.sold} />
            <C k="settled" v={seller.settled} tone="text-green" />
            <C k="confirmed" v={seller.confirmed} tone="text-green" />
            <C k="refuted" v={seller.refuted} tone="text-red" />
            <C k="unadjud." v={seller.unadjudicated} />
            <C k="ghosted" v={seller.ghosted} tone="text-orange" />
            <C k="disp. won" v={seller.disputesWon} />
          </div>
          <div className="mt-2 flex items-baseline justify-between font-mono text-xs">
            <span className="text-ink-3" title="confirmed / (confirmed + refuted); unadjudicated excluded">hit rate <span className="text-ink">{hit}</span></span>
            <span className="text-ink-3">volume <span className="text-ink">{fmtEth(seller.volume)}</span></span>
          </div>
        </div>
      )}
      {showBuyer && buyer && (
        <div className="mt-3">
          <div className="eyebrow">as buyer</div>
          <div className="mt-1 grid grid-cols-3 gap-x-2 gap-y-1 font-mono text-xs">
            <C k="bought" v={buyer.bought} />
            <C k="disputes filed" v={buyer.disputesFiled} tone="text-amber" />
            <C k="disputes lost" v={buyer.disputesLost} tone="text-red" />
          </div>
        </div>
      )}
      {!showSeller && !showBuyer && !isArbiter && <div className="mt-2 font-mono text-xs text-ink-3">no on-chain activity yet</div>}
    </div>
  )
}

function C({ k, v, tone = 'text-ink' }: { k: string; v: number; tone?: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[0.62rem] uppercase tracking-wider text-ink-3">{k}</div>
      <div className={tone}>{v}</div>
    </div>
  )
}
