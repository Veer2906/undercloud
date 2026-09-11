// pnpm demo - one process runs all four agents against the deployed contract, tick every 3 s.
//   DEMO_MODE=short (default, `pnpm demo`):  two scenes, a sale then a dispute, ~2.5 min on the testnet.
//   DEMO_MODE=full  (`pnpm demo:full`):      six scenes with all five demo dossiers, ~6 min.
// Re-runnable: fresh salts + a fresh Scout identity per run. Ends with a recap box; exit 0 when every scene landed.
import './demo-env.js' // must stay the first import: sets CLASS_C_MIN_LOCK_SECONDS before schema.ts loads
import { parseEther, type Address } from 'viem'
import pc from 'picocolors'
import { env, DEMO_MODE } from '../src/env.js'
import { publicClient, walletFor, RPC_URL, IS_LOCAL, explorerAddr, type Wallet } from '../src/chain.js'
import { address as contractAddress, deployBlock } from '../src/contract.js'
import { loadState, loadParams, readReps, statusName, EMPTY_BUYER_REP, MARGIN, type MarketState, type Listing } from '../src/market.js'
import { loadDossiers, loadPublicRecord } from '../src/data.js'
import { canonicalize } from '../src/crypto.js'
import { reasonName } from '../src/schema.js'
import { SellerAgent } from '../src/agents/seller.js'
import { BuyerAgent, LAB, BROKER } from '../src/agents/buyer.js'
import { ArbiterAgent } from '../src/agents/arbiter.js'
import { onTxLogs, txHistory } from '../src/tx.js'
import { llmMode } from '../src/llm.js'
import { say, scene, info, warn, fail, kv, box, eth, ethDelta, clock, countdown, stopCountdown, resetClock, txLine, urlLine, leader, para, short, nb, PACE } from '../src/say.js'
import { keyFor, scoutKeyFor } from '../src/wallets.js'

const TICK_MS = 3000
const MAX_MS = 8 * 60_000
const SHORT = DEMO_MODE === 'short'
const ENTRIES = SHORT ? ['D1', 'D2'] : ['D1', 'D2', 'D3', 'D4', 'D5']

process.on('unhandledRejection', (err) => { fail(`unhandled: ${(err as Error)?.stack ?? err}`); process.exit(1) })
process.on('uncaughtException', (err) => { fail(`uncaught: ${err.stack ?? err}`); process.exit(1) })

resetClock()
if (contractAddress === '0x0000000000000000000000000000000000000000') throw new Error('no contract address: run `pnpm deploy:contract` then `pnpm sync` (or set UNDERCLOUD_ADDRESS + DEPLOY_BLOCK)')
const params = await loadParams()
const runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

// ---- Wallets: the treasury funds a fresh Scout identity for this run (see src/wallets.ts). ----
const treasury = walletFor(keyFor('SELLER'))
const runIndex = env.SCOUT_RUN !== undefined ? Number(env.SCOUT_RUN) : await publicClient.getTransactionCount({ address: treasury.account.address })
const scout = walletFor(scoutKeyFor(keyFor('SELLER'), runIndex))
const labWallet = walletFor(keyFor('BUYER_LAB'))
const brokerWallet = walletFor(keyFor('BUYER_BROKER'))
const arbiterWallet = walletFor(keyFor('ARBITER'))
const deployerAddr = (env.DEPLOYER_ADDRESS || walletFor(keyFor('DEPLOYER')).account.address) as Address

const wallets: { name: string; address: Address }[] = [
  { name: 'Deployer', address: deployerAddr },
  { name: 'Scout treasury', address: treasury.account.address },
  { name: `Scout (run ${runIndex + 1})`, address: scout.account.address },
  { name: 'Brineholt Labs', address: labWallet.account.address },
  { name: 'Sounding Compute', address: brokerWallet.account.address },
  { name: 'Judge (arbiter)', address: arbiterWallet.account.address },
]
const balances = async () => Object.fromEntries(await Promise.all(wallets.map(async (w) => [w.name, await publicClient.getBalance({ address: w.address })] as const)))

