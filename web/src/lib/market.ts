'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GetContractEventsReturnType } from 'viem'
import { isLocalRpc, publicClient } from './chain'
import { address, undercloudAbi, chainId, deployBlock } from './generated/contract'

// ---------------------------------------------------------------------------------------------
// useMarket(): the dashboard's only data source. It reconstructs the whole market from the chain:
//   1. on mount, scan every contract event from deployBlock to head - one address-filtered
//      eth_getLogs for the whole range first (the official RPC has no block-range cap, only a
//      10,000-matched-logs cap), falling back to 40,000-block chunks (4 in flight) if the provider
//      rejects the range; progress is committed per chunk so a 429 resumes instead of restarting.
//      The listing structs, reputation counters and immutable params are read IN PARALLEL with that
//      first scan so the table fills before the event backfill finishes;
//   2. every 4 s, scan the new blocks (with a small overlap, in case a lagging load-balanced node
//      answered the previous scan) and refresh the structs when something happened.
// State is keyed by `${txHash}-${logIndex}` so re-scanning a range can never duplicate an event.
// All wei/timestamps stay `bigint` in memory - they are never JSON.stringified.
// ---------------------------------------------------------------------------------------------

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const isDeployed = address.toLowerCase() !== ZERO_ADDRESS
const CHUNK = 40_000n
const PARALLEL_CHUNKS = 4
// Re-scan this many blocks (≈ 4 s of L2 blocks) behind the last cursor: a load-balanced node that is a
// block or two behind returns fewer logs without an error; the key-based dedup makes the overlap free.
const OVERLAP = 16n
const POLL_MS = 4_000
// Full re-read of listings/reps every N ticks even without new events (self-heals a missed log).
const FULL_REFRESH_EVERY = 15

type RawLog = GetContractEventsReturnType<typeof undercloudAbi, undefined, true>[number]

/** One decoded contract event plus its block time. `eventName` narrows `args` (viem strict mode). */
export type MarketEvent = RawLog & { key: string; timestamp: number; listingId: bigint }

export type Listing = {
  id: bigint
  seller: `0x${string}`
  buyer: `0x${string}`
  price: bigint
  bond: bigint
  disputeBond: bigint
  contentHash: `0x${string}`
  category: number
  status: number
  reason: number
  afterRelease: boolean
  confirmed: boolean
  bondWithdrawn: boolean
  listedAt: bigint
  expiresAt: bigint
  resolveBy: bigint
  paidAt: bigint
  deliveredAt: bigint
  disputedAt: bigint
}

export type SellerRep = {
  listed: number; sold: number; settled: number; confirmed: number; refuted: number
  disputesWon: number; unadjudicated: number; ghosted: number; volume: bigint
}
export type BuyerRep = { bought: number; disputesFiled: number; disputesLost: number }

export type Params = {
  arbiter: `0x${string}`
  arbiterPubKey: `0x${string}`
  arbiterModelId: string
  rubricHash: `0x${string}`
  qualityWindow: bigint
  deliverTimeout: bigint
  arbiterTimeout: bigint
}

export type Head = { number: bigint; timestamp: bigint; fetchedAtMs: number }

export type MarketState = {
  /** false while the generated address is still the zero placeholder */
  deployed: boolean
  loading: boolean
  /** last RPC failure message; the hook keeps polling and clears it on the next success */
  rpcError: string | null
  lastSyncMs: number | null
  head: Head | null
  params: Params | null
  listings: Listing[]
  events: MarketEvent[]
  sellerReps: Record<string, SellerRep>
  buyerReps: Record<string, BuyerRep>
}

const contract = { address, abi: undercloudAbi } as const
const useMulticall = chainId === 421614 && !isLocalRpc

function lower(a: string) {
  return a.toLowerCase()
}

const getLogs = (fromBlock: bigint, toBlock: bigint) =>
  publicClient.getContractEvents({ ...contract, fromBlock, toBlock, strict: true })

/** Scan [from, to]; `onChunk` is awaited for every contiguous range that succeeded, in order, so the
 *  caller can store the logs and advance its cursor before the next range is requested. */
