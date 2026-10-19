import type { Lane, Span, Turn, TurnSummary } from '../types'

// Validated categorical slots (dataviz reference palette, dark steps): one fixed hue per model family
export const MODEL_COLORS: Record<string, string> = {
  opus: '#3987e5',
  sonnet: '#d95926',
  haiku: '#199e70',
  fable: '#9085e9',
  other: '#898781',
}

export const TOOL_COLORS: Record<string, string> = {
  // validated all-pairs (dark): yellow, magenta, green; grey for the rest
  read: '#c98500',
  edit: '#d55181',
  shell: '#008300',
  tool: '#6f6e69',
}

export function family(model: string): string {
  const m = /(fable|opus|sonnet|haiku)/i.exec(model)
  return m?.[1] ? m[1].toLowerCase() : 'other'
}

export function toolKind(tool: string): string {
  if (/^(Read|Grep|Glob|WebFetch|WebSearch|NotebookRead)$/.test(tool)) return 'read'
  if (/^(Edit|Write|NotebookEdit|MultiEdit)$/.test(tool)) return 'edit'
  if (/^(Bash|PowerShell)$/.test(tool)) return 'shell'
  return 'tool'
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

export function isLive(turn: Turn): boolean {
  if (turn.endedAt === undefined) return true
  return turn.lanes.some(l => !l.isDone || l.spans.some(s => s.end === undefined))
}

// Last moment anything in the turn happened, used as the right edge once live is over.
export function lastMoment(turn: Turn): number {
  let t = turn.endedAt ?? turn.startedAt
  for (const lane of turn.lanes) for (const s of lane.spans) t = Math.max(t, s.end ?? s.start)
  return t
}

export type Segment = { text: string; color?: string }

// One lane as runs of same-colored cells: requests first, tool calls painted on top
// so short tools stay visible next to long requests.
export function laneSegments(lane: Lane, t0: number, t1: number, width: number): Segment[] {
  const total = Math.max(1, t1 - t0)
  const colors: (string | undefined)[] = new Array(width).fill(undefined)
  const chars: string[] = new Array(width).fill(' ')
  const cellsOf = (s: Span): [number, number] => {
    const end = s.end ?? t1
    const c0 = Math.min(width - 1, Math.max(0, Math.floor(((s.start - t0) / total) * width)))
    const c1 = Math.min(width - 1, Math.max(c0, Math.ceil(((end - t0) / total) * width) - 1))
    return [c0, c1]
  }
  for (const s of lane.spans) {
    if (s.kind !== 'req') continue
    const [c0, c1] = cellsOf(s)
    const fam = family(s.name)
    for (let i = c0; i <= c1; i++) colors[i] = MODEL_COLORS[fam]
    const label = ` ${fam}`
    if (c1 - c0 + 1 > label.length) for (let i = 0; i < label.length; i++) chars[c0 + i] = label[i] ?? ' '
  }
  for (const s of lane.spans) {
    if (s.kind !== 'tool') continue
    const [c0, c1] = cellsOf(s)
    for (let i = c0; i <= c1; i++) {
      colors[i] = TOOL_COLORS[toolKind(s.name)]
      chars[i] = ' '
    }
  }
  const out: Segment[] = []
  for (let i = 0; i < width; i++) {
    const color = colors[i]
    const ch = color === undefined ? '·' : (chars[i] ?? ' ')
    const last = out[out.length - 1]
    if (last && last.color === color) last.text += ch
    else out.push({ text: ch, color })
  }
  return out
}

export function axis(t0: number, t1: number, width: number): string {
  const total = Math.max(1, t1 - t0)
  const cells = new Array(width).fill(' ')
  const step = niceStep(total / 1000 / Math.max(1, Math.floor(width / 8)))
  for (let sec = 0; sec * 1000 <= total; sec += step) {
    const label = `${Number.isInteger(sec) ? sec : sec.toFixed(1)}s`
    const at = Math.floor(((sec * 1000) / total) * width)
    if (at + label.length > width) break
    for (let i = 0; i < label.length; i++) cells[at + i] = label[i]
  }
  return cells.join('')
}

function niceStep(raw: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) if (s >= raw) return s
  return 1200
}

export function summarize(turn: Turn): TurnSummary {
  let reqs = 0
  let tools = 0
  let tokens = 0
  for (const l of turn.lanes) {
    reqs += l.reqs
    tools += l.tools
    tokens += l.tokens
  }
  return {
    n: turn.n,
    seconds: (lastMoment(turn) - turn.startedAt) / 1000,
    cost: turn.cost,
    reqs,
    tools,
    tokens,
    agents: turn.lanes.length - 1,
    cacheRate: turn.promptTokens > 0 ? turn.cacheRead / turn.promptTokens : 0,
  }
}
