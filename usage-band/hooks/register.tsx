import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionUsage } from 'claude-code'

import type { Snapshot } from '../types'
import { HUE, roboSvg } from './robo'

const usageAtom = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const modelAtom = atom({ plugin: 'usage-band', key: 'model' } as const, null)
const nowAtom = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const hiddenAtom = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)
// input tokens this session, and how many of them the prompt cache served
const cacheAtom = atom({ plugin: 'usage-band', key: 'cache' } as const, { read: 0, total: 0 })
// when the main thread last sent a request, which keeps the prompt cache warm; 0 before the first
const lastAtAtom = atom({ plugin: 'usage-band', key: 'lastAt' } as const, 0)
// the buttons you turned on: none by default, kept across sessions
const shownButtonsAtom = atom({ plugin: 'usage-band', key: 'shownButtons' } as const, [])

// The band's buttons by the name /band-usage <button> takes, with the command each opens
const BUTTONS = [
  { name: 'flight-recorder', command: 'hud-flight-recorder' },
  { name: 'switchboard', command: 'hud-switchboard' },
  { name: 'hud', command: 'hud-session' },
] as const

// The band's icons off the terminal: one size and one grey, which reads on light and dark
const ICON = 16
const ICON_GREY = '#8B8B95'
// Robo stands a little taller than the icons, as ribbon's does beside its chip
const ROBO = 18
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
  return fmtMins(Math.round(ms / 60000))
}

// no space inside, so a countdown stays short beside the buttons: 2h11m, 2d9h
export function fmtMins(mins: number): string {
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return `${d}d${h}h`
  if (h > 0) return `${h}h${m}m`
  return `${m}m`
}

// The prompt cache lives an hour after the last request that read or wrote it (Claude Code's 1h
// TTL; a session on the 5-minute cache goes cold sooner than this shows)
export const CACHE_TTL_MIN = 60

// Warm with the minutes left, or cold with the minutes idle; undefined before the first request
export function cacheClock(lastAt: number, now: number): { mode: 'warm' | 'cold'; mins: number } | undefined {
  if (lastAt <= 0) return undefined
  const idle = Math.max(0, Math.floor((now - lastAt) / 60000))
  return idle < CACHE_TTL_MIN ? { mode: 'warm', mins: CACHE_TTL_MIN - idle } : { mode: 'cold', mins: idle }
}

// The share of input the cache served, in percent; undefined before the first response
export function cacheHit(read: number, total: number): number | undefined {
  return total > 0 ? Math.round((read / total) * 100) : undefined
}

