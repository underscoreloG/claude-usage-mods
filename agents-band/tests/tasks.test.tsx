import { expect, mock, test } from 'claude-code/testing'

import { LINGER_MS } from '../hooks/register'
import { endFromNotification, startedTaskId } from '../hooks/tasks'
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

test('shows background shells and monitors, closes them on notification and TaskStop', async ($, on) => {
  const clock = mock.clock(on)
  // a terminal session: its ticker moves the clock the rows read, no session server
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('mcp.call', (_$, e) => ({ deny: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }))
  on('tool.call', (_$, e) => {
    if (e.tool === 'Bash' && e.run_in_background) {
      return { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }
    }
    if (e.tool === 'Bash') return { result: { stdout: 'hi', stderr: '', interrupted: false } }
    if (e.tool === 'Monitor') return { result: { taskId: 'm1', timeoutMs: 300000 } }
    return { result: 'ok' }
  })
  on('prompt.submit', () => ({ text: '' }))
  // stands in for usage-band, the mod beneath
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>USAGE ROW</Text>
  })

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the app', run_in_background: true, tool_use_id: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'echo hi', tool_use_id: 't2' })
  await $.tool.call({ tool: 'Monitor', command: 'tail -f app.log', description: 'Watch app log', timeout_ms: 300000, tool_use_id: 't3' })
  await clock.advance(5000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agents-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Text', text: /Background/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 running/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /shell/ }))?.text ?? '').toContain('Build the app')
    expect((await ui.find({ type: 'Text', text: /monitor/ }))?.text ?? '').toContain('Watch app log')
    // the foreground call drew no row
    expect(await ui.find({ type: 'Text', text: /echo hi/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'USAGE ROW' })).toBeDefined()
    await ui.unmount()
  }

  await $.prompt.submit({ text: notification('b1', 'completed'), wait: false, origin: { kind: 'task-notification' } })
  await $.tool.call({ tool: 'TaskStop', task_id: 'm1', tool_use_id: 't4' })
  let ui = await $.ui.mount({ plugin: 'agents-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /2 finished/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /completed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /killed/ })).toBeDefined()
  await ui.unmount()

  // finished rows linger, then drop off and leave the band beneath alone
  await clock.advance(LINGER_MS + 1000)
  ui = await $.ui.mount({ plugin: 'agents-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: /Background/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'USAGE ROW' })).toBeDefined()
})
