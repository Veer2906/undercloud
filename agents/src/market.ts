// Chain state for the agents (spec §5.3). Agents act on what the CHAIN says, never on memory, so a
// restarted process picks up exactly where the contract is. One loadState() per tick feeds all four agents.
import type { Address, Hex, ReadContractReturnType } from 'viem'
import { publicClient, IS_LOCAL } from './chain.js'
import { abi, address, deployBlock, chainId } from './contract.js'
import { env } from './env.js'

export const STATUS = ['Listed', 'Paid', 'Delivered', 'Released', 'Disputed', 'RuledBuyer', 'RuledSeller', 'Unadjudicated', 'Refunded', 'Delisted'] as const
export type StatusName = (typeof STATUS)[number]
export const statusName = (i: number): StatusName => STATUS[i] ?? (`Status${i}` as StatusName)
export const statusIndex = (s: StatusName): number => STATUS.indexOf(s)

export type Listing = ReadContractReturnType<typeof abi, 'getListing'> & { id: bigint }
export type SellerRep = { listed: number; sold: number; settled: number; confirmed: number; refuted: number; disputesWon: number; unadjudicated: number; ghosted: number; volume: bigint }
export type BuyerRep = { bought: number; disputesFiled: number; disputesLost: number }
export const EMPTY_SELLER_REP: SellerRep = { listed: 0, sold: 0, settled: 0, confirmed: 0, refuted: 0, disputesWon: 0, unadjudicated: 0, ghosted: 0, volume: 0n }
export const EMPTY_BUYER_REP: BuyerRep = { bought: 0, disputesFiled: 0, disputesLost: 0 }

/** Constructor immutables + arbiter identity, read once. Agents never hardcode 90/180/600. */
export type Params = {
  qualityWindow: bigint; deliverTimeout: bigint; arbiterTimeout: bigint
  arbiter: Address; arbiterPubKey: Hex; rubricHash: Hex; arbiterModelId: string
}

const CHUNK = 40_000n // max blocks per eth_getLogs call on the public RPC
/** Deadline margin: agents wait this many seconds past a deadline before acting so a slightly lagging
 *  chain clock never makes release/refund/withdraw revert on camera. */
export const MARGIN = BigInt(env.DEADLINE_MARGIN ?? '10')

async function fetchEvents(fromBlock: bigint, toBlock: bigint) {
  return publicClient.getContractEvents({ address, abi, fromBlock, toBlock, strict: true })
}
export type MarketEvent = Awaited<ReturnType<typeof fetchEvents>>[number]
export type EventName = MarketEvent['eventName']
export type EventOf<N extends EventName> = Extract<MarketEvent, { eventName: N }>

export type MarketState = {
  listings: Listing[]
  events: MarketEvent[]
  now: bigint // latest block timestamp (or wall clock if ahead): what the NEXT block will see
  head: bigint
  sellerRep: Map<Address, SellerRep>
  buyerRep: Map<Address, BuyerRep>
  params: Params
  eventsFor: (id: bigint) => MarketEvent[]
  find: <N extends EventName>(id: bigint, name: N) => EventOf<N> | undefined
}

// Incremental cursor: after the first backfill only new blocks are scanned.
let cursor: bigint | null = null
const seen = new Set<string>()
const events: MarketEvent[] = []
let params: Params | null = null

const useMulticall = () => !IS_LOCAL && !env.UNDERCLOUD_NO_MULTICALL && publicClient.chain.id === chainId

export async function loadParams(): Promise<Params> {
  if (params) return params
  const read = <N extends 'qualityWindow' | 'deliverTimeout' | 'arbiterTimeout' | 'arbiter' | 'arbiterPubKey' | 'rubricHash' | 'arbiterModelId'>(functionName: N) =>
    publicClient.readContract({ address, abi, functionName }) as Promise<ReadContractReturnType<typeof abi, N>>
  params = {
    qualityWindow: BigInt(await read('qualityWindow')),
    deliverTimeout: BigInt(await read('deliverTimeout')),
    arbiterTimeout: BigInt(await read('arbiterTimeout')),
    arbiter: await read('arbiter'),
    arbiterPubKey: await read('arbiterPubKey'),
    rubricHash: await read('rubricHash'),
    arbiterModelId: await read('arbiterModelId'),
  }
  return params
}

