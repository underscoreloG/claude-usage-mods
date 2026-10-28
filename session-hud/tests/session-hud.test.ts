import { expect, test } from 'claude-code/testing'

// Each hook here stands for the engine beneath the mod
function engine(on, usd: () => number, context: object = { window: 200000, percent: 34 }) {
  on('session.cwd', () => ({ value: '/project' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context, rateLimits: [], cost: { usd: usd() } } }))
  on('command.register', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/project' }))
  on('tool.call', () => ({ result: 'ran' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
}

const pane = (surface) => ({
  plugin: 'session-hud',
  component: 'Pane',
  requestId: 'session-hud',
  surface,
  props: { title: 'Session HUD', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
})

test('tool calls go through unchanged, however much the session cost', async ($, on) => {
  engine(on, () => 50)
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })
  expect(await $.tool.call({ tool: 'Bash', command: 'pytest' })).toEqual({ result: 'ran' })
})

test('the pane shows context, turns, tools, files and what runs now, on every surface', async ($, on) => {
  let usd = 0.1
  engine(on, () => usd)
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/project/app/main.py' })
  await $.tool.call({ tool: 'Edit', file_path: '/project/app/main.py' })
  usd = 0.35
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  // A fake key, split so secret scanners don't flag this file
  const key = 'sk-ant-' + 'abcdefgh12345678'
  await $.tool.call({ tool: 'Bash', command: 'curl -H "x-api-key: ' + key + '" /project/x' })

  // The terminal lays out in cells: text and Raster bars
  {
    const ui = await $.ui.mount(pane('terminal'))
    expect((await ui.find({ type: 'Text', text: /Opus 5\.5 · 1 turn$/ }))?.text).toBe('Opus 5.5 · 1 turn')
    expect(await ui.find({ type: 'Text', text: /^34%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\$0\.35  this session$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\$0\.250  last turn$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /last \$0\.250/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /✎ app\/main\.py/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /3 calls/ })).toBeTruthy()
    // The running command shows with the key hidden and the project path trimmed
    expect((await ui.find({ type: 'Text', text: /▶/ }))?.text).toBe('▶ Bash: curl -H "x-api-key: [ANTHROPIC KEY]" x')
    expect(await ui.find({ type: 'Text', text: /BUDGET/ })).toBeFalsy()
    expect(await ui.find({ type: 'Svg' })).toBeFalsy()
    await ui.unmount()
  }
  // Elsewhere it is one drawing in ribbon's look, scaled to the pane, with the same facts
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(pane(surface))
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs).toHaveLength(1)
    const card = svgs[0]
    expect([card?.props.width, card?.props.height]).toEqual([undefined, undefined])
    const source = String(card?.props.source)
    for (const fact of ['Opus 5.5 · 1 turn', '>34%<', '$0.35', '$0.250 last turn', 'last $0.250', 'app/main.py', '3 calls', 'Bash: curl -H &quot;x-api-key: [ANTHROPIC KEY]&quot; x']) {
      expect(source).toContain(fact)
    }
    expect(source).not.toContain('sk-ant-')
    expect(String(card?.props.alt)).toContain('34% context')
    expect(await ui.find({ type: 'Raster' })).toBeFalsy()
    await ui.unmount()
  }
})

test('NOW shows one line of a long command, cut at 60 characters', async ($, on) => {
  engine(on, () => 0)
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'python3 -I - "$F" <<EOF ' + 'x'.repeat(80) + '\nimport sys\nEOF' })
  const cut = 'Bash: python3 -I - "$F" <<EOF ' + 'x'.repeat(59 - 'Bash: python3 -I - "$F" <<EOF '.length) + '…'
  const terminal = await $.ui.mount(pane('terminal'))
  expect((await terminal.find({ type: 'Text', text: /▶/ }))?.text).toBe('▶ ' + cut)
  await terminal.unmount()
  const desktop = await $.ui.mount(pane('desktop'))
  const source = String((await desktop.find({ type: 'Svg' }))?.props.source)
  expect(source).not.toContain('import sys')
  // escaped as the drawing writes text: the <<EOF and the quotes stay text, not markup
  expect(source).toContain('>' + cut.replace(/</g, '&lt;').replace(/"/g, '&quot;') + '<')
  await desktop.unmount()
})


const cachePane = (surface) => ({ ...pane(surface), requestId: 'hud-cache', props: { ...pane(surface).props, title: 'Prompt cache' } })

test('/hud-cache shows the cache card: waiting before a reply, then cold with its idle time and prices', async ($, on) => {
  engine(on, () => 0, { tokens: 245_000, window: 1_000_000, percent: 25 })
  on('classic.SessionStart', () => ({}))
  on('clock.now', () => ({ value: 50_000_000 }))
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })
  const before = await $.ui.mount(cachePane('desktop'))
  expect((await before.findAll({ type: 'Text' })).map((t) => t.text)).toContain('The cache shows after the first reply.')
  await before.unmount()

  await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 2 * 3600 + 5 * 60 } as never)
  const desktop = await $.ui.mount(cachePane('desktop'))
  const [card] = await desktop.findAll({ type: 'Svg' })
  expect(card.props.alt).toBe('Cache cold. Idle 2h 5m. Next message re-caches 245k tokens.')
  expect(card.props.width).toBeUndefined()
  const terminal = await $.ui.mount(cachePane('terminal'))
  const texts = (await terminal.findAll({ type: 'Text' })).map((t) => t.text)
  expect(texts).toContain('COLD')
  expect(texts.some((t) => t.includes('OPUS $1.96 (you)'))).toBe(true)
})
