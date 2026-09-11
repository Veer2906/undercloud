// pnpm sweep - the seller's housekeeping across every per-run Scout identity (see src/wallets.ts):
//   withdrawBond  for Released / RuledSeller listings whose resolveBy has passed (the bond was locked "until the outcome")
//   delist        for listings still Listed after they expired (nobody bought; the bond comes back)
//   return        any ETH left in the identity above a gas reserve to the Scout treasury
// Each identity is topped up with gas from the treasury only when it has something to do. Safe to run any
// time: idle identities print nothing, locked bonds print their unlock time, and a no-op prints "nothing to sweep".
import { parseEther, type Address } from 'viem'
import pc from 'picocolors'
import { env } from '../src/env.js'
import { publicClient, walletFor, RPC_URL, IS_LOCAL, explorerAddr, type Wallet } from '../src/chain.js'
import { address as contractAddress } from '../src/contract.js'
import { loadState, statusName, type Listing } from '../src/market.js'
import { sendTx, RevertError } from '../src/tx.js'
import { keyFor, scoutKeyFor } from '../src/wallets.js'
import { say, warn, kv, box, eth, clock, txLine, resetClock, short } from '../src/say.js'

resetClock()
process.on('unhandledRejection', (err) => { console.error((err as Error)?.stack ?? err); process.exit(1) })

const treasury = walletFor(keyFor('SELLER'))
const treasuryKey = keyFor('SELLER')
// The treasury's tx count is the demo's run counter (one funding tx per run); sweep top-ups move it too,
// which only means the next demo run skips an index. Always look at the first 20 identities as well.
const runIndex = env.SCOUT_RUN !== undefined ? Number(env.SCOUT_RUN) + 1 : await publicClient.getTransactionCount({ address: treasury.account.address })
const N = Math.max(20, runIndex)
const identities: { run: number; wallet: Wallet }[] = Array.from({ length: N }, (_, i) => ({ run: i + 1, wallet: walletFor(scoutKeyFor(treasuryKey, i)) }))

console.log()
box([`${pc.bold('UNDERCLOUD sweep')}  ${pc.dim('·')}  scout identities run 1..${N}  ${pc.dim('·')}  treasury ${short(treasury.account.address)}`], { color: pc.magenta })
kv("rpc", RPC_URL, 12)
kv('contract', IS_LOCAL ? `${contractAddress} (local anvil)` : explorerAddr(contractAddress))

const state = await loadState()
const now = state.now
const fees = await publicClient.estimateFeesPerGas()
const GAS_PER_ACTION = 200_000n // withdrawBond / delist use well under 100k; 2x headroom
const TRANSFER_GAS = 21_000n
const costOf = (gas: bigint) => gas * fees.maxFeePerGas
const kind = (l: Listing) => {
  const s = statusName(l.status)
  if ((s === 'Released' || s === 'RuledSeller') && !l.bondWithdrawn) return now >= l.resolveBy ? 'withdraw' : 'locked'
  if (s === 'Listed') return now >= l.expiresAt ? 'delist' : 'open'
  return 'done'
}

let withdrawn = 0n, withdrawnCount = 0, delisted = 0n, delistedCount = 0, returned = 0n, toppedUp = 0n, actions = 0
const stillLocked: { run: number; l: Listing }[] = []
const stillOpen: { run: number; l: Listing }[] = []

