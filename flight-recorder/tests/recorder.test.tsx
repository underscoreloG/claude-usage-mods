import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Flight recorder',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

async function drain<C, R>(stream: AsyncGenerator<C, R> & { result: Promise<R> }): Promise<R> {
  for await (const _ of stream) {
    // read the stream to its end
  }
  return stream.result
}

const USAGE =(model: string) => ({
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_input_tokens: 8000,
  cache_creation_input_tokens: 500,
  model,
})

test('records main + subagent lanes, requests, tools and cost', async ($, on) => {
  const clock = mock.clock(on)
  let usd = 1
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd } } }))
  on('agent.list', () => ({ value: [] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_$, e) {
    usd += 0.25
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: USAGE(e.model) }
  })
  on('tool.call', () => ({ result: 'ok' }))

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.advance(1000)
  await drain($.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 }))
  await $.tool.call({ tool: 'Read', file_path: 'a.txt', tool_use_id: 'tu1' })
  await $.turn.start({ text: 'explore', turnId: 's1', agentId: 'abcd1234' })
  await clock.advance(2000)
  await drain($.turn.step({ turnId: 's1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1, agentId: 'abcd1234' }))
  await $.turn.complete({ turnId: 's1', agentId: 'abcd1234', reason: 'answer', answer: '', durationMs: 2000, isAborted: false })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 3000, isAborted: false })

  // terminal: text timeline
  const term = await $.ui.mount({ plugin: 'flight-recorder', surface: 'terminal', component: 'Pane', requestId: 'flight-recorder', props: PANE_PROPS })
  const header = (await term.find({ type: 'Text', text: /TURN 1/ }))?.text ?? ''
  expect(header).toContain('2 req')
  expect(header).toContain('1 tools')
  expect(header).toContain('20.0k tok')
  expect(header).toContain('1 agents')
  expect(header).toContain('$0.500')
  expect(await term.find({ type: 'Text', text: /agent abcd/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: 'idle' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /MODELS.*opus 50%.*sonnet 50%/ })).toBeDefined()
  await term.unmount()

  // desktop: analytics SVG with hover tooltips
  const desk = await $.ui.mount({ plugin: 'flight-recorder', surface: 'desktop', component: 'Pane', requestId: 'flight-recorder', props: PANE_PROPS })
  await desk.press({ key: 'view-dashboard' })
  const svgEl = await desk.find({ type: 'Svg' })
  const svg = String(svgEl?.props.source ?? '')
  expect(svgEl?.props.isInteractive).toBe(true)
  expect(String(svgEl?.props.alt)).toContain('Turn 1: $0.500, 2 requests, 1 tool calls')
  expect(svg).toContain('Turn 1')
  expect(svg).toContain('Tokens by model')
  // hovering the Read tick shows the file it read; a request shows tokens and cache
  expect(svg).toMatch(/<title>Read · [^<]*main\na\.txt<\/title>/)
  expect(svg).toMatch(/<title>claude-opus-5-5 · [^<]*\n9\.5k in \(84% cached\)/)
  // the donut has one slice per model, each with a tooltip
  expect(svg).toMatch(/<title>opus: 10\.0k tokens \(50%\), 1 requests<\/title>/)
  expect(svg).toMatch(/<title>sonnet: 10\.0k tokens \(50%\), 1 requests<\/title>/)
  expect(svg).toMatch(/<title>Read: 1 calls \(read\)<\/title>/)
  // hovering a whole lane shows that agent's summary
  expect(svg).toMatch(/<title>agent abcd · finished\n1 requests \(sonnet\) · 0 tool calls · 10\.0k tokens<\/title>/)
  // tool ticks are colored by kind (read = yellow)
  expect(svg).toContain('fill="#c98500"')
  await desk.unmount()
})

