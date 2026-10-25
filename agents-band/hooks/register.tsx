import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, SessionRow, TaskRow } from '../types'
import { startSessionPoller } from './sessions'
import { endFromNotification, notificationText, startedTaskId } from './tasks'

const agentsAtom = atom({ plugin: 'agents-band', key: 'agents' } as const, [])
const sessionsAtom = atom({ plugin: 'agents-band', key: 'sessions' } as const, [] as SessionRow[])
const tasksAtom = atom({ plugin: 'agents-band', key: 'tasks' } as const, [] as TaskRow[])
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

export function fmtAgo(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 1) return 'just now'
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`
}

export function visible<T extends { status: string; endedAt?: number }>(list: T[], now: number): T[] {
  return list.filter(a => a.status === 'running' || now - (a.endedAt ?? now) < LINGER_MS)
}

const TASK_ICONS: Record<TaskRow['status'], [string, string]> = {
  running: ['', 'claude'],
  completed: ['✓', 'success'],
  failed: ['✗', 'error'],
  killed: ['■', 'subtle'],
}

function patch($: EngineInterface, id: string, fn: (a: AgentRow) => AgentRow) {
  return update($, agentsAtom, list => list.map(a => (a.id === id ? fn(a) : a)))
}

// add a row for a call that went to the background; observer only: the call
// already ran and its result goes back untouched whatever happens here
async function track($: EngineInterface, tool: 'Bash' | 'Monitor', label: string, result: unknown) {
  try {
    const id = startedTaskId(tool, result)
    if (id === undefined) return
    const now = await $.clock.now()
    const row: TaskRow = { id, kind: tool === 'Bash' ? 'shell' : 'monitor', label, status: 'running', startedAt: now }
    await update($, tasksAtom, list => [...list.filter(t => t.id !== id), row])
    await update($, nowAtom, () => now)
  } catch {
    // keep the call's result
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agentsband',
      description: 'Show or hide the subagent, background task and linked-session rows above the prompt',
    })
    // live spinner and timers, only while something on screen moves
    $.clock.every(250, () => {
      void (async () => {
        const now = await $.clock.now()
        const list = await read($, agentsAtom)
        const isAgentShown = visible(list, now).length > 0
        if (!isAgentShown && list.length > 0) await update($, agentsAtom, () => [])
        const tasks = await read($, tasksAtom)
        const isTaskShown = visible(tasks, now).length > 0
        if (!isTaskShown && tasks.length > 0) await update($, tasksAtom, () => [])
        const sessions = await read($, sessionsAtom)
        const isSessionRunning = sessions.some(s => s.isRunning)
        // idle sessions only show "Nm ago": a redraw every 30s is enough
        const isAgoStale = sessions.length > 0 && now - (await read($, nowAtom)) >= 30_000
        if (isAgentShown || isTaskShown || isSessionRunning || isAgoStale) await update($, nowAtom, () => now)
      })()
    })
    // sessions this one started, read from the desktop app every few seconds
    startSessionPoller($)
    return next(e)
  })

  on('command.run', { command: 'agentsband' }, async $ => {
    const hidden = await update($, hiddenAtom, x => !x)
    return { text: hidden ? 'Subagent, background and session rows hidden.' : 'Subagent, background and session rows shown.' }
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

  // background shells and monitors, from any loop: a row from the call that
  // backgrounded them, closed by TaskStop or by their task notification
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const out = await next(e)
    if (!out.isError) await track($, 'Bash', e.description || e.command, out.result)
    return out
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const out = await next(e)
    if (!out.isError) await track($, 'Monitor', e.description || (e.command ?? e.ws?.url ?? ''), out.result)
    return out
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const out = await next(e)
    try {
      const id = e.task_id ?? e.shell_id
      const now = await $.clock.now()
      await update($, tasksAtom, list =>
        list.map(t => (t.id === id && t.status === 'running' ? { ...t, status: 'killed' as const, endedAt: now } : t)),
      )
    } catch {
      // observer only
    }
    return out
  })

  // a notification row in any loop: a subagent's background task reports into
  // that subagent's conversation, never through the main loop's prompt
  on('session.append', async ($, e, next) => {
    const out = await next(e)
    try {
      const text = notificationText(e)
      if (text !== undefined) {
        const now = await $.clock.now()
        await update($, tasksAtom, list => endFromNotification(list, text, now))
        await update($, nowAtom, () => now)
      }
    } catch {
      // observer only: the row is stored whatever happens here
    }
    return out
  })

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
    const tasks = visible(await read($, tasksAtom), now)
    const sessions = await read($, sessionsAtom)
    if (shown.length === 0 && tasks.length === 0 && sessions.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const frame = SPINNER[Math.floor(now / 100) % SPINNER.length] ?? '•'
    const sections = []

    if (shown.length > 0) {
      const running = shown.filter(a => a.status === 'running').length
      const finished = shown.length - running
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
      sections.push(
        <Text wrap="truncate">
          <Text dimColor>Subagents  </Text>
          <Text color="claude">{running} running</Text>
          {finished > 0 && <Text dimColor> · {finished} finished</Text>}
          {shown.length > MAX_ROWS && <Text dimColor> · {shown.length - MAX_ROWS} more not shown</Text>}
        </Text>,
        ...rows,
      )
    }

    if (tasks.length > 0) {
      const running = tasks.filter(t => t.status === 'running').length
      const finished = tasks.length - running
      const rows = tasks.slice(-MAX_ROWS).map(t => {
        const [icon, iconColor] = TASK_ICONS[t.status]
        const end = t.endedAt ?? Math.max(now, t.startedAt)
        return (
          <Box flexDirection="row" justifyContent="space-between" width="100%">
            <Text wrap="truncate">
              <Text color={iconColor}>{icon || frame} </Text>
              <Text bold>{t.kind}</Text>
              {t.label && <Text dimColor>  {t.label}</Text>}
            </Text>
            <Text wrap="truncate">
              <Text dimColor={t.status !== 'running'}>{t.status}</Text>
              <Text dimColor> · {fmtElapsed(end - t.startedAt)}</Text>
            </Text>
          </Box>
        )
      })
      sections.push(
        <Text wrap="truncate">
          <Text dimColor>Background  </Text>
          {running > 0 && <Text color="claude">{running} running</Text>}
          {running > 0 && finished > 0 && <Text dimColor> · </Text>}
          {finished > 0 && <Text dimColor>{finished} finished</Text>}
          {tasks.length > MAX_ROWS && <Text dimColor> · {tasks.length - MAX_ROWS} more not shown</Text>}
        </Text>,
        ...rows,
      )
    }

    if (sessions.length > 0) {
      const working = sessions.filter(s => s.isRunning).length
      const idle = sessions.length - working
      const rows = sessions.slice(0, MAX_ROWS).map(s => {
        const fam = family(s.model)
        return (
          <Box flexDirection="row" justifyContent="space-between" width="100%">
            <Text wrap="truncate">
              <Text color={s.isRunning ? 'claude' : 'subtle'}>{s.isRunning ? frame : '○'} </Text>
              <Text bold>{s.name}</Text>
              {s.title && <Text dimColor>  {s.title}</Text>}
            </Text>
            <Text wrap="truncate">
              {s.model && <Text color={MODEL_COLORS[fam] ?? 'subtle'}>{fam}</Text>}
              {s.model && <Text dimColor> · </Text>}
              {s.isRunning ? <Text>working</Text> : <Text dimColor>idle {fmtAgo(now - s.lastActivityAt)}</Text>}
              {s.contextPercent !== undefined && <Text dimColor> · ctx {s.contextPercent}%</Text>}
            </Text>
          </Box>
        )
      })
      sections.push(
        <Text wrap="truncate">
          <Text dimColor>Sessions  </Text>
          {working > 0 && <Text color="claude">{working} working</Text>}
          {working > 0 && idle > 0 && <Text dimColor> · </Text>}
          {idle > 0 && <Text dimColor>{idle} idle</Text>}
          {sessions.length > MAX_ROWS && <Text dimColor> · {sessions.length - MAX_ROWS} more not shown</Text>}
        </Text>,
        ...rows,
      )
    }

    // Share the band: these rows on top, then whatever the mods beneath drew
    // (usage-band's row), so neither mod hides the other whichever loads first.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        {sections}
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
