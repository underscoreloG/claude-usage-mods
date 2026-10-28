import { expect, mock, test } from 'claude-code/testing'

import { cacheClock, cacheHit, fmtMins, hitLevel, untilReset } from '../hooks/register'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
}

const ALL_THREE = [
  { name: 'hud-flight-recorder', description: 'Open the flight recorder pane' },
  { name: 'hud-switchboard', description: 'Switchboard' },
  { name: 'hud-session', description: 'Open the session dashboard' },
] as never

// What every band test needs beneath the mod: a measure, a command list, and a band drawn below
function beneath(on, commands = ALL_THREE) {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: commands }))
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>beneath</Text>
  })
}

const measure = $ => $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], changed: ['context'] })
// /band-usage <button> turns that button on when off, off when on
const toggle = ($, button: string) => $.command.run({ command: 'band-usage', args: button })

test('band is one line: model, context, limits, cache hit, cost, in that order, with separators and no labels', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  // stands in for agents-band, the mod beneath
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Text } = $$.ui.resolve(e)
    return <Text>AGENT ROWS</Text>
  })
  await $.session.measure({
    context: { tokens: 99_600, window: 1_000_000, percent: 10 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 1 },
      { kind: 'seven_day', percentUsed: 83 },
    ],
    cost: { usd: 0.44 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const at = (s: string) => texts.indexOf(s)
    // no label row
    for (const label of ['Context', 'API cost', '5h limit', '7d limit', 'Model']) expect(at(label)).toBe(-1)
    // values in order: context (bar first), 5h, 7d, then cost; model and cache hit need a response first
    const ctx = texts.findIndex(t => /^▰{8} 10% 99\.6k\/1M$/.test(t))
    const cost = at('$0.44')
    // the cost is led by a money bag
    expect(texts[cost - 1]).toBe('💰 ')
    // colours: a dim, quiet cost (an estimate), blue limit labels, each limit's percentage in its level (1% green, 83% red)
    const colorOf = async (text: string) => (await ui.findAll({ type: 'Text', text })).map(t => t.props.color).filter(Boolean)
    expect(await colorOf('$0.44')).toEqual([])
    expect((await ui.findAll({ type: 'Text', text: '$0.44' })).some(t => t.props.dimColor === true)).toBe(true)
    expect(await colorOf('5h ')).toEqual(['suggestion'])
    expect(await colorOf('7d ')).toEqual(['suggestion'])
    expect(await colorOf('1%')).toEqual(['success'])
    expect(await colorOf('83%')).toEqual(['error'])
    const five = texts.findIndex(t => /^5h 1%/.test(t))
    const seven = texts.findIndex(t => /^7d 83%/.test(t))
    expect(ctx).toBeGreaterThan(-1)
    expect(ctx < five && five < seven && seven < cost).toBe(true)
    // a one-line separator between each section
    expect(texts.filter(t => t === '│')).toHaveLength(3)
    // spread with equal gaps: sections and separators alternate in one space-between row
    const row = (await ui.findAll({ type: 'Box' })).find(box => box.props.justifyContent === 'space-between')
    // and never closer than a space, so a narrow band doesn't press them against the text
    expect(row?.props.gap).toBe(1)
    expect(row?.children.map(c => (c.type === 'Text' && c.props.wrap === undefined ? '│' : 'section'))).toEqual(['section', '│', 'section', '│', 'section', '│', 'section'])
    // shares the band: the mod beneath is drawn first, this row under it
    expect(at('AGENT ROWS')).toBeGreaterThan(-1)
    expect(at('AGENT ROWS')).toBeLessThan(ctx)
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

test('no buttons by default, even with every mod loaded', async ($, on) => {
  mock.store(on)
  beneath(on)
  await measure($)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Button' })).toBeUndefined()
    await ui.unmount()
  }
})

test('Flight recorder button, once shown, opens the pane through its command', async ($, on) => {
  const ran: string[] = []
  mock.store(on)
  beneath(on)
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: 'opened' }
  })
  await measure($)
  await toggle($, 'flight-recorder')
  ran.length = 0
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ type: 'Button', key: 'flight-recorder' })).toBeDefined()
    await ui.press({ key: 'flight-recorder' })
    await ui.unmount()
  }
  expect(ran).toEqual(['hud-flight-recorder', 'hud-flight-recorder'])
})