test('pane still draws when the surface reports no bodyColumns', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const props = { ...PANE_PROPS, bodyColumns: undefined as unknown as number }
  const term = await $.ui.mount({ plugin: 'flight-recorder', surface: 'terminal', component: 'Pane', requestId: 'flight-recorder', props })
  expect(await term.find({ type: 'Text', text: /TURN 1/ })).toBeDefined()
  await term.unmount()
  const desk = await $.ui.mount({ plugin: 'flight-recorder', surface: 'desktop', component: 'Pane', requestId: 'flight-recorder', props })
  await desk.press({ key: 'view-dashboard' })
  expect(String((await desk.find({ type: 'Svg' }))?.props.source)).toContain('Turn 1')
})

test('second turn lists the first under previous turns', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.start({ text: 'one', turnId: 't1' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: '', durationMs: 1, isAborted: false })
  await $.turn.start({ text: 'two', turnId: 't2' })
  const term = await $.ui.mount({ plugin: 'flight-recorder', surface: 'terminal', component: 'Pane', requestId: 'flight-recorder', props: PANE_PROPS })
  expect(await term.find({ type: 'Text', text: /TURN 2/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^T1 / })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /failed to draw/ })).toBeUndefined()
  await term.unmount()
  // desktop: cost-per-turn chart has a column for each turn
  const desk = await $.ui.mount({ plugin: 'flight-recorder', surface: 'desktop', component: 'Pane', requestId: 'flight-recorder', props: PANE_PROPS })
  await desk.press({ key: 'view-dashboard' })
  const svg = String((await desk.find({ type: 'Svg' }))?.props.source)
  expect(svg).toContain('Turn 2')
  expect(svg).toMatch(/<title>Turn 1: /)
  expect(svg).toMatch(/<title>Turn 2: /)
})

test('pane waits for the first turn', async $ => {
  const ui = await $.ui.mount({ plugin: 'flight-recorder', surface: 'terminal', component: 'Pane', requestId: 'flight-recorder', props: PANE_PROPS })
  expect(await ui.find({ type: 'Text', text: /Waiting for the first turn/ })).toBeDefined()
})

test("usage-band's ✈ press opens the pane without running the command", async ($, on) => {
  const opened: string[] = []
  const ran: string[] = []
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('command.run', (_$, e) => {
    ran.push(e.command)
    return { text: '' }
  })
  // stands in for usage-band's ✈ button; its own onPress (the command fallback) must not run
  on('ui.render', { component: 'AbovePrompt' }, ($$, e) => {
    const { Button } = $$.ui.resolve(e)
    return <Button key="flight-recorder" label="✈" onPress={() => void ran.push('onPress')} />
  })
  const band = await $.ui.mount({
    plugin: 'test',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  await band.press({ key: 'flight-recorder' })
  expect(opened).toEqual(['flight-recorder'])
  expect(ran).toEqual([])
})

test('desktop opens on the live text view, with a Text | Dashboard toggle', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const desk = await $.ui.mount({ plugin: 'flight-recorder', surface: 'desktop', component: 'Pane', requestId: 'flight-recorder', props: PANE_PROPS })
  expect(await desk.find({ type: 'Text', text: /TURN 1/ })).toBeDefined()
  expect(await desk.find({ type: 'Svg' })).toBeUndefined()
  expect(await desk.find({ type: 'Button', key: 'view-text' })).toBeDefined()
  await desk.press({ key: 'view-dashboard' })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.press({ key: 'view-text' })
  expect(await desk.find({ type: 'Svg' })).toBeUndefined()
  // the terminal has no dashboard, so no toggle there
  const term = await $.ui.mount({ plugin: 'flight-recorder', surface: 'terminal', component: 'Pane', requestId: 'flight-recorder', props: PANE_PROPS })
  expect(await term.find({ type: 'Button' })).toBeUndefined()
})

test('/flight-recorder dashboard and text switch the desktop view', async ($, on) => {
  mock.clock(on)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [], cost: { usd: 0 } } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect((await $.command.run({ command: 'flight-recorder', args: 'dashboard' } as never)).text).toBe('Flight recorder opened (dashboard view).')
  const desk = await $.ui.mount({ plugin: 'flight-recorder', surface: 'desktop', component: 'Pane', requestId: 'flight-recorder', props: PANE_PROPS })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await $.command.run({ command: 'flight-recorder', args: 'text' } as never)
  expect(await desk.find({ type: 'Svg' })).toBeUndefined()
})
