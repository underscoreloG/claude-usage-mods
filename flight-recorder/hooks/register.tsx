import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Frame, Lane, Span, Totals, Turn } from '../types'
import { dashboardAlt, dashboardSvg } from './dashboard'
import {
  MODEL_COLORS,
  TOOL_COLORS,
  axis,
  family,
  fmtSecs,
  fmtTokens,
  isLive,
  laneSegments,
  lastMoment,
  summarize,
} from './timeline'

const PANE = 'flight-recorder'
const MAX_SPANS = 400
const LABEL_W = 12

const turnAtom = atom({ plugin: 'flight-recorder', key: 'turn' } as const, null)
const historyAtom = atom({ plugin: 'flight-recorder', key: 'history' } as const, [])
const nowAtom = atom({ plugin: 'flight-recorder', key: 'now' } as const, 0)
const EMPTY_TOTALS: Totals = { models: {}, tools: {}, cacheRead: 0, promptTokens: 0 }
const totalsAtom = atom({ plugin: 'flight-recorder', key: 'totals' } as const, EMPTY_TOTALS)
const NO_FRAME: Frame | null = null
const frameAtom = atom({ plugin: 'flight-recorder', key: 'frame' } as const, NO_FRAME)
const TEXT_VIEW: 'text' | 'dashboard' = 'text'
const modeAtom = atom({ plugin: 'flight-recorder', key: 'mode' } as const, TEXT_VIEW)

// Desktop snapshot throttle: the SVG redraws at most every FRAME_MS
const FRAME_MS = 2000
let isDirty = true
let lastFrameAt = 0

function saveTurn($: EngineInterface, fn: (t: Turn | null) => Turn | null) {
  isDirty = true
  return update($, turnAtom, fn)
}

// Snapshot right away (turn start and end), independent of the 2s tick
async function snapshotNow($: EngineInterface) {
  const turn = await read($, turnAtom)
  if (!turn) return
  const now = await $.clock.now()
  isDirty = false
  lastFrameAt = now
  await writeFrame($, turn, now, isLive(turn))
}

async function writeFrame($: EngineInterface, turn: Turn, now: number, live: boolean) {
  const history = await read($, historyAtom)
  const totals = await read($, totalsAtom)
  await update($, frameAtom, () => ({ turn, history, totals, now, live }))
}

async function costUsd($: EngineInterface): Promise<number> {
  try {
    return (await $.session.usage()).cost?.usd ?? 0
  } catch {
    return 0
  }
}

function withLane(turn: Turn, laneId: string, fn: (lane: Lane) => Lane, label?: string): Turn {
  const has = turn.lanes.some(l => l.id === laneId)
  const lanes = has
    ? turn.lanes
    : [
        ...turn.lanes,
        { id: laneId, label: label ?? laneId.slice(0, 8), spans: [], reqs: 0, tools: 0, tokens: 0, isDone: false },
      ]
  return { ...turn, lanes: lanes.map(l => (l.id === laneId ? fn(l) : l)) }
}

function openSpan(lane: Lane, span: Span): Lane {
  return { ...lane, isDone: false, spans: [...lane.spans, span].slice(-MAX_SPANS) }
}

// What a tool call ran, for the hover tooltip: the first telling field of its input
const DETAIL_KEYS = ['command', 'file_path', 'notebook_path', 'pattern', 'query', 'url', 'description', 'prompt', 'skill']
export function toolDetail(input: Record<string, unknown>): string | undefined {
  for (const key of DETAIL_KEYS) {
    const v = input[key]
    if (typeof v === 'string' && v.trim()) {
      const one = v.replace(/\s+/g, ' ').trim()
      return one.length > 160 ? `${one.slice(0, 159)}…` : one
    }
  }
  return undefined
}

// Session token share per model family, largest first
function shareRows(totals: Totals): [string, number][] {
  const rows = Object.entries(totals.models).filter(([, v]) => v.tokens > 0)
  const all = rows.reduce((n, [, v]) => n + v.tokens, 0)
  return rows.sort((a, b) => b[1].tokens - a[1].tokens).map(([fam, v]) => [fam, v.tokens / all])
}

