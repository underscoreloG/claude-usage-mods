import type { SessionAppendInput } from 'claude-code'

import type { TaskRow } from '../types'

// The id a background call answered with: Bash's backgroundTaskId (run_in_background
// or Ctrl+B), Monitor's taskId. Undefined for a call that ran in the foreground.
export function startedTaskId(tool: string, result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as { backgroundTaskId?: unknown; taskId?: unknown }
  const id = tool === 'Bash' ? r.backgroundTaskId : tool === 'Monitor' ? r.taskId : undefined
  return typeof id === 'string' && id !== '' ? id : undefined
}

// The text of a row that carries a task notification, in any loop: a prompt the
// session dequeued (origin task-notification) or one the engine delivered into a
// running turn (origin engine, a subagent's included). Undefined for any other
// row, so a tool's output or the model quoting a notification closes nothing.
export function notificationText(e: SessionAppendInput): string | undefined {
  if (e.origin.kind !== 'task-notification' && e.origin.kind !== 'engine') return undefined
  const text = e.message.content.map(b => (b.type === 'text' ? b.text : '')).join('\n')
  return text.includes('<task-notification>') ? text : undefined
}

// Close the running tasks a task notification reports on. The notification is
// text the model reads; one may carry several <task-notification> blocks, so
// each block is matched to the ids it names, with its own <status> if any.
export function endFromNotification(list: readonly TaskRow[], text: string, now: number): TaskRow[] {
  const blocks = text.split('<task-notification>').filter(b => b.trim() !== '')
  return list.map(t => {
    if (t.status !== 'running') return t
    const block = blocks.find(b => b.includes(t.id))
    if (block === undefined) return t
    const word = /<status>\s*(\w+)\s*<\/status>/.exec(block)?.[1]?.toLowerCase()
    const status = word === 'failed' || word === 'killed' ? word : 'completed'
    return { ...t, status, endedAt: now }
  })
}
