import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PluginRow, ServerRow, SkillRow } from '../types'

type Engine = EngineInterface

const plugins = atom({ plugin: 'switchboard', key: 'plugins' } as const, [])
const skills = atom({ plugin: 'switchboard', key: 'skills' } as const, [])
const skillDeny = atom({ plugin: 'switchboard', key: 'skillDeny' } as const, [])
const servers = atom({ plugin: 'switchboard', key: 'servers' } as const, [])
const mcpOff = atom({ plugin: 'switchboard', key: 'mcpOff' } as const, [])
// the last failure a tab ran into, shown under the tab bar
const notice = atom({ plugin: 'switchboard', key: 'notice' } as const, '')

async function home($: Engine) {
  return (await $.env.get('HOME')) ?? ''
}

async function settingsPath($: Engine) {
  return `${await home($)}/.claude/settings.json`
}

const byName = <T,>(key: (one: T) => string) => (a: T, b: T) => key(a).localeCompare(key(b))

async function subdirs($: Engine, dir: string) {
  try {
    return (await $.fs.list(dir)).filter(entry => entry.kind === 'dir').map(entry => `${dir}/${entry.name}`)
  } catch {
    return []
  }
}

async function readJson<T>($: Engine, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

// Plugins: listed and switched through the official CLI, which writes
// enabledPlugins in settings.json; a session loads its plugins at start.

type ListedPlugin = { id: string; scope: string; enabled: boolean; installPath?: string }

async function claude($: Engine, args: string[]) {
  try {
    return await $.process.run(['claude', ...args], { timeoutMs: 30000 })
  } catch {
    return await $.process.run([`${await home($)}/.local/bin/claude`, ...args], { timeoutMs: 30000 })
  }
}

export async function loadPlugins($: Engine) {
  const ran = await claude($, ['plugin', 'list', '--json'])
  if (ran.exitCode !== 0) {
    await update($, notice, () => `claude plugin list failed: ${ran.stderr.trim().slice(0, 160)}`)
    return
  }
  const before = await read($, plugins)
  const rows: PluginRow[] = []
  // `session` scope is this session's --plugin-dir mods: the Mods tab's.
  for (const listed of (JSON.parse(ran.stdout) as ListedPlugin[]).filter(one => one.scope !== 'session')) {
    const root = listed.installPath
    const manifest = root ? await readJson<{ description?: string }>($, `${root}/.claude-plugin/plugin.json`) : undefined
    rows.push({
      id: listed.id,
      root,
      description: manifest?.description,
      isEnabled: listed.enabled,
      wasEnabled: before.find(one => one.id === listed.id)?.wasEnabled ?? listed.enabled,
    })
  }
  await update($, plugins, () => rows.sort(byName(one => one.id)))
}

export async function switchPlugin($: Engine, id: string, isOn: boolean) {
  const ran = await claude($, ['plugin', isOn ? 'enable' : 'disable', id])
  await update($, notice, () => (ran.exitCode === 0 ? '' : `${id}: ${ran.stderr.trim().slice(0, 160)}`))
  await loadPlugins($)
}

// Skills: found on disk (user, project, and each enabled plugin's), switched
// by a Skill(<name>) rule in the user settings' permissions.deny.

function frontmatter(text: string) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ''
  const field = (key: string) => {
    const lines = block.split(/\r?\n/)
    const at = lines.findIndex(line => line.startsWith(`${key}:`))
    if (at < 0) return undefined
    const value = lines[at]!.slice(key.length + 1).trim()
    if (!/^[>|][-+]?$/.test(value)) return value.replace(/^(["'])(.*)\1$/, '$2')
    const folded: string[] = []
    for (const line of lines.slice(at + 1)) {
      if (!/^\s/.test(line)) break
      folded.push(line.trim())
    }

    return folded.join(' ')
  }

  return { name: field('name'), description: field('description') }
}

async function readSkill($: Engine, dir: string, prefix: string, source: string): Promise<SkillRow | undefined> {
  try {
    const head = frontmatter(await $.fs.read(`${dir}/SKILL.md`))
    const base = head.name || dir.split('/').at(-1)!

    return { name: prefix ? `${prefix}:${base}` : base, description: head.description, source }
  } catch {
    return undefined
  }
}

export async function loadSkills($: Engine) {
  if ((await read($, plugins)).length === 0) await loadPlugins($)
  const found: SkillRow[] = []
  const add = (row: SkillRow | undefined) => {
    if (row && !found.some(one => one.name === row.name)) found.push(row)
  }

  for (const dir of await subdirs($, `${await home($)}/.claude/skills`)) add(await readSkill($, dir, '', 'user'))
  for (const dir of await subdirs($, `${await $.session.cwd()}/.claude/skills`)) add(await readSkill($, dir, '', 'project'))
  for (const plugin of (await read($, plugins)).filter(one => one.isEnabled && one.root)) {
    const manifest = await readJson<{ name?: string; skills?: unknown }>($, `${plugin.root}/.claude-plugin/plugin.json`)
    const prefix = manifest?.name ?? plugin.id.split('@')[0]!
    const dirs = Array.isArray(manifest?.skills)
      ? (manifest.skills as string[]).map(rel => `${plugin.root}/${rel.replace(/^\.\//, '').replace(/\/$/, '')}`)
      : await subdirs($, `${plugin.root}/skills`)
    for (const dir of dirs) add(await readSkill($, dir, prefix, plugin.id))
  }

  await update($, skills, () => found.sort(byName(one => one.name)))
  await loadSkillDeny($)
}

async function loadSkillDeny($: Engine) {
  const settings = await readJson<{ permissions?: { deny?: string[] } }>($, await settingsPath($))
  const names = (settings?.permissions?.deny ?? []).flatMap(rule => rule.match(/^Skill\((.+)\)$/)?.[1] ?? [])
  await update($, skillDeny, () => names)
}

export async function switchSkill($: Engine, name: string, isOn: boolean) {
  const path = await settingsPath($)
  let text = '{}\n'
  try {
    text = await $.fs.read(path)
  } catch {
    // no user settings yet
  }
  const settings = JSON.parse(text) as { permissions?: { deny?: string[] } & Record<string, unknown> }
  // One copy of the file as it was before Switchboard first changed it.
  if (!(await $.fs.exists(`${path}.switchboard-backup`))) await $.fs.write(`${path}.switchboard-backup`, text)
  const rule = `Skill(${name})`
  const deny = settings.permissions?.deny ?? []
  const next = isOn ? deny.filter(one => one !== rule) : deny.includes(rule) ? deny : [...deny, rule]
  settings.permissions = { ...settings.permissions, deny: next }
  await $.fs.write(path, `${JSON.stringify(settings, null, 2)}\n`)
  await loadSkillDeny($)
}

// MCP: servers grouped from the tools the model can call (mcp__<server>__<tool>);
// one switched off has its calls refused by Switchboard's tool.call hook.

export const serverOf = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__')[1] : undefined)

export async function loadServers($: Engine) {
  const byServer = new Map<string, string[]>()
  for (const tool of (await $.tool.list()).filter(one => one.mcp)) {
    const server = serverOf(tool.name)
    if (server) byServer.set(server, [...(byServer.get(server) ?? []), tool.name.split('__').slice(2).join('__')])
  }
  for (const server of await read($, mcpOff)) {
    if (!byServer.has(server)) byServer.set(server, [])
  }
  const rows: ServerRow[] = [...byServer].map(([id, tools]) => ({ id, tools }))
  await update($, servers, () => rows.sort(byName(one => one.id)))
}

export async function switchServer($: Engine, id: string, isOn: boolean) {
  const list = await read($, mcpOff)
  const next = isOn ? list.filter(one => one !== id) : [...new Set([...list, id])]
  await $.store.set('mcpOff', next)
  await update($, mcpOff, () => next)
  $.ui.invalidate('tool.describe')
}
