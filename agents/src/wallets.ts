// The five roles in .env and how the Scout identity is derived per run.
import { concat, keccak256, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { env } from './env.js'

export type Role = 'DEPLOYER' | 'SELLER' | 'BUYER_LAB' | 'BUYER_BROKER' | 'ARBITER'
export const ROLES: Role[] = ['DEPLOYER', 'SELLER', 'BUYER_LAB', 'BUYER_BROKER', 'ARBITER']
export const ROLE_LABEL: Record<Role, string> = {
  DEPLOYER: 'Deployer', SELLER: 'Scout treasury', BUYER_LAB: 'Brineholt Labs agent', BUYER_BROKER: 'Sounding Compute agent', ARBITER: 'Judge',
}

const isKey = (v: string | undefined): v is Hex => !!v && /^0x[0-9a-fA-F]{64}$/.test(v)

/** Private key for a role, or a clear error telling the operator to run `pnpm keygen`. */
export function keyFor(role: Role): Hex {
  const v = env[`${role}_PRIVATE_KEY`]
  if (!isKey(v)) throw new Error(`${role}_PRIVATE_KEY is missing or malformed in .env - run \`pnpm keygen\` first (never paste a real wallet key).`)
  return v
}
export const addressFor = (role: Role): Address => privateKeyToAccount(keyFor(role)).address

/** Reputation is per address and one refutation bans a seller from both buyers' theses forever.
 *  So each demo run gives the Scout a fresh identity, derived deterministically from the
 *  treasury key + run index (the treasury's own tx count: the demo sends one funding tx per run;
 *  `pnpm sweep` may add gas top-ups, which only makes the next run skip an index - every index up to
 *  the tx count is still swept). `pnpm sync` pre-labels the first ten on the dashboard as "Scout (run n)".
 *  Per-address reputation is not Sybil-proof - the README says so; this is what that looks like. */
export function scoutKeyFor(treasuryKey: Hex, runIndex: number): Hex {
  return keccak256(concat([treasuryKey, toHex(runIndex, { size: 32 })]))
}
export const scoutAddressFor = (treasuryKey: Hex, runIndex: number): Address => privateKeyToAccount(scoutKeyFor(treasuryKey, runIndex)).address
