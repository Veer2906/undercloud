// pnpm fund - the deployer tops up the four agent wallets (serial sends; skips anything ≥ 80% funded).
// Amounts: the scout treasury needs 2x every demo price in bonds (0.006 ETH) plus gas, hence 0.008.
import { formatEther, parseEther } from 'viem'
import pc from 'picocolors'
import { publicClient, walletFor, explorerAddr, IS_LOCAL } from '../src/chain.js'
import { keyFor, addressFor, ROLE_LABEL, type Role } from '../src/wallets.js'
import { linkTx } from '../src/say.js'

const TARGETS: [Role, string][] = [['SELLER', '0.008'], ['BUYER_LAB', '0.003'], ['BUYER_BROKER', '0.002'], ['ARBITER', '0.001']]

const deployer = walletFor(keyFor('DEPLOYER'))
const start = await publicClient.getBalance({ address: deployer.account.address })
const total = TARGETS.reduce((a, [, eth]) => a + parseEther(eth), 0n)
console.log(`Deployer ${deployer.account.address} has ${formatEther(start)} ETH; targets total ${formatEther(total)} ETH.`)
if (start < total) console.log(pc.yellow('Deployer holds less than the full target set; funding what it can (skips are logged).'))

for (const [role, eth] of TARGETS) {
  const to = addressFor(role)
  const target = parseEther(eth)
  const have = await publicClient.getBalance({ address: to })
  if (have * 10n >= target * 8n) { console.log(`skip  ${ROLE_LABEL[role].padEnd(26)} ${to}  already has ${formatEther(have)} ETH (≥ 80% of ${eth})`); continue }
  const value = target - have
  if ((await publicClient.getBalance({ address: deployer.account.address })) < value + parseEther('0.0005')) {
    console.log(pc.red(`stop  deployer cannot cover ${formatEther(value)} ETH for ${ROLE_LABEL[role]} - top up the deployer via a faucet and re-run \`pnpm fund\`.`))
    break
  }
  console.log(`send  ${ROLE_LABEL[role].padEnd(26)} ${to}  +${formatEther(value)} ETH …`)
  const hash = await deployer.client.sendTransaction({ to, value })
  await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  console.log(`      confirmed ${linkTx(hash)}`)
}

const rows = []
for (const role of ['DEPLOYER', 'SELLER', 'BUYER_LAB', 'BUYER_BROKER', 'ARBITER'] as Role[]) {
  const address = addressFor(role)
  rows.push({ role: ROLE_LABEL[role], address, ETH: Number(formatEther(await publicClient.getBalance({ address }))).toFixed(6), link: IS_LOCAL ? '(local)' : explorerAddr(address) })
}
console.table(rows)
console.log('Next: `pnpm demo` (first with ANTHROPIC_API_KEY empty = deterministic mode, then with your key).')