// ---- Header ----
console.log()
box([
  `${pc.bold('UNDERCLOUD')}  ${pc.dim('·')}  a sealed market for compute-capacity intelligence`,
  pc.dim(SHORT ? 'pnpm demo · a sale, then a dispute · every step is a real transaction' : 'pnpm demo:full · six scenes · every step is a real transaction'),
  pc.yellow('All providers, sites and companies are synthetic. Testnet only:'),
  pc.yellow('no GPU-hours change hands here - only facts about them.'),
], { color: pc.magenta })
const W = 16 // label gutter for the header and recap facts (wallet names are cut to fit it)
const fact = (k: string, v: unknown) => kv(k, v, W, 2)
fact('rpc', RPC_URL)
fact('contract', IS_LOCAL ? `${contractAddress} (local anvil)` : explorerAddr(contractAddress))
fact('deploy block', deployBlock.toString())
fact('windows', `quality ${params.qualityWindow}s · deliver ${params.deliverTimeout}s · arbiter ${params.arbiterTimeout}s ${pc.dim(nb('(production: 48h / 24h / 7d)'))}`)
fact('arbiter', `${params.arbiter} · ${nb(`model ${params.arbiterModelId}`)} · ${nb(`rubric ${short(params.rubricHash, 8)}`)}`)
fact('llm', llmMode)
fact('pace', `${PACE} ms/line · ${TICK_MS / 1000} s/tick · mode ${DEMO_MODE} · run ${runId}`)
const before = await balances()
for (const w of wallets) fact(w.name, w.address)
console.log(pc.bold('  Balances'))
for (const w of wallets) leader(w.name, eth(before[w.name]!))

// ---- Agents ----
const dossiers = loadDossiers()
const publicRecord = loadPublicRecord()
const seller = new SellerAgent(scout, ENTRIES.map((id) => dossiers.find((d) => d.id === id && d.demo)!).filter(Boolean), { plan: SHORT ? 'sequential' : 'all', housekeeping: !SHORT })
// The synthetic world: what "later surfaced" is seeded in dossiers.json, keyed by canonical payload.
const laterSurfaced = new Map(dossiers.filter((d) => d.laterSurfaced).map((d) => [canonicalize(d.payload), d.laterSurfaced!]))
// Buyers only consider listings that appear while they are watching (listedAt >= now): a crashed earlier
// run may have left expired-or-expiring listings behind and those are not part of this story.
const since = (await publicClient.getBlock({ blockTag: 'latest' })).timestamp
const lab = new BuyerAgent(labWallet, LAB, { runId, publicRecord, laterSurfaced, since })
const broker = new BuyerAgent(brokerWallet, BROKER, { runId, publicRecord, laterSurfaced, since })
const arbiter = new ArbiterAgent(arbiterWallet, keyFor('ARBITER'), publicRecord)
await arbiter.startup(params)

// Fund this run's Scout from the treasury (one tx; the treasury's nonce is the run counter).
// Gas reserve: ~12 transactions at up to 300k gas each at the chain's current fee (≈ 0.001 ETH on Arbitrum Sepolia).
const fees = await publicClient.estimateFeesPerGas()
const gasReserve = (() => { const est = 12n * 300_000n * fees.maxFeePerGas; const floor = parseEther('0.0006'); return est > floor ? est : floor })()
const need = seller.bondsRequired() + gasReserve
const scoutBal = await publicClient.getBalance({ address: scout.account.address })
if (scoutBal < need) {
  const value = need - scoutBal
  const treasuryBal = await publicClient.getBalance({ address: treasury.account.address })
  if (treasuryBal < value + parseEther('0.0002')) throw new Error(`Scout treasury ${treasury.account.address} has ${eth(treasuryBal)} but this run needs ${eth(value)} (bonds 2x each price + gas). Run \`pnpm fund\`.`)
  await say('SCOUT', `fresh identity for run ${runIndex + 1} - reputation is per address, so every run starts from zero`)
  kv('scout', scout.account.address)
  kv('funding', `${eth(value)} from the treasury (bonds + gas)`)
  const hash = await treasury.client.sendTransaction({ to: scout.account.address, value })
  await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
  txHistory.push({ label: 'fund scout', hash })
  txLine('fund scout', hash)
} else {
  await say('SCOUT', `identity for run ${runIndex + 1} already holds ${eth(scoutBal)} - no funding needed`)
  kv('scout', scout.account.address)
}

