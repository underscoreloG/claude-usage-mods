import type { SessionAppendInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { LINGER_MS } from '../hooks/register'
import { endFromNotification, notificationText, startedTaskId } from '../hooks/tasks'
import type { TaskRow } from '../types'

const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

const notification = (id: string, status: string) =>
  `<task-notification>\n<task-id>${id}</task-id>\n<status>${status}</status>\n<summary>done</summary>\n</task-notification>`

test('startedTaskId reads the id a background call answered with, none for a foreground one', () => {
  expect(startedTaskId('Bash', { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' })).toBe('b1')
  expect(startedTaskId('Monitor', { taskId: 'm1', timeoutMs: 300000 })).toBe('m1')
  expect(startedTaskId('Bash', { stdout: 'hi', stderr: '', interrupted: false })).toBeUndefined()
  expect(startedTaskId('Grep', { taskId: 'x' })).toBeUndefined()
})

test('endFromNotification closes each task its block names, with that block status', () => {
  const list: TaskRow[] = [
    { id: 'b1', kind: 'shell', label: 'build', status: 'running', startedAt: 0 },
    { id: 'b2', kind: 'shell', label: 'tests', status: 'running', startedAt: 0 },
    { id: 'm1', kind: 'monitor', label: 'logs', status: 'running', startedAt: 0 },
  ]
  const out = endFromNotification(list, notification('b1', 'completed') + notification('b2', 'failed'), 500)
  expect(out.map(t => t.status)).toEqual(['completed', 'failed', 'running'])
  expect(out[0]?.endedAt).toBe(500)
  expect(out[2]?.endedAt).toBeUndefined()
})

// a notification row as the engine appends it: dequeued as a main-loop prompt, or
// delivered into a running subagent's turn as an attachment
const mainRow = (text: string): SessionAppendInput => ({
    message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text }] },
    door: 'prompt',
    origin: { kind: 'task-notification' },
    uuid: 'u-main',
})
const subagentRow = (text: string, agentId: string): SessionAppendInput => ({
    message: { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text }] },
    door: 'attachment',
    origin: { kind: 'engine' },
    uuid: 'u-sub',
    agentId,
})

test('notificationText reads notification rows from any loop, never a tool result or the model', () => {
  const text = notification('b1', 'completed')
  expect(notificationText(mainRow(text))).toBe(text)
  expect(notificationText(subagentRow(text, 'a1'))).toBe(text)
  const toolRow: SessionAppendInput = { ...mainRow(text), door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' } }
  expect(notificationText(toolRow)).toBeUndefined()
  const modelRow: SessionAppendInput = { ...mainRow(text), message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] }, door: 'response', origin: { kind: 'model', model: 'claude-opus-5-5' } }
  expect(notificationText(modelRow)).toBeUndefined()
  expect(notificationText(subagentRow('b1 is a plain reminder', 'a1'))).toBeUndefined()
})

test('shows background shells and monitors, closes them on notification and TaskStop', async ($, on) => {
  const clock = mock.clock(on)
  // a terminal session: its ticker moves the clock the rows read, no session server
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('mcp.call', (_$, e) => ({ deny: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.run_in_background) {
      const id = e.agentId === undefined ? 'b1' : 'b2'
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id } }
    }
    if (e.tool === 'Bash') return { result: { stdout: 'hi', stderr: '', interrupted: false } }
    if (e.tool === 'Monitor') return { result: { taskId: 'm1', timeoutMs: 300000 } }
    return { result: 'ok' }
  })
  // stands in for usage-band, the mod beneath
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>USAGE ROW</Text>
  })

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the app', run_in_background: true, tool_use_id: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'echo hi', tool_use_id: 't2' })
  await $.tool.call({ tool: 'Monitor', command: 'tail -f app.log', description: 'Watch app log', timeout_ms: 300000, tool_use_id: 't3' })
  // a subagent's own background shell
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', description: 'Start the dev server', run_in_background: true, tool_use_id: 't5', agentId: 'a1' })
  await clock.advance(5000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agents-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /Background/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /3 running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Build the app/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Start the dev server/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /monitor/ }))?.text ?? '').toContain('Watch app log')
    // the foreground call drew no row
    expect(await ui.find({ type: 'Text', text: /echo hi/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'USAGE ROW' })).toBeDefined()
    await ui.unmount()
  }

  // a tool's output quoting a notification closes nothing
  await $.session.append({ ...mainRow(notification('b2', 'failed')), door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' } })
  let ui = await $.ui.mount({ plugin: 'agents-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /3 running/ })).toBeDefined()
  await ui.unmount()

  await $.session.append(mainRow(notification('b1', 'completed')))
  await $.session.append(subagentRow(notification('b2', 'failed'), 'a1'))
  await $.tool.call({ tool: 'TaskStop', task_id: 'm1', tool_use_id: 't4' })
  ui = await $.ui.mount({ plugin: 'agents-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /3 finished/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /failed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /completed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /killed/ })).toBeDefined()
  await ui.unmount()

  // finished rows linger, then drop off and leave the band beneath alone
  await clock.advance(LINGER_MS + 1000)
  ui = await $.ui.mount({ plugin: 'agents-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Background/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'USAGE ROW' })).toBeDefined()
})