export async function loadState(): Promise<MarketState> {
  const p = await loadParams()
  const block = await publicClient.getBlock({ blockTag: 'latest' })
  const head = block.number

  // 1. Events: backfill from the deploy block in ≤ 40,000-block chunks, then only new blocks.
  let from = cursor === null ? deployBlock : cursor + 1n
  while (from <= head) {
    const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head
    for (const log of await fetchEvents(from, to)) {
      const key = `${log.transactionHash}-${log.logIndex}`
      if (seen.has(key)) continue
      seen.add(key)
      events.push(log)
    }
    from = to + 1n
  }
  cursor = head

  // 2. Every listing struct (multicall3 on the real chain; per-id reads on anvil, which has no multicall3).
  const count = await publicClient.readContract({ address, abi, functionName: 'listingCount' })
  const ids = Array.from({ length: Number(count) }, (_, i) => BigInt(i))
  let structs: ReadContractReturnType<typeof abi, 'getListing'>[]
  if (ids.length === 0) structs = []
  else if (useMulticall()) {
    structs = (await publicClient.multicall({
      contracts: ids.map((id) => ({ address, abi, functionName: 'getListing' as const, args: [id] as const })),
      allowFailure: false,
    })) as ReadContractReturnType<typeof abi, 'getListing'>[]
  } else {
    structs = []
    for (const id of ids) structs.push(await publicClient.readContract({ address, abi, functionName: 'getListing', args: [id] }))
  }
  const listings: Listing[] = structs.map((s, i) => ({ ...s, id: BigInt(i) }))

  // 3. Reputation counters for every address that appears as a seller or buyer.
  const ZERO = '0x0000000000000000000000000000000000000000'
  const sellers = [...new Set(listings.map((l) => l.seller))]
  const buyers = [...new Set(listings.map((l) => l.buyer).filter((b) => b !== ZERO))]
  const sellerRep = new Map<Address, SellerRep>()
  const buyerRep = new Map<Address, BuyerRep>()
  for (const s of sellers) {
    const r = await publicClient.readContract({ address, abi, functionName: 'sellerRep', args: [s] })
    sellerRep.set(s, { listed: r[0], sold: r[1], settled: r[2], confirmed: r[3], refuted: r[4], disputesWon: r[5], unadjudicated: r[6], ghosted: r[7], volume: r[8] })
  }
  for (const b of buyers) {
    const r = await publicClient.readContract({ address, abi, functionName: 'buyerRep', args: [b] })
    buyerRep.set(b, { bought: r[0], disputesFiled: r[1], disputesLost: r[2] })
  }

  // 4. "now": the next block's timestamp is ≈ wall clock; the latest block can lag when the chain is quiet.
  const wall = BigInt(Math.floor(Date.now() / 1000))
  const now = block.timestamp > wall ? block.timestamp : wall

  const byId = new Map<bigint, MarketEvent[]>()
  for (const e of events) {
    const id = (e.args as { id?: bigint }).id
    if (id === undefined) continue
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id)!.push(e)
  }
  return {
    listings,
    events: [...events],
    now,
    head,
    sellerRep,
    buyerRep,
    params: p,
    eventsFor: (id) => byId.get(id) ?? [],
    find: (id, name) => byId.get(id)?.find((e) => e.eventName === name) as any,
  }
}

/** Reads one address's counters even if it has no listings yet (banner / scoreboard). */
export async function readReps(seller: Address, buyer: Address) {
  const s = await publicClient.readContract({ address, abi, functionName: 'sellerRep', args: [seller] })
  const b = await publicClient.readContract({ address, abi, functionName: 'buyerRep', args: [buyer] })
  return {
    seller: { listed: s[0], sold: s[1], settled: s[2], confirmed: s[3], refuted: s[4], disputesWon: s[5], unadjudicated: s[6], ghosted: s[7], volume: s[8] } as SellerRep,
    buyer: { bought: b[0], disputesFiled: b[1], disputesLost: b[2] } as BuyerRep,
  }
}
