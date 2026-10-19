import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow } from '../types'

const agentsAtom = atom({ plugin: 'agents-band', key: 'agents' } as const, [])
const nowAtom = atom({ plugin: 'agents-band', key: 'now' } as const, 0)
const hiddenAtom = atom({ plugin: 'agents-band', key: 'isHidden' } as const, false)

// a finished agent stays on screen this long, then drops off
export const LINGER_MS = 20_000
const MAX_ROWS = 6
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const MODEL_COLORS: Record<string, string> = {
  fable: '#f2c94c',
  opus: '#b388ff',
  sonnet: '#4f8cff',
  haiku: '#3ecf8e',
}

export function family(model: string | undefined): string {
  const m = /(fable|opus|sonnet|haiku)/i.exec(model ?? '')
  return m?.[1] ? m[1].toLowerCase() : (model ?? '...')
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export function visible(list: AgentRow[], now: number): AgentRow[] {
  return list.filter(a => a.status === 'running' || now - (a.endedAt ?? now) < LINGER_MS)
}

function patch($: EngineInterface, id: string, fn: (a: AgentRow) => AgentRow) {
  return update($, agentsAtom, list => list.map(a => (a.id === id ? fn(a) : a)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agentsband',
      description: 'Show or hide the running-subagents rows above the prompt',
    })
    // live spinner and timers, only while something is on screen
    $.clock.every(250, () => {
      void (async () => {
        const now = await $.clock.now()
        const list = await read($, agentsAtom)
        if (visible(list, now).length === 0) {
          if (list.length > 0) await update($, agentsAtom, () => [])
          return
        }
        await update($, nowAtom, () => now)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'agentsband' }, async $ => {
    const hidden = await update($, hiddenAtom, x => !x)
    return { text: hidden ? 'Subagent rows hidden.' : 'Subagent rows shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const id = e.agentId
    const now = await $.clock.now()
    let type = 'agent'
    let description = ''
    try {
      const info = (await $.agent.list()).find(a => a.id === id)
      if (info) {
        type = info.type
        description = info.description
      }
    } catch {
      // keep the defaults
    }
    await update($, agentsAtom, list => {
      const known = list.find(a => a.id === id)
      if (known) return list.map(a => (a.id === id ? { ...a, status: 'running' as const, endedAt: undefined } : a))
      const row: AgentRow = { id, type, description, status: 'running', startedAt: now, reqs: 0, tools: 0, tokens: 0 }
      return [...list, row]
    })
    await update($, nowAtom, () => now)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    if (id !== undefined) await patch($, id, a => ({ ...a, model: e.model, reqs: a.reqs + 1, currentTool: undefined }))
    const result = yield* next(e)
    const u = result.usage
    if (id !== undefined && u) {
      const tokens = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      await patch($, id, a => ({ ...a, model: u.model, tokens: a.tokens + tokens }))
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id === undefined) return next(e)
    await patch($, id, a => ({ ...a, tools: a.tools + 1, currentTool: String(e.tool) }))
    try {
      return await next(e)
    } finally {
      await patch($, id, a => ({ ...a, currentTool: undefined }))
    }
  }).catch(($, e, next) => next(e)) // observer only: fail open, never block a tool

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const now = await $.clock.now()
    const status = e.reason === 'answer' ? 'done' : 'failed'
    await patch($, e.agentId, a => ({ ...a, status, endedAt: now, currentTool: undefined }))
    await update($, nowAtom, () => now)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)
    const now = await read($, nowAtom)
    const shown = visible(await read($, agentsAtom), now)
    if (shown.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const running = shown.filter(a => a.status === 'running').length
    const finished = shown.length - running
    const frame = SPINNER[Math.floor(now / 100) % SPINNER.length] ?? '•'

    const rows = shown.slice(-MAX_ROWS).map(a => {
      const icon = a.status === 'running' ? frame : a.status === 'done' ? '✓' : '✗'
      const iconColor = a.status === 'running' ? 'claude' : a.status === 'done' ? 'success' : 'error'
      const fam = family(a.model)
      const activity =
        a.status === 'running' ? (a.currentTool ? `▸ ${a.currentTool}` : 'thinking') : a.status === 'done' ? 'done' : 'failed'
      const end = a.endedAt ?? Math.max(now, a.startedAt)
      return (
        <Box flexDirection="row" justifyContent="space-between" width="100%">
          <Text wrap="truncate">
            <Text color={iconColor}>{icon} </Text>
            <Text bold>{a.type}</Text>
            {a.description && <Text dimColor>  {a.description}</Text>}
          </Text>
          <Text wrap="truncate">
            <Text color={MODEL_COLORS[fam] ?? 'subtle'}>{fam}</Text>
            <Text dimColor> · </Text>
            <Text dimColor={a.status !== 'running'}>{activity}</Text>
            <Text dimColor>
              {' · '}
              {a.tools} tools · {fmtTokens(a.tokens)} tok · {fmtElapsed(end - a.startedAt)}
            </Text>
          </Text>
        </Box>
      )
    })

    const header = (
      <Text wrap="truncate">
        <Text dimColor>Subagents  </Text>
        <Text color="claude">{running} running</Text>
        {finished > 0 && <Text dimColor> · {finished} finished</Text>}
        {shown.length > MAX_ROWS && <Text dimColor> · {shown.length - MAX_ROWS} more not shown</Text>}
      </Text>
    )

    // Share the band: these rows on top, then whatever the mods beneath drew
    // (usage-band's row), so neither mod hides the other whichever loads first.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {header}
        {rows}
        {below && (
          <Text dimColor wrap="truncate">
            {'─'.repeat(400)}
          </Text>
        )}
        {below ?? null}
      </Box>
    )
  })
}
