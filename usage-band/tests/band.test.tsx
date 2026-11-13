import { expect, mock, test } from 'claude-code/testing'

import { bandCells, cacheClock, cacheHit, cellsOf, fmtMins, hitLevel, untilReset } from '../hooks/register'

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

// One model request: the main thread's, or a subagent's when agentId is given
async function step($, model: string, effort?: string, agentId?: string) {
  const stream = $.turn.step({ turnId: 't', index: 0, model, effort, agentId } as never)
  for await (const _ of stream);
  return stream.result
}

test('the effort shows after the model, from the main thread\'s requests alone', async ($, on) => {
  mock.clock(on)
  beneath(on)
  on('turn.step', async function* () {
    return { turnId: 't', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await measure($)
  const texts = async () => {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    return all
  }
  await step($, 'claude-opus-5-5', 'high')
  expect(await texts()).toContain('opus 5.5 high')
  // a subagent's effort is its own: the band keeps the main thread's
  await step($, 'claude-haiku-5-5', 'low', 'agent-1')
  expect(await texts()).toContain('opus 5.5 high')
  // /effort max shows from the next request
  await step($, 'claude-opus-5-5', 'max')
  expect(await texts()).toContain('opus 5.5 max')
  // a model that takes no effort shows its name alone
  await step($, 'claude-haiku-5-5')
  const last = await texts()
  expect(last).toContain('haiku 5.5')
  expect(last.some(t => /haiku 5\.5 /.test(t))).toBe(false)
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

// A session well under way, with a long value in every section: the band at its widest
const NOW = 50_000_000
async function busy($, on) {
  beneath(on)
  on('classic.SessionStart', () => ({}))
  on('clock.now', () => ({ value: NOW }))
  const inMins = (mins: number) => new Date(NOW + mins * 60_000).toISOString()
  await $.session.measure({
    context: { tokens: 225_400, window: 1_000_000, percent: 23 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 19, resetsAt: inMins(116) },
      { kind: 'seven_day', percentUsed: 15, resetsAt: inMins(6 * 1440 + 12 * 60) },
    ],
    cost: { usd: 63.31 },
    changed: ['context', 'rateLimits', 'cost'],
  })
  // a minute after the last reply: the cache reads warm 59m, and the countdowns have a now to count from
  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 60 } as never)
}
const widthReport = async $ => (await $.command.run({ command: 'band-usage', args: 'width' })).text ?? ''

test('cells: a character each, an emoji two; the desktop draws a wider bar box', () => {
  expect([cellsOf('5h 19%', true), cellsOf('💰 ', true), cellsOf('▰▰', true)]).toEqual([6, 3, 2])
  expect([cellsOf('5h 19%', false), cellsOf('💰 ', false)]).toEqual([6, 3])
  expect(Math.round(cellsOf('▰▰', false) * 10)).toBe(36)
  // two sections and the separator between them, a space either side
  expect(bandCells(['ab', 'cd'], 0, true)).toBe(7)
  expect(bandCells(['ab', 'cd'], 3.5, false)).toBe(11)
  // a band seen live on a 99-cell desktop column, where it wrapped onto two lines: it takes 105,
  // and 95 without its token counts, which the four cells kept free just allow
  const live = ['sonnet 5.5', '▰▰▰▰▰▰▰▰ 12% 121.7k/1M', '5h 32% ↻ 1h43m', '7d 17% ↻ 6d12h', 'warm 60m 89%', '💰 $0.42']
  expect(bandCells(live, 3.5, false)).toBe(105)
  expect(bandCells(live.map(s => s.replace(' 121.7k/1M', '')), 3.5, false)).toBe(95)
})

test('a band wider than its column leaves out what it takes to fit: token counts first', async ($, on) => {
  await busy($, on)
  const drawn = async (surface: 'desktop' | 'terminal', bodyColumns: number) => {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    const sections = (await ui.findAll({ type: 'Text' })).filter(x => x.props.wrap === 'truncate').map(x => x.text)
    await ui.unmount()
    return { texts, sections, report: await widthReport($) }
  }
  // the whole band takes 89 cells on desktop (a wider bar, Robo) and four are kept free: whole from 93
  let d = await drawn('desktop', 93)
  expect(d.report).toContain('desktop: 93 cells (bodyColumns), the whole band takes about 89, nothing left out')
  expect(d.texts).toContain('▰▰▰▰▰▰▰▰ 23% 225.4k/1M')
  // a cell less and the token counts go; all else stays
  d = await drawn('desktop', 92)
  expect(d.report).toContain('desktop: 92 cells (bodyColumns), the whole band takes about 89, left out: token counts')
  expect(d.texts).toContain('▰▰▰▰▰▰▰▰ 23%')
  expect(d.texts).toContain('5h 19% ↻ 1h56m')
  expect(d.texts).toContain('warm 59m')
  expect(d.texts).toContain('💰 ')
  // narrower, the money bag, then the cache's word (Robo says it), then the bar
  d = await drawn('desktop', 81)
  expect(d.report).toContain('left out: token counts, 💰')
  d = await drawn('desktop', 77)
  expect(d.report).toContain('left out: token counts, 💰, cache word')
  expect(d.texts).toContain('59m')
  d = await drawn('desktop', 70)
  expect(d.report).toContain('left out: token counts, 💰, cache word, context bar')
  expect(d.texts).toContain('7d 15% ↻ 6d12h')
  // at the narrowest each section is its number alone; the cache's time stays while it is all the
  // cache has to show, so it is not among what was left out
  d = await drawn('desktop', 45)
  expect(d.report).toContain('left out: token counts, 💰, cache word, context bar, reset countdowns')
  expect(d.texts).toContain('5h 19%')
  expect(d.texts.some(t => t.includes('↻') || t.includes('▰'))).toBe(false)

  // the terminal counts characters: what it reports is what it drew, 79 cells with the separators
  let t = await drawn('terminal', 120)
  expect(t.report).toContain('terminal: 120 cells (bodyColumns), the whole band takes about 79, nothing left out')
  expect(t.sections).toEqual(['▰▰▰▰▰▰▰▰ 23% 225.4k/1M', '5h 19% ↻ 1h56m', '7d 15% ↻ 6d12h', 'warm 59m', '💰 $63.31'])
  expect(bandCells(t.sections, 0, true)).toBe(79)
  // two cells kept free: whole from 81, and no Robo there, so the cache keeps its word
  expect((await drawn('terminal', 81)).report).toContain('nothing left out')
  expect((await drawn('terminal', 80)).report).toContain('terminal: 80 cells (bodyColumns), the whole band takes about 79, left out: token counts')
  t = await drawn('terminal', 30)
  expect(t.report).toContain('left out: token counts, 💰, context bar, reset countdowns')
  expect(t.sections).toEqual(['23%', '5h 19%', '7d 15%', 'warm 59m', '$63.31'])
  expect(t.report).toContain('Layout: auto (shows what fits the width).')
})

test('buttons take room too: a band that fit whole leaves something out once they are on', async ($, on) => {
  mock.store(on)
  await busy($, on)
  const report = async () => {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'desktop', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 99 } })
    await ui.unmount()
    return widthReport($)
  }
  expect(await report()).toContain('nothing left out')
  for (const b of ['flight-recorder', 'switchboard', 'hud']) await toggle($, b)
  expect(await report()).toContain('desktop: 99 cells (bodyColumns), the whole band takes about 100, left out: token counts')
})

