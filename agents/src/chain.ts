// One public client (reads) + one wallet client per agent key (writes). Chain object stays
// arbitrumSepolia even for local tests: anvil is started with --chain-id 421614.
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount, nonceManager } from 'viem/accounts'
import { arbitrumSepolia } from 'viem/chains'
import { env } from './env.js'

export const RPC_URL = env.ARBITRUM_SEPOLIA_RPC_URL ?? 'https://sepolia-rollup.arbitrum.io/rpc'
/** True when talking to a local anvil - explorer links are meaningless and multicall3 does not exist. */
export const IS_LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|0\.0\.0\.0)(:|\/|$)/.test(RPC_URL)
export const chain = arbitrumSepolia

// The public RPC rate-limits: retry 429s a few times instead of dying. Arbitrum blocks every ~250 ms,
// so a 1 s receipt poll is plenty.
const transport = () => http(RPC_URL, { retryCount: 5, retryDelay: 500 })
export const publicClient = createPublicClient({ chain, transport: transport(), pollingInterval: 1000 })

export type Wallet = ReturnType<typeof walletFor>

export function walletFor(privateKey: Hex) {
  // nonceManager: viem tracks the pending nonce per key so back-to-back sends never collide.
  const account = privateKeyToAccount(privateKey, { nonceManager })
  const client = createWalletClient({ account, chain, transport: transport(), pollingInterval: 1000 })
  return { account, client }
}

export const EXPLORER = 'https://sepolia.arbiscan.io'
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`
export const explorerAddr = (addr: string) => `${EXPLORER}/address/${addr}`
