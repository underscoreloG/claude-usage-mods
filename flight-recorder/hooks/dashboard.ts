// Desktop dashboard: one SVG document built from the recorder's state, in ribbon's look (the
// /hud-cache card's warm card, Outfit, uppercase spaced labels). The series colors follow the
// dataviz reference palette (dark steps, validated on this card's surface:
// scripts/validate_palette.js "#3987e5,#d95926,#199e70,#9085e9" --mode dark --surface "#24221c").
import type { Totals, Turn, TurnSummary } from '../types'
import { SANS } from './font'
import { MODEL_COLORS, TOOL_COLORS, family, fmtTokens, lastMoment, summarize, toolKind } from './timeline'

const W = 600
const PAD = 16
// ribbon's card colours: surface, cream text, muted labels, rules, unlit dots, accents
const CARD = '#24221c'
const INK = '#e8e2d2'
const INK_2 = '#c8c1ae'
const MUTED = '#8d8775'
const GRID = '#36332b'
const AXIS = '#4a463b'
const ORANGE = '#ff6b1a'
const CHIP_INK = '#1c1a16'
const LIVE = '#8fbf7f'
const TOOL_MARK = '#6f6e69'
const FONT = "RS,system-ui,'Segoe UI',sans-serif"

export type DashboardInput = { turn: Turn; history: TurnSummary[]; totals: Totals; now: number; live: boolean }

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const fmtCost = (usd: number) => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`)
export const fmtDur = (ms: number) => {
  const s = ms / 1000
  return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
}

function text(x: number, y: number, s: string, size: number, fill: string, extra = ''): string {
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" font-weight="500" ${extra}>${esc(s)}</text>`
}

// The card's label: small, bold, uppercase and spaced
const label = (x: number, y: number, s: string, extra = '') => text(x, y, s.toUpperCase(), 11, MUTED, `font-weight="700" letter-spacing="1.4" ${extra}`)
const rule = (y: number) => `<rect x="${PAD}" y="${y}" width="${W - 2 * PAD}" height="1" fill="${GRID}"/>`

// A figure as the card draws one: the label over a big number, no box; rules part the tiles
function tile(x: number, y: number, w: number, name: string, value: string, sub?: string): string {
  return (
    label(x, y + 18, name) +
    text(x, y + 50, value, 26, INK, 'font-weight="600"') +
    (sub ? text(x + w - 14, y + 50, sub, 11, MUTED, 'text-anchor="end"') : '')
  )
}

function section(y: number, title: string, note?: string): string {
  return rule(y - 22) + label(PAD, y, title) + (note ? text(W - PAD, y, note, 12, MUTED, 'text-anchor="end"') : '')
}

// Donut segment from angle a0 to a1 (radians, 0 = 12 o'clock, clockwise)
function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => `${(cx + r * Math.sin(a)).toFixed(2)} ${(cy - r * Math.cos(a)).toFixed(2)}`
  const large = a1 - a0 > Math.PI ? 1 : 0
  return `M${p(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`
}

// Bar with a 4px rounded data end and a square start (horizontal)
function hbar(x: number, y: number, w: number, hgt: number, fill: string, title: string): string {
  const r = Math.min(4, w / 2, hgt / 2)
  const d = `M${x} ${y}h${Math.max(0, w - r)}a${r} ${r} 0 0 1 ${r} ${r}v${hgt - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-Math.max(0, w - r)}Z`
  return `<path d="${d}" fill="${fill}"><title>${esc(title)}</title></path>`
}

// Column with a 4px rounded top and a square baseline
function vbar(x: number, base: number, w: number, hgt: number, fill: string, title: string): string {
  const r = Math.min(4, w / 2, hgt)
  const d = `M${x} ${base}v${-(hgt - r)}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${hgt - r}Z`
  return `<path d="${d}" fill="${fill}"><title>${esc(title)}</title></path>`
}

