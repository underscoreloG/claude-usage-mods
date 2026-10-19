import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { SessionRow } from '../types'

// The desktop app's session server. Absent in a terminal session, where the
// first call says so and polling stops for good.
export const SERVER = 'ccd_session_mgmt'
export const POLL_MS = 5000

// register.tsx declares the same state; the validator wants each file's own
const sessionsAtom = atom({ plugin: 'agents-band', key: 'sessions' } as const, [] as SessionRow[])

type Listed = {
  sessionId: string
  name?: string
  title?: string
  startedBy?: string
  isArchived?: boolean
  isRunning?: boolean
  lastActivityAt?: string
}

function text(res: { content: readonly { type: string; text?: string }[] }): string {
  return res.content.map(b => (b.type === 'text' ? (b.text ?? '') : '')).join('')
}

async function callJson($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await $.mcp.call(SERVER, tool, args)
  const body = text(res)
  if (res.isError) throw new Error(body)
  // list_sessions answers plain text when the family is empty
  if (!body.trimStart().startsWith('{') && !body.trimStart().startsWith('[')) return null
  return JSON.parse(body)
}

// Every non-archived session below `root` in the startedBy tree, parents before children
export function descendants(rows: readonly Listed[], root: string): Listed[] {
  const out: Listed[] = []
  const queue = [root]
  while (queue.length > 0) {
    const parent = queue.shift()
    for (const r of rows) {
      if (r.startedBy !== parent || r.isArchived || out.includes(r)) continue
      out.push(r)
      queue.push(r.sessionId)
    }
  }
  return out
}

export function startSessionPoller($: EngineInterface) {
  let selfId: string | undefined
  let isOff = false
  let isBusy = false
  // model is fixed per session in practice; read once
  const models = new Map<string, string>()

  const poll = async () => {
    if (isOff || isBusy) return
    isBusy = true
    try {
      if (selfId === undefined) {
        const self = (await callJson($, 'get_session', { session_id: 'self' })) as { sessionId?: string } | null
        if (!self?.sessionId) return
        selfId = self.sessionId
      }
      const listed = ((await callJson($, 'list_sessions', { linked: true, limit: 50 })) as Listed[] | null) ?? []
      const family = descendants(listed, selfId)
      const previous = await read($, sessionsAtom)
      const rows: SessionRow[] = []
      for (const s of family) {
        if (!models.has(s.sessionId)) {
          const info = (await callJson($, 'get_session', { session_id: s.sessionId }).catch(() => null)) as {
            model?: string
          } | null
          if (info?.model) models.set(s.sessionId, info.model)
        }
        // an idle session reports its context unavailable: keep the last known figure
        let contextPercent = previous.find(p => p.id === s.sessionId)?.contextPercent
        if (s.isRunning || contextPercent === undefined) {
          const usage = (await callJson($, 'get_usage', { session_id: s.sessionId }).catch(() => null)) as {
            context?: { status?: string; percentUsed?: number }
          } | null
          if (usage?.context?.status === 'ok' && typeof usage.context.percentUsed === 'number') {
            contextPercent = usage.context.percentUsed
          }
        }
        rows.push({
          id: s.sessionId,
          name: s.name ?? s.sessionId.slice(6, 14),
          title: s.title ?? '',
          isRunning: s.isRunning === true,
          lastActivityAt: Date.parse(s.lastActivityAt ?? '') || 0,
          model: models.get(s.sessionId),
          contextPercent,
        })
      }
      // write only on change, so an idle family costs no redraws
      if (JSON.stringify(rows) !== JSON.stringify(previous)) await update($, sessionsAtom, () => rows)
    } catch (err) {
      // no server here (a terminal session): stop; anything else: try again next round
      if (/no connected MCP tool/.test(String(err))) isOff = true
    } finally {
      isBusy = false
    }
  }

  void poll()
  $.clock.every(POLL_MS, () => void poll())
}
