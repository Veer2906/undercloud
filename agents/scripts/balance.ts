// pnpm balance - one table with every role's address and ETH balance.
import { formatEther } from 'viem'
import pc from 'picocolors'
import { publicClient, RPC_URL, explorerAddr, IS_LOCAL } from '../src/chain.js'
import { ROLES, ROLE_LABEL, addressFor } from '../src/wallets.js'

console.log(`RPC ${RPC_URL}`)
const rows = []
let deployer = 0n
for (const role of ROLES) {
  const address = addressFor(role)
  const wei = await publicClient.getBalance({ address })
  if (role === 'DEPLOYER') deployer = wei
  rows.push({ role: ROLE_LABEL[role], address, ETH: Number(formatEther(wei)).toFixed(6), link: IS_LOCAL ? '(local)' : explorerAddr(address) })
}
console.table(rows)
if (deployer < 20_000_000_000_000_000n) {
  console.log(pc.yellow(`Deployer has ${formatEther(deployer)} ETH; it needs ≥ 0.02 ETH before \`pnpm deploy:contract\` + \`pnpm fund\`. Use the faucets printed by \`pnpm keygen\`.`))
} else {
  console.log(pc.green('Deployer is funded. Next: `pnpm deploy:contract` (once), then `pnpm sync`, `pnpm fund`, `pnpm demo`.'))
}
