import { expect, test } from 'claude-code/testing'

// Each hook here stands for the engine beneath the mod
function engine(on, usd: () => number) {
  on('session.cwd', () => ({ value: '/project' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { context: { window: 200000, percent: 34 }, rateLimits: [], cost: { usd: usd() } } }))
  on('command.register', () => ({ value: undefined }))
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

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.find({ type: 'Text', text: /Opus 5\.5 · 1 turn$/ }))?.text).toBe('Opus 5.5 · 1 turn')
    expect(await ui.find({ type: 'Text', text: /^34%/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\$0\.35  this session$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^\$0\.250  last turn$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /last \$0\.250/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /✎ app\/main\.py/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /3 calls/ })).toBeTruthy()
    // The running command shows with the key hidden and the project path trimmed
    expect((await ui.find({ type: 'Text', text: /▶/ }))?.text).toBe('▶ Bash: curl -H "x-api-key: [ANTHROPIC KEY]" x')
    // CONTEXT and COST each fill their half's height off the terminal, so they're always equal
    const grown = (await ui.findAll({ type: 'Box' })).filter(box => box.props.borderStyle === 'round' && box.props.flexGrow === 1)
    expect(grown).toHaveLength(surface === 'terminal' ? 0 : 2)
    // one turn draws one 12px bar at its own size, not scaled up to the card
    if (surface === 'desktop' || surface === 'mobile') {
      const turns = (await ui.findAll({ type: 'Svg' })).find(svg => svg.props.alt === '1 turns')
      expect(turns).toBeDefined()
      expect([turns?.props.width, turns?.props.height]).toEqual([16, 32])
    }
    expect(await ui.find({ type: 'Text', text: /BUDGET/ })).toBeFalsy()
    // Desktop and mobile lay out in pixels: bars are Svg, not block characters
    if (surface === 'desktop' || surface === 'mobile') expect(await ui.find({ type: 'Svg' })).toBeTruthy()
    // Only the terminal lays out in cells; a Raster anywhere else means the wrong layout branch
    if (surface !== 'terminal') expect(await ui.find({ type: 'Raster' })).toBeFalsy()
    await ui.unmount()
  }
})

test('NOW shows one line of a long command, cut at 60 characters', async ($, on) => {
  engine(on, () => 0)
  await $.session.start({ cwd: '/project', surface: null, isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'python3 -I - "$F" <<EOF ' + 'x'.repeat(80) + '\nimport sys\nEOF' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    const row = (await ui.find({ type: 'Text', text: /▶/ }))?.text ?? ''
    expect(row).not.toContain('import sys')
    expect(row).toBe('▶ Bash: python3 -I - "$F" <<EOF ' + 'x'.repeat(59 - 'Bash: python3 -I - "$F" <<EOF '.length) + '…')
    await ui.unmount()
  }
})

