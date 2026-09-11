'use client'

import { explorerAddr, RPC_URL, RPC_HOST, isLocalRpc } from '@/lib/chain'
import { address, arbiterModelId as genModelId, rubricHash as genRubricHash } from '@/lib/generated/contract'
import { fmtAgo, fmtEth, shortHex } from '@/lib/format'
import { CONTRACT_SRC_URL, HAS_REPO_URL, RUBRIC_URL } from '@/lib/links'
import { chainNow, marketStats, type MarketState } from '@/lib/market'
import { AddrLink, Stat } from './ui'

export default function Header({ m, nowMs }: { m: MarketState; nowMs: number }) {
  const p = m.params
  const stats = marketStats(m)
  const headAge = m.head && nowMs ? chainNow(m.head, nowMs) - Number(m.head.timestamp) : null
  const rubric = p?.rubricHash ?? genRubricHash
  const modelId = p?.arbiterModelId ?? genModelId

  return (
    <header className="pt-4">
      <div className="flex flex-col gap-6 border-b border-line pb-6 md:flex-row md:items-end md:justify-between">
        <div className="max-w-3xl">
          <h1 className="font-serif text-5xl leading-none tracking-tight text-ink sm:text-6xl">
            Undercloud
          </h1>
          <p className="mt-3 text-base leading-relaxed text-ink-2">
            A sealed market for pre-public GPU-capacity facts.
          </p>
        </div>
        <div className="shrink-0 font-mono text-xs text-ink-3">
          <div className="flex items-center gap-2">
            <span className={`live-dot inline-block h-2 w-2 rounded-full ${!m.deployed ? 'bg-ink-3' : m.rpcError ? 'bg-red' : m.loading ? 'bg-amber' : 'bg-green'}`} />
            {!m.deployed ? (
              <span>not deployed · nothing to poll</span>
            ) : m.rpcError ? (
              <span className="text-red" title={m.rpcError}>RPC error, retrying…</span>
            ) : m.loading ? (
              <span>syncing from block {m.head ? m.head.number.toString() : '…'}</span>
            ) : (
              <span>live · polling every 4 s</span>
            )}
          </div>
          <div className="mt-1">
            head {m.head ? `#${m.head.number.toString()}` : '-'}
            {headAge !== null && <span className="text-ink-3"> · {fmtAgo(headAge)}</span>}
          </div>
          <div className="mt-1 truncate" title={RPC_URL}>rpc {isLocalRpc ? 'local anvil' : RPC_HOST}</div>
        </div>
      </div>

      {/* Contract facts: everything a judge would want to verify, each one a link. */}
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-b border-line py-5 text-sm sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="contract">
          {m.deployed ? (
            <>
              <AddrLink addr={address} name={false} />
              {/* Makes no claim about verification status: that is a separate step (pnpm verify:contract). */}
              <a
                className="ml-2 rounded border border-green/40 px-1.5 py-0.5 font-mono text-[0.65rem] text-green"
                href={`${explorerAddr(address)}#code`}
                target="_blank"
                rel="noreferrer"
                title="Read the source on Arbiscan (shows 'Contract Source Code Verified' once pnpm verify:contract has run)"
              >
                arbiscan source ↗
              </a>
              <div className="mt-1 text-xs text-ink-3">
                <a className="hex" href={CONTRACT_SRC_URL} target="_blank" rel="noreferrer" title={HAS_REPO_URL ? CONTRACT_SRC_URL : 'repo URL not set yet (REPO_URL in .env + pnpm sync)'}>Undercloud.sol ↗</a> · no owner, no upgrade
              </div>
            </>
          ) : (
            <span className="font-mono text-ink-3">not deployed</span>
          )}
        </Fact>
        <Fact label="arbiter (judge)">
          {p ? <AddrLink addr={p.arbiter} /> : <span className="text-ink-3">-</span>}
          <div className="mt-1 font-mono text-xs text-ink-2">model {modelId}</div>
          <div className="text-xs text-ink-3">address, model id and rubric are immutable</div>
        </Fact>
        <Fact label="rubric hash">
          <a className="hex" href={RUBRIC_URL} target="_blank" rel="noreferrer" title={`keccak256(contracts/rubric.md) = ${rubric}`}>
            {shortHex(rubric, 10, 6)} ↗
          </a>
          <div className="mt-1 text-xs text-ink-3">keccak256 of contracts/rubric.md</div>
        </Fact>
      </dl>

      {/* Stats strip */}
      <div className="mb-6 grid grid-cols-2 divide-x divide-line border-b border-line sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="listings" value={m.deployed ? stats.listings : '-'} />
        <Stat label="ETH in escrow" value={m.deployed ? fmtEth(stats.escrow, { unit: false }) : '-'} hint="Prices held for deals in Paid / Delivered / quality-Disputed" />
        <Stat label="bonds locked" value={m.deployed ? fmtEth(stats.bonds, { unit: false }) : '-'} hint="Seller bonds not yet withdrawn + buyer dispute bonds" />
        <Stat label="disputes" value={m.deployed ? stats.disputes : '-'} />
        <Stat label="burned" value={m.deployed ? fmtEth(stats.burned, { unit: false }) : '-'} hint="2% release fees + slashed bonds sent to 0x…dEaD" />
        <Stat label="events" value={m.deployed ? m.events.length : '-'} />
      </div>
    </header>
  )
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="eyebrow">{label}</dt>
      <dd className="mt-1 min-w-0 break-words">{children}</dd>
    </div>
  )
}
