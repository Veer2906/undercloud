// Narration helpers (spec §5.7): every agent line is `[+Ns] ACTOR  message`, every tx is one full explorer link,
// key facts are aligned `label: value` pairs, scenes are boxed. Colors come from picocolors, which already turns
// itself off under NO_COLOR, when stdout is not a TTY and when TERM=dumb; the in-place countdown additionally
// falls back to one plain line every 15 s when stdout is not a TTY (CI logs, `| tee`).
// DEMO_PACE (ms) pauses after each agent line so a viewer can read along while filming; 0 for CI.
//
// Width: everything is laid out for COLS columns (COLUMNS env, else the TTY width, else 100; clamped to 60..120)
// so the demo reads well in a narrow pane. Messages word-wrap with a hanging indent; a token that cannot be
// broken (a hash, an address, a URL) is the only thing allowed to run past COLS.
import pc from 'picocolors'
import { formatEther } from 'viem'
import { explorerTx, IS_LOCAL } from './chain.js'

export type Actor = 'SCOUT' | 'LAB' | 'BROKER' | 'JUDGE' | 'DEMO'

const COLOR: Record<Actor, (s: string) => string> = {
  SCOUT: pc.magenta,
  LAB: pc.green,
  BROKER: pc.cyan,
  JUDGE: pc.yellow,
  DEMO: pc.white,
}

/** True when stdout is an interactive terminal: the only case where a line may be rewritten in place. */
export const TTY = !!process.stdout.isTTY
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))
/** Terminal width every helper lays out for. COLUMNS overrides (tests, non-TTY); 60..120. */
export const COLS = clamp(Number(process.env.COLUMNS) || process.stdout.columns || 100, 60, 120)
const TAG_W = 6 // "SCOUT ", "BROKER", "chain "
const STAMP_W = 9 // "[+ 12.3s]"
/** Column where every message starts, so continuation lines (kv, wrapped text) align under the text. */
const INDENT = STAMP_W + 1 + TAG_W + 2
/** Explorer URLs sit on their own line at this indent: 5 + 70 chars fits even a 76-column pane. */
export const URL_INDENT = 5

let t0 = Date.now()
export const resetClock = () => { t0 = Date.now() }
export const stamp = () => pc.dim(`[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s]`)
export const PACE = Number(process.env.DEMO_PACE ?? 600)
export const pause = (ms = PACE) => new Promise<void>((r) => setTimeout(r, ms))

