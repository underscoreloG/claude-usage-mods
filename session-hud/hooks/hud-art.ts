// The /hud-session dashboard drawn in ribbon's look (the cache card's palette, font, uppercase
// labels and dot meters): one SVG the pane scales to its width. Pure: nothing here touches the engine.
import { BG, EMPTY, HUE, LINE, MUTED, ORANGE, TEXT, YELLOW, svgDoc, tok } from './cache-art'

export type HudFacts = {
  model: string
  turns: number[]
  ctxShare: number
  tokens: number
  window: number
  cost: number
  tools: [string, number][]
  files: [string, number][]
  now: string
}

const W = 640
const GREEN = '#8fbf7f'

// Context fills green, then amber, then red, in the card's muted shades
const heat = (share: number) => (share < 0.6 ? GREEN : share < 0.85 ? YELLOW : HUE.warm)

// A hue per kind of tool, the flight recorder's (validated on this card's surface): read and
// search, edit and write, shell, the rest the card's muted grey (a darker grey vanishes among the
// unlit dots); each bar carries its tool's name beside it
export const toolHue = (name: string): string =>
  /^(Read|Grep|Glob|WebFetch|WebSearch|NotebookRead)$/.test(name) ? '#c98500'
    : /^(Edit|Write|NotebookEdit|MultiEdit)$/.test(name) ? '#d55181'
    : /^(Bash|PowerShell)$/.test(name) ? '#008300'
    : MUTED

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type TextOpts = { size?: number; w?: number; fill?: string; ls?: number; anchor?: string }
const t = (x: number, y: number, str: string, o: TextOpts = {}) =>
  `<text x="${x}" y="${y}" font-size="${o.size || 11}" font-weight="${o.w || 700}" fill="${o.fill || MUTED}"` +
  ` letter-spacing="${o.ls ?? 0}" text-anchor="${o.anchor || 'start'}">${esc(str)}</text>`
const label = (x: number, y: number, str: string) => t(x, y, str, { ls: 1.4 })
const hline = (y: number) => `<rect x="13" y="${y}" width="${W - 26}" height="1" fill="${LINE}"/>`
const vline = (x: number, y: number, h: number) => `<rect x="${x}" y="${y}" width="1" height="${h}" fill="${LINE}"/>`
const big = (x: number, y: number, value: string, unit: string, size = 38) =>
  `<text x="${x}" y="${y}" font-weight="600" fill="${TEXT}"><tspan font-size="${size}">${esc(value)}</tspan>` +
  `<tspan font-size="15" font-weight="500" fill="${MUTED}" dx="7">${esc(unit)}</tspan></text>`

// A row of dots, the first `lit` in the hue
const dots = (x: number, y: number, cols: number, lit: number, hue: string, step = 9.6) => {
  let d = ''
  for (let c = 0; c < cols; c++) d += `<circle cx="${x + 3 + c * step}" cy="${y}" r="3" fill="${c < lit ? hue : EMPTY}"/>`
  return d
}

const usd = (n: number, places = 2) => '$' + n.toFixed(places)