async function scanLogs(from: bigint, to: bigint, onChunk: (logs: RawLog[], scannedTo: bigint) => Promise<void>): Promise<void> {
  if (to - from + 1n > CHUNK) {
    // One shot for the whole range: works on the official endpoint unless > 10k logs matched.
    try {
      const logs = await getLogs(from, to)
      await onChunk(logs, to)
      return
    } catch {
      /* provider rejected the range (PublicNode/dRPC-style caps or too many results): chunk it */
    }
  }
  const starts: bigint[] = []
  for (let start = from; start <= to; start += CHUNK) starts.push(start)
  for (let i = 0; i < starts.length; i += PARALLEL_CHUNKS) {
    const group = starts.slice(i, i + PARALLEL_CHUNKS)
    const endOf = (start: bigint) => (start + CHUNK - 1n < to ? start + CHUNK - 1n : to)
    // The batched transport folds these into one JSON-RPC batch; a failure here resumes at `group[0]`.
    const results = await Promise.all(group.map((start) => getLogs(start, endOf(start))))
    await onChunk(results.flat(), endOf(group[group.length - 1]))
  }
}

/** Read many contract views; Multicall3 on the real testnet, plain batched calls on a local chain. */
async function readMany<T>(calls: { functionName: string; args?: readonly unknown[] }[]): Promise<T[]> {
  if (calls.length === 0) return []
  if (useMulticall) {
    const res = await publicClient.multicall({
      allowFailure: false,
      // viem's multicall typing is per-call; we cast once here and re-type on the way out.
      contracts: calls.map((c) => ({ ...contract, functionName: c.functionName, args: c.args })) as never,
    })
    return res as unknown as T[]
  }
  return Promise.all(
    calls.map((c) =>
      publicClient.readContract({ ...contract, functionName: c.functionName, args: c.args } as never) as Promise<T>,
    ),
  )
}

type ListingTuple = readonly [
  `0x${string}`, `0x${string}`, bigint, bigint, bigint, `0x${string}`, number, number, number,
  boolean, boolean, boolean, bigint, bigint, bigint, bigint, bigint, bigint,
] | {
  seller: `0x${string}`; buyer: `0x${string}`; price: bigint; bond: bigint; disputeBond: bigint
  contentHash: `0x${string}`; category: number; status: number; reason: number; afterRelease: boolean
  confirmed: boolean; bondWithdrawn: boolean; listedAt: bigint; expiresAt: bigint; resolveBy: bigint
  paidAt: bigint; deliveredAt: bigint; disputedAt: bigint
}

function toListing(id: bigint, t: ListingTuple): Listing {
  // getListing returns a struct; viem decodes named structs as objects. Tuples handled defensively.
  const o = Array.isArray(t)
    ? {
        seller: t[0], buyer: t[1], price: t[2], bond: t[3], disputeBond: t[4], contentHash: t[5],
        category: t[6], status: t[7], reason: t[8], afterRelease: t[9], confirmed: t[10], bondWithdrawn: t[11],
        listedAt: t[12], expiresAt: t[13], resolveBy: t[14], paidAt: t[15], deliveredAt: t[16], disputedAt: t[17],
      }
    : (t as Exclude<ListingTuple, readonly unknown[]>)
  return { id, ...o }
}

function toSellerRep(t: readonly [number, number, number, number, number, number, number, number, bigint]): SellerRep {
  return { listed: t[0], sold: t[1], settled: t[2], confirmed: t[3], refuted: t[4], disputesWon: t[5], unadjudicated: t[6], ghosted: t[7], volume: t[8] }
}
function toBuyerRep(t: readonly [number, number, number]): BuyerRep {
  return { bought: t[0], disputesFiled: t[1], disputesLost: t[2] }
}