test('a shown button stays out while its mod is not loaded', async ($, on) => {
  mock.store(on)
  beneath(on, [] as never)
  await measure($)
  await toggle($, 'flight-recorder')
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
})

test('shown buttons sit in one row: plane, gear, HUD; the HUD button opens session-hud', async ($, on) => {
  const ran: string[] = []
  mock.store(on)
  beneath(on)
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: 'opened' }
  })
  await measure($)
  for (const b of ['flight-recorder', 'switchboard', 'hud']) await toggle($, b)
  ran.length = 0
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    // one row of three (off the terminal each sits in its icon's site)
    const keyOf = (c: { props: { key?: string } }) => c.props.key?.replace(/-site$/, '')
    const rows = (await ui.findAll({ type: 'Box' })).filter(
      b => b.props.flexDirection === 'row' && b.children?.length && b.children.every(c => /^(flight-recorder|switchboard|session-hud)(-site)?$/.test(c.props.key ?? '')),
    )
    expect(rows.map(r => r.children.map(keyOf))).toEqual([['flight-recorder', 'switchboard', 'session-hud']])
    // the terminal shows glyphs; elsewhere each is an icon named by its alt
    if (surface === 'terminal') {
      expect((await ui.find({ type: 'Button', key: 'switchboard' }))?.props.label).toBe('⚙️')
      expect((await ui.find({ type: 'Button', key: 'session-hud' }))?.props.label).toBe('◆')
    } else {
      expect(await ui.find({ type: 'Svg', alt: 'Open Switchboard' })).toBeDefined()
      expect(await ui.find({ type: 'Svg', alt: 'Open the session HUD' })).toBeDefined()
    }
    await ui.press({ key: 'session-hud' })
    await ui.unmount()
  }
  expect(ran).toEqual(['hud-session', 'hud-session'])
})

test('reset countdown is short, with no space inside', () => {
  const now = 1_000_000
  const at = (mins: number) => new Date(now + mins * 60_000).toISOString()
  expect(untilReset(at(2 * 60 + 11), now)).toBe('2h11m')
  expect(untilReset(at(2 * 1440 + 9 * 60), now)).toBe('2d9h')
  expect(untilReset(at(42), now)).toBe('42m')
})

test('/band-usage <button> turns it on and off, and /band-usage buttons lists them', async ($, on) => {
  mock.store(on)
  beneath(on)
  await measure($)
  const band = () => $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })

  const before = await $.command.run({ command: 'band-usage', args: 'buttons' })
  expect(before.text).toContain('flight-recorder: off')
  expect(before.text).toContain('hud: off')

  const shown = await toggle($, 'hud')
  expect(shown.text).toMatch(/hud button is on/)
  let ui = await band()
  expect(await ui.find({ type: 'Button', key: 'session-hud' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'flight-recorder' })).toBeUndefined()
  await ui.unmount()

  const list = await $.command.run({ command: 'band-usage', args: 'buttons' })
  expect(list.text).toContain('hud: on')
  expect(list.text).toContain('flight-recorder: off')

  const off = await toggle($, 'hud')
  expect(off.text).toMatch(/hud button is off/)
  ui = await band()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  await ui.unmount()

  const wrong = await toggle($, 'nope')
  expect(wrong.text).toMatch(/flight-recorder, switchboard, hud/)
})

test('a shown button stays shown in a new session', async ($, on) => {
  mock.store(on, { shownButtons: ['switchboard'] })
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  beneath(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ type: 'Button', key: 'switchboard' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'flight-recorder' })).toBeUndefined()
  await ui.unmount()
})