// ---- Scenes: printed the first time the orchestrator observes the triggering event. ----
type SceneDef = { title: string; explainer: string }
const SCENES: Record<string, SceneDef> = SHORT
  ? {
      '1': { title: 'A sale', explainer: 'sealed hash + label + 2x bond → blind buy, one-time key → ciphertext on-chain → quality window → release' },
      '2': { title: 'A dispute', explainer: 'rogue fact → the buyer finds it on the public record → dispute, key sealed to the judge → checks → ruling' },
    }
  : {
      '1': { title: 'Scout commits and bonds', explainer: 'five facts as salted hashes + provider-free labels, 2x bond each → buyers score blind, buy with one-time keys' },
      '1b': { title: 'Sealed delivery', explainer: "ciphertext to the buyer's one-time key goes into calldata → the buyer decrypts locally, checks the hash" },
      '2': { title: 'Already on the price board', explainer: 'the broker finds the fact on a price board dated before the listing → dispute AlreadyPublic, key to the judge' },
      '3': { title: 'True but forbidden', explainer: 'an API key and NDA text inside a real go-live dossier → dispute ForbiddenContent; truth is not a defense' },
      '4': { title: 'Honest sale settles', explainer: 'no complaint inside the quality window → release: 98% to the seller, 2% burned; the bond stays locked' },
      '5': { title: 'Ghost seller', explainer: "paid and never delivered → after deliverTimeout the buyer takes a refund plus 10% of the seller's bond" },
      '6': { title: 'On the hook until the outcome', explainer: 'resolveBy passed, no DidNotHappen dispute → the scout withdraws the bond and delists what nobody bought' },
    }
const shown = new Set<string>()
const once = (k: string) => { if (!shown.has(k)) { shown.add(k); scene(k, SCENES[k]!.title, SCENES[k]!.explainer) } }
const isId = (entry: string, id: bigint) => seller.idOf(entry) === id
if (!SHORT) onTxLogs((logs) => {
  for (const e of logs) {
    const id = (e.args as { id?: bigint }).id
    if (id === undefined) continue
    if (e.eventName === 'Delivered' && seller.entryOf(id)) once('1b')
    if (e.eventName === 'Disputed' && isId('D2', id) && reasonName(e.args.reason) === 'AlreadyPublic') once('2')
    if (e.eventName === 'Disputed' && isId('D3', id) && reasonName(e.args.reason) === 'ForbiddenContent') once('3')
    if (e.eventName === 'Released' && isId('D1', id)) once('4')
    if (e.eventName === 'Refunded' && isId('D4', id)) once('5')
    if (e.eventName === 'BondWithdrawn' && isId('D1', id)) once('6')
  }
})

// ---- Tick loop ----
const t0 = Date.now()
const listingOf = (state: MarketState, entry: string) => { const id = seller.idOf(entry); return id === undefined ? undefined : state.listings.find((l) => l.id === id) }
const ruled = (l?: Listing) => !!l && (statusName(l.status) === 'RuledBuyer' || statusName(l.status) === 'RuledSeller')
const settled = (l?: Listing) => !!l && ['Released', 'RuledBuyer', 'RuledSeller', 'Unadjudicated', 'Refunded'].includes(statusName(l.status))
const done = (state: MarketState) => {
  const d1 = listingOf(state, 'D1'), d2 = listingOf(state, 'D2')
  if (SHORT) return settled(d1) && ruled(d2)
  const d3 = listingOf(state, 'D3'), d4 = listingOf(state, 'D4'), d5 = listingOf(state, 'D5')
  return !!d1?.bondWithdrawn && ruled(d2) && ruled(d3) && statusName(d4?.status ?? -1) === 'Refunded' && statusName(d5?.status ?? -1) === 'Delisted'
}
let last: MarketState | undefined
let failures = 0
let timedOut = false
let countdownStarted = false
const MAX_FAILURES = 20
while (true) {
  // loadState makes ~15 RPC calls per tick; a transient RPC failure (429 past the transport's retries,
  // a timeout) must not kill the demo either - same failure accounting as the agents below.
  let state: MarketState
  try { state = await loadState() }
  catch (err) {
    failures++
    warn(`state: ${(err as Error).message.split('\n')[0]} - retrying next tick (${failures}/${MAX_FAILURES})`)
    if (failures >= MAX_FAILURES) throw err
    await new Promise((r) => setTimeout(r, TICK_MS))
    continue
  }
  last = state
  if (done(state)) break
  if (Date.now() - t0 > MAX_MS) {
    stopCountdown()
    timedOut = true
    warn(`8 minutes elapsed; stopping with these still pending:`)
    for (const e of ENTRIES) { const l = listingOf(state, e); kv(e, l ? `#${l.id} ${statusName(l.status)}${l.bondWithdrawn ? ' (bond withdrawn)' : ''}` : 'not listed') }
    break
  }
  // A revert is decoded inside each agent and retried next tick. Anything else (RPC hiccup, a 429 that
  // outlived the retries) is logged here and retried next tick too; only a long streak is fatal.
  // The broker acts before the lab so the "already on the price board" scene (D2) lands before "true but forbidden" (D3).
  for (const [name, agent] of [['SCOUT', seller], ['BROKER', broker], ['LAB', lab], ['JUDGE', arbiter]] as const) {
    // The scene banner goes up just before the scout lists the dossier that opens it.
    if (agent === seller) { const next = seller.nextToList(state)[0]; if (next) once(SHORT ? (next.id === 'D1' ? '1' : '2') : '1') }
    try { await agent.act(state); failures = 0 }
    catch (err) {
      failures++
      warn(`${name}: ${(err as Error).message.split('\n')[0]} - retrying next tick (${failures}/${MAX_FAILURES})`)
      if (failures >= MAX_FAILURES) throw err
    }
  }
  // The honest sale's quality window, counted down live once the buyer has opened the delivery.
  const d1 = listingOf(state, 'D1')
  if (!countdownStarted && d1 && statusName(d1.status) === 'Delivered') {
    countdownStarted = true
    countdown('quality window', Number(d1.deliveredAt + state.params.qualityWindow), 'buyer may still dispute', `no dispute filed - the buyer releases the escrow after a ${MARGIN}s margin`)
  }
  await new Promise((r) => setTimeout(r, TICK_MS))
}
stopCountdown()

