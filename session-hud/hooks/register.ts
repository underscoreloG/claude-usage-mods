// session-hud: the /hud-session dashboard pane from StackSprint's session-guard 0.1.2 (MIT, see LICENSE),
// without the status band, budget guard or recording mode. It only observes and draws: no tool call
// or prompt is ever changed or refused.
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import { MODELS, TTL_MIN, TTL_MS, cardSvg, costOf, familyOf, fmtIdle, tok, usd } from './cache-art'
import type { CacheView } from './cache-art'
import { hudSvg } from './hud-art'

// The engine has Uint8Array.toBase64; the es2023 lib doesn't declare it
declare global {
  interface Uint8Array { toBase64(): string }
}

// What the NOW line hides, so a command carrying a secret doesn't show in the pane
const SECRETS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, '[ANTHROPIC KEY]'],
  [/sk-[A-Za-z0-9_-]{20,}/g, '[API KEY]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[GITHUB TOKEN]'],
  [/AKIA[0-9A-Z]{16}/g, '[AWS KEY]'],
  // An email starts with a letter or digit, so code like @app.get or +@decorator is left alone
  [/\b[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '[EMAIL]'],
]

const PANE = 'session-hud'
// The prompt cache card, ribbon's drawing in a pane of its own: /hud-cache, or Robo in usage-band
const CACHE_PANE = 'hud-cache'
// The card's drawing width in pixels: ribbon's two-row layout, scaled to the pane
const CARD_W = 640
const SPARK = '▁▂▃▄▅▆▇█'

// The dashboard's palette, as 0xRRGGBB
const C = {
  teal: 0x2dd4bf, violet: 0x8b7cf6, amber: 0xf5a623, red: 0xf0465a, green: 0x3fb950,
  blue: 0x4493f8, dim: 0x8b93a7, border: 0x3a3f4b, track: 0x353a46, bg: 0x01000000,
}
const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

// Green, then amber, then red as a share fills up
const heatColor = (share: number) => (share < 0.6 ? C.green : share < 0.85 ? C.amber : C.red)

// Each tool gets its own color in the chart
const toolColor = (name: string) =>
  ({ Edit: C.violet, Write: C.violet, MultiEdit: C.violet, Read: C.teal, Bash: C.amber, Grep: C.blue, Glob: C.blue } as Record<string, number>)[name] ?? C.dim

// claude-opus-5-5 -> Opus 5.5
const prettyModel = (id: string) =>
  id.replace(/^claude-/, '').replace(/-(\d+)-(\d+).*$/, ' $1.$2').replace(/^./, (c) => c.toUpperCase())

// A color fading in from dim at the start of a bar to full strength at its end
function shade(color: number, t: number): number {
  const k = 0.45 + 0.55 * Math.max(0, Math.min(1, t))
  const r = Math.round(((color >> 16) & 255) * k), g = Math.round(((color >> 8) & 255) * k), b = Math.round((color & 255) * k)
  return (r << 16) | (g << 8) | b
}

// Pack [character, color] cells into the base64 string a Raster takes
function cells(row: [string, number][]): string {
  const words = row.flatMap(([ch, color]) => [ch.codePointAt(0) ?? 32, color, C.bg])
  return new Uint8Array(Uint32Array.from(words).buffer).toBase64()
}

export function mask(text: string): string {
  return SECRETS.reduce((t, [pattern, label]) => t.replace(pattern, label), text)
}

// Shared by the hooks below
const tools: Record<string, number> = {}
const files: Record<string, number> = {}
const turnCosts: number[] = []
let now = 'idle'
let cwd = ''
let turnStartCost = 0
// When the main thread last sent a request, which keeps the prompt cache warm; 0 before the first
let lastAt = 0

/** What the cache card reads, or null until a request and the context size are known. */
export function cacheView(last: number, now: number, tokens: number, window: number, model: string): CacheView | null {
  if (last <= 0 || tokens <= 0) return null
  const idleMs = Math.max(0, now - last)
  return {
    mode: idleMs >= TTL_MS ? 'cold' : 'warm',
    idle: fmtIdle(idleMs),
    idleMin: Math.floor(idleMs / 60000),
    tokens,
    window,
    mine: familyOf(model),
  }
}