export function useMarket(): MarketState {
  const [state, setState] = useState<MarketState>({
    deployed: isDeployed,
    loading: isDeployed,
    rpcError: null,
    lastSyncMs: null,
    head: null,
    params: null,
    listings: [],
    events: [],
    sellerReps: {},
    buyerReps: {},
  })

  // Mutable sync bookkeeping lives in refs so the polling closure never goes stale.
  const eventsRef = useRef<Map<string, MarketEvent>>(new Map())
  const blockTimeRef = useRef<Map<bigint, number>>(new Map())
  const scannedToRef = useRef<bigint | null>(null)
  const tickRef = useRef(0)
  const busyRef = useRef(false)
  // Set only after a successful setState, so a cancelled/failed first pass (React StrictMode
  // double-mounts effects in dev; an RPC hiccup does the same in prod) is retried on the next tick.
  const paramsLoadedRef = useRef(false)
  const structsLoadedRef = useRef(false)

  const blockTimestamps = useCallback(async (numbers: Iterable<bigint>) => {
    const missing = [...new Set(numbers)].filter((n) => !blockTimeRef.current.has(n))
    const blocks = await Promise.all(missing.map((n) => publicClient.getBlock({ blockNumber: n })))
    blocks.forEach((b) => blockTimeRef.current.set(b.number, Number(b.timestamp)))
  }, [])

  const readStructs = useCallback(async (sellers: Set<string>, buyers: Set<string>) => {
    const count = (await publicClient.readContract({ ...contract, functionName: 'listingCount' })) as bigint
    const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i))
    const raw = await readMany<ListingTuple>(ids.map((id) => ({ functionName: 'getListing', args: [id] })))
    const listings = raw.map((t, i) => toListing(ids[i], t))
    // Every seller/buyer that appears in a struct gets its counters read too.
    listings.forEach((l) => {
      sellers.add(lower(l.seller))
      if (l.buyer.toLowerCase() !== ZERO_ADDRESS) buyers.add(lower(l.buyer))
    })
    const sellerList = [...sellers]
    const buyerList = [...buyers]
    const [sr, br] = await Promise.all([
      readMany<readonly [number, number, number, number, number, number, number, number, bigint]>(
        sellerList.map((a) => ({ functionName: 'sellerRep', args: [a] })),
      ),
      readMany<readonly [number, number, number]>(buyerList.map((a) => ({ functionName: 'buyerRep', args: [a] }))),
    ])
    const sellerReps: Record<string, SellerRep> = {}
    const buyerReps: Record<string, BuyerRep> = {}
    sellerList.forEach((a, i) => (sellerReps[a] = toSellerRep(sr[i])))
    buyerList.forEach((a, i) => (buyerReps[a] = toBuyerRep(br[i])))
    return { listings, sellerReps, buyerReps }
  }, [])

  const readParams = useCallback(async (): Promise<Params> => {
    const [arbiter, arbiterPubKey, arbiterModelId, rubricHash, qualityWindow, deliverTimeout, arbiterTimeout] =
      await Promise.all([
        publicClient.readContract({ ...contract, functionName: 'arbiter' }),
        publicClient.readContract({ ...contract, functionName: 'arbiterPubKey' }),
        publicClient.readContract({ ...contract, functionName: 'arbiterModelId' }),
        publicClient.readContract({ ...contract, functionName: 'rubricHash' }),
        publicClient.readContract({ ...contract, functionName: 'qualityWindow' }),
        publicClient.readContract({ ...contract, functionName: 'deliverTimeout' }),
        publicClient.readContract({ ...contract, functionName: 'arbiterTimeout' }),
      ])
    return { arbiter, arbiterPubKey, arbiterModelId, rubricHash, qualityWindow, deliverTimeout, arbiterTimeout }
  }, [])

  useEffect(() => {
    if (!isDeployed) return
    let cancelled = false

    const sortedEvents = () =>
      [...eventsRef.current.values()].sort((a, b) =>
        a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
      )

    const sync = async () => {
      if (busyRef.current) return
      busyRef.current = true
      try {
        const headBlock = await publicClient.getBlock({ blockTag: 'latest' })
        const head: Head = { number: headBlock.number, timestamp: headBlock.timestamp, fetchedAtMs: Date.now() }
        blockTimeRef.current.set(headBlock.number, Number(headBlock.timestamp))

        const first = scannedToRef.current === null
        const overlapped = first ? deployBlock : scannedToRef.current! - OVERLAP
        const from = first ? deployBlock : overlapped < deployBlock ? deployBlock : overlapped

        // First pass: the structs/params do not depend on the event scan, so read them concurrently and
        // publish them as soon as they land - the table fills while a long backfill is still running.
        let early: Promise<void> | null = null
        if (first && !structsLoadedRef.current) {
          early = Promise.all([paramsLoadedRef.current ? null : readParams(), readStructs(new Set(), new Set())])
            .then(([params, structs]) => {
              if (cancelled) return
              if (params) paramsLoadedRef.current = true
              structsLoadedRef.current = true
              setState((s) => ({
                ...s,
                head,
                params: params ?? s.params,
                listings: structs.listings,
                sellerReps: { ...s.sellerReps, ...structs.sellerReps },
                buyerReps: { ...s.buyerReps, ...structs.buyerReps },
              }))
            })
            .catch(() => { /* the main path below reads them again and reports the error */ })
        }

        const sellersSeen = new Set<string>()
        const buyersSeen = new Set<string>()
        let freshCount = 0
        // Store one scanned range: block times, key + store, then advance the cursor. Only committed
        // ranges move the cursor, so a failure part-way through a backfill resumes, never restarts.
        const onChunk = async (logs: RawLog[], scannedTo: bigint) => {
          // Only listing events (those with an `id`) are part of the market model. PaymentDeferred /
          // OwedWithdrawn (pull-payment ledger for a payee that rejected ETH) carry no listing id.
          const withId = logs.filter((l) => (l.args as { id?: bigint }).id !== undefined)
          await blockTimestamps(withId.map((l) => l.blockNumber))
          for (const l of withId) {
            const key = `${l.transactionHash}-${l.logIndex}`
            if (!eventsRef.current.has(key)) freshCount += 1
            eventsRef.current.set(key, {
              ...l,
              key,
              timestamp: blockTimeRef.current.get(l.blockNumber) ?? 0,
              listingId: (l.args as { id: bigint }).id,
            })
            if (l.eventName === 'Listed') sellersSeen.add(lower(l.args.seller))
            if (l.eventName === 'Purchased' || l.eventName === 'Disputed') buyersSeen.add(lower(l.args.buyer))
          }
          scannedToRef.current = scannedTo
          // Show backfill progress on a long first scan (the feed grows while the scan runs).
          if (first && !cancelled && withId.length > 0) setState((s) => ({ ...s, head, events: sortedEvents() }))
        }
        if (from <= head.number) await scanLogs(from, head.number, onChunk)
        scannedToRef.current = head.number
        tickRef.current += 1
        if (early) await early

        const needStructs = !structsLoadedRef.current || freshCount > 0 || tickRef.current % FULL_REFRESH_EVERY === 0
        const params = paramsLoadedRef.current ? null : await readParams()
        const structs = needStructs ? await readStructs(sellersSeen, buyersSeen) : null

        if (cancelled) return
        if (params) paramsLoadedRef.current = true
        if (structs) structsLoadedRef.current = true
        const events = sortedEvents()
        setState((s) => ({
          ...s,
          loading: false,
          rpcError: null,
          lastSyncMs: Date.now(),
          head,
          params: params ?? s.params,
          events,
          listings: structs ? structs.listings : s.listings,
          sellerReps: structs ? { ...s.sellerReps, ...structs.sellerReps } : s.sellerReps,
          buyerReps: structs ? { ...s.buyerReps, ...structs.buyerReps } : s.buyerReps,
        }))
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message.split('\n')[0].slice(0, 160) : String(err)
        setState((s) => ({ ...s, loading: false, rpcError: msg }))
      } finally {
        busyRef.current = false
      }
    }

    void sync()
    const timer = setInterval(() => void sync(), POLL_MS)
    // Browsers throttle or freeze timers in background tabs (Chrome: once a minute after 5 min hidden).
    // The cursor makes catching up cheap, so re-sync the moment the tab is visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void sync()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [blockTimestamps, readParams, readStructs])

  return state
}

// ---------- derived helpers (pure; used by several components) ----------

/** Chain time right now, extrapolated from the head block's timestamp (ticks locally between polls). */
export function chainNow(head: Head | null, nowMs: number): number {
  if (!head) return Math.floor(nowMs / 1000)
  return Number(head.timestamp) + Math.max(0, Math.floor((nowMs - head.fetchedAtMs) / 1000))
}

/** Is the price still held by the contract for this listing? (Invariant I1 in the spec.) */
export function priceInEscrow(l: Listing): boolean {
  // Status: 1 Paid, 2 Delivered, 4 Disputed
  return l.status === 1 || l.status === 2 || (l.status === 4 && !l.afterRelease)
}

/** The next deadline that matters for a listing, with the label to show while counting down. */
export function nextDeadline(l: Listing, p: Params | null): { at: number; label: string; after: string } | null {
  if (!p) return null
  switch (l.status) {
    case 0: return { at: Number(l.expiresAt), label: 'expires in', after: 'expired, no purchases' }
    case 1: return { at: Number(l.paidAt + p.deliverTimeout), label: 'deliver due in', after: 'refundable (seller ghosted)' }
    case 2: return { at: Number(l.deliveredAt + p.qualityWindow), label: 'window closes in', after: 'releasable' }
    case 4: return { at: Number(l.disputedAt + p.arbiterTimeout), label: 'ruling due in', after: 'timeout → unadjudicated' }
    case 3:
    case 6:
      if (l.bondWithdrawn) return null
      return { at: Number(l.resolveBy), label: 'bond unlocks in', after: 'bond withdrawable' }
    default: return null
  }
}

export function marketStats(s: MarketState) {
  let escrow = 0n
  let bonds = 0n
  let burned = 0n
  let disputes = 0
  for (const l of s.listings) {
    if (priceInEscrow(l)) escrow += l.price
    if (!l.bondWithdrawn) bonds += l.bond
    if (l.status === 4) bonds += l.disputeBond
  }
  for (const e of s.events) {
    if (e.eventName === 'Disputed') disputes += 1
    if (e.eventName === 'Released') burned += e.args.feeBurned
    if (e.eventName === 'Ruled') burned += e.args.burned
  }
  return { listings: s.listings.length, escrow, bonds, burned, disputes }
}
