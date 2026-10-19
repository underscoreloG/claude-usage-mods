import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, SessionUsage } from 'claude-code'

import type { Snapshot } from '../types'

const usageAtom = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const modelAtom = atom({ plugin: 'usage-band', key: 'model' } as const, null)
const nowAtom = atom({ plugin: 'usage-band', key: 'now' } as const, 0)
const hiddenAtom = atom({ plugin: 'usage-band', key: 'isHidden' } as const, false)

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
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function level(pct: number): 'success' | 'warning' | 'error' {
  if (pct >= 80) return 'error'
  if (pct >= 50) return 'warning'
  return 'success'
}

export function bar(pct: number, cells = 10): string {
  const full = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)))
  return '▰'.repeat(full) + '▱'.repeat(cells - full)
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
      description: 'Show or hide the usage band above the prompt',
    })
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

  on('command.run', { command: 'usageband' }, async $ => {
    const hidden = await update($, hiddenAtom, h => !h)
    return { text: hidden ? 'Usage band hidden.' : 'Usage band shown.' }
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
    const { Box, Text, Button } = $.ui.resolve(e)
    // the Flight recorder button shows only while that mod is loaded
    let hasFlight = false
    try {
      hasFlight = (await $.command.list()).some(c => c.name === 'flight-recorder')
    } catch {
      // no command list: leave the button out
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
          <Text color={level(pct)}>{bar(pct, 8)}</Text>
          <Text dimColor>
            {' '}
            {fmtTokens(usage.tokens ?? 0)}/{fmtTokens(usage.window)}
          </Text>
        </Text>,
      ),
    ]
    if (usage.cost !== undefined) {
      groups.push(group('Session cost', <Text bold>${usage.cost.toFixed(2)}</Text>))
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
            {reset && <Text dimColor>  resets {reset}</Text>}
          </Text>,
        ),
      )
    }
    if (model) groups.push(group('Model', <Text color="claude">{shortModel(model)}</Text>))

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
        {hasFlight && separator}
        {hasFlight && (
          <Box alignItems="center" paddingLeft={1}>
            <Button
              key="flight-recorder"
              label="✈"
              onPress={async () => {
                try {
                  await $.command.run({ command: 'flight-recorder' })
                } catch {
                  $.ui.toast('The flight-recorder mod is not loaded.')
                }
              }}
            />
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