function closeSpan(lane: Lane, id: string, end: number): Lane {
  return { ...lane, spans: lane.spans.map(s => (s.id === id ? { ...s, end } : s)) }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'flight-recorder',
      description: 'Open the flight recorder pane (live turn timeline)',
    })
    // no auto-open: the pane opens from usage-band's ✈ button or /flight-recorder; it records either way

    // Drive the live clock only while something is running, so idle sessions write nothing.
    $.clock.every(400, () => {
      void (async () => {
        const turn = await read($, turnAtom)
        const live = turn !== null && isLive(turn)
        const now = await $.clock.now()
        if (live) await update($, nowAtom, () => now)
        // desktop snapshot: every 2s while live, once more after a change while idle
        if (turn && (live || isDirty) && now - lastFrameAt >= FRAME_MS) {
          isDirty = false
          lastFrameAt = now
          await writeFrame($, turn, now, live)
        }
      })()
    })

    return next(e)
  })

  // The ✈ button (usage-band draws it, keyed "flight-recorder"): open the pane here and
  // take the press, so no /flight-recorder command row lands in the chat. Matched on the
  // key alone; if opening fails, the button's own fallback (running the command) runs.
  on('ui.press', { element: 'flight-recorder' }, async ($, e) => {
    await $.ui.open({ id: PANE, title: 'Flight recorder' })
    return { element: e.element }
  }).catch(($, e, next) => next(e))

  // /flight-recorder opens the pane; "text" or "dashboard" also picks the desktop view
  on('command.run', { command: 'flight-recorder' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'text' || arg === 'dashboard') await update($, modeAtom, () => arg)
    await $.ui.open({ id: PANE, title: 'Flight recorder' })
    return { text: arg === 'text' || arg === 'dashboard' ? `Flight recorder opened (${arg} view).` : 'Flight recorder opened.' }
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      const costStart = await costUsd($)
      const prev = await read($, turnAtom)
      if (prev) await update($, historyAtom, list => [summarize(prev), ...list].slice(0, 11))
      const fresh: Turn = {
        n: (prev?.n ?? 0) + 1,
        startedAt: now,
        costStart,
        cost: 0,
        cacheRead: 0,
        promptTokens: 0,
        lanes: [{ id: 'main', label: 'main', spans: [], reqs: 0, tools: 0, tokens: 0, isDone: false }],
      }
      await saveTurn($, () => fresh)
      await snapshotNow($)
    } else {
      const agentId = e.agentId
      let label = `agent ${agentId.slice(0, 4)}`
      try {
        const info = (await $.agent.list()).find(a => a.id === agentId)
        if (info) label = `${info.type.slice(0, 4)} ${agentId.slice(0, 4)}`
      } catch {
        // keep the id-based label
      }
      await saveTurn($, t => (t ? withLane(t, agentId, l => ({ ...l, isDone: false }), label) : t))
    }
    await update($, nowAtom, () => now)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const laneId = e.agentId ?? 'main'
    const id = `${e.turnId}:${e.index}`
    const start = await $.clock.now()
    await saveTurn($, t =>
      t ? withLane(t, laneId, l => openSpan({ ...l, reqs: l.reqs + 1 }, { id, kind: 'req', name: e.model, start })) : t,
    )

    const result = yield* next(e)

    const end = await $.clock.now()
    const u = result.usage
    const prompt = u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : 0
    const tokens = u ? prompt + u.output_tokens : 0
    const cacheRead = u?.cache_read_input_tokens ?? 0
    const detail = u
      ? `${fmtTokens(prompt)} in (${prompt > 0 ? Math.round((cacheRead / prompt) * 100) : 0}% cached) · ${fmtTokens(u.output_tokens)} out · ${result.toolUses.length} tool call${result.toolUses.length === 1 ? '' : 's'} asked`
      : 'no response'
    const usd = await costUsd($)
    await saveTurn($, t => {
      if (!t) return t
      const closed = withLane(t, laneId, l => {
        const c = closeSpan({ ...l, tokens: l.tokens + tokens }, id, end)
        // the answering model can differ from the requested one (fallback)
        return { ...c, spans: c.spans.map(s => (s.id === id ? { ...s, name: u?.model ?? s.name, detail } : s)) }
      })
      return {
        ...closed,
        cost: Math.max(closed.cost, usd - closed.costStart),
        cacheRead: (closed.cacheRead || 0) + cacheRead,
        promptTokens: (closed.promptTokens || 0) + prompt,
      }
    })
    if (u) {
      const fam = family(u.model)
      await update($, totalsAtom, tot => {
        const prev = tot.models[fam] ?? { tokens: 0, reqs: 0 }
        return {
          ...tot,
          models: { ...tot.models, [fam]: { tokens: prev.tokens + tokens, reqs: prev.reqs + 1 } },
          cacheRead: tot.cacheRead + cacheRead,
          promptTokens: tot.promptTokens + prompt,
        }
      })
    }
    return result
  })

  on('tool.call', async ($, e, next) => {
    const laneId = e.agentId ?? 'main'
    const id = e.tool_use_id ?? `tool:${await $.clock.now()}`
    const start = await $.clock.now()
    const name = String(e.tool)
    const detail = toolDetail(e as unknown as Record<string, unknown>)
    await saveTurn($, t =>
      t ? withLane(t, laneId, l => openSpan({ ...l, tools: l.tools + 1 }, { id, kind: 'tool', name, start, detail })) : t,
    )
    await update($, totalsAtom, tot => ({ ...tot, tools: { ...tot.tools, [name]: (tot.tools[name] ?? 0) + 1 } }))
    try {
      return await next(e)
    } finally {
      const end = await $.clock.now()
      await saveTurn($, t => (t ? withLane(t, laneId, l => closeSpan(l, id, end)) : t))
    }
  }).catch(($, e, next) => next(e)) // observer only: fail open, never block a tool

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const usd = await costUsd($)
    const laneId = e.agentId ?? 'main'
    await saveTurn($, t => {
      if (!t) return t
      const done = withLane(t, laneId, l => ({ ...l, isDone: true }))
      const withCost = { ...done, cost: Math.max(done.cost, usd - done.costStart) }
      return e.agentId === undefined ? { ...withCost, endedAt: now } : withCost
    })
    await update($, nowAtom, () => now)
    // turn and agent ends show at once on the desktop, not at the next 2s tick
    await snapshotNow($)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
    const { Box, Text, Button } = $.ui.resolve(e)
    // the desktop surface may not report bodyColumns; NaN here used to crash the whole draw
    const measured = Number.isFinite(e.props.bodyColumns) ? e.props.bodyColumns : (e.viewport?.columns ?? 80)
    const cols = Math.max(30, Math.floor(measured))

    // Two views: live text (default, every surface) and the SVG dashboard (surfaces with
    // Svg only, so not the terminal). A Text | Dashboard toggle switches on those surfaces.
    const canDashboard = e.surface !== 'terminal'
    const mode = canDashboard ? await read($, modeAtom) : 'text'
    const toggle = canDashboard ? (
      <Box flexDirection="row" gap={1}>
        <Button key="view-text" label="Text" variant={mode === 'text' ? 'primary' : 'secondary'} onPress={() => update($, modeAtom, () => 'text')} />
        <Button
          key="view-dashboard"
          label="Dashboard"
          variant={mode === 'dashboard' ? 'primary' : 'secondary'}
          onPress={() => update($, modeAtom, () => 'dashboard')}
        />
      </Box>
    ) : null

    // Dashboard: reads ONLY the throttled snapshot (every read subscribes the drawing),
    // so the SVG redraws at most every 2s instead of on every span.
    if (mode === 'dashboard' && e.surface !== 'terminal') {
      const frame = await read($, frameAtom)
      if (!frame) {
        return (
          <Box flexDirection="column">
            {toggle}
            <Text dimColor>Waiting for the first turn. Send a prompt to start recording.</Text>
          </Box>
        )
      }
      const { svg, width, height } = dashboardSvg(frame)
      // Without a size the desktop draws the SVG as a small thumbnail: fill the pane's width.
      // The pane is measured in cells; ~7 CSS px per cell (not verified on every display).
      const px = Math.min(1200, Math.max(320, Math.round(cols * 7)))
      const { Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {toggle}
          <Svg source={svg} alt={dashboardAlt(frame)} width={px} height={Math.round((px / width) * height)} isInteractive />
        </Box>
      )
    }

    const turn = await read($, turnAtom)
    const history = await read($, historyAtom)
    const now = await read($, nowAtom)

    if (!turn) {
      return (
        <Box flexDirection="column">
          {toggle}
          <Text bold color="error">● FLIGHT RECORDER</Text>
          <Text dimColor>Waiting for the first turn. Send a prompt to start recording.</Text>
        </Box>
      )
    }

    const live = isLive(turn)
    const totals = await read($, totalsAtom)

    const t0 = turn.startedAt
    const t1 = live ? Math.max(now, lastMoment(turn)) : lastMoment(turn)
    const sum = summarize(turn)
    const width = Math.max(10, cols - LABEL_W - 1)

    return (
      <Box flexDirection="column">
        {toggle}
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="error">● FLIGHT RECORDER <Text dimColor>inside the turn</Text></Text>
          {live ? <Text color="error" bold>● REC</Text> : <Text dimColor>idle</Text>}
        </Box>
        <Text wrap="truncate">
          <Text backgroundColor="#e53935" color="#ffffff" bold> TURN {turn.n} </Text>
          {'  '}
          <Text bold>{fmtSecs(t1 - t0)}</Text>
          {'  '}
          <Text color="warning">${turn.cost.toFixed(3)}</Text>
          {'  '}
          {sum.reqs} req  {sum.tools} tools  {fmtTokens(sum.tokens)} tok  {sum.agents} agents
        </Text>
        <Text dimColor wrap="truncate">{'LANE'.padEnd(LABEL_W)} {axis(t0, t1, width)}</Text>
        {turn.lanes.map(lane => (
          <Text key={lane.id} wrap="truncate">
            <Text color={lane.isDone ? undefined : 'success'}>{lane.isDone ? '○' : '●'}</Text>
            <Text>{` ${lane.label}`.slice(0, LABEL_W - 1).padEnd(LABEL_W)}</Text>
            {laneSegments(lane, t0, t1, width).map(seg =>
              seg.color === undefined ? (
                <Text dimColor>{seg.text}</Text>
              ) : (
                <Text backgroundColor={seg.color} color="#000000">{seg.text}</Text>
              ),
            )}
          </Text>
        ))}
        <Text wrap="wrap">
          <Text dimColor>MODEL </Text>
          {Object.entries(MODEL_COLORS)
            .filter(([k]) => k !== 'other')
            .map(([k, c]) => (
              <Text>
                <Text color={c}>■</Text> {k}{' '}
              </Text>
            ))}
          <Text dimColor> TOOL </Text>
          {Object.entries(TOOL_COLORS).map(([k, c]) => (
            <Text>
              <Text color={c}>■</Text> {k}{' '}
            </Text>
          ))}
        </Text>
        <Text> </Text>
        {shareRows(totals).length > 0 && (
          <Text wrap="truncate">
            <Text dimColor>{'MODELS'.padEnd(LABEL_W)}</Text>
            {shareRows(totals).map(([fam, share]) => (
              <Text backgroundColor={MODEL_COLORS[fam] ?? MODEL_COLORS.other} color="#000000">
                {' '.repeat(Math.max(1, Math.round(share * 30)))}
              </Text>
            ))}
            {shareRows(totals).map(([fam, share]) => (
              <Text>
                {'  '}
                <Text color={MODEL_COLORS[fam] ?? MODEL_COLORS.other}>■</Text> {fam} {Math.round(share * 100)}%
              </Text>
            ))}
          </Text>
        )}
        <Text dimColor>{'lane'.padEnd(LABEL_W)} {'req'.padStart(4)} {'tools'.padStart(6)} {'tokens'.padStart(8)}</Text>
        {turn.lanes.map(lane => (
          <Text key={`row-${lane.id}`}>
            {lane.label.slice(0, LABEL_W - 1).padEnd(LABEL_W)} {String(lane.reqs).padStart(4)} {String(lane.tools).padStart(6)}{' '}
            {fmtTokens(lane.tokens).padStart(8)}
          </Text>
        ))}
        {history.length > 0 && <Text> </Text>}
        {history.length > 0 && <Text dimColor>PREVIOUS TURNS</Text>}
        {history.map(past => (
          <Text key={`h-${past.n}`} dimColor wrap="truncate">
            T{past.n}  {past.seconds.toFixed(1)}s  ${past.cost.toFixed(3)}  {past.reqs} req  {past.tools} tools  {fmtTokens(past.tokens)} tok  {past.agents} agents
          </Text>
        ))}
      </Box>
    )
    } catch (err) {
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      const { Text } = $.ui.resolve(e)
      return <Text color="error">flight-recorder failed to draw: {msg}</Text>
    }
  })
}
