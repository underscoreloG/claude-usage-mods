import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionUsage } from 'claude-code'

import type { Snapshot } from '../types'

const usageAtom = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const modelAtom = atom({ plugin: 'usage-band', key: 'model' } as const, null)
const nowAtom = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const hiddenAtom = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)
const hiddenButtonsAtom = atom({ plugin: 'usage-band', key: 'hiddenButtons' } as const, [])

// The band's buttons by the name /usageband hide|show takes, with the command each opens
const BUTTONS = [
  { name: 'flight', command: 'flight-recorder' },
  { name: 'switchboard', command: 'switchboard' },
  { name: 'hud', command: 'hud' },
] as const

// The band's icons off the terminal: one size and one grey, which reads on light and dark
const ICON = 16
const ICON_GREY = '#8B8B95'
// U+2800 draws nothing yet is not whitespace, so no surface trims it away
const BLANK = '\u2800'.repeat(2)
const glyphSvg = (glyph: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 16 16">` +
  `<text x="8" y="12.5" text-anchor="middle" font-size="13" font-family="-apple-system, system-ui, sans-serif" fill="${ICON_GREY}">${glyph}</text></svg>`
// A dial with its needle: the HUD's dashboard
const GAUGE_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON}" height="${ICON}" viewBox="0 0 16 16" fill="none" stroke="${ICON_GREY}" stroke-width="1.6" stroke-linecap="round">` +
  `<path d="M2.5 12.5a5.5 5.5 0 1 1 11 0"/><path d="M8 12.5l3-4"/><circle cx="8" cy="12.5" r="1" fill="${ICON_GREY}"/></svg>`