export function dashboardSvg({ turn, history, totals, now, live }: DashboardInput): { svg: string; width: number; height: number } {
  const parts: string[] = []
  const sum = summarize(turn)
  const t0 = turn.startedAt
  const t1 = live ? Math.max(now, lastMoment(turn)) : lastMoment(turn)
  let y = 22

  // Header: the turn as a chip, then whether it records
  y = 30
  const chip = `TURN ${turn.n}`
  const chipW = Math.round(chip.length * 8.6 + 14)
  parts.push(
    `<rect x="${PAD}" y="${y - 15}" width="${chipW}" height="21" rx="7" fill="${ORANGE}"/>` +
      text(PAD + chipW / 2, y, chip, 13, CHIP_INK, 'font-weight="700" letter-spacing="1" text-anchor="middle"'),
  )
  parts.push(
    live
      ? `<circle cx="${PAD + chipW + 14}" cy="${y - 4}" r="4" fill="${LIVE}"/>` + label(PAD + chipW + 24, y, 'Recording')
      : label(PAD + chipW + 12, y, 'Idle'),
  )
  parts.push(label(W - PAD, y, 'Flight recorder', 'text-anchor="end"'))
  y += 16
  parts.push(rule(y))
  y += 8

  // KPI tiles, 3 x 2
  const tw = (W - 2 * PAD - 2 * 10) / 3
  const cache = turn.promptTokens > 0 ? turn.cacheRead / turn.promptTokens : 0
  const tiles: [string, string, string?][] = [
    ['Duration', fmtDur(t1 - t0)],
    ['Turn cost', fmtCost(turn.cost)],
    ['Model requests', String(sum.reqs), sum.agents > 0 ? `${sum.agents} subagent${sum.agents > 1 ? 's' : ''}` : undefined],
    ['Tool calls', String(sum.tools)],
    ['Tokens', fmtTokens(sum.tokens)],
    ['Cache hit', turn.promptTokens > 0 ? `${Math.round(cache * 100)}%` : '-', 'of prompt tokens'],
  ]
  tiles.forEach(([name, value, sub], i) => {
    parts.push(tile(PAD + (i % 3) * (tw + 10), y + Math.floor(i / 3) * 70, tw, name, value, sub))
  })
  // rules between the columns, as the cache card parts its zones
  for (const c of [1, 2]) parts.push(`<rect x="${PAD + c * (tw + 10) - 12}" y="${y + 4}" width="1" height="${126}" fill="${GRID}"/>`)
  y += 140 + 40

  // Timeline: one lane per agent, requests colored by model, tool calls as grey ticks under them
  parts.push(section(y, 'Timeline', `${turn.lanes.length} lane${turn.lanes.length > 1 ? 's' : ''}`))
  y += 14
  const labelW = 96
  const x0 = PAD + labelW
  const plotW = W - PAD - x0
  const total = Math.max(1000, t1 - t0)
  const xOf = (t: number) => x0 + ((t - t0) / total) * plotW
  for (const lane of turn.lanes) {
    const mid = y + 11
    parts.push(
      `<circle cx="${PAD + 4}" cy="${mid}" r="3" fill="${lane.isDone ? MUTED : LIVE}"/>` +
        text(PAD + 12, mid + 4, lane.label.slice(0, 12), 11, INK_2),
    )
    parts.push(`<line x1="${x0}" x2="${W - PAD}" y1="${mid}" y2="${mid}" stroke="${GRID}"/>`)
    // whole-row hover target (under the blocks, which keep their own tooltips)
    const laneModels = [...new Set(lane.spans.filter(s => s.kind === 'req').map(s => family(s.name)))].join(', ')
    const laneTip =
      `${lane.label} · ${lane.isDone ? 'finished' : 'running'}\n` +
      `${lane.reqs} requests${laneModels ? ` (${laneModels})` : ''} · ${lane.tools} tool calls · ${fmtTokens(lane.tokens)} tokens`
    parts.push(`<rect x="${PAD}" y="${y}" width="${W - 2 * PAD}" height="24" fill="transparent"><title>${esc(laneTip)}</title></rect>`)
    for (const s of lane.spans) {
      const xs = xOf(s.start)
      const xe = Math.max(xs + 2, xOf(s.end ?? t1))
      const took = `${fmtDur((s.end ?? t1) - s.start)}${s.end === undefined ? ' (running)' : ''}`
      const more = s.detail ? `\n${s.detail}` : ''
      const w = (xe - xs).toFixed(1)
      if (s.kind === 'req') {
        const fam = family(s.name)
        const tip = `${s.name} · ${took} · ${lane.label}${more}`
        parts.push(
          `<rect x="${xs.toFixed(1)}" y="${y + 4}" width="${w}" height="12" rx="3" fill="${MODEL_COLORS[fam] ?? MODEL_COLORS.other}"><title>${esc(tip)}</title></rect>`,
        )
      } else {
        // thin tick, with a taller invisible hit target so it is easy to hover
        const tip = `${s.name} · ${took} · ${lane.label}${more}`
        parts.push(
          `<g><title>${esc(tip)}</title>` +
            `<rect x="${xs.toFixed(1)}" y="${y + 17}" width="${w}" height="5" rx="2" fill="${TOOL_COLORS[toolKind(s.name)] ?? TOOL_MARK}"/>` +
            `<rect x="${(xs - 2).toFixed(1)}" y="${y + 15}" width="${(xe - xs + 4).toFixed(1)}" height="10" fill="transparent"/></g>`,
        )
      }
    }
    y += 26
  }
  // time axis
  parts.push(`<line x1="${x0}" x2="${W - PAD}" y1="${y}" y2="${y}" stroke="${AXIS}"/>`)
  const ticks = 5
  for (let i = 0; i <= ticks; i++) {
    const t = (total / ticks) * i
    const anchor = i === 0 ? 'start' : i === ticks ? 'end' : 'middle'
    parts.push(text(x0 + (plotW / ticks) * i, y + 14, fmtDur(t), 10, MUTED, `text-anchor="${anchor}" font-variant-numeric="tabular-nums"`))
  }
  y += 38
  // legend (identity never color-alone: names next to swatches)
  let lx = x0
  // only the models this turn used
  const turnFams = new Set(turn.lanes.flatMap(l => l.spans.filter(s => s.kind === 'req').map(s => family(s.name))))
  const usedFams = Object.keys(MODEL_COLORS).filter(f => turnFams.has(f))
  for (const f of usedFams) {
    parts.push(`<rect x="${lx}" y="${y - 8}" width="10" height="10" rx="2" fill="${MODEL_COLORS[f]}"/>` + text(lx + 14, y + 1, f, 11, INK_2))
    lx += 22 + f.length * 6.5
  }
  // tool kinds on their own legend line
  y += 18
  lx = x0
  for (const [kind, label] of [["read", "read / web"], ["edit", "edit / write"], ["shell", "shell"], ["tool", "other tool"]] as const) {
    parts.push(`<rect x="${lx}" y="${y - 6}" width="12" height="5" rx="2" fill="${TOOL_COLORS[kind]}"/>` + text(lx + 16, y + 1, label, 11, INK_2))
    lx += 26 + label.length * 6.2
  }
  y += 30

  // Two columns: model share donut | top tools
  const colTop = y
  parts.push(section(y, 'Tokens by model', 'session'))
  const fams = Object.entries(totals.models)
    .filter(([, v]) => v.tokens > 0)
    .sort((a, b) => b[1].tokens - a[1].tokens)
  const famTotal = fams.reduce((n, [, v]) => n + v.tokens, 0)
  const cx = PAD + 62
  const cy = y + 78
  if (famTotal === 0) {
    parts.push(text(PAD, cy, 'No model requests yet', 11, MUTED))
  } else {
    const gap = fams.length > 1 ? 0.025 : 0 // ~2px surface gap between slices
    let a = 0
    for (const [fam, v] of fams) {
      const share = v.tokens / famTotal
      const a1 = a + share * Math.PI * 2
      const tip = `${fam}: ${fmtTokens(v.tokens)} tokens (${Math.round(share * 100)}%), ${v.reqs} requests`
      const d = share >= 0.9999 ? arc(cx, cy, 34, 54, 0, Math.PI * 1.9999) : arc(cx, cy, 34, 54, a + gap, a1 - gap)
      parts.push(`<path d="${d}" fill="${MODEL_COLORS[fam] ?? MODEL_COLORS.other}"><title>${esc(tip)}</title></path>`)
      a = a1
    }
    parts.push(text(cx, cy + 4, fmtTokens(famTotal), 16, INK, 'text-anchor="middle" font-weight="600"'))
    parts.push(text(cx, cy + 16, 'tokens', 10, MUTED, 'text-anchor="middle"'))
    // direct legend with shares
    fams.slice(0, 5).forEach(([fam, v], i) => {
      const ly = y + 36 + i * 20
      parts.push(
        `<rect x="${PAD + 134}" y="${ly - 9}" width="10" height="10" rx="2" fill="${MODEL_COLORS[fam] ?? MODEL_COLORS.other}"/>` +
          text(PAD + 150, ly, fam, 12, INK_2) +
          text(PAD + 262, ly, `${Math.round((v.tokens / famTotal) * 100)}%`, 12, INK, 'text-anchor="end" font-variant-numeric="tabular-nums"'),
      )
    })
  }

  // Top tools (session), single series: one hue
  const toolX = W / 2 + 14
  parts.push(label(toolX, y, 'Top tools'))
  parts.push(text(W - PAD, y, 'session', 12, MUTED, 'text-anchor="end"'))
  parts.push(`<rect x="${toolX - 16}" y="${y - 10}" width="1" height="160" fill="${GRID}"/>`)
  const tools = Object.entries(totals.tools).sort((a, b) => b[1] - a[1]).slice(0, 6)
  const maxTool = tools[0]?.[1] ?? 0
  if (tools.length === 0) {
    parts.push(text(toolX, y + 30, 'No tool calls yet', 11, MUTED))
  } else {
    const nameW = 92
    const barMax = W - PAD - toolX - nameW - 30
    tools.forEach(([name, count], i) => {
      const by = y + 18 + i * 22
      const short = name.length > 14 ? `${name.slice(0, 13)}…` : name
      parts.push(text(toolX, by + 11, short, 11, INK_2))
      parts.push(hbar(toolX + nameW, by + 2, Math.max(3, (count / maxTool) * barMax), 12, TOOL_COLORS[toolKind(name)] ?? TOOL_MARK, `${name}: ${count} calls (${toolKind(name)})`))
      parts.push(text(toolX + nameW + (count / maxTool) * barMax + 6, by + 12, String(count), 11, INK, 'font-variant-numeric="tabular-nums"'))
    })
  }
  y = colTop + 196

  // Cost per turn: previous turns plus this one, oldest on the left
  const turns = [...history].reverse().concat([{ ...sum, cost: turn.cost }])
  parts.push(section(y, 'Cost per turn', `${fmtCost(turns.reduce((n, t) => n + t.cost, 0))} over ${turns.length} turns`))
  y += 14
  const chartH = 70
  const base = y + chartH
  const maxCost = Math.max(...turns.map(t => t.cost), 0.001)
  const slot = (W - 2 * PAD) / Math.max(turns.length, 6)
  const cw = Math.min(24, slot - 8)
  parts.push(`<line x1="${PAD}" x2="${W - PAD}" y1="${base}" y2="${base}" stroke="${AXIS}"/>`)
  turns.forEach((t, i) => {
    const bx = PAD + i * slot + (slot - cw) / 2
    const bh = Math.max(2, (t.cost / maxCost) * (chartH - 14))
    const isNow = i === turns.length - 1
    const tip = `Turn ${t.n}: ${fmtCost(t.cost)}, ${fmtDur(t.seconds * 1000)}, ${t.reqs} requests, ${t.tools} tools, ${fmtTokens(t.tokens)} tokens`
    parts.push(vbar(bx, base, cw, bh, isNow ? ORANGE : AXIS, tip))
    parts.push(text(bx + cw / 2, base + 13, `T${t.n}`, 10, isNow ? INK_2 : MUTED, 'text-anchor="middle"'))
    if (isNow || t.cost === maxCost) parts.push(text(bx + cw / 2, base - bh - 4, fmtCost(t.cost), 10, INK, 'text-anchor="middle"'))
  })
  y = base + 30

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y}" viewBox="0 0 ${W} ${y}" font-family="${FONT}">` +
    // Outfit rides along: an Svg is drawn isolated and cannot reach the app's fonts
    `<style>@font-face{font-family:RS;font-weight:100 900;src:url(data:font/woff2;base64,${SANS}) format('woff2')}</style>` +
    `<rect width="${W}" height="${y}" rx="14" fill="${CARD}"/>` +
    parts.join('') +
    `</svg>`
  return { svg, width: W, height: y }
}

export function dashboardAlt({ turn, totals }: DashboardInput): string {
  const sum = summarize(turn)
  const fams = Object.entries(totals.models).filter(([, v]) => v.tokens > 0)
  const all = fams.reduce((n, [, v]) => n + v.tokens, 0)
  const share = fams.map(([f, v]) => `${f} ${Math.round((v.tokens / Math.max(1, all)) * 100)}%`).join(', ')
  return `Turn ${turn.n}: ${fmtCost(turn.cost)}, ${sum.reqs} requests, ${sum.tools} tool calls, ${fmtTokens(sum.tokens)} tokens, ${sum.agents} subagents. Session tokens by model: ${share || 'none yet'}.`
}
