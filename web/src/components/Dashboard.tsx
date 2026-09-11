'use client'

import { useEffect, useState } from 'react'
import { useMarket } from '@/lib/market'
import { address } from '@/lib/generated/contract'
import { RPC_URL } from '@/lib/chain'
import Header from './Header'
import MarketTable from './MarketTable'
import AgentsPanel from './AgentsPanel'
import LiveFeed from './LiveFeed'
import { Card } from './ui'

// The one client island. Everything below reads from a single useMarket() so all panels agree.
export default function Dashboard() {
  const m = useMarket()
  // Wall clock ticking once a second drives every countdown; starts at 0 so SSR and hydration match
  // (the first real value arrives on the first tick, before any chain data is on screen anyway).
  const [nowMs, setNowMs] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <div className="mx-auto w-full max-w-7xl px-4 sm:px-6">
      <Header m={m} nowMs={nowMs} />
      {!m.deployed ? (
        <NotDeployed />
      ) : (
        // The feed sits beside the market only on very wide screens; below that it stacks between the
        // table and the agents panel so the listings table always gets the full width (no side-scroll
        // in a half-screen recording layout or on a laptop).
        <div className="grid gap-4 pb-8 2xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="min-w-0 space-y-4">
            <MarketTable m={m} nowMs={nowMs} />
            <div className="2xl:hidden"><LiveFeed m={m} nowMs={nowMs} compact /></div>
            <AgentsPanel m={m} />
          </div>
          <div className="hidden 2xl:block"><LiveFeed m={m} nowMs={nowMs} /></div>
        </div>
      )}
    </div>
  )
}

function NotDeployed() {
  return (
    <Card className="mb-8" eyebrow="status" title="Contract not deployed yet">
      <div className="space-y-3 px-4 py-4 text-sm text-ink-2">
        <p>
          The dashboard reads everything from the Undercloud contract on Arbitrum Sepolia, and the generated address is still the
          zero placeholder (<span className="font-mono text-ink-3">{address}</span>). Nothing to show until it exists.
        </p>
        <p>
          To fix: from the repo root run <span className="font-mono text-ink">pnpm deploy:contract</span>, then{' '}
          <span className="font-mono text-ink">pnpm sync</span> (writes <span className="font-mono">web/src/lib/generated/contract.ts</span>),
          then rebuild the site. For local testing you can instead set{' '}
          <span className="font-mono text-ink">NEXT_PUBLIC_UNDERCLOUD_ADDRESS</span>, <span className="font-mono text-ink">NEXT_PUBLIC_DEPLOY_BLOCK</span> and{' '}
          <span className="font-mono text-ink">NEXT_PUBLIC_RPC_URL</span> before <span className="font-mono text-ink">pnpm dev</span>.
        </p>
        <p className="text-xs text-ink-3">RPC in use: <span className="font-mono">{RPC_URL}</span>.</p>
      </div>
    </Card>
  )
}