for (const { run, wallet } of identities) {
  const me = wallet.account.address as Address
  const mine = state.listings.filter((l) => l.seller === me)
  const bal = await publicClient.getBalance({ address: me })
  if (!mine.length && bal === 0n) continue
  const todo = mine.filter((l) => kind(l) === 'withdraw' || kind(l) === 'delist')
  for (const l of mine) { const k = kind(l); if (k === 'locked') stillLocked.push({ run, l }); else if (k === 'open') stillOpen.push({ run, l }) }
  const returnCost = costOf(TRANSFER_GAS * 12n / 10n)
  if (!todo.length && bal <= returnCost * 2n) continue

  await say('SCOUT', `run ${run} · ${me} · ${mine.length} listing${mine.length === 1 ? '' : 's'} · ${eth(bal)} in the wallet`)
  // 1. Gas: top up from the treasury only for what this identity is about to do.
  if (todo.length) {
    const need = costOf(GAS_PER_ACTION) * BigInt(todo.length) + returnCost
    if (bal < need) {
      const value = need - bal
      const tBal = await publicClient.getBalance({ address: treasury.account.address })
      if (tBal < value + returnCost) { warn(`treasury has ${eth(tBal)}, cannot fund ${eth(value)} of gas for run ${run} - run \`pnpm fund\` and try again`); continue }
      const hash = await treasury.client.sendTransaction({ to: me, value })
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      toppedUp += value
      txLine(`gas for run ${run}`, hash)
    }
  }
  // 2. Withdraw unlocked bonds, delist expired listings. A revert (e.g. a lagging chain clock) is reported, not fatal.
  for (const l of todo) {
    const k = kind(l)
    try {
      if (k === 'withdraw') {
        await say('SCOUT', `#${l.id} ${statusName(l.status)} - resolveBy ${clock(l.resolveBy)} has passed with no outcome dispute; withdrawing the ${eth(l.bond)} bond`)
        const res = await sendTx(wallet, { functionName: 'withdrawBond', args: [l.id] })
        const ev = res.logs.find((e) => e.eventName === 'BondWithdrawn')
        if (ev && ev.eventName === 'BondWithdrawn') { withdrawn += ev.args.amount; withdrawnCount++ }
      } else {
        await say('SCOUT', `#${l.id} still Listed, expired ${clock(l.expiresAt)} with no buyer - delisting to recover the ${eth(l.bond)} bond`)
        const res = await sendTx(wallet, { functionName: 'delist', args: [l.id] })
        const ev = res.logs.find((e) => e.eventName === 'Delisted')
        if (ev && ev.eventName === 'Delisted') { delisted += ev.args.bondReturned; delistedCount++ }
      }
      actions++
    } catch (err) {
      if (err instanceof RevertError) { warn(`#${l.id}: ${err.message}${err.errorName === 'WindowOpen' ? ' - the chain clock is not there yet; run sweep again in a minute' : ''}`); if (k === 'withdraw') stillLocked.push({ run, l }) }
      else throw err
    }
  }
  // 3. Return everything above the cost of the transfer itself to the treasury.
  try {
    const left = await publicClient.getBalance({ address: me })
    const gas = ((await publicClient.estimateGas({ account: wallet.account, to: treasury.account.address, value: 1n })) * 12n) / 10n
    const cost = costOf(gas)
    if (left > cost * 2n) {
      const value = left - cost
      const hash = await wallet.client.sendTransaction({ to: treasury.account.address, value, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
      await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
      returned += value; actions++
      txLine(`return ${eth(value)} to treasury`, hash)
    }
  } catch (err) { warn(`run ${run}: return to treasury skipped: ${(err as Error).message.split('\n')[0]}`) }
}

console.log()
if (actions === 0 && !stillLocked.length && !stillOpen.length) {
  box([pc.bold('nothing to sweep'), pc.dim('no unlocked bonds, no expired listings, no stray ETH in any scout identity')], { color: pc.green })
} else {
  const lines: string[] = []
  if (actions === 0) lines.push(pc.bold('nothing to sweep right now'))
  else lines.push(`${pc.bold('swept')}  withdrew ${withdrawnCount} bond${withdrawnCount === 1 ? '' : 's'} (${eth(withdrawn)}) · delisted ${delistedCount} (${eth(delisted)}) · returned ${eth(returned)} to the treasury${toppedUp ? pc.dim(` · gas advanced ${eth(toppedUp)}`) : ''}`)
  for (const { run, l } of stillLocked) lines.push(`${pc.yellow('locked')}  run ${run} #${l.id} ${statusName(l.status)} · bond ${eth(l.bond)} · unlocks ${clock(l.resolveBy)} (${new Date(Number(l.resolveBy) * 1000).toISOString()}, in ${l.resolveBy > now ? l.resolveBy - now : 0n}s)`)
  for (const { run, l } of stillOpen) lines.push(`${pc.cyan('listed')}  run ${run} #${l.id} still for sale · bond ${eth(l.bond)} · expires ${clock(l.expiresAt)} (delist after that)`)
  box(lines, { title: pc.bold('SWEEP'), color: pc.magenta })
}
const tBal = await publicClient.getBalance({ address: treasury.account.address })
kv('treasury', `${treasury.account.address}  ${eth(tBal)}${tBal < parseEther('0.003') ? pc.yellow('  (low: run pnpm fund before the next demo)') : ''}`)
console.log()
process.exit(0)
