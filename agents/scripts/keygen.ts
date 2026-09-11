// pnpm keygen - writes .env with five fresh TESTNET-ONLY keys and prints the deployer address to fund.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import pc from 'picocolors'
import { REPO_DIR } from '../src/data.js'
import { ROLES } from '../src/wallets.js'

const envPath = resolve(REPO_DIR, '.env')
const examplePath = resolve(REPO_DIR, '.env.example')

if (existsSync(envPath)) {
  console.error(pc.red(`Refusing to overwrite ${envPath}.`))
  console.error('It already holds keys (and maybe funded wallets). Move it away yourself if you really want new ones.')
  process.exit(1)
}

let text = readFileSync(examplePath, 'utf8')
const set = (name: string, value: string) => {
  const re = new RegExp(`^${name}=.*$`, 'm')
  if (!re.test(text)) throw new Error(`.env.example has no ${name}= line`)
  text = text.replace(re, `${name}=${value}`)
}

const keys = Object.fromEntries(ROLES.map((r) => [r, generatePrivateKey()])) as Record<(typeof ROLES)[number], `0x${string}`>
for (const role of ROLES) set(`${role}_PRIVATE_KEY`, keys[role])
const deployer = privateKeyToAccount(keys.DEPLOYER)
const arbiter = privateKeyToAccount(keys.ARBITER)
set('DEPLOYER_ADDRESS', deployer.address)
set('ARBITER_ADDRESS', arbiter.address)
set('ARBITER_PUBKEY', arbiter.publicKey) // 65-byte uncompressed 0x04…: the contract's constructor arg

writeFileSync(envPath, text, { mode: 0o600 })

const width = 76
const row = (text = '') => `║ ${text.padEnd(width)} ║`
const box = [
  `╔${'═'.repeat(width + 2)}╗`,
  row('DEPLOYER address - fund THIS one with Arbitrum Sepolia ETH (≥ 0.02 ETH):'),
  row(),
  row(`    ${deployer.address}`),
  `╚${'═'.repeat(width + 2)}╝`,
].join('\n')
console.log(`
Wrote ${envPath} with 5 testnet burner keys (deployer, scout treasury, 2 buyers, arbiter).
It is gitignored. Never paste any private key anywhere except this file.

${box}

Faucets (paste the address; one success is enough - the whole project costs < 0.02 ETH):
  1. QuickNode  https://faucet.quicknode.com/arbitrum/sepolia   (no account, 12 h cooldown)
  2. Chainlink  https://faucets.chain.link/arbitrum-sepolia     (wallet connect + captcha)
  3. ETHGlobal  https://ethglobal.com/faucet/arbitrum-sepolia-421614   (free account, 0.05/day)
  4. thirdweb   https://thirdweb.com/arbitrum-sepolia           (login, 0.01/day)
  5. Fallback   https://cloud.google.com/application/web3/faucet/ethereum/sepolia then bridge at https://portal.arbitrum.io/bridge/

Other roles: scout treasury ${privateKeyToAccount(keys.SELLER).address}
             Brineholt Labs ${privateKeyToAccount(keys.BUYER_LAB).address}
             Sounding Compute ${privateKeyToAccount(keys.BUYER_BROKER).address}
             arbiter        ${arbiter.address}  (pubkey ${arbiter.publicKey.slice(0, 12)}…, goes into the contract)

Next: check with \`pnpm balance\`; when the deployer shows ≥ 0.02 ETH run \`pnpm test:contracts\` then \`pnpm deploy:contract\`.
`)
