import { expect, mock, test } from 'claude-code/testing'

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
    expect(texts[at('Session cost') + 1]).toBe('$0.44')
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

test('Switchboard button sits under the plane, and only while Switchboard is loaded', async ($, on) => {
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
    expect((await ui.find({ type: 'Button', key: 'switchboard' }))?.props.label).toBe('⚙\uFE0F')
    await ui.unmount()
  }
})
