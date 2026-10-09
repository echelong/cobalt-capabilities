import type { SwarmView, Receipt, Capabilities } from '../types'
export type { Receipt, Capabilities } from '../types'

/** Same conservative rule as Cockpit custom effects, enforced even when its
 * orchestration toggle is off. Unknown ownership cannot authorize an agent,
 * and a renamed or malformed ledger field refuses instead of failing open. */
export const ownershipDenial = (swarm: SwarmView | undefined, agent?: string): string | null => {
  if (!swarm || swarm.version !== 2 || !Array.isArray(swarm.tasks)) return 'Cockpit ownership state unavailable'
  const shaped = swarm.tasks.every(t => typeof t?.id === 'string' && typeof t.tier === 'string' && typeof t.state === 'string'
    && typeof t.mode === 'string' && Array.isArray(t.owned) && typeof t.cancellationRequested === 'boolean'
    && (t.agentId === null || typeof t.agentId === 'string')
    && (t.startedAt === null || typeof t.startedAt === 'number')
    && (t.endedAt === null || typeof t.endedAt === 'number')
    && ['pending', 'pass', 'fail', 'unknown'].includes(t.verification))
  if (!shaped) return 'Cockpit ownership state unavailable'
  const occupied = swarm.tasks.filter(t => t.endedAt === null && (t.startedAt !== null || t.agentId !== null || ['reserved', 'running'].includes(t.state)))
  if (!agent) return occupied.some(t => t.tier !== 'OPUS') ? 'Active agent ownership holds commander effects' : null
  const task = occupied.find(t => t.agentId === agent)
  if (!task || !['running', 'reserved'].includes(task.state) || task.cancellationRequested || task.mode !== 'write' || !task.owned.includes('*')) return 'Exclusive wildcard task ownership required'
  return occupied.some(t => t.id !== task.id) ? 'Another task holds resources' : null
}

const token = (v: unknown, pattern: RegExp): string | null => typeof v === 'string' && pattern.test(v) ? v : null
const finite = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 1e9) : null
/** Wall-clock stamps are not clampable: a realistic epoch millisecond value
 * must survive a restore, or the next write persists the corrupted value. */
const stamp = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
const STATUS = /^(disabled|ready|unavailable|error|success|refused|timeout|observed)$/
const OPERATION = /^(status|recall|retain|reflect|list|forget|task)$/
const STEP = /^(status|navigate|inspect|snapshot|console|network|screenshot|click|fill)$/
const ERROR = /^(interrupted|timeout|service_unavailable|operation_refused_or_invalid_response|repository_not_enabled|browser_timeout|browser_output_limit|browser_unavailable|browser_egress_unverified|browser_egress_unavailable|browser_policy_or_execution_error|browser_cleanup_failed|browser_invalid_input|worker_unavailable_or_timeout|worker_failed|resource_busy|lock_storage_unavailable|invalid_configuration_or_request)$/

/** HUD label for a step the worker reported as started. The tables are the
 * whole vocabulary: a name the worker did not report, or one outside them,
 * yields null and leaves the HUD as it was. */
const MEMORY_LABELS: Record<string, string> = { status: 'Checking', recall: 'Recalling', retain: 'Retaining', reflect: 'Reflecting', list: 'Listing', forget: 'Forgetting' }
const BROWSER_LABELS: Record<string, string> = { status: 'Checking', navigate: 'Navigating', inspect: 'Inspecting', snapshot: 'Inspecting',
  console: 'Capturing evidence', network: 'Capturing evidence', screenshot: 'Capturing evidence', click: 'Interacting', fill: 'Interacting' }
export const stepLabel = (capability: 'memory' | 'browser', step: string): string | null => {
  const labels = capability === 'memory' ? MEMORY_LABELS : BROWSER_LABELS
  return Object.hasOwn(labels, step) ? labels[step]! : null
}

/** Split worker stderr into the step names it reported. Only a complete line
 * of the one fixed shape counts; runtime warnings and anything else on the
 * pipe are dropped unread, and an unterminated tail is kept only while short. */
export const stepLines = (buffer: string): { steps: string[]; rest: string } => {
  const lines = buffer.split('\n'), rest = lines.pop() ?? ''
  const steps: string[] = []
  for (const line of lines) {
    const match = /^\{"cobalt_step": ?"([a-z]{1,16})"\}\r?$/.exec(line)
    if (match) steps.push(match[1]!)
  }
  return { steps, rest: rest.length > 64 ? '' : rest }
}