export function hudSvg(f: HudFacts): { source: string; alt: string; h: number } {
  let g = ''
  let y = 0

  // Header: the name, then the model and turn count
  g += t(13, 28, 'SESSION HUD', { size: 13, fill: TEXT, ls: 1.6 })
  g += t(W - 13, 28, `${f.model} · ${f.turns.length} ${f.turns.length === 1 ? 'turn' : 'turns'}`, { size: 12, w: 500, anchor: 'end' })
  y = 44
  g += hline(y)

  // Context and cost, side by side
  const hue = heat(f.ctxShare)
  g += label(13, y + 30, 'CONTEXT')
  g += big(13, y + 72, `${Math.round(f.ctxShare * 100)}%`, `${tok(f.tokens)} of ${tok(f.window)}`)
  const lit = Math.round(Math.min(1, f.ctxShare) * 50)
  g += dots(13, y + 90, 25, lit, hue) + dots(13, y + 99, 25, lit - 25, hue)
  g += vline(314, y + 18, 96)
  const last = f.turns[f.turns.length - 1]
  g += label(340, y + 30, 'COST')
  g += big(340, y + 72, usd(f.cost), 'this session')
  g += t(340, y + 98, last === undefined ? 'no turn yet' : `${usd(last, 3)} last turn`, { size: 12, w: 500 })
  y += 132
  g += hline(y)

  // Cost per turn: a dot column per turn, the latest in orange
  const shown = f.turns.slice(-60)
  const avg = f.turns.length ? f.turns.reduce((a, b) => a + b, 0) / f.turns.length : 0
  g += label(13, y + 30, 'COST PER TURN')
  if (shown.length) g += t(W - 13, y + 30, `last ${usd(shown[shown.length - 1] ?? 0, 3)} · avg ${usd(avg, 3)}`, { size: 12, w: 500, anchor: 'end' })
  if (!shown.length) {
    g += t(13, y + 58, 'waiting for the first turn', { size: 13, w: 500 })
    y += 78
  } else {
    const top = Math.max(...shown, 0.0001)
    const rows = 8
    shown.forEach((v, i) => {
      const n = Math.max(1, Math.round((v / top) * rows))
      const fill = i === shown.length - 1 ? ORANGE : YELLOW
      for (let r = 0; r < rows; r++) g += `<circle cx="${16 + i * 10}" cy="${y + 110 - r * 8}" r="3" fill="${r < n ? fill : EMPTY}"/>`
    })
    y += 130
  }
  g += hline(y)

  // Tools, busiest first: a dot bar each in the tool's hue
  const calls = f.tools.reduce((a, [, n]) => a + n, 0)
  g += label(13, y + 30, 'TOOLS')
  g += t(W - 13, y + 30, `${calls} ${calls === 1 ? 'call' : 'calls'}`, { size: 12, w: 500, anchor: 'end' })
  if (!f.tools.length) {
    g += t(13, y + 58, 'no tool calls yet', { size: 13, w: 500 })
    y += 78
  } else {
    const most = Math.max(1, ...f.tools.map(([, n]) => n))
    f.tools.slice(0, 6).forEach(([name, n], i) => {
      const ry = y + 56 + i * 24
      g += t(13, ry + 4, name.slice(0, 14), { size: 13, w: 500, fill: TEXT })
      g += dots(130, ry, 46, Math.max(1, Math.round((n / most) * 46)), toolHue(name))
      g += t(W - 13, ry + 4, String(n), { size: 13, w: 700, fill: TEXT, anchor: 'end' })
    })
    y += 56 + Math.min(6, f.tools.length) * 24 - 4
  }
  g += hline(y)

  // Files changed, with how many edits each
  g += label(13, y + 30, 'FILES CHANGED')
  const files = f.files.slice(0, 5)
  if (!files.length) g += t(13, y + 56, 'no files changed yet', { size: 13, w: 500 })
  files.forEach(([name, n], i) => {
    g += t(13, y + 56 + i * 20, name, { size: 13, w: 500, fill: TEXT })
    g += t(W - 13, y + 56 + i * 20, `×${n}`, { size: 12, w: 500, anchor: 'end' })
  })
  y += Math.max(1, files.length) * 20 + 50
  g += hline(y)

  // What runs now, the whole line the pane has always shown (60 characters)
  g += label(13, y + 30, 'NOW')
  const idle = f.now === 'idle'
  g += `<circle cx="17" cy="${y + 52}" r="4" fill="${idle ? GREEN : ORANGE}"/>`
  g += t(29, y + 56, idle ? 'ready' : f.now, { size: 13, w: 500, fill: idle ? MUTED : TEXT })
  y += 76

  const body = `<rect width="${W}" height="${y}" rx="14" fill="${BG}"/>` + g
  const alt =
    `Session HUD: ${Math.round(f.ctxShare * 100)}% context, ${usd(f.cost)} this session over ${f.turns.length} turns, ` +
    `${calls} tool calls, ${f.files.length} files changed, ${idle ? 'ready' : f.now}.`
  return { source: svgDoc(W, y, body, true), alt, h: y }
}
