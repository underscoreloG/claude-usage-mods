import { expect, mock, test } from 'claude-code/testing'

import { untilReset } from '../hooks/register'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

test('band shows context, cost, limits with reset countdown', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  // stands in for agents-band, the mod beneath
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>AGENT ROWS</Text>
  })
  const clock = mock.clock(on)
  const now = clock.now()
  await $.session.measure({
    context: { tokens: 99_600, window: 1_000_000, percent: 10 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 1, resetsAt: new Date(now + (2 * 60 + 11) * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 83 },
    ],
    cost: { usd: 0.44 },
    changed: ['context', 'rateLimits', 'cost'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    // two lines per group: label, then value
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const at = (s: string) => texts.indexOf(s)
    expect(at('Context')).toBeGreaterThan(-1)
    expect(texts[at('Context') + 1]).toMatch(/^10% .* 99\.6k\/1M$/)
    expect(texts[at('API cost') + 1]).toBe('$0.44')
    // the context bar: filled and track are the same box, the track dimmed
    expect(texts).toContain('▰')
    expect(texts).toContain('▰▰▰▰▰▰▰')
    expect(texts.some(t => t.includes('▱'))).toBe(false)
    expect(texts[at('5h limit') + 1]).toMatch(/^1%/)
    expect(texts[at('7d limit') + 1]).toBe('83%')
    expect(texts.filter(t => t === '│')).toHaveLength(6)
    // shares the band: the mod beneath is drawn first, this row under it
    expect(at('AGENT ROWS')).toBeGreaterThan(-1)
    expect(at('AGENT ROWS')).toBeLessThan(at('Context'))
    await ui.unmount()
  }
})

test('band yields to a survey', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  // stands in for the engine's own band (the survey)
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>survey</Text>
  })
  await $.session.measure({
    context: { tokens: 1000, window: 200_000, percent: 1 },
    rateLimits: [],
    changed: ['context'],
  })
  const ui = await $.ui.mount({
    plugin: 'usage-band',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { ...PROPS, hasSurvey: true },
  })
  expect(await ui.find({ type: 'Text', text: /1\.0k/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'survey' })).toBeDefined()
})

test('Flight recorder button opens the pane through its command', async ($, on) => {
  const ran: string[] = []
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: [{ name: 'flight-recorder', description: 'Open the flight recorder pane' }] as never }))
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: 'opened' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>beneath</Text>
  })
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Button', key: 'flight-recorder' })).toBeDefined()
    await ui.press({ key: 'flight-recorder' })
    await ui.unmount()
  }
  expect(ran).toEqual(['flight-recorder', 'flight-recorder'])
})

test('no Flight recorder button when that mod is not loaded', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: [] }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>beneath</Text>
  })
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
})

test('Switchboard button sits beside the plane, and only while Switchboard is loaded', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.list', () => ({
    value: [
      { name: 'flight-recorder', description: 'Open the flight recorder pane' },
      { name: 'switchboard', description: 'Switchboard' },
    ] as never,
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>beneath</Text>
  })
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Button', key: 'flight-recorder' })).toBeDefined()
    // the terminal shows the emoji gear; elsewhere the gear is an icon named by its alt
    if (surface === 'terminal') expect((await ui.find({ type: 'Button', key: 'switchboard' }))?.props.label).toBe('⚙\uFE0F')
    else expect(await ui.find({ type: 'Svg', alt: 'Open Switchboard' })).toBeDefined()
    await ui.unmount()
  }
})

test('HUD button opens the session-hud pane; three buttons sit two per line', async ($, on) => {
  const ran: string[] = []
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.list', () => ({
    value: [
      { name: 'flight-recorder', description: 'Open the flight recorder pane' },
      { name: 'switchboard', description: 'Switchboard' },
      { name: 'hud', description: 'Open the session dashboard' },
    ] as never,
  }))
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: 'opened' }
  })
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>beneath</Text>
  })
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Button', key: 'session-hud' })).toBeDefined()
    // the two lines of the grid: plane and gear, then the HUD (off the terminal each sits in its icon's site)
    const keyOf = (c: { props: { key?: string } }) => c.props.key?.replace(/-site$/, '')
    const lines = (await ui.findAll({ type: 'Box' })).filter(
      b => b.props.flexDirection === 'row' && b.children?.length && b.children.every(c => /^(flight-recorder|switchboard|session-hud)(-site)?$/.test(c.props.key ?? '')),
    )
    expect(lines.map(l => l.children.map(keyOf))).toEqual([['flight-recorder', 'switchboard'], ['session-hud']])
    // the HUD's mark: the pane's own ◆ in the terminal, a gauge icon elsewhere
    if (surface === 'terminal') expect((await ui.find({ type: 'Button', key: 'session-hud' }))?.props.label).toBe('◆')
    else expect(await ui.find({ type: 'Svg', alt: 'Open the session HUD' })).toBeDefined()
    await ui.press({ key: 'session-hud' })
    await ui.unmount()
  }
  expect(ran).toEqual(['hud', 'hud'])
})

test('reset countdown is short, with no space inside', () => {
  const now = 1_000_000
  const at = (mins: number) => new Date(now + mins * 60_000).toISOString()
  expect(untilReset(at(2 * 60 + 11), now)).toBe('2h11m')
  expect(untilReset(at(2 * 1440 + 9 * 60), now)).toBe('2d9h')
  expect(untilReset(at(42), now)).toBe('42m')
})

const ALL_THREE = [
  { name: 'flight-recorder', description: 'Open the flight recorder pane' },
  { name: 'switchboard', description: 'Switchboard' },
  { name: 'hud', description: 'Open the session dashboard' },
] as never

test('/usageband hide and show a button, and /usageband buttons lists them', async ($, on) => {
  mock.store(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: ALL_THREE }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>beneath</Text>
  })
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  const band = () => $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

  const hid = await $.command.run({ command: 'usageband', args: 'hide hud' })
  expect(hid.text).toMatch(/hud button is hidden/)
  let ui = await band()
  expect(await ui.find({ type: 'Button', key: 'session-hud' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'flight-recorder' })).toBeDefined()
  await ui.unmount()

  const list = await $.command.run({ command: 'usageband', args: 'buttons' })
  expect(list.text).toContain('flight: on')
  expect(list.text).toContain('hud: off')

  await $.command.run({ command: 'usageband', args: 'show hud' })
  ui = await band()
  expect(await ui.find({ type: 'Button', key: 'session-hud' })).toBeDefined()
  await ui.unmount()

  const wrong = await $.command.run({ command: 'usageband', args: 'hide nope' })
  expect(wrong.text).toMatch(/flight, switchboard, hud/)
})

test('a hidden button stays hidden in a new session', async ($, on) => {
  mock.store(on, { hiddenButtons: ['flight'] })
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: ALL_THREE }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>beneath</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'flight-recorder' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'switchboard' })).toBeDefined()
  await ui.unmount()
})
