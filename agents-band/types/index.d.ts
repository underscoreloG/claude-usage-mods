export type AgentRow = {
  id: string
  type: string
  description: string
  model?: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  reqs: number
  tools: number
  tokens: number
  // tool running right now, if any
  currentTool?: string
}

// A session this one started (start_session), or one those started, as the
// desktop app's ccd_session_mgmt server reports it
export type SessionRow = {
  id: string
  // short handle the session family calls it by
  name: string
  title: string
  isRunning: boolean
  lastActivityAt: number
  model?: string
  contextPercent?: number
}

declare module 'claude-code' {
  interface PluginState {
    'agents-band': { agents: AgentRow[]; sessions: SessionRow[]; now: number; isHidden: boolean }
  }
}
