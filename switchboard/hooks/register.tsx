import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModInfo, Tab } from '../types'
import { loadPlugins, loadServers, loadSkills, serverOf, switchPlugin, switchServer, switchSkill } from './sources'

const SELF = 'switchboard'
// U+2800 draws nothing yet is not whitespace, so no surface trims it away
const BLANK = '\u2800'.repeat(6)
const PANE = 'switchboard'

const tab = atom({ plugin: 'switchboard', key: 'tab' } as const, 'mods')
// The same state sources.ts writes; a file reads only atoms declared in it.
const plugins = atom({ plugin: 'switchboard', key: 'plugins' } as const, [])
const skills = atom({ plugin: 'switchboard', key: 'skills' } as const, [])
const skillDeny = atom({ plugin: 'switchboard', key: 'skillDeny' } as const, [])
const servers = atom({ plugin: 'switchboard', key: 'servers' } as const, [])
const mcpOff = atom({ plugin: 'switchboard', key: 'mcpOff' } as const, [])
const notice = atom({ plugin: 'switchboard', key: 'notice' } as const, '')
const TABS: readonly [Tab, string][] = [['mods', 'Mods'], ['plugins', 'Plugins'], ['skills', 'Skills'], ['mcp', 'MCP']]

async function loadTab($: Engine, which: Tab) {
  if (which === 'mods') await scanLoadedMods($)
  if (which === 'plugins') await loadPlugins($)
  if (which === 'skills') await loadSkills($)
  if (which === 'mcp') await loadServers($)
}

const mods = atom({ plugin: 'switchboard', key: 'mods' } as const, [])
const off = atom({ plugin: 'switchboard', key: 'off' } as const, [])
const hidden = atom({ plugin: 'switchboard', key: 'hidden' } as const, [])
// mods whose hooks.json Switchboard has pointed at its no-op stub
const stubbed = atom({ plugin: 'switchboard', key: 'stubbed' } as const, [])

const STUB = 'switchboard-off.ts'
const STUB_SOURCE = `// Written by Switchboard: this mod is switched off. /hud-switchboard on <name> restores it.
export const register = () => {}
`

type Backup = { root: string; text: string }
// pane id -> the plugin that opened it, learned from ui.open
const panes = atom({ plugin: 'switchboard', key: 'panes' } as const, {})

const upsert = (list: ModInfo[], mod: ModInfo) => {
  const rest = list.filter(one => one.name !== mod.name)

  return [...rest, mod].sort((a, b) => a.name.localeCompare(b.name))
}

const toggle = (list: string[], name: string, isOn: boolean) =>
  isOn ? list.filter(one => one !== name) : [...new Set([...list, name])]


