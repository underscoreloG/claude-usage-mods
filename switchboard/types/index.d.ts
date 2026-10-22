// One mod as the switchboard knows it. `isJudged` is true when the mod's load
// passed through Switchboard's plugin.register hook, so an off switch reaches it.
export type ModInfo = {
  name: string
  root: string
  provenance: string
  tier: string
  version?: string
  description?: string
  events: number
  isJudged: boolean
  isRefused: boolean
}

export type Tab = 'mods' | 'plugins' | 'skills' | 'mcp'

// An installed plugin as `claude plugin list --json` reports it. `wasEnabled`
// is its state when this session started, which is what is loaded now.
export type PluginRow = {
  id: string
  root?: string
  description?: string
  isEnabled: boolean
  wasEnabled: boolean
}

// A skill found on disk; `name` is what a Skill(<name>) deny rule names.
export type SkillRow = {
  name: string
  description?: string
  source: string
}

// An MCP server as the model's tool list shows it, by its tool prefix.
export type ServerRow = {
  id: string
  tools: string[]
}

declare module 'claude-code' {
  interface PluginState {
    switchboard: {
      mods: ModInfo[]
      off: string[]
      hidden: string[]
      stubbed: string[]
      panes: Record<string, string>
      tab: Tab
      plugins: PluginRow[]
      skills: SkillRow[]
      skillDeny: string[]
      servers: ServerRow[]
      mcpOff: string[]
      notice: string
    }
  }
}