export function toSnapshot(u: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Snapshot {
  return {
    tokens: u.context.tokens,
    window: u.context.window,
    percent: u.context.percent,
    cost: u.cost?.usd,
    limits: u.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })),
  }
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function shortModel(model: string): string {
  const m = /(fable|opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i.exec(model)
  if (!m) return model
  return m[3] ? `${m[1]} ${m[2]}.${m[3]}` : `${m[1]} ${m[2]}`
}

export function limitName(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  if (kind === 'spend_limit') return 'spend'
  return kind
}

export function untilReset(resetsAt: string | undefined, now: number): string | undefined {
  if (!resetsAt || !now) return undefined
  const ms = Date.parse(resetsAt) - now
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  const mins = Math.round(ms / 60000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  // no space inside, so the countdown stays short beside the buttons: 2h11m, 2d9h
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

export function level(pct: number): 'success' | 'warning' | 'error' {
  if (pct >= 80) return 'error'
  if (pct >= 50) return 'warning'
  return 'success'
}

// The filled part and the track, both ▰: the outline ▱ draws larger than ▰ on desktop,
// so the track is the same box, dimmed
export function bar(pct: number, cells = 10): [string, string] {
  const full = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return ['▰'.repeat(full), '▰'.repeat(cells - full)]
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    const snap = toSnapshot(await $.session.usage())
    await update($, usageAtom, () => snap)
  } catch {
    // no ledger yet; keep the last snapshot
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'usageband',
      description: 'Show or hide the usage band above the prompt; buttons, hide or show a button',
      argumentHint: '[buttons | hide <button> | show <button>]',
    })
    // which buttons you hid, kept across sessions
    const saved = await $.store.get('hiddenButtons')
    if (Array.isArray(saved)) {
      await update($, hiddenButtonsAtom, () => saved.filter((n): n is string => typeof n === 'string'))
    }
    await refresh($)
    const now = await $.clock.now()
    await update($, nowAtom, () => now)
    // keeps the reset countdowns honest while idle
    $.clock.every(30_000, () => {
      void (async () => {
        const t = await $.clock.now()
        await update($, nowAtom, () => t)
      })()
    })
    return next(e)
  })

  on('command.run', { command: 'usageband' }, async ($, e) => {
    const [verb, name] = e.args.trim().split(/\s+/)
    if (!verb) {
      const hidden = await update($, hiddenAtom, h => !h)
      return { text: hidden ? 'Usage band hidden.' : 'Usage band shown.' }
    }
    const names = BUTTONS.map(b => b.name).join(', ')
    if (verb === 'buttons') {
      const hiddenButtons = await read($, hiddenButtonsAtom)
      let loaded: string[] = []
      try {
        loaded = (await $.command.list()).map(c => c.name)
      } catch {
        // no command list: say nothing about which mods are loaded
      }
      const rows = BUTTONS.map(
        b => `${b.name}: ${hiddenButtons.includes(b.name) ? 'off' : 'on'}${loaded.includes(b.command) ? '' : ' (mod not loaded)'}`,
      )
      return { text: `Usage band buttons\n${rows.join('\n')}\nHide or show one with /usageband hide <button> or /usageband show <button>.` }
    }
    if ((verb === 'hide' || verb === 'show') && BUTTONS.some(b => b.name === name)) {
      const hiddenButtons = await update($, hiddenButtonsAtom, list =>
        verb === 'hide' ? [...list.filter(n => n !== name), name as string] : list.filter(n => n !== name),
      )
      await $.store.set('hiddenButtons', hiddenButtons)
      return { text: `The ${name} button is ${verb === 'hide' ? 'hidden' : 'shown'}. It stays that way in new sessions.` }
    }
    return { text: `Use /usageband, /usageband buttons, or /usageband hide|show <button> (${names}).` }
  })

  on('session.measure', async ($, e, next) => {
    await update($, usageAtom, () => toSnapshot(e))
    return next(e)
  })

  // session.measure fires after main turns only; refresh after every response so
  // cost and limits move while subagents are still working.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (e.agentId === undefined) {
      const model = result.usage?.model ?? e.model
      if ((await read($, modelAtom)) !== model) await update($, modelAtom, () => model)
    }
    await refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) return next(e)
    const usage = await read($, usageAtom)
    if (!usage) return next(e)
    const model = await read($, modelAtom)
    const now = await read($, nowAtom)
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // the Flight recorder, Switchboard and HUD buttons show only while those mods are loaded
    let hasFlight = false
    let hasSwitchboard = false
    let hasHud = false
    try {
      const commands = await $.command.list()
      // a button shows while its mod is loaded, unless you hid it with /usageband hide
      const hiddenButtons = await read($, hiddenButtonsAtom)
      const shows = (name: string, command: string) => !hiddenButtons.includes(name) && commands.some(c => c.name === command)
      hasFlight = shows('flight', 'flight-recorder')
      hasSwitchboard = shows('switchboard', 'switchboard')
      hasHud = shows('hud', 'hud')
    } catch {
      // no command list: leave the buttons out
    }
    const pct = usage.percent ?? 0

    // each group is two lines: a dim label on top, the value under it
    const group = (label: string, value: RenderElement) => (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate">
          {label}
        </Text>
        <Text wrap="truncate">{value}</Text>
      </Box>
    )
    const groups = [
      group(
        'Context',
        <Text>
          <Text color={level(pct)} bold>
            {pct}%{' '}
          </Text>
          <Text color={level(pct)}>{bar(pct, 8)[0]}</Text>
          <Text dimColor>{bar(pct, 8)[1]}</Text>
          <Text dimColor>
            {' '}
            {fmtTokens(usage.tokens ?? 0)}/{fmtTokens(usage.window)}
          </Text>
        </Text>,
      ),
    ]
    if (usage.cost !== undefined) {
      groups.push(group('API cost', <Text bold>${usage.cost.toFixed(2)}</Text>))
    }
    for (const l of usage.limits) {
      const reset = untilReset(l.resetsAt, now)
      groups.push(
        group(
          `${limitName(l.kind)} limit`,
          <Text>
            <Text color={level(l.percentUsed)} bold>
              {l.percentUsed}%
            </Text>
            {/* "↻ 2h11m" rather than "resets 2h 11m": short enough not to wrap beside the buttons */}
            {reset && <Text dimColor> ↻ {reset}</Text>}
          </Text>,
        ),
      )
    }
    if (model) groups.push(group('Model', <Text color="claude">{shortModel(model)}</Text>))

    // Up to two buttons per line, so three still fit the band's two lines. Off the terminal each
    // is an icon drawn at a set size, pressed through a plain Button laid over it (as Switchboard
    // draws its switches): a Button's own size is the surface's to choose.
    const terminal = e.surface === 'terminal'
    const Svg = terminal || !('Svg' in elements) ? undefined : elements.Svg
    const button = (key: string, label: string, glyph: string, svg: string, onPress: () => void) =>
      Svg === undefined ? (
        <Button key={key} label={glyph} onPress={onPress} />
      ) : (
        <Box key={`${key}-site`} position="relative">
          <Svg source={svg} alt={label} />
          <Box position="absolute" top={0} left={0} right={0} bottom={0}>
            {/* No label: the desktop draws it over the icon. Blank Braille cells give the
                Button something to press: a plain space collapses to nothing. */}
            <Button key={key} plain onPress={onPress}>
              {BLANK}
            </Button>
          </Box>
        </Box>
      )
    const buttons: RenderElement[] = []
    if (hasFlight) {
      buttons.push(
        button('flight-recorder', 'Open the flight recorder', '✈', glyphSvg('✈'), async () => {
          try {
            await $.command.run({ command: 'flight-recorder' })
          } catch {
            $.ui.toast('The flight-recorder mod is not loaded.')
          }
        }),
      )
    }
    // Switchboard's ui.press hook opens its panel and takes the press; this closure runs only
    // when that hook did not. In the terminal the emoji gear draws at the plane's size.
    if (hasSwitchboard) {
      buttons.push(
        button('switchboard', 'Open Switchboard', '⚙️', glyphSvg('⚙'), () =>
          $.ui.toast('Switchboard did not answer: run /switchboard.'),
        ),
      )
    }
    if (hasHud) {
      buttons.push(
        button('session-hud', 'Open the session HUD', '◆', GAUGE_SVG, async () => {
          try {
            await $.command.run({ command: 'hud' })
          } catch {
            $.ui.toast('The session-hud mod is not loaded.')
          }
        }),
      )
    }
    const grid: RenderElement[][] = []
    for (let i = 0; i < buttons.length; i += 2) grid.push(buttons.slice(i, i + 2))

    const separator = (
      <Box flexDirection="column">
        <Text dimColor>│</Text>
        <Text dimColor>│</Text>
      </Box>
    )
    // Each cell grows to share the width; inside it the separator comes first and the
    // group sits right after it, so every group is left-aligned like Context.
    const row = (
      <Box flexDirection="row" width="100%">
        {groups.map((g, i) => (
          <Box flexDirection="row" flexGrow={1}>
            {i > 0 && separator}
            <Box paddingLeft={i > 0 ? 1 : 0}>{g}</Box>
          </Box>
        ))}
        {buttons.length > 0 && separator}
        {buttons.length > 0 && (
          <Box flexDirection="column" gap={terminal ? 0 : 1} paddingLeft={1}>
            {grid.map(pair => (
              <Box flexDirection="row" gap={1}>
                {pair}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )

    // Share the band: draw whatever the mods beneath drew (agents-band's rows), then
    // this row under it, so neither mod hides the other whichever loads first.
    const below = await next(e)
    if (!below) return row
    return (
      <Box flexDirection="column">
        {below}
        {row}
      </Box>
    )
  })
}
