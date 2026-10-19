export type Span = {
  id: string
  kind: 'req' | 'tool'
  // model id for a request, tool name for a tool call
  name: string
  start: number
  end?: number
  // shown on hover: what a tool ran, or a request's tokens and cache hits
  detail?: string
}

export type Lane = {
  id: string
  label: string
  spans: Span[]
  reqs: number
  tools: number
  tokens: number
  isDone: boolean
}

export type Turn = {
  n: number
  startedAt: number
  endedAt?: number
  costStart: number
  cost: number
  // prompt tokens served from cache, and all prompt tokens (uncached + cache read + cache write)
  cacheRead: number
  promptTokens: number
  lanes: Lane[]
}

export type TurnSummary = {
  n: number
  seconds: number
  cost: number
  reqs: number
  tools: number
  tokens: number
  agents: number
  cacheRate: number
}

// Running totals for the whole session, across turns
export type Totals = {
  models: Record<string, { tokens: number; reqs: number }>
  tools: Record<string, number>
  cacheRead: number
  promptTokens: number
}

// What the desktop dashboard draws: a snapshot taken at most every 2s, so the
// SVG (a sandboxed frame that reloads on each new source) does not blink
export type Frame = { turn: Turn; history: TurnSummary[]; totals: Totals; now: number; live: boolean }

declare module 'claude-code' {
  interface PluginState {
    'flight-recorder': { turn: Turn | null; history: TurnSummary[]; now: number; totals: Totals; frame: Frame | null; mode: 'text' | 'dashboard' }
  }
}