test('cache hit: the share of input the cache served, green when high', () => {
  expect(cacheHit(0, 0)).toBeUndefined()
  expect(cacheHit(63, 100)).toBe(63)
  expect(cacheHit(1, 3)).toBe(33)
  expect([hitLevel(90), hitLevel(63), hitLevel(20)]).toEqual(['success', 'warning', 'error'])
})

test('/band-usage open <pane> opens it through its command, just after, buttons on or off', async ($, on) => {
  const ran: string[] = []
  mock.store(on)
  const clock = mock.clock(on)
  beneath(on)
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: 'opened' }
  })
  for (const pane of ['flight-recorder', 'switchboard', 'hud']) {
    const out = await $.command.run({ command: 'band-usage', args: 'open ' + pane })
    expect(out.text).toBeUndefined()
  }
  await clock.settle()
  expect(ran).toEqual(['hud-flight-recorder', 'hud-switchboard', 'hud-session'])
  const wrong = await $.command.run({ command: 'band-usage', args: 'open nope' })
  expect(wrong.text).toMatch(/open <pane> \(flight-recorder, switchboard, hud\)/)
})

test('/band-usage open says so when that mod is not loaded', async ($, on) => {
  mock.store(on)
  beneath(on, [] as never)
  const out = await $.command.run({ command: 'band-usage', args: 'open hud' })
  expect(out.text).toBe('The hud mod is not loaded.')
})

test('cache clock: warm with the minutes left for an hour after the last request, then cold with the time idle', () => {
  const now = 10_000_000
  const ago = (mins: number) => now - mins * 60_000
  expect(cacheClock(0, now)).toBeUndefined()
  expect(cacheClock(ago(6), now)).toEqual({ mode: 'warm', mins: 54 })
  expect(cacheClock(ago(59), now)).toEqual({ mode: 'warm', mins: 1 })
  expect(cacheClock(ago(60), now)).toEqual({ mode: 'cold', mins: 60 })
  // a request just sent, before the clock ticked: a full hour left, never more
  expect(cacheClock(now + 5000, now)).toEqual({ mode: 'warm', mins: 60 })
  expect([fmtMins(45), fmtMins(125), fmtMins(3 * 1440 + 9 * 60)]).toEqual(['45m', '2h5m', '3d9h'])
})

test('a resumed session shows the cache cold with its idle time, Robo only off the terminal; /clear drops it', async ($, on) => {
  beneath(on)
  on('classic.SessionStart', () => ({}))
  on('clock.now', () => ({ value: 50_000_000 }))
  await $.session.measure({ context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 0.44 }, changed: ['context', 'cost'] })
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 3600 + 5 * 60 } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: PROPS })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain('cold 2h5m')
    expect((await ui.findAll({ type: 'Svg' })).some(s => String(s.props.alt).startsWith('Robo'))).toBe(surface === 'desktop')
  }
  await $.classic.SessionStart({ source: 'clear' } as never)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).some(t => /^(warm|cold) /.test(t))).toBe(false)
  await ui.unmount()
  // just after a reply the warm countdown reads the full hour in minutes, not 1h0m
  await $.classic.SessionStart({ source: 'fork', seconds_since_last_response: 0 } as never)
  const fresh = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await fresh.findAll({ type: 'Text' })).map(t => t.text)).toContain('warm 60m')
  await fresh.unmount()
  // a narrow band keeps each number alone: context % with no bar or tokens, and the cache without
  // its word beside Robo (the terminal, with no Robo, keeps the word); before a response counts,
  // the time stays, as it is all the cache has to show
  for (const surface of ['desktop', 'terminal'] as const) {
    const narrow = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 80 } })
    const texts = (await narrow.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain(surface === 'desktop' ? '60m' : 'warm 60m')
    expect(texts).toContain('1%')
    expect(texts).toContain('$0.44')
    expect(texts.some(t => t.includes('▰') || t.includes('1.0k') || t.includes('💰'))).toBe(false)
    await narrow.unmount()
  }
})
