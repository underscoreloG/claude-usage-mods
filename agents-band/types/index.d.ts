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

declare module 'claude-code' {
  interface PluginState {
    'agents-band': { agents: AgentRow[]; now: number; isHidden: boolean }
  }
}