// Return whatever the scout has left to the treasury so the next run can fund a fresh identity.
try {
  const bal = await publicClient.getBalance({ address: scout.account.address })
  const fees = await publicClient.estimateFeesPerGas()
  const gas = ((await publicClient.estimateGas({ account: scout.account, to: treasury.account.address, value: 1n })) * 12n) / 10n
  const cost = gas * fees.maxFeePerGas
  if (bal > cost * 2n) {
    const hash = await (scout as Wallet).client.sendTransaction({ to: treasury.account.address, value: bal - cost, gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas })
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 })
    txHistory.push({ label: 'return scout gas', hash })
    info(`scout returned its unspent ${eth(bal - cost)} to the treasury`)
    txLine('return scout gas', hash)
  }
} catch (err) { warn(`sweep skipped: ${(err as Error).message}`) }

// ---- Recap ----
const after = await balances()
const rows: { scene: string; title: string; entry: string }[] = SHORT
  ? [{ scene: '1', title: 'A sale', entry: 'D1' }, { scene: '2', title: 'A dispute', entry: 'D2' }]
  : [{ scene: '1·1b·4·6', title: 'Honest sale', entry: 'D1' }, { scene: '2', title: 'Already public', entry: 'D2' }, { scene: '3', title: 'Forbidden content', entry: 'D3' }, { scene: '5', title: 'Ghost seller', entry: 'D4' }, { scene: '6', title: 'Delisted', entry: 'D5' }]