test('/band-usage width wide | narrow | auto holds a layout whatever the width, kept across sessions', async ($, on) => {
  mock.store(on, {})
  await busy($, on)
  const words = async (bodyColumns: number) => {
    const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns } })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    return texts.some(t => t.includes('225.4k/1M'))
  }
  expect((await $.command.run({ command: 'band-usage', args: 'width wide' })).text).toMatch(/stays wide/)
  expect(await words(59)).toBe(true)
  expect(await widthReport($)).toContain('terminal: 59 cells (bodyColumns), the whole band takes about 79, nothing left out')
  await $.command.run({ command: 'band-usage', args: 'width narrow' })
  expect(await words(140)).toBe(false)
  const narrow = await widthReport($)
  expect(narrow).toContain('left out: token counts, 💰, context bar, reset countdowns')
  expect(narrow).toContain('Layout: narrow')
  expect((await $.command.run({ command: 'band-usage', args: 'width auto' })).text).toMatch(/shows what fits/)
  expect([await words(59), await words(140)]).toEqual([false, true])
  expect((await $.command.run({ command: 'band-usage', args: 'width huge' })).text).toMatch(/width auto \| wide \| narrow/)
})

test('a layout set with /band-usage width stays in a new session', async ($, on) => {
  beneath(on)
  mock.store(on, { layout: 'wide' })
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await measure($)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 59 } })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text).some(t => t.includes('1.0k/200.0k'))).toBe(true)
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
  // a band with no room keeps each number alone: context % with no bar or tokens, and the cache
  // without its word beside Robo (the terminal, with no Robo, keeps the word); before a response
  // counts, the time stays, as it is all the cache has to show
  for (const surface of ['desktop', 'terminal'] as const) {
    const narrow = await $.ui.mount({ plugin: 'usage-band', surface, component: 'AbovePrompt', props: { ...PROPS, bodyColumns: 20 } })
    const texts = (await narrow.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain(surface === 'desktop' ? '60m' : 'warm 60m')
    expect(texts).toContain('1%')
    expect(texts).toContain('$0.44')
    expect(texts.some(t => t.includes('▰') || t.includes('1.0k') || t.includes('💰'))).toBe(false)
    await narrow.unmount()
  }
})

test('the model shows from the session start, and a /model switch shows at once', async ($, on) => {
  mock.store(on, {})
  mock.clock(on)
  on('command.register', () => ({ value: undefined }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('classic.PostModelSwitch', () => ({}))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  beneath(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await measure($)
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text)).toContain('opus 5.5')
  await ui.unmount()
  // a /model switch shows the new model at once, before the next request
  await $.classic.PostModelSwitch({ to_model: 'claude-sonnet-5-5', source: 'command' } as never)
  const after = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const texts = (await after.findAll({ type: 'Text' })).map(t => t.text)
  expect(texts).toContain('sonnet 5.5')
  expect(texts).not.toContain('opus 5.5')
  await after.unmount()
})
