import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'switchboard',
  component: 'Pane',
  requestId: 'switchboard',
  props: {
    title: 'Switchboard',
    isFocused: true,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const entry = (name: string) => ({ name, kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false })
const run = (args: string) => ({
  command: 'switchboard',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})
const HOOKS = '{ "modules": ["./register.tsx"] }\n'

test('off stubs a mod\'s hooks.json, on restores it, switches persist', async ($, on) => {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : e.name === 'CLAUDE_CODE_PLUGIN_DIRS' ? '~/.claude/mods/tidy' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.list', (_, e) => ({ value: e.path === '/home/me/.claude/dev-mods/sess-1' ? [entry('noisy'), entry('switchboard')] : [] }))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('/noisy/hooks/hooks.json') }))
  on('fs.read', (_, e) => ({
    value: e.path.endsWith('hooks.json')
      ? (files.get(e.path) ?? HOOKS)
      : JSON.stringify({ name: e.path.split('/').at(-3), version: '0.2.0' }),
  }))
  on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on('command.register', () => ({ value: { command: 'switchboard' } }))
  on('command.list', () => ({ value: [{ name: 'noisy-log', description: 'Opens the log', source: 'plugin', plugin: 'noisy' }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /noisy/ }))?.text).toContain('noisy')
    expect((await ui.find({ type: 'Text', text: /tidy/ }))?.text).toContain('tidy')
    expect(await ui.find({ type: 'Text', text: /^ switchboard/ })).toBeUndefined()
    await ui.unmount()
  }

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await desk.find({ type: 'Svg' }))?.props.alt).toBe('Switch noisy off')
  await desk.press({ key: 'on-noisy' })
  expect(store.get('off')).toEqual(['noisy'])
  expect((await desk.find({ type: 'Svg' }))?.props.alt).toBe('Switch noisy on')
  await desk.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Button', key: 'panel-noisy' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /OFF/ }))?.text).toBe('○── OFF')
  expect((await ui.find({ type: 'Text', text: /noisy-log/ }))?.text).toBe('/noisy-log')
  await $.command.run(run('hide noisy'))
  expect(store.get('hidden')).toEqual(['noisy'])
  const hooksFile = [...files.keys()].find(path => path.endsWith('/noisy/hooks/hooks.json'))
  expect(hooksFile).toBeDefined()
  expect(files.get(hooksFile!)).toContain('switchboard-off.ts')
  expect([...files.keys()].some(path => path.endsWith('/noisy/hooks/switchboard-off.ts'))).toBe(true)
  expect(store.get('backup:noisy')).toMatchObject({ text: HOOKS })
  expect((await ui.find({ type: 'Text', text: /hooks stubbed/ }))?.text).toContain('off (hooks stubbed)')
  expect((await ui.find({ type: 'Text', text: /panels/ }))?.text).toBe('◌ panels')
  await ui.press({ key: 'panel-noisy' })
  expect(store.get('hidden')).toEqual([])
  await ui.unmount()

  const back = await $.command.run(run('on noisy'))
  expect(back.text).toMatch(/noisy switched on\. Its hooks.json is restored/)
  expect(back.text).not.toMatch(/reload|new session/)
  expect(files.get(hooksFile!)).toBe(HOOKS)
  expect(store.has('backup:noisy')).toBe(false)
  expect(store.get('off')).toEqual([])

  const self = await $.command.run(run('off switchboard'))
  expect(self.text).toMatch(/cannot switch itself off/)
})

test('plugins, skills and MCP tabs switch through the CLI, deny rules and call refusal', async ($, on) => {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>([
    ['/home/me/.claude/settings.json', '{\n  "env": { "A": "1" },\n  "permissions": { "deny": ["Bash(rm:*)"] }\n}\n'],
    ['/home/me/.claude/skills/tidy/SKILL.md', '---\nname: tidy\ndescription: Tidies the desk. Long tail.\n---\nbody'],
    ['/plug/kit/.claude-plugin/plugin.json', '{ "name": "kit", "description": "A kit", "skills": ["./skills/a/one"] }'],
    ['/plug/kit/skills/a/one/SKILL.md', '---\nname: one\ndescription: >\n  Folded line\n  continued\n---\n'],
  ])
  const runs: string[][] = []
  let isKitOn = true
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.cwd', () => ({ value: '/work' }))
  on('fs.list', (_, e) => ({
    value: e.path === '/home/me/.claude/skills' ? [entry('tidy')] : [],
  }))
  on('fs.read', (_, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)

    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: files.has(e.path) }))
  on('fs.write', (_, e) => (files.set(e.path, e.text), { value: undefined }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (e.argv[2] === 'disable') isKitOn = false
    const listed = [
      { id: 'kit@market', scope: 'user', enabled: isKitOn, installPath: '/plug/kit' },
      { id: 'mymod@inline', scope: 'session', enabled: true, installPath: '/mods/mymod' },
    ]

    return { value: { exitCode: 0, stdout: JSON.stringify(listed), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: '', mcp: false },
      { name: 'mcp__mail__send', description: '', mcp: true },
      { name: 'mcp__mail__read', description: '', mcp: true },
    ],
  }))
  on('tool.call', () => ({ result: {} }))
  on('command.register', () => ({ value: { command: 'switchboard' } }))
  on('command.list', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/work', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Plugins: session-scope mods stay out; a switch runs the CLI.
  await ui.press({ key: 'tab-plugins' })
  expect((await ui.find({ type: 'Text', text: /kit@market/ }))?.text).toBe('kit@market')
  expect(await ui.find({ type: 'Text', text: /mymod/ })).toBeUndefined()
  await ui.press({ key: 'plugin-kit@market' })
  expect(runs.some(argv => argv.join(' ') === 'claude plugin disable kit@market')).toBe(true)
  expect((await ui.find({ type: 'Text', text: /next session/ }))?.text).toBe('off from your next session')

  // Skills: user and plugin skills; off writes one deny rule and keeps the rest.
  await ui.press({ key: 'tab-skills' })
  expect((await ui.find({ type: 'Text', text: /^tidy$/ }))?.text).toBe('tidy')
  expect((await ui.find({ type: 'Text', text: /Tidies/ }))?.text).toBe('Tidies the desk')
  await ui.press({ key: 'skill-tidy' })
  const settings = JSON.parse(files.get('/home/me/.claude/settings.json')!)
  expect(settings.permissions.deny).toEqual(['Bash(rm:*)', 'Skill(tidy)'])
  expect(settings.env).toEqual({ A: '1' })
  expect(files.has('/home/me/.claude/settings.json.switchboard-backup')).toBe(true)
  await ui.press({ key: 'skill-tidy' })
  expect(JSON.parse(files.get('/home/me/.claude/settings.json')!).permissions.deny).toEqual(['Bash(rm:*)'])

  // MCP: servers grouped by prefix; off refuses that server's calls only.
  await ui.press({ key: 'tab-mcp' })
  expect((await ui.find({ type: 'Text', text: /2 tools/ }))?.text).toBe('2 tools: send, read')
  await ui.press({ key: 'mcp-mail' })
  expect(store.get('mcpOff')).toEqual(['mail'])
  const refused = await $.tool.call({ tool: 'mcp__mail__send', input: {} } as never)
  expect((refused as { deny?: string }).deny).toMatch(/mail is switched off/)
  const allowed = await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  expect((allowed as { deny?: string }).deny).toBeUndefined()
  await ui.unmount()
})
