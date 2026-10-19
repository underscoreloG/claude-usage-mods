import { expect, mock, test } from 'claude-code/testing'

import { descendants } from '../hooks/sessions'

const PROPS = {
  hasSurvey: false,
  isWorking: true,
  maxRows: 12,
  bodyColumns: 140,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

const START = { cwd: '.', surface: 'desktop' as const, isInteractive: true }

// list_sessions {linked: true} as the desktop app answers it: the family, this session excluded
const FAMILY = [
  { sessionId: 'local_parent', title: 'Parent', isRunning: false, lastActivityAt: '2026-10-19T19:00:00.000Z' },
  { sessionId: 'local_kid', name: 'certbot', title: 'Build certbot add-on', startedBy: 'local_me', isRunning: true, lastActivityAt: '2026-10-19T19:59:00.000Z' },
  { sessionId: 'local_grandkid', name: 'docs', title: 'Write the docs', startedBy: 'local_kid', isRunning: false, lastActivityAt: '2026-10-19T19:57:00.000Z' },
  { sessionId: 'local_sibling', name: 'other', title: 'Not ours', startedBy: 'local_parent', isRunning: true, lastActivityAt: '2026-10-19T19:59:00.000Z' },
  { sessionId: 'local_gone', name: 'gone', title: 'Archived', startedBy: 'local_me', isArchived: true, isRunning: false, lastActivityAt: '2026-10-19T18:00:00.000Z' },
]

const reply = (value: unknown) => ({ value: {
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
  isError: false,
} })

test('descendants keeps only what this session started, children of children included', () => {
  const ids = descendants(FAMILY, 'local_me').map(s => s.sessionId)
  expect(ids).toEqual(['local_kid', 'local_grandkid'])
})

test('shows the sessions this one started, working and idle, under the band', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  await clock.set(Date.parse('2026-10-19T20:00:00.000Z'))
  on('mcp.call', (_$, e) => {
    const sid = e.args.session_id
    if (e.tool === 'get_session') return reply({ sessionId: sid === 'self' ? 'local_me' : sid, model: 'claude-sonnet-5-5' })
    if (e.tool === 'list_sessions') return reply(FAMILY)
    if (e.tool === 'get_usage') return reply({ context: sid === 'local_kid' ? { status: 'ok', percentUsed: 23 } : { status: 'unavailable' } })
    throw new Error(`unexpected ${e.tool}`)
  })
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>USAGE ROW</Text>
  })

  await $.session.start(START)
  // the first poll lands, then the next 250ms tick stamps the clock the band reads
  await clock.advance(600)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agents-band', surface, component: 'AbovePrompt', props: PROPS })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts.some(t => /Sessions/.test(t) && /1 working/.test(t) && /1 idle/.test(t))).toBe(true)
    expect(texts.some(t => /certbot/.test(t) && /Build certbot add-on/.test(t))).toBe(true)
    expect(texts.some(t => /sonnet/.test(t) && /working/.test(t) && /ctx 23%/.test(t))).toBe(true)
    expect(texts.some(t => /idle 3m ago/.test(t))).toBe(true)
    expect(texts.some(t => /Not ours|Archived|Parent/.test(t))).toBe(false)
    // no subagents: no subagent header
    expect(texts.some(t => /Subagents/.test(t))).toBe(false)
    expect(texts.indexOf('USAGE ROW')).toBeGreaterThan(texts.findIndex(t => /certbot/.test(t)))
    await ui.unmount()
  }
})

test('in a terminal session, with no session server, draws nothing and stops asking', async ($, on) => {
  const clock = mock.clock(on)
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  let calls = 0
  on('mcp.call', (_$, e) => {
    calls++
    return { deny: `no connected MCP tool "${e.tool}" on a server named "${e.server}"` }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>USAGE ROW</Text>
  })

  await $.session.start({ ...START, surface: 'terminal' })
  await clock.advance(30_000)
  expect(calls).toBe(1)

  const ui = await $.ui.mount({ plugin: 'agents-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Text', text: 'USAGE ROW' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Sessions/ })).toBeUndefined()
})
