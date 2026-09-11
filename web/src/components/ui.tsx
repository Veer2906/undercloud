'use client'

import type { ReactNode } from 'react'
import { explorerAddr, explorerTx } from '@/lib/chain'
import { agentOf, CATEGORY_HELP, categoryName, shortHex, STATUS_HELP, statusName, VERIFIABILITY_HELP, VERIFIABILITY_TITLE, type VerifiabilityClass } from '@/lib/format'

// Small shared presentational pieces used by every dashboard component.

export function Card({ title, eyebrow, children, className = '', aside }: { title?: string; eyebrow?: string; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={`rounded-lg border border-line bg-card ${className}`}>
      {(title || eyebrow) && (
        <header className="flex items-baseline justify-between gap-3 border-b border-line px-4 py-3">
          <div>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && <h2 className="font-serif text-xl leading-tight text-ink">{title}</h2>}
          </div>
          {aside}
        </header>
      )}
      {children}
    </section>
  )
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="hex text-xs" href={explorerTx(hash)} target="_blank" rel="noreferrer" title={hash}>
      {label ?? shortHex(hash, 6, 4)} ↗
    </a>
  )
}

export function AddrLink({ addr, full = false, name = true }: { addr: string; full?: boolean; name?: boolean }) {
  const a = agentOf(addr)
  const text = name && a.known ? a.name : full ? addr : shortHex(addr)
  return (
    <a className="hex text-xs" href={explorerAddr(addr)} target="_blank" rel="noreferrer" title={`${addr}${a.known ? ` (${a.role})` : ''}`}>
      {text} ↗
    </a>
  )
}

const STATUS_STYLE: Record<string, string> = {
  Listed: 'border-blue/40 text-blue',
  Paid: 'border-violet/40 text-violet',
  Delivered: 'border-cyan/40 text-cyan',
  Released: 'border-green/40 text-green',
  Disputed: 'border-amber/50 text-amber',
  RuledBuyer: 'border-red/50 text-red',
  RuledSeller: 'border-green/40 text-green',
  Unadjudicated: 'border-line-2 text-ink-2',
  Refunded: 'border-orange/50 text-orange',
  Delisted: 'border-line-2 text-ink-3',
}

export function StatusPill({ status }: { status: number }) {
  const name = statusName(status)
  return (
    <span
      title={STATUS_HELP[name]}
      className={`inline-flex items-center gap-1.5 rounded-full border bg-paper-2 px-2 py-0.5 font-mono text-[0.68rem] tracking-wide ${STATUS_STYLE[name] ?? 'border-line-2 text-ink-2'}`}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      {name}
    </span>
  )
}

const CAT_STYLE: Record<string, string> = {
  CapacityRelease: 'bg-orange/10 text-orange',
  NewSupply: 'bg-violet/10 text-violet',
  PriceMove: 'bg-green/10 text-green',
  DemandSignal: 'bg-cyan/10 text-cyan',
  ProviderReference: 'bg-blue/10 text-blue',
}

export function CategoryChip({ category }: { category: number }) {
  const name = categoryName(category)
  return (
    <span title={CATEGORY_HELP[name as keyof typeof CATEGORY_HELP]} className={`rounded px-1.5 py-0.5 font-mono text-[0.68rem] ${CAT_STYLE[name] ?? 'bg-line text-ink-2'}`}>
      {name}
    </span>
  )
}

// A / B / C: how soon (if ever) the claim can be checked against a board, a page or press. C is the
// class the buyer can never refute from outside - the bond lock is the whole warranty.
const CLASS_STYLE: Record<VerifiabilityClass, string> = {
  A: 'border-green/40 text-green',
  B: 'border-amber/50 text-amber',
  C: 'border-red/40 text-red',
}

export function VerifiabilityChip({ cls }: { cls: VerifiabilityClass | undefined }) {
  if (!cls) return null
  return (
    <span
      title={`${VERIFIABILITY_HELP[cls]}. ${VERIFIABILITY_TITLE}`}
      className={`inline-flex h-4 w-4 items-center justify-center rounded-full border bg-paper-2 font-mono text-[0.62rem] ${CLASS_STYLE[cls]}`}
    >
      {cls}
    </span>
  )
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono ${className}`}>{children}</span>
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 px-4 py-3" title={hint}>
      <div className="eyebrow">{label}</div>
      <div className="mt-1 truncate font-mono text-base text-ink">{value}</div>
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-sm text-ink-3">{children}</div>
}