export const register: Register = on => {
  // The off switch: refuses a switched-off mod each time it loads or reloads.
  // Only mods admitted after Switchboard pass through here.
  on('plugin.register', async ($, e, next) => {
    if (e.tier === 'builtin' || e.name === SELF) {
      return next(e)
    }

    const offList = ((await $.store.get('off')) as string[] | undefined) ?? []
    const isRefused = offList.includes(e.name)
    const description = await readDescription($, e.root)
    await update($, mods, list =>
      upsert(list, {
        name: e.name,
        root: e.root,
        provenance: e.provenance,
        tier: e.tier,
        version: e.version,
        description,
        events: e.uses.events.length,
        isJudged: true,
        isRefused,
      }),
    )

    return isRefused ? { refuse: 'switched off in Switchboard (/hud-switchboard)' } : next(e)
  })

  // The hide switch: a hidden mod's panes are not opened.
  on('ui.open', async ($, e, next) => {
    const owner = next.origin.plugin
    if (owner !== SELF && owner !== 'engine') {
      await update($, panes, map => ({ ...map, [e.id]: owner }))
      if ((await read($, hidden)).includes(owner)) {
        return { deny: `${owner} panels hidden in Switchboard (/hud-switchboard)` }
      }
    }

    return next(e)
  })

  // A hidden mod's pane that is already open draws a one-line stub instead.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const owner = (await read($, panes))[e.requestId]
    if (owner === undefined || !(await read($, hidden)).includes(owner)) {
      return next(e)
    }
    const { Text } = $.ui.resolve(e)

    return <Text dimColor>Hidden by Switchboard. /hud-switchboard to show {owner} again.</Text>
  })

  // The MCP switch: refuses every call to a switched-off server's tools.
  on('tool.call', async ($, e, next) => {
    const server = serverOf(e.tool)
    if (server !== undefined && (await read($, mcpOff)).includes(server)) {
      return { deny: `The MCP server ${server} is switched off in Switchboard (/hud-switchboard).` }
    }

    return next(e)
  })

  // Tells the model up front, so it does not try a switched-off server's tools.
  on('tool.describe', async ($, e, next) => {
    const server = serverOf(e.tool)
    if (server === undefined || !(await read($, mcpOff)).includes(server)) {
      return next(e)
    }

    return next({ ...e, description: `[Switched off by the user in Switchboard: calls are refused.] ${e.description}` })
  })

  on('session.start', async ($, e, next) => {
    const storedOff = ((await $.store.get('off')) as string[] | undefined) ?? []
    const storedHidden = ((await $.store.get('hidden')) as string[] | undefined) ?? []
    const storedMcpOff = ((await $.store.get('mcpOff')) as string[] | undefined) ?? []
    await update($, off, () => storedOff)
    await update($, hidden, () => storedHidden)
    await update($, mcpOff, () => storedMcpOff)
    await scanLoadedMods($)
    await enforceOff($)
    await $.command.register({
      name: 'hud-switchboard',
      description: 'Switchboard: switch mods, plugins, skills and MCP servers on or off',
      argumentHint: '[on|off|hide|show <mod>]',
      immediate: true,
    })

    return next(e)
  })

  on('command.run', { command: 'hud-switchboard' }, async ($, e) => {
    const [verb, name] = e.args.trim().split(/\s+/)
    if (verb && name) {
      const text = await apply($, verb, name)

      return { text }
    }
    await loadTab($, await read($, tab))
    await $.ui.open({ id: PANE, title: 'Switchboard', focus: true, closeOnEscape: true })

    return { text: 'Switchboard opened.' }
  })

  // usage-band's switchboard button: opens the panel straight from the press,
  // so no command shows in the transcript, and takes the press.
  on('ui.press', { plugin: 'usage-band', element: 'switchboard' }, async ($, e) => {
    await loadTab($, await read($, tab))
    await $.ui.open({ id: PANE, title: 'Switchboard', focus: true, closeOnEscape: true })

    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    // The terminal is the one surface without Svg.
    const Svg = e.surface === 'terminal' || !('Svg' in elements) ? undefined : elements.Svg
    const current = await read($, tab)
    const problem = await read($, notice)
    // Off the terminal the pane wears ribbon's card: warm surface, cream titles, muted text;
    // the terminal keeps its theme's colours
    const card = Svg !== undefined
    const ink = card ? RIBBON.text : undefined
    const muted = card ? RIBBON.muted : undefined

    // On a surface with Svg the control is the drawing, pressed through a
    // Button laid over it; the terminal draws the glyph switch instead.
    const control = (key: string, label: string, svg: string, size: [number, number], glyphs: ReturnType<typeof h>, onPress: () => void) =>
      Svg === undefined ? (
        <Button key={key} label={label} plain onPress={onPress}>
          {glyphs}
        </Button>
      ) : (
        <Box key={`${key}-site`} position="relative">
          {/* A set size: left out, the desktop fits the drawing to the room its row leaves,
              so a long summary shrank the pill or squeezed it out */}
          <Svg source={svg} alt={label} width={size[0]} height={size[1]} />
          <Box position="absolute" top={0} left={0} right={0} bottom={0}>
            {/* No label: the desktop draws it over the drawing; the Svg's alt names it.
                Blank Braille cells give the button the drawing's width: a plain
                space collapses to nothing to click. */}
            <Button key={key} plain onPress={onPress}>
              {BLANK}
            </Button>
          </Box>
        </Box>
      )

    const switchControl = (key: string, name: string, isOn: boolean, onPress: () => void) =>
      control(
        key,
        isOn ? `Switch ${name} off` : `Switch ${name} on`,
        switchSvg(isOn, card),
        [44, 26],
        isOn
          ? <Text color="success" weight="semibold">━━● ON </Text>
          : <Text color="inactive">○── OFF</Text>,
        onPress,
      )

    type Row = {
      key: string
      title: string
      isOn: boolean
      summary?: string
      hint?: string
      status?: string
      extra?: ReturnType<typeof h>
      onToggle: () => void
    }
    const row = (one: Row) => (
      <Box key={`row-${one.key}`} flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={1}>
        {/* The text gives way (its summary truncates); the controls keep their size */}
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text weight="semibold" color={one.isOn ? ink : muted} dimColor={!card && !one.isOn}>{one.title}</Text>
          {one.summary !== undefined && <Text color={muted} dimColor={!card} wrap="truncate-end">{one.summary}</Text>}
          {one.hint !== undefined && <Text color={card ? RIBBON.yellow : undefined} dimColor={!card} italic>{one.hint}</Text>}
          {one.status !== undefined && <Text color={muted} dimColor={!card} size="footnote">{one.status}</Text>}
        </Box>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          {one.extra}
          {switchControl(one.key, one.title, one.isOn, one.onToggle)}
        </Box>
      </Box>
    )

    const header = (active: number, total: number, words: [string, string] = ['on', 'off']) => (
      <Box flexDirection="row" justifyContent="flex-end" marginBottom={1}>
        {/* the card's label style: uppercase, bold, muted */}
        <Text color={muted} dimColor={!card} weight={card ? 'bold' : undefined}>
          {card ? `${active} ${words[0]} · ${total - active} ${words[1]}`.toUpperCase() : `${active} ${words[0]} · ${total - active} ${words[1]}`}
        </Text>
      </Box>
    )

    const body = async () => {
      if (current === 'plugins') {
        const list = await read($, plugins)
        if (list.length === 0) return <Text dimColor>No installed plugins found.</Text>

        return (
          <Box flexDirection="column">
            {header(list.filter(one => one.isEnabled).length, list.length, ['enabled', 'disabled'])}
            {list.map(one =>
              row({
                key: `plugin-${one.id}`,
                title: one.id,
                isOn: one.isEnabled,
                summary: shortDescription(one.description),
                status: one.isEnabled === one.wasEnabled ? undefined : one.isEnabled ? 'on from your next session' : 'off from your next session',
                onToggle: () => void switchPlugin($, one.id, !one.isEnabled),
              }),
            )}
            <Text dimColor size="footnote">Uses claude plugin enable/disable · applies to new sessions</Text>
          </Box>
        )
      }

      if (current === 'skills') {
        const list = await read($, skills)
        const deny = await read($, skillDeny)
        if (list.length === 0) return <Text dimColor>No skills found.</Text>

        return (
          <Box flexDirection="column">
            {header(list.filter(one => !deny.includes(one.name)).length, list.length, ['allowed', 'blocked'])}
            {list.map(one =>
              row({
                key: `skill-${one.name}`,
                title: one.name,
                isOn: !deny.includes(one.name),
                summary: shortDescription(one.description),
                hint: `/${one.name}`,
                status: one.source,
                onToggle: () => void switchSkill($, one.name, deny.includes(one.name)),
              }),
            )}
            <Text dimColor size="footnote">Off adds Skill(name) to permissions.deny in ~/.claude/settings.json</Text>
          </Box>
        )
      }

      if (current === 'mcp') {
        const list = await read($, servers)
        const offList = await read($, mcpOff)
        if (list.length === 0) return <Text dimColor>No MCP tools available to Claude right now.</Text>

        return (
          <Box flexDirection="column">
            {header(list.filter(one => !offList.includes(one.id)).length, list.length)}
            {list.map(one =>
              row({
                key: `mcp-${one.id}`,
                title: serverTitle(one.id),
                isOn: !offList.includes(one.id),
                summary: one.tools.length === 0 ? 'no tools listed now' : `${one.tools.length} tools: ${one.tools.slice(0, 4).join(', ')}${one.tools.length > 4 ? '…' : ''}`,
                onToggle: () => void switchServer($, one.id, offList.includes(one.id)),
              }),
            )}
            <Text dimColor size="footnote">Off: Switchboard refuses Claude's calls to that server</Text>
          </Box>
        )
      }

      const list = await read($, mods)
      const offList = await read($, off)
      const hiddenList = await read($, hidden)
      const stubbedList = await read($, stubbed)
      const paneOwners = new Set(Object.values(await read($, panes)))
      const commands = await $.command.list()
      if (list.length === 0) return <Text dimColor>No mods found besides Switchboard.</Text>

      return (
        <Box flexDirection="column">
          {header(list.filter(mod => !offList.includes(mod.name)).length, list.length, ['running', 'off'])}
          {list.map(mod => {
            const isOn = !offList.includes(mod.name)
            const isShown = !hiddenList.includes(mod.name)
            const command = commands.find(one => one.plugin === mod.name)?.name

            return row({
              key: `on-${mod.name}`,
              title: mod.name,
              isOn,
              summary: shortDescription(mod.description),
              hint: command === undefined ? undefined : `/${command}`,
              status: isOn
                ? undefined
                : stubbedList.includes(mod.name)
                  ? isLive(mod.root) ? 'off (hooks stubbed)' : 'off from your next session'
                  : mod.isRefused ? 'off (refused at load)' : 'off: could not stub its hooks.json',
              extra: paneOwners.has(mod.name) || !isShown
                ? control(
                    `panel-${mod.name}`,
                    isShown ? `Hide ${mod.name} panels` : `Show ${mod.name} panels`,
                    eyeSvg(isShown, card),
                    [28, 26],
                    isShown
                      ? <Text color="suggestion">◉ panels</Text>
                      : <Text color="inactive" strikethrough>◌ panels</Text>,
                    () => void apply($, isShown ? 'hide' : 'show', mod.name),
                  )
                : undefined,
              onToggle: () => void apply($, isOn ? 'off' : 'on', mod.name),
            })
          })}
          <Text dimColor size="footnote">New mods appear on their first load</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" {...(card ? { backgroundColor: RIBBON.card, padding: 2 } : {})}>
        <Box flexDirection="row" columnGap={1} marginBottom={1}>
          {TABS.map(([id, label], index) => (
            <Button
              key={`tab-${id}`}
              label={label}
              hotkey={String(index + 1)}
              variant={id === current ? 'primary' : 'secondary'}
              onPress={async () => {
                await update($, tab, () => id)
                await update($, notice, () => '')
                await loadTab($, id)
              }}
            />
          ))}
        </Box>
        {problem !== '' && <Text color="warning">{problem}</Text>}
        {await body()}
        <Text color={muted} dimColor={!card} size="footnote">1-4 switch tabs · Esc closes</Text>
      </Box>
    )
  })
}

