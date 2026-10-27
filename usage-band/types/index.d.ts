export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Snapshot = {
  tokens?: number
  window: number
  percent?: number
  cost?: number
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Snapshot | null; model: string | null; now: number; isHidden: boolean; hiddenButtons: string[] }
  }
}