async function costNow($: EngineInterface): Promise<number> {
  const usage = await $.session.usage()
  return usage.cost ? usage.cost.usd : 0
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    cwd = await $.session.cwd()
    await $.command.register({ name: 'hud-session', description: 'Open the session dashboard', immediate: true })
    await $.command.register({ name: 'hud-cache', description: 'Open the prompt cache card: warm or cold, size, next message cost', immediate: true })
    // keeps the cache card's countdown and its warm-to-cold flip current
    $.clock.every(30_000, () => $.ui.invalidate('ui.render'))
    return next(e)
  })

  // A resumed or forked session knows how long it was away; a cleared or compacted one starts a new cache
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear' || e.source === 'compact') lastAt = 0
    else if ((e.source === 'resume' || e.source === 'fork') && typeof e.seconds_since_last_response === 'number') {
      lastAt = (await $.clock.now()) - e.seconds_since_last_response * 1000
    }
    return r
  }).catch(($, e, next) => next(e))

  // Each main-thread request reads or writes the cache, so its start resets the hour; a subagent's
  // prompt is its own
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) lastAt = await $.clock.now()
    return yield* next(e)
  })

  // ---------- OBSERVE: what Claude is doing ----------
  on('tool.call', async ($, e, next) => {
    tools[e.tool] = (tools[e.tool] ?? 0) + 1
    // What it's doing, with paths shown relative to the project
    const target = 'command' in e && typeof e.command === 'string' ? e.command
      : 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : ''
    // Secrets are hidden before the cut, so a key can't show half-masked; then one line, 60 characters
    const line = mask((e.tool + (target ? ': ' + target : '')).split(cwd + '/').join('')).split('\n')[0] ?? ''
    now = line.length > 60 ? line.slice(0, 59) + '…' : line
    if ((e.tool === 'Edit' || e.tool === 'Write') && target) {
      const name = target.split('/').slice(-2).join('/')
      files[name] = (files[name] ?? 0) + 1
    }
    $.ui.invalidate('ui.render')
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    turnStartCost = await costNow($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      turnCosts.push((await costNow($)) - turnStartCost)
      now = 'idle'
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  // ---------- DRAW: the /hud-session dashboard pane ----------
  on('command.run', { command: 'hud-session' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Session HUD', closeOnEscape: true })
    return {}
  })

  on('command.run', { command: 'hud-cache' }, async ($) => {
    await $.ui.open({ id: CACHE_PANE, title: 'Prompt cache', closeOnEscape: true })
    return {}
  })

  // usage-band's Robo opens the cache card the same way its HUD button opens the HUD
  on('ui.press', { plugin: 'usage-band', element: 'cache' }, async ($, e) => {
    await $.ui.open({ id: CACHE_PANE, title: 'Prompt cache', closeOnEscape: true })
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: CACHE_PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const usage = await $.session.usage()
    const view = cacheView(lastAt, await $.clock.now(), usage.context.tokens ?? 0, usage.context.window, await $.session.model())
    const note = Text({ color: hex(C.dim), children: ['List-price estimates; assumes the 1h cache, a 5m one goes cold sooner.'] })
    if (!view) return Box({ flexDirection: 'column', paddingX: 1, children: [Text({ color: hex(C.dim), children: ['The cache shows after the first reply.'] })] })
    const cold = view.mode === 'cold'
    if (Svg) {
      // No width or height: the drawing scales to the pane. Interactive, so Robo bobs and the ice twinkles
      const card = cardSvg(view, 'stacked', CARD_W)
      return Box({ flexDirection: 'column', gap: 1, children: [Svg({ source: card.source, alt: card.alt, isInteractive: true }), note] })
    }
    // The terminal gets the same facts as text
    const prices = MODELS.map((m) => m.NAME + ' ' + usd(costOf(m, view.mode, view.tokens)) + (m.id === view.mine ? ' (you)' : '')).join('  ')
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      children: [
        Text({ children: [
          Text({ color: cold ? '#6aaabd' : '#cc6363', bold: true, children: [cold ? 'COLD' : 'WARM'] }),
          Text({ color: hex(C.dim), children: ['  idle ' + view.idle + (cold ? '' : '  ·  cold in ' + Math.max(0, TTL_MIN - view.idleMin) + 'm')] }),
        ] }),
        Text({ children: [tok(view.tokens) + ' tokens ' + (cold ? 'to re-cache' : 'in cache') + (view.window ? '  ·  ' + Math.round((view.tokens / view.window) * 100) + '% of ' + tok(view.window) : '')] }),
        Text({ children: [Text({ color: hex(C.dim), children: ['next message  '] }), prices] }),
        note,
      ],
    })
  })

  // usage-band's HUD button: opens the pane straight from the press, so no /hud-session shows in the
  // transcript, and takes the press (as Switchboard does for the band's gear)
  on('ui.press', { plugin: 'usage-band', element: 'session-hud' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Session HUD', closeOnEscape: true })
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text } = els
    // The terminal lays out in cells and draws a Raster; desktop and mobile lay out in pixels and draw
    // an Svg. Decide by the surface, as upstream does: the live desktop table may carry a Raster too
    const Raster = e.surface === 'terminal' && 'Raster' in els ? els.Raster : undefined
    const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
    const usage = await $.session.usage()
    const model = await $.session.model()
    const ctx = (usage.context.percent ?? 0) / 100
    const cost = usage.cost ? usage.cost.usd : 0

    // Off the terminal the dashboard is one drawing in ribbon's look, scaled to the pane (no width or height)
    if (Svg) {
      const card = hudSvg({
        model: prettyModel(model),
        turns: turnCosts,
        ctxShare: ctx,
        tokens: usage.context.tokens ?? Math.round(ctx * usage.context.window),
        window: usage.context.window,
        cost,
        tools: Object.entries(tools).sort((a, b) => b[1] - a[1]),
        files: Object.entries(files),
        now,
      })
      return Svg({ source: card.source, alt: card.alt })
    }

    const W = Math.max(40, e.props.bodyColumns ?? 60)
    const half = Math.floor((W - 1) / 2)
    // A cell width only fits the terminal; elsewhere a card fills the pane
    const full = Raster ? W : undefined

    // A slim meter: a colored line over a dark track (a Raster in the terminal, text elsewhere)
    const meter = (key: string, share: number, width: number, color: number) => {
      const filled = Math.max(0, Math.min(width, Math.round(share * width)))
      if (!Raster) {
        return Text({ children: [Text({ color: hex(color), children: ['▆'.repeat(filled)] }), Text({ color: hex(C.track), children: ['▆'.repeat(width - filled)] })] })
      }
      const row = Array.from({ length: width }, (_, i) => ['▆', i < filled ? shade(color, i / width) : C.track] as [string, number])
      return Raster({ key, columns: width, rows: 1, cells: cells(row) })
    }
    const card = (title: string, width: number | undefined, children: RenderChildren[], right?: RenderChildren, grow?: boolean) =>
      Box({
        width,
        ...(grow ? { flexGrow: 1 } : {}),
        flexDirection: 'column',
        borderStyle: 'round',
        borderColor: hex(C.border),
        paddingX: 1,
        children: [
          Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Text({ color: hex(C.dim), bold: true, children: [title] }), right ?? Text({ children: [''] })] }),
          ...children,
        ],
      })
    const inner = (width: number) => width - 4

    // Header
    const header = Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingX: 1,
      children: [
        Text({ children: [Text({ color: hex(C.teal), bold: true, children: ['◆ SESSION HUD'] })] }),
        Text({ color: hex(C.dim), children: [prettyModel(model) + ' · ' + turnCosts.length + (turnCosts.length === 1 ? ' turn' : ' turns')] }),
      ],
    })

    // Context and cost, side by side (the cost card takes the budget card's place)
    const ctxColor = heatColor(ctx)
    const tokens = Math.round((ctx * usage.context.window) / 1000)
    const lastTurn = turnCosts[turnCosts.length - 1]
    // Outside the terminal the two top cards share a row: equal halves while both fit 22 cells,
    // one under the other on a narrow pane
    const pair = (box: RenderChildren) =>
      Raster ? box : Box({ flexDirection: 'column', width: '40%', minWidth: 22, flexGrow: 1, children: [box] })
    const meters = Box({
      flexDirection: 'row',
      flexWrap: Raster ? 'nowrap' : 'wrap',
      gap: 1,
      children: [
        // Off the terminal each card fills its half's height, so the two are always as tall as each other
        pair(card('CONTEXT', Raster ? half : undefined, [
          Text({ children: [Text({ color: hex(ctxColor), bold: true, children: [Math.round(ctx * 100) + '%'] }), Text({ color: hex(C.dim), children: ['  ' + tokens + 'k of ' + Math.round(usage.context.window / 1000) + 'k'] })] }),
          meter('ctx', ctx, inner(half), ctxColor),
        ], undefined, !Raster)),
        pair(card('COST', Raster ? half : undefined, [
          Text({ children: [Text({ color: hex(C.amber), bold: true, children: ['$' + cost.toFixed(2)] }), Text({ color: hex(C.dim), children: ['  this session'] })] }),
          Text({ color: hex(C.dim), children: [lastTurn === undefined ? 'no turn yet' : '$' + lastTurn.toFixed(3) + '  last turn'] }),
        ], undefined, !Raster)),
      ],
    })

    // Cost per turn: one bar per turn, two cells wide
    const spark = (() => {
      const shown = turnCosts.slice(-Math.floor(inner(W) / 4))
      if (!shown.length) return Text({ color: hex(C.dim), children: ['waiting for the first turn'] })
      const top = Math.max(...shown, 0.0001)
      const avg = turnCosts.reduce((a, b) => a + b, 0) / turnCosts.length
      // Each bar is up to two rows tall (16 steps): the bottom row fills first, then the top
      const top_: [string, number][] = []
      const bottom: [string, number][] = []
      for (const v of shown) {
        const level = Math.max(1, Math.round((v / top) * 16))
        const color = shade(C.amber, v / top)
        const low = level >= 8 ? '█' : SPARK[level - 1] ?? ' '
        const high = level > 8 ? SPARK[level - 9] ?? ' ' : ' '
        top_.push([high, color], [high, color], [high, color], [' ', C.bg])
        bottom.push([low, color], [low, color], [low, color], [' ', C.bg])
      }
      return Box({
        flexDirection: 'column',
        children: [
          Raster
            ? Raster({ key: 'turns', columns: bottom.length, rows: 2, cells: cells([...top_, ...bottom]) })
            : Text({ color: hex(C.amber), children: [bottom.map((b) => b[0]).join('')] }),
          Text({ color: hex(C.dim), children: ['last $' + (shown[shown.length - 1] ?? 0).toFixed(3) + ' · avg $' + avg.toFixed(3)] }),
        ],
      })
    })()

    // Tools, busiest first, each with its own color
    const sorted = Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 6)
    const most = Math.max(1, ...sorted.map(([, n]) => n))
    const barWidth = Math.max(6, inner(W) - 18)
    const toolRows = sorted.length
      ? sorted.map(([name, n]) =>
          Box({
            flexDirection: 'row',
            columnGap: 1,
            children: [
              Text({ color: hex(toolColor(name)), children: ['●'] }),
              Text({ children: [name.slice(0, 10).padEnd(10)] }),
              meter('tool-' + name, n / most, barWidth, toolColor(name)),
              Text({ bold: true, children: [String(n).padStart(3)] }),
            ],
          }),
        )
      : [Text({ color: hex(C.dim), children: ['no tool calls yet'] })]

    // Files Claude changed, with how many edits each
    const fileRows = Object.keys(files).length
      ? Object.entries(files).slice(0, 5).map(([name, n]) =>
          Box({ flexDirection: 'row', justifyContent: 'space-between', children: [Text({ color: hex(C.green), children: ['✎ ' + name] }), Text({ color: hex(C.dim), children: ['×' + n] })] }),
        )
      : [Text({ color: hex(C.dim), children: ['no files changed yet'] })]

    // What Claude is doing right now
    const status = now === 'idle'
      ? Text({ children: [Text({ color: hex(C.green), children: ['● '] }), Text({ color: hex(C.dim), children: ['ready'] })] })
      : Text({ wrap: 'truncate-end', children: [Text({ color: hex(C.amber), children: ['▶ '] }), Text({ children: [now] })] })

    return Box({
      flexDirection: 'column',
      // Cards touch in the terminal, as box-drawing frames do; elsewhere they get room between them
      gap: Raster ? 0 : 1,
      children: [
        header,
        meters,
        card('COST PER TURN', full, [spark]),
        card('TOOLS', full, toolRows, Text({ color: hex(C.dim), children: [Object.values(tools).reduce((a, b) => a + b, 0) + ' calls'] })),
        card('FILES CHANGED', full, fileRows),
        card('NOW', full, [status]),
      ],
    })
  })
}