// ribbon's card colours (the /hud-cache card): surface, text, labels, unlit, the warm accent
const RIBBON = { card: '#24221c', text: '#e8e2d2', muted: '#8d8775', empty: '#4a463b', warm: '#cc6363', yellow: '#f5a623' }

// Connectors have a UUID for a server name; show them shorter.
const serverTitle = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) ? `connector ${id.slice(0, 8)}` : id.replace(/^claude_ai_/, '')

const shortDescription = (text: string | undefined) => {
  const first = text?.split(/\s\(|\.\s|:\s/)[0]
  if (!first) return undefined

  return first.length > 72 ? `${first.slice(0, 71)}…` : first
}

// On the ribbon card: a warm track with a cream knob when on, an unlit one when off
const switchSvg = (isOn: boolean, card = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="26" viewBox="0 0 44 26">` +
  `<rect x="1" y="1" width="42" height="24" rx="12" fill="${card ? (isOn ? RIBBON.warm : RIBBON.empty) : isOn ? '#30A46C' : '#5B5B66'}"/>` +
  `<circle cx="${isOn ? 30 : 14}" cy="13" r="10" fill="${card ? (isOn ? RIBBON.text : RIBBON.muted) : '#FFFFFF'}"/></svg>`

const eyeSvg = (isShown: boolean, card = false) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="26" viewBox="0 0 28 26" fill="none" stroke="${card ? RIBBON.muted : '#8B8B95'}" stroke-width="1.5">` +
  `<rect x="1" y="1" width="26" height="24" rx="7"/>` +
  `<path d="M6 13s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5z"/><circle cx="14" cy="13" r="2" fill="${card ? RIBBON.muted : '#8B8B95'}"/>` +
  (isShown ? '' : `<line x1="7" y1="20" x2="21" y2="6"/>`) +
  `</svg>`

type Engine = EngineInterface

async function apply($: Engine, verb: string, name: string): Promise<string> {
  if (name === SELF) {
    return 'Switchboard cannot switch itself off.'
  }
  if (verb === 'on' || verb === 'off') {
    const next = toggle(await read($, off), name, verb === 'on')
    await $.store.set('off', next)
    await update($, off, () => next)
    const note = verb === 'off' ? await stub($, name) : await unstub($, name)

    return `${name} switched ${verb}. ${note}`
  }
  if (verb === 'hide' || verb === 'show') {
    const next = toggle(await read($, hidden), name, verb === 'show')
    await $.store.set('hidden', next)
    await update($, hidden, () => next)

    return `${name} panels ${verb === 'hide' ? 'hidden' : 'shown'}.`
  }

  return `Unknown action "${verb}". Use on, off, hide or show.`
}

// Only a session's own dev-mods folder reloads when its files change; mods
// from CLAUDE_CODE_PLUGIN_DIRS and installed plugins load at session start.
const isLive = (root: string) => root.includes('/.claude/dev-mods/')
const reloadNote = (root: string) => (isLive(root) ? '' : ' Takes effect in your next session.')

// The off switch that does not depend on load order: back up the mod's
// hooks.json, then point it at a module that registers nothing.
async function stub($: Engine, name: string): Promise<string> {
  const root = (await read($, mods)).find(mod => mod.name === name)?.root
  const file = `${root}/hooks/hooks.json`
  if (root === undefined || !(await $.fs.exists(file))) {
    return `No hooks/hooks.json found for ${name}: it stays loaded until it reloads after Switchboard.`
  }
  const text = await $.fs.read(file)
  if (!text.includes(STUB)) {
    const backup: Backup = { root, text }
    await $.store.set(`backup:${name}`, backup)
    await $.fs.write(`${root}/hooks/${STUB}`, STUB_SOURCE)
    await $.fs.write(file, `{ "modules": ["./${STUB}"] }\n`)
  }
  await update($, stubbed, list => toggle(list, name, false))

  return `Its hooks are stubbed.${reloadNote(root)}`
}

async function unstub($: Engine, name: string): Promise<string> {
  const backup = (await $.store.get(`backup:${name}`)) as Backup | undefined
  await update($, stubbed, list => toggle(list, name, true))
  if (backup === undefined) {
    return 'It takes effect at its next load.'
  }
  await $.fs.write(`${backup.root}/hooks/hooks.json`, backup.text)
  await $.store.delete(`backup:${name}`)

  return `Its hooks.json is restored.${reloadNote(backup.root)}`
}

// At each load, stubs any mod on the off list whose hooks are live again.
async function enforceOff($: Engine) {
  for (const name of await read($, off)) {
    await stub($, name)
  }
}

// Finds the mods this session loads from folders (CLAUDE_CODE_PLUGIN_DIRS and
// this session's dev-mods folder), so ones admitted before Switchboard, which
// never passed its plugin.register hook, are listed too.
async function scanLoadedMods($: Engine) {
  const home = (await $.env.get('HOME')) ?? ''
  const roots = ((await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '')
    .split(':')
    .filter(Boolean)
    .map(dir => dir.replace(/^~(?=\/|$)/, home).replace(/\/$/, ''))
  const devMods = `${home}/.claude/dev-mods/${await $.session.id()}`
  try {
    for (const dir of await $.fs.list(devMods)) {
      if (dir.kind === 'dir') roots.push(`${devMods}/${dir.name}`)
    }
  } catch {
    // no dev-mods folder in this session
  }

  const found: ModInfo[] = []
  for (const root of roots) {
    try {
      const manifest = JSON.parse(await $.fs.read(`${root}/.claude-plugin/plugin.json`)) as {
        name?: string
        version?: string
        description?: string
      }
      if (manifest.name && manifest.name !== SELF) {
        found.push({
          name: manifest.name,
          root,
          provenance: `${manifest.name}@inline`,
          tier: 'user',
          version: manifest.version,
          description: manifest.description,
          events: 0,
          isJudged: false,
          isRefused: false,
        })
      }
    } catch {
      // not a mod folder
    }
  }
  await update($, mods, list =>
    found.reduce((acc, mod) => (acc.some(one => one.name === mod.name) ? acc : upsert(acc, mod)), list),
  )
}

async function readDescription($: Engine, root: string) {
  try {
    const manifest = JSON.parse(await $.fs.read(`${root}/.claude-plugin/plugin.json`)) as { description?: string }

    return manifest.description
  } catch {
    return undefined
  }
}