/** The resting HUD label an observed result leaves behind. */
export const displayOf = (receipt: Receipt): string => receipt.status === 'disabled' ? 'Disabled'
  : receipt.status === 'observed' ? 'Completed'
  : receipt.status === 'ready' || receipt.status === 'success' ? 'Ready'
  : receipt.status === 'unavailable' ? 'Unavailable' : 'Error'

/** One row of the capability ledger pane: fixed fields only, never content. */
export const receiptLine = (r: Receipt): string => `${r.capability} ${r.operation} ${r.status} · ${r.durationMs === null ? 'duration unknown' : `${r.durationMs}ms`} · count ${r.count ?? 'unknown'} · task ${r.task ?? 'unknown'} · ${r.operations.join(',')} · verification ${r.verification}${r.executed ? ' · executed' : r.effectsPossible ? ' · evidence invalid, effects possible' : ''}${r.fallback ? ` · fallback ${r.error ?? 'unknown'}` : ''}`

/** Re-validate a previously projected receipt from the plugin store. A stored
 * row is untrusted input: anything malformed is dropped, never displayed. */
export const storedReceipt = (value: unknown): Receipt | null => {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  const capability = row['capability'] === 'memory' || row['capability'] === 'browser' ? row['capability'] as 'memory' | 'browser' : null
  const operation = token(row['operation'], OPERATION), status = token(row['status'], STATUS), at = stamp(row['at'])
  if (!capability || !operation || !status || at === null) return null
  const verification = row['verification'] === 'pending' || row['verification'] === 'unknown' ? row['verification'] as 'pending' | 'unknown' : 'unknown'
  return {
    capability, operation, status, at,
    durationMs: finite(row['durationMs']), count: finite(row['count']),
    bank: token(row['bank'], /^cobalt-[a-f0-9]{32,64}$/), task: token(row['task'], /^[a-zA-Z0-9_.-]{1,80}$/),
    executed: row['executed'] === true, effectsPossible: row['effectsPossible'] === true, verification,
    operations: Array.isArray(row['operations']) ? (row['operations'] as unknown[]).slice(0, 12).map(step => token(step, STEP)).filter((step): step is string => step !== null) : [],
    fallback: row['fallback'] === true,
    error: token(row['error'], ERROR),
  }
}

export const storedReceipts = (value: unknown): Receipt[] =>
  Array.isArray(value) ? value.slice(-64).map(storedReceipt).filter((row): row is Receipt => row !== null) : []

/** Union two bounded receipt lists, newest last, deduplicated by identity.
 * Store writes merge instead of overwriting so a concurrent session or a
 * currently disabled capability cannot erase another session's history. */
export const mergeReceipts = (existing: Receipt[], incoming: Receipt[]): Receipt[] => {
  const seen = new Set<string>()
  const rows: Receipt[] = []
  for (const row of [...existing, ...incoming]) {
    const key = `${row.capability}|${row.operation}|${row.at}|${row.status}|${row.task ?? ''}|${row.verification}`
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  // Bounded by time, not by insertion order: a session that restores its own
  // older rows and appends one new one must not evict the newer history another
  // session wrote; the oldest rows are the ones to drop.
  return rows.sort((a, b) => a.at - b.at).slice(-64)
}

/** Explicit projection: no page text, query, summary, URLs, screenshots or errors. */
export const receiptOf = (capability: 'memory' | 'browser', operation: string, value: Record<string, unknown>, at: number): Receipt => ({
  capability, operation: token(operation, /^(status|recall|retain|reflect|list|forget|task)$/) ?? 'task',
  status: token(value['status'], STATUS) ?? 'error', at,
  durationMs: finite(value['duration_ms']), count: finite(value['result_count']),
  bank: token(value['bank_id'], /^cobalt-[a-f0-9]{32,64}$/), task: token(value['task_id'], /^[a-zA-Z0-9_.-]{1,80}$/),
  executed: value['executed'] === true, effectsPossible: value['effects_possible'] === true,
  verification: value['executed'] === true ? 'pending' : 'unknown',
  // The worker names its completed steps in `operations_completed` whenever it
  // knows them, including a failed task whose evidence rows are withheld; an
  // empty `results` array alongside it means "no evidence returned", never "no
  // step ran". Reading `results` first erased the names of every failed task.
  operations: (Array.isArray(value['operations_completed'])
    ? value['operations_completed'].slice(0, 12).map(step => token(step, STEP))
    : Array.isArray(value['results'])
      ? value['results'].slice(0, 12).map(row => token((row as Record<string, unknown>)?.['operation'], STEP))
      : []).filter((v): v is string => v !== null),
  fallback: value['fallback'] === true || ['error', 'unavailable', 'timeout', 'refused'].includes(String(value['status'])),
  error: token(value['error'], ERROR),
})