// A cache hit rate is good when high: green from 80%, amber from 50%, red below
export function hitLevel(pct: number): 'success' | 'warning' | 'error' {
  if (pct >= 80) return 'success'
  if (pct >= 50) return 'warning'
  return 'error'
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
      name: 'band-usage',
      description: 'Show or hide the usage band; open a pane, or turn its button on or off',
      argumentHint: '[open] flight-recorder | switchboard | hud, or buttons',
    })
    const saved = await $.store.get('shownButtons')
    if (Array.isArray(saved)) {
      await update($, shownButtonsAtom, () => saved.filter((n): n is string => typeof n === 'string'))
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

  on('command.run', { command: 'band-usage' }, async ($, e) => {
    const [first = '', second] = e.args.trim().split(/\s+/)
    const verb = first
    if (!verb) {
      const hidden = await update($, hiddenAtom, h => !h)
      return { text: hidden ? 'Usage band hidden.' : 'Usage band shown.' }
    }
    const names = BUTTONS.map(b => b.name).join(', ')
    if (verb === 'buttons') {
      const shownButtons = await read($, shownButtonsAtom)
      let loaded: string[] = []
      try {
        loaded = (await $.command.list()).map(c => c.name)
      } catch {
        // no command list: say nothing about which mods are loaded
      }
      const rows = BUTTONS.map(
        b => `${b.name}: ${shownButtons.includes(b.name) ? 'on' : 'off'}${loaded.includes(b.command) ? '' : ' (mod not loaded)'}`,
      )
      return { text: `Usage band buttons\n${rows.join('\n')}\nTurn one on or off with /band-usage <button>.` }
    }
    // open <name> opens that pane, as its button would: its command runs through the command
    // chain, not the prompt, so no second line lands in the transcript. A command can't run another
    // from inside its own hook (it would wait on the turn this one holds), so it runs just after.
    if (verb === 'open') {
      const target = BUTTONS.find(b => b.name === second)
      if (!target) return { text: `Use /band-usage open <pane> (${names}).` }
      let loaded = true
      try {
        loaded = (await $.command.list()).some(c => c.name === target.command)
      } catch {
        // no command list: try it anyway
      }
      if (!loaded) return { text: `The ${target.name} mod is not loaded.` }
      $.clock.after(0, () => {
        void $.command.run({ command: target.command }).catch(() => $.ui.toast(`Could not open ${target.name}.`))
      })
      return {}
    }
    // a button's name turns it on when off, off when on
    if (BUTTONS.some(b => b.name === verb)) {
      const shownButtons = await update($, shownButtonsAtom, list =>
        list.includes(verb) ? list.filter(n => n !== verb) : [...list, verb],
      )
      await $.store.set('shownButtons', shownButtons)
      return { text: `The ${verb} button is ${shownButtons.includes(verb) ? 'on' : 'off'}. It stays that way in new sessions.` }
    }
    return { text: `Use /band-usage, /band-usage buttons, /band-usage open <pane>, or /band-usage <button> (${names}).` }
  })

  on('session.measure', async ($, e, next) => {
    await update($, usageAtom, () => toSnapshot(e))
    return next(e)
  })

  // session.measure fires after main turns only; refresh after every response so
  // cost and limits move while subagents are still working.
  // A resumed or forked session knows how long it was away; a cleared or compacted one starts a new cache
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') {
      await update($, lastAtAtom, () => 0)
    } else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      const now = await $.clock.now()
      const lastAt = now - e.seconds_since_last_response * 1000
      await update($, lastAtAtom, () => lastAt)
      await update($, nowAtom, () => now)
    }
    return r
  }).catch(($, e, next) => next(e)) // a band that fails to seed never holds up the session

  on('turn.step', async function* ($, e, next) {
    // each main-thread request reads or writes the cache, so its start resets the hour;
    // a subagent's prompt is its own and keeps no cache of the conversation's
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      await update($, lastAtAtom, () => t)
      await update($, nowAtom, () => t)
    }
    const result = yield* next(e)
    // every response counts toward the cache hit rate, subagents' too: they are billed alike
    const u = result.usage
    if (u) {
      await update($, cacheAtom, c => ({
        read: c.read + u.cache_read_input_tokens,
        total: c.total + u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
      }))
    }
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
      // a button shows once you turned it on with /band-usage show, and only while its mod is loaded
      const shownButtons = await read($, shownButtonsAtom)
      const shows = (name: string, command: string) => shownButtons.includes(name) && commands.some(c => c.name === command)
      hasFlight = shows('flight-recorder', 'hud-flight-recorder')
      hasSwitchboard = shows('switchboard', 'hud-switchboard')
      hasHud = shows('hud', 'hud-session')
    } catch {
      // no command list: leave the buttons out
    }
    const pct = usage.percent ?? 0

    // One line: each group is its value alone, the limits led by a blue "5h" or "7d"
    const group = (value: RenderElement) => <Text wrap="truncate">{value}</Text>
    // In order: model, context, 5h and 7d limits, cache hit, cost
    const groups: RenderElement[] = []
    if (model) groups.push(group(<Text color="claude">{shortModel(model)}</Text>))
    groups.push(
      group(
        <Text>
          <Text color={level(pct)}>{bar(pct, 8)[0]}</Text>
          <Text dimColor>{bar(pct, 8)[1]}</Text>
          <Text color={level(pct)} bold>
            {' '}
            {pct}%
          </Text>
          <Text dimColor>
            {' '}
            {fmtTokens(usage.tokens ?? 0)}/{fmtTokens(usage.window)}
          </Text>
        </Text>,
      ),
    )
    for (const l of usage.limits) {
      const reset = untilReset(l.resetsAt, now)
      groups.push(
        group(
          <Text>
            <Text color="suggestion">{limitName(l.kind)} </Text>
            <Text color={level(l.percentUsed)} bold>
              {l.percentUsed}%
            </Text>
            {/* "↻ 2h11m" rather than "resets 2h 11m": short enough to keep the band on one line */}
            {reset && <Text dimColor> ↻ {reset}</Text>}
          </Text>,
        ),
      )
    }
    // The cache: Robo, warm with the minutes left or cold with the time idle, then the hit rate.
    // Off the terminal Robo opens the /hud-cache card, as ribbon's Show does.
    const cache = await read($, cacheAtom)
    const hit = cacheHit(cache.read, cache.total)
    const clock = cacheClock(await read($, lastAtAtom), now)
    if (clock || hit !== undefined) {
      const text = (
        <Text wrap="truncate">
          {clock && (
            <Text color={HUE[clock.mode]}>
              {/* warm counts down from the hour in minutes (60m, not 1h0m); cold says how long idle */}
              <Text bold>{clock.mode}</Text> {clock.mode === 'warm' ? `${clock.mins}m` : fmtMins(clock.mins)}
              {hit !== undefined && ' '}
            </Text>
          )}
          {hit !== undefined && (
            <Text color={hitLevel(hit)} bold>
              {hit}%
            </Text>
          )}
        </Text>
      )
      const RoboSvg = e.surface === 'terminal' || !('Svg' in elements) ? undefined : elements.Svg
      groups.push(
        clock && RoboSvg ? (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box key="cache-site" position="relative">
              {/* interactive, so the SMIL bob and blink run; the Button laid over it takes the press */}
              <RoboSvg source={roboSvg(clock.mode, ROBO)} alt={clock.mode === 'warm' ? 'Robo, bobbing' : 'Robo, frozen'} width={ROBO} height={ROBO} isInteractive />
              <Box position="absolute" top={0} left={0} right={0} bottom={0}>
                {/* session-hud's ui.press hook opens the card and takes the press; this runs only when it did not */}
                <Button
                  key="cache"
                  plain
                  onPress={async () => {
                    try {
                      await $.command.run({ command: 'hud-cache' })
                    } catch {
                      $.ui.toast('The session-hud mod is not loaded.')
                    }
                  }}
                >
                  {BLANK}
                </Button>
              </Box>
            </Box>
            {text}
          </Box>
        ) : (
          text
        ),
      )
    }
    if (usage.cost !== undefined) {
      groups.push(
        group(
          <Text>
            <Text>💰 </Text>
            <Text color="warning" bold>
              ${usage.cost.toFixed(2)}
            </Text>
          </Text>,
        ),
      )
    }

    // The buttons sit in a row at the end of the line. Off the terminal each
    // is an icon drawn at a set size, pressed through a plain Button laid over it (as Switchboard
    // draws its switches): a Button's own size is the surface's to choose.
    const terminal = e.surface === 'terminal'
    const Svg = terminal || !('Svg' in elements) ? undefined : elements.Svg
    const button = (key: string, label: string, glyph: string, svg: string, onPress: () => void) =>
      Svg === undefined ? (
        <Button key={key} label={glyph} onPress={onPress} />
      ) : (
        <Box key={`${key}-site`} position="relative">
          {/* A set size: left out, the desktop may scale the icon to the space it has */}
          <Svg source={svg} alt={label} width={ICON} height={ICON} />
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
            await $.command.run({ command: 'hud-flight-recorder' })
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
          $.ui.toast('Switchboard did not answer: run /hud-switchboard.'),
        ),
      )
    }
    // session-hud's ui.press hook opens its pane and takes the press, so no /hud-session shows in the
    // transcript; running the command is the fallback when that hook did not answer.
    if (hasHud) {
      buttons.push(
        button('session-hud', 'Open the session HUD', '◆', GAUGE_SVG, async () => {
          try {
            await $.command.run({ command: 'hud-session' })
          } catch {
            $.ui.toast('The session-hud mod is not loaded.')
          }
        }),
      )
    }

    const separator = <Text dimColor>│</Text>
    // Sections and separators alternate in one row spread with equal gaps, so each separator
    // sits midway between its neighbours: the first section at the left edge, the last at the right.
    // The gap keeps at least a space either side of each separator when the band is narrow.
    const sections: RenderElement[] = [...groups]
    if (buttons.length > 0) {
      sections.push(
        <Box flexDirection="row" alignItems="center" gap={1}>
          {buttons}
        </Box>,
      )
    }
    const row = (
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" gap={1} width="100%">
        {sections.flatMap((section, i) => (i > 0 ? [separator, section] : [section]))}
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