const outcome = (l?: Listing) => {
  if (!l) return pc.red('not listed')
  const s = statusName(l.status)
  const reason = s.startsWith('Ruled') || s === 'Disputed' ? ` · ${reasonName(l.reason)}` : ''
  const bond = (s === 'Released' || s === 'RuledSeller') ? (l.bondWithdrawn ? ' · bond withdrawn' : ' · bond locked') : ''
  const ok = s === 'Released' || s === 'RuledBuyer' || s === 'RuledSeller' || s === 'Refunded' || s === 'Delisted'
  return `${(ok ? pc.green : pc.yellow)(s)}${pc.dim(reason + bond)}`
}
const txOf = (entry: string) => { const id = seller.idOf(entry); return id === undefined ? [] : txHistory.filter((t) => t.id === id) }
const setup = txHistory.filter((t) => t.id === undefined)
const money = (l?: Listing) => {
  if (!l || !last) return ''
  const rel = last.find(l.id, 'Released')
  if (rel) return `seller +${eth(rel.args.sellerPayout)} (98%) · burned ${eth(rel.args.feeBurned)} (2%)${l.bondWithdrawn ? '' : ` · ${nb(`bond ${eth(l.bond)}`)} locked until ${clock(l.resolveBy)} (pnpm sweep)`}`
  const rul = last.find(l.id, 'Ruled')
  // The listing's bond field is zeroed once the bond is slashed: the seller's bond was what got burned plus the damages.
  const slashed = rul ? rul.args.burned + rul.args.buyerPayout - l.price - (l.price + 1n) / 2n : 0n
  if (rul) return rul.args.buyerWins
    ? `buyer +${eth(rul.args.buyerPayout)} (price + dispute bond + damages) · burned ${eth(rul.args.burned)} (1.5x price) · seller refuted, its ${nb(`${eth(slashed)} bond`)} gone`
    : `seller +${eth(rul.args.sellerPayout)} · burned ${eth(rul.args.burned)} · buyer lost its dispute bond`
  return ''
}
// Each scene is two or three short lines inside the box: what happened, then where the money went (wrapped).
const lines: string[] = rows.flatMap((r) => {
  const l = last && listingOf(last, r.entry)
  const row = `${pc.bold(`scene ${r.scene}`)} ${pc.dim('·')} ${r.title}  ${pc.dim(`${r.entry} → ${l ? `#${l.id}` : '-'}`)}  ${outcome(l)}`
  const m = money(l)
  return [row, `   ${pc.dim(`${txOf(r.entry).length} tx${m ? ` · ${m}` : ''}`)}`]
})
lines.push(pc.dim(`${txHistory.length} transactions in ${((Date.now() - t0) / 1000).toFixed(0)} s (${setup.length} funding/return) · every one on ${IS_LOCAL ? 'local anvil' : 'Arbitrum Sepolia'}`))
console.log()
box(lines, { title: pc.bold('RECAP'), color: pc.magenta })
const txList = (txs: typeof txHistory) => { for (const t of txs) { console.log(`    ${pc.dim('⛓')}  ${t.label}`); console.log(urlLine(t.hash)) } }
for (const r of rows) {
  const txs = txOf(r.entry)
  if (!txs.length) continue
  console.log(`  ${pc.bold(`scene ${r.scene}`)} ${pc.dim('·')} ${r.title}`)
  txList(txs)
}
if (setup.length) {
  console.log(`  ${pc.bold('run')} ${pc.dim('·')} funding and return`)
  txList(setup)
}
console.log()
console.log(pc.bold('  On-chain counters'))
para('hit rate = confirmed / (confirmed + refuted); unchallenged ≠ confirmed', 2, pc.dim)
const scoutRep = last?.sellerRep.get(scout.account.address) ?? (await readReps(scout.account.address, labWallet.account.address)).seller
fact(`Scout (run ${runIndex + 1})`, `listed ${scoutRep.listed} · sold ${scoutRep.sold} · settled ${scoutRep.settled} · confirmed ${scoutRep.confirmed} · refuted ${scoutRep.refuted} · disputesWon ${scoutRep.disputesWon} · ghosted ${scoutRep.ghosted} · volume ${eth(scoutRep.volume)}`)
for (const [name, w] of [['Brineholt Labs', labWallet], ['Sounding Compute', brokerWallet]] as const) {
  const r = last?.buyerRep.get(w.account.address) ?? EMPTY_BUYER_REP
  fact(name, `bought ${r.bought} · disputesFiled ${r.disputesFiled} · disputesLost ${r.disputesLost}`)
}
console.log()
console.log(pc.bold('  Balances'))
for (const w of wallets) leader(w.name, `${eth(after[w.name]!)}  ${pc.dim(ethDelta(before[w.name]!, after[w.name]!).padStart(14))}`)
const locked = last ? seller.own(last).filter((l) => (statusName(l.status) === 'Released' || statusName(l.status) === 'RuledSeller') && !l.bondWithdrawn) : []
console.log()
if (locked.length) {
  for (const l of locked) fact('locked', `#${l.id} bond ${eth(l.bond)} until ${clock(l.resolveBy)} (${new Date(Number(l.resolveBy) * 1000).toISOString()})`)
  fact('later', `${pc.bold('pnpm sweep')} withdraws unlocked bonds from every past scout identity and returns the ETH to the treasury - safe to run any time`)
} else fact('later', `${pc.bold('pnpm sweep')} tidies up past runs (unlocked bonds, expired listings) - safe to run any time`)
console.log()
para(`${pc.bold(`Done in ${((Date.now() - t0) / 1000).toFixed(0)} s.`)} ${pc.dim('Everything above is synthetic; no GPU-hour was delivered.')}`)
fact('contract', IS_LOCAL ? `${contractAddress} (local anvil)` : explorerAddr(contractAddress))
console.log()
process.exit(timedOut ? 1 : 0)
