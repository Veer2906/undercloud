import { createPublicClient, http } from 'viem'
import { arbitrumSepolia } from 'viem/chains'

// The dashboard is read-only: one public client, no wallet, no signing.
// NEXT_PUBLIC_RPC_URL lets a local Anvil (http://127.0.0.1:8548) stand in for the testnet
// during development; the chain id stays 421614 in both cases.
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ??
  process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ??
  'https://sepolia-rollup.arbitrum.io/rpc'

export const chain = arbitrumSepolia

/** Host part of the RPC URL for display; a malformed NEXT_PUBLIC_RPC_URL must not throw during render. */
export const RPC_HOST = (() => {
  try { return new URL(RPC_URL).host } catch { return RPC_URL }
})()

// `batch: true` folds the many small reads the market hook makes (one getListing per id,
// one sellerRep per address, one getBlock per touched block) into single JSON-RPC batches.
export const publicClient = createPublicClient({
  chain,
  transport: http(RPC_URL, { batch: true, retryCount: 4, retryDelay: 400 }),
})

/** True when the RPC is a local dev chain - Multicall3 is not deployed there, so we read per id. */
export const isLocalRpc = /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(RPC_URL)

export const EXPLORER = 'https://sepolia.arbiscan.io'
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`
export const explorerAddr = (addr: string) => `${EXPLORER}/address/${addr}`