const tag = (actor: Actor) => COLOR[actor](pc.bold(actor.padEnd(TAG_W)))
const ANSI = /\x1b\[[0-9;]*m/g
// Wide glyphs the demo prints (⏳ ⛓ and emoji) take two cells; counting them as two keeps lines inside COLS.
const wide = (cp: number) => (cp >= 0x231a && cp <= 0x23ff) || (cp >= 0x2600 && cp <= 0x26ff) || (cp >= 0x1f300 && cp <= 0x1faff)
/** Visible width: ANSI codes do not count. */
export function width(s: string): number {
  let n = 0
  for (const ch of s.replace(ANSI, '')) n += wide(ch.codePointAt(0)!) ? 2 : 1
  return n
}
/** Cut to `n` cells with an ellipsis (plain text only). */
const clip = (s: string, n: number) => (width(s) <= n ? s : `${[...s].slice(0, Math.max(0, n - 1)).join('')}…`)

// ---- Word wrap that survives ANSI styling: a style open on a broken line is closed at the break and reopened
// on the continuation line, so a dim explainer stays dim across lines and never bleeds into the next output. ----
function ansiState(s: string): number[] {
  const codes: number[] = []
  const drop = (f: (c: number) => boolean) => { for (let i = codes.length - 1; i >= 0; i--) if (f(codes[i]!)) codes.splice(i, 1) }
  for (const m of s.matchAll(/\x1b\[([0-9;]*)m/g)) for (const p of (m[1] || '0').split(';')) {
    const c = Number(p)
    if (c === 0) codes.length = 0
    else if (c === 22) drop((x) => x === 1 || x === 2)
    else if (c >= 23 && c <= 29) drop((x) => x === c - 20)
    else if (c === 39) drop((x) => (x >= 30 && x <= 37) || (x >= 90 && x <= 97))
    else if (c === 49) drop((x) => (x >= 40 && x <= 47) || (x >= 100 && x <= 107))
    else codes.push(c)
  }
  return codes
}

/** Word-wrap `text` to `max` visible cells. Continuation lines get `hang` (default: the paragraph's own leading
 *  spaces, so an indented line stays indented). Words are never cut: a single token wider than `max` (a hash, a
 *  URL) is placed on its own line and allowed to run over. Multiple spaces between words are kept. */
export function wrap(text: string, max: number, hang?: string): string[] {
  const res: string[] = []
  for (const raw of text.split('\n')) {
    const para = raw.replace(/ (?:\x1b\[[0-9;]*m)*·(?:\x1b\[[0-9;]*m)* /g, (m) => `${m.slice(0, -1)}\u00a0`)
    const lead = /^ */.exec(para)![0]
    const indent = hang ?? lead
    let cur = lead, w = lead.length, words = 0
    for (const tok of para.slice(lead.length).split(' ')) {
      const tw = width(tok)
      if (words > 0 && w + 1 + tw > max) {
        const open = ansiState(cur)
        res.push(open.length ? `${cur}\x1b[0m` : cur)
        cur = indent + open.map((c) => `\x1b[${c}m`).join('')
        w = indent.length; words = 0
        if (tok === '') continue
        cur += tok; w += tw; words = 1
      } else if (words === 0) { if (tok === '') continue; cur += tok; w += tw; words = 1 }
      else { cur += ` ${tok}`; w += 1 + tw; if (tok) words++ }
    }
    res.push(cur)
  }
  return res
}

// ---- The one writer: clears the live countdown line first so ordinary output never lands on top of it. ----
function out(line = ''): void {
  if (live && TTY) process.stdout.write('\r\x1b[2K')
  console.log(line)
  if (live && TTY) live.render()
}
/** `prefix` on the first line, `indent` spaces under it for the rest; the text wraps to COLS. */
function outWrapped(prefix: string, indent: number, text: string, style: (s: string) => string = (s) => s): void {
  const lines = wrap(text, COLS - indent, '')
  lines.forEach((l, i) => out(i === 0 ? `${prefix}${style(l)}` : `${' '.repeat(indent)}${style(l)}`))
}

/** One narrated agent line. Returns after the DEMO_PACE pause so callers can `await` it. */
export async function say(actor: Actor, msg: string): Promise<void> {
  outWrapped(`${stamp()} ${tag(actor)}  `, INDENT, msg)
  if (PACE > 0) await pause()
}

/** Full explorer URL (clickable in any terminal) or "(local) <hash>" on anvil, where Arbiscan knows nothing. */
export const linkTx = (hash: string) => (IS_LOCAL ? `(local) ${hash}` : explorerTx(hash))
export const styledLink = (hash: string) => (IS_LOCAL ? pc.dim(`(local) ${hash}`) : pc.underline(pc.blue(explorerTx(hash))))
/** The URL line under a tx label: always on its own line so it is never truncated and stays clickable. */
export const urlLine = (hash: string) => `${' '.repeat(URL_INDENT)}${styledLink(hash)}`

/** A tx: `  ⛓  list(#12)` on one line, the explorer URL on the next. */
export function txLine(label: string, hash: string): void {
  out(`${stamp()} ${pc.dim('chain'.padEnd(TAG_W))}  ${pc.dim('⛓')}  ${pc.bold(label)}`)
  out(urlLine(hash))
}

/** Aligned `label: value` continuation line under the current actor's message; label dim, right-aligned in a
 *  `w`-char gutter, value wrapped with a hanging indent. `indent` is where the gutter starts. */
export function kv(k: string, v: unknown, w = 12, indent = INDENT): void {
  const label = (k ? `${clip(k, w)}:` : '').padStart(w + 1)
  outWrapped(`${' '.repeat(indent)}${pc.dim(label)} `, indent + w + 2, String(v))
}
/** A plain paragraph at `indent`, wrapped to COLS. */
export const para = (text: string, indent = 2, style: (s: string) => string = (s) => s) => outWrapped(' '.repeat(indent), indent, text, style)
/** `  name ………… value` with the value right-aligned at column `w` (dot leader). */
export function leader(name: string, value: string, indent = 2, w = Math.min(COLS, 64)): void {
  const dots = Math.max(1, w - indent - width(name) - width(value) - 2)
  out(`${' '.repeat(indent)}${name} ${pc.dim('…'.repeat(dots))} ${value}`)
}
/** Pad to a visible width (ANSI codes do not count). */
export const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)))
export const info = (msg: string) => outWrapped(`${stamp()} ${pc.dim('·'.padEnd(TAG_W))}  `, INDENT, msg, pc.dim)
export const warn = (msg: string) => outWrapped(`${stamp()} ${pc.yellow('!'.padEnd(TAG_W))}  `, INDENT, msg, pc.yellow)
export const fail = (msg: string) => {
  if (live && TTY) process.stdout.write('\r\x1b[2K')
  wrap(msg, COLS - INDENT, '').forEach((l, i) => console.error(i === 0 ? `${stamp()} ${pc.red('✗'.padEnd(TAG_W))}  ${pc.red(l)}` : `${' '.repeat(INDENT)}${pc.red(l)}`))
}
export const short = (hex: string, n = 6) => `${hex.slice(0, 2 + n)}…${hex.slice(-4)}`
/** Glue the spaces of a phrase (non-breaking) so `wrap` never splits it: "0.0008 ETH", "H100 x 256-1023". */
export const nb = (s: string) => s.replace(/ /g, '\u00a0')

/** Money: "0.0008 ETH" - up to `decimals` places, trailing zeros trimmed. */
export function eth(wei: bigint, decimals = 6): string {
  const s = Number(formatEther(wei)).toFixed(decimals).replace(/\.?0+$/, '')
  return nb(`${s === '' ? '0' : s} ETH`)
}
/** A signed money delta: "+0.000784 ETH" / "-0.0005 ETH". */
export const ethDelta = (before: bigint, after: bigint) => (after >= before ? `+${eth(after - before)}` : `-${eth(before - after)}`)
/** Chain timestamp (seconds) as a short UTC clock, e.g. "10:05:12 UTC". */
export const clock = (ts: bigint | number) => nb(`${new Date(Number(ts) * 1000).toISOString().slice(11, 19)} UTC`)
export const mmss = (secs: number) => { const s = Math.max(0, Math.round(secs)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }

// ---- Score table: what a buyer saw before buying blind. Fixed columns, never wider than COLS. ----
export type ScoreRow = { id: number; category: string; block: string; region: string; price: string; fit: number; buy: boolean }
export function scoreTable(rows: ScoreRow[], indent = 4): void {
  const heads = ['#', 'category', 'block', 'region/IC', 'price', 'fit', 'buy']
  const cells = rows.map((r) => [`#${r.id}`, r.category, r.block, r.region, r.price, String(r.fit), r.buy ? 'yes' : 'no'])
  // Narrow panes: the region/interconnect moves under the block as a second line.
  const narrow = COLS < 96
  const keep = narrow ? [0, 1, 2, 4, 5, 6] : [0, 1, 2, 3, 4, 5, 6]
  const widths = keep.map((i) => Math.max(width(heads[i]!), ...cells.map((c) => width(c[i]!))))
  const total = () => indent + widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1)
  // Should a label ever be freakishly long, shave the widest text column until the table fits (cells get clipped).
  while (total() > COLS) { const j = widths.indexOf(Math.max(...widths.slice(1, narrow ? 3 : 4)), 1); if (widths[j]! <= 6) break; widths[j]! -= 1 }
  const line = (c: string[], style: (i: number, s: string) => string = (_, s) => s) =>
    `${' '.repeat(indent)}${keep.map((i, j) => { const s = clip(c[i]!, widths[j]!); return style(i, i === 5 ? s.padStart(widths[j]!) : pad(s, widths[j]!)) }).join('  ')}`.trimEnd()
  out(pc.dim(line(heads)))
  for (const [k, c] of cells.entries()) {
    out(line(c, (i, s) => (i === 6 ? (rows[k]!.buy ? pc.green(s) : pc.dim(s)) : s)))
    if (narrow && c[3]) { const at = indent + widths[0]! + 2 + widths[1]! + 2; out(`${' '.repeat(at)}${pc.dim(clip(c[3], COLS - at))}`) }
  }
}

// ---- Boxes ----
/** Unicode box around `lines` (already styled); wraps long lines to the terminal width. The border is as wide
 *  as the longest wrapped line (+4), never wider than COLS. */
export function box(lines: string[], opts: { color?: (s: string) => string; title?: string } = {}): void {
  const color = opts.color ?? pc.dim
  const inner = COLS - 4
  const body = lines.flatMap((l) => wrap(l, inner))
  const w = Math.min(inner, Math.max(...body.map(width), opts.title ? width(opts.title) + 2 : 0))
  const top = opts.title ? `┌─ ${opts.title} ${'─'.repeat(Math.max(0, w - width(opts.title) - 1))}┐` : `┌${'─'.repeat(w + 2)}┐`
  out(color(top))
  for (const l of body) out(`${color('│')} ${l}${' '.repeat(Math.max(0, w - width(l)))} ${color('│')}`)
  out(color(`└${'─'.repeat(w + 2)}┘`))
}

/** Scene banner: number + title on the first line, an explainer of the mechanism step underneath (wraps). */
export function scene(n: string, title: string, explainer = ''): void {
  out()
  box([`${pc.bold(pc.white(`SCENE ${n}`))}  ${pc.dim('·')}  ${pc.bold(title)}`, ...(explainer ? [pc.dim(explainer)] : [])], { color: pc.white })
  out()
}

// ---- Live countdown: one line rewritten in place on a TTY; one plain line every 15 s otherwise. ----
type Live = { render: () => void; stop: () => void }
let live: Live | null = null

/** Count down to `untilSec` (a chain timestamp). `note` is the tail of the line ("the buyer may still dispute");
 *  `closed` is printed once when it reaches zero. Ordinary output during the countdown clears and redraws it. */
export function countdown(label: string, untilSec: number, note: string, closed: string): void {
  stopCountdown()
  let lastPrinted = -1
  const head = (state: string) => `${' '.repeat(INDENT)}${pc.yellow('⏳')} ${pc.bold(label)}  ${state} `
  // The live line must stay a single line: the note is clipped if the pane is too narrow for it.
  const line = (left: number) => { const h = head(`${pc.yellow(mmss(left))} left`); return `${h}${pc.dim(clip(`- ${note}`, COLS - width(h)))}` }
  const finish = () => {
    const ls = wrap(`${head(pc.green('closed'))}${pc.dim(`- ${closed}`)}`, COLS, ' '.repeat(INDENT + 3))
    if (TTY) process.stdout.write(`\r\x1b[2K${ls.join('\n')}\n`); else for (const l of ls) console.log(l)
  }
  const c: Live = {
    render() {
      const left = untilSec - Date.now() / 1000
      if (left <= 0) { c.stop(); finish(); return }
      if (TTY) process.stdout.write(`\r\x1b[2K${line(left)}`)
      else {
        const sec = Math.ceil(left)
        if (lastPrinted < 0 || (sec % 15 === 0 && sec !== lastPrinted)) { lastPrinted = sec; console.log(line(sec)) }
      }
    },
    stop() { clearInterval(timer); if (live === c) live = null },
  }
  const timer = setInterval(() => c.render(), 1000)
  live = c
  c.render()
}
export function stopCountdown(): void {
  if (!live) return
  if (TTY) process.stdout.write('\r\x1b[2K')
  live.stop()
}
