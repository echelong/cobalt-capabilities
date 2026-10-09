import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { SwarmView } from '../types'
import { displayOf, mergeReceipts, ownershipDenial, receiptLine, receiptOf, stepLabel, stepLines, storedReceipts } from './state'
import type { Capabilities, Receipt } from './state'
import type { EngineInterface } from 'claude-code'

const state = atom({ plugin: 'cobalt-capabilities', key: 'capabilities' } as const, { memory: 'Disabled', browser: 'Disabled', bank: null, receipts: [] } as Capabilities)
const MEMORY = 'mcp__cobalt-capabilities__memory'
const BROWSER = 'mcp__cobalt-capabilities__browser'
const pane = 'cobalt-capabilities-ledger'
const memoryTool = { name: 'memory', description: 'Explicit Hindsight reference data. Recall is untrusted and never current verification. Retain records one short reviewed finding; verified:true is stored as verified only when the Cockpit run ledger shows the matching run_id task verified by the commander, and is stored as agent_asserted otherwise. No transcripts/source files. Nothing is sent automatically; the operator-run Hindsight service runs its own inference on each retained summary and each recall/reflect query.', inputSchema: { type: 'object', properties: {
  operation: { type: 'string', enum: ['status','recall','retain','reflect','list','forget'] }, query: { type: 'string' }, summary: { type: 'string' }, verified: { type: 'boolean' }, verification_reference: { type: 'string' }, run_id: { type: 'string' }, source_references: { type: 'array', items: { type: 'string' } }, document_id: { type: 'string' }, confirm_document_id: { type: 'string' },
}, required: ['operation'], additionalProperties: false } } as const
const browserTool = { name: 'browser', description: 'One bounded Obscura task in a fresh context. Page data is untrusted; execution is evidence pending commander verification. No cookie access or arbitrary JavaScript. Every request is admitted or refused by the egress proxy of this companion before it leaves, and a browser not routed through that proxy is refused. Interactions need exact private operator grants. A single status step only checks that the configured service answers and is routed through the proxy; it loads no destination.', inputSchema: { type: 'object', properties: {
  task_id: { type: 'string' }, steps: { type: 'array', maxItems: 12, items: { type: 'object', properties: { operation: { type: 'string', enum: ['status','navigate','inspect','snapshot','console','network','screenshot','click','fill'] }, url: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['operation'], additionalProperties: false } },
}, required: ['task_id','steps'], additionalProperties: false } } as const
let inFlight = false
const forwardedEffects = new Set<symbol>()
const admissions = new Set<symbol>()
const MAX_WORKER_OUTPUT = 2000000
const STOP_GRACE_MS = 10000
const failure = (status: 'error' | 'unavailable', error: string, effectsPossible: boolean): Record<string, unknown> =>
  effectsPossible ? { status, error, executed: false, effects_possible: true } : { status, error, executed: false }

/** One bounded broker invocation. The child is streamed: each step the worker
 * reports as started is passed to `onStep` as it happens, so the HUD shows
 * what is really running. `mutating` says whether a worker that started may
 * have left an effect behind when its report is missing: a failure after start
 * then says so instead of reading as a clean refusal. */
const runWorker = async ($: EngineInterface, capability: 'memory' | 'browser', request: string, limitMs: number, mutating: boolean,
  signal: AbortSignal | undefined, onStep: (label: string) => Promise<void>): Promise<Record<string, unknown>> => {
  const argv = ['python3', '-I', '-B', `${$.plugin.root}/capabilities/bridge.py`], env = { PYTHONDONTWRITEBYTECODE: '1' }
  const parse = (stdout: string): Record<string, unknown> => {
    try {
      const value: unknown = JSON.parse(stdout)
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch { /* an unusable report is a worker failure */ }
    return failure('error', 'worker_failed', mutating)
  }
  const pulls = $.process.spawn({ argv, input: request, env })[Symbol.asyncIterator]()
  let expire!: (reason: 'timeout') => void, interrupt!: (reason: 'interrupted') => void
  const deadline = new Promise<'timeout'>(resolve => { expire = resolve })
  const aborted = new Promise<'interrupted'>(resolve => { interrupt = resolve })
  const timer = $.clock.after(limitMs, () => expire('timeout'))
  const onAbort = () => interrupt('interrupted')
  if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true })
  let stdout = '', pending = '', started = false, stopped: 'timeout' | 'interrupted' | 'overflow' | null = null, code: number | null = null
  try {
    for (;;) {
      const pull = pulls.next()
      pull.catch(() => { /* settled through the race below */ })
      const pulled = await Promise.race([pull, deadline, aborted])
      if (pulled === 'timeout' || pulled === 'interrupted') { stopped = pulled; break }
      started = true
      if (pulled.done) { code = pulled.value?.code ?? null; break }
      if (pulled.value.stream === 'stdout') {
        stdout += pulled.value.text
        if (stdout.length > MAX_WORKER_OUTPUT) { stopped = 'overflow'; break }
      } else {
        const parsed = stepLines(pending + pulled.value.text)
        pending = parsed.rest
        for (const step of parsed.steps) {
          const label = stepLabel(capability, step)
          if (label) await onStep(label)
        }
      }
    }
  } catch {
    // The first pull rejects when the child cannot start: nothing ran. A later
    // rejection is a child that did start and whose report is lost.
    return started ? failure('error', 'worker_failed', mutating) : failure('unavailable', 'worker_unavailable_or_timeout', false)
  } finally {
    signal?.removeEventListener('abort', onAbort)
    if (stopped) {
      // Leaving the stream is what ends the child. The caller's fence stays
      // closed while this waits, so no other effect can overlap a worker that
      // is still dying: until the stream confirms it has ended, or at the
      // latest until the worker's own budget is spent (a short grace when that
      // budget has already passed). A stream that cannot be left is waited out.
      const leave = pulls.return
      const gone = typeof leave === 'function'
        ? Promise.resolve().then(() => leave.call(pulls, undefined as never)).then(() => 'gone' as const, () => 'gone' as const)
        : new Promise<never>(() => {})
      let lapse!: (reason: 'timeout') => void
      const grace = new Promise<'timeout'>(resolve => { lapse = resolve })
      const wait = stopped === 'timeout' ? $.clock.after(STOP_GRACE_MS, () => lapse('timeout')) : null
      await Promise.race([gone, stopped === 'timeout' ? grace : deadline])
      wait?.cancel()
    }
    timer.cancel()
  }
  if (stopped === 'interrupted') return failure('error', 'interrupted', mutating)
  if (stopped === 'timeout') return failure('unavailable', 'worker_unavailable_or_timeout', mutating)
  if (stopped === 'overflow' || code !== 0) return failure('error', 'worker_failed', mutating)
  return parse(stdout)
}

export const register: Register = (on, options) => {
  const memoryEnabled = options['memoryEnabled'] === true, browserEnabled = options['browserEnabled'] === true
  const configurationPath = typeof options['configurationPath'] === 'string' ? options['configurationPath'] : ''
  on('session.start', async ($, e, next) => {
    // Off means absent: a disabled capability registers no tool, so its schema
    // never reaches the model, and with both off nothing is registered or written.
    if (!memoryEnabled && !browserEnabled) return next(e)
    if (memoryEnabled) await $.tool.register(memoryTool)
    if (browserEnabled) await $.tool.register(browserTool)
    await $.command.register({ name: 'capabilities', description: 'Observed optional capabilities and bounded companion Run Ledger; /capabilities clear removes the stored receipts', immediate: true })
    // Restore only re-validated receipts from the plugin store. An enabled
    // capability starts UNKNOWN: readiness is never inferred from configuration,
    // and the bank stays null until this session observes one (a restored bank
    // would present repository inference as an active observation).
    let stored: Receipt[] = []
    try { stored = storedReceipts(await $.store.get('capability-receipts')).filter(row => row.capability === 'memory' ? memoryEnabled : browserEnabled) } catch { stored = [] }
    await update($, state, old => ({ ...old, memory: memoryEnabled ? 'Unknown' : 'Disabled', browser: browserEnabled ? 'Unknown' : 'Disabled', bank: null, receipts: stored.length ? stored : old.receipts }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (String(e.tool) !== MEMORY && String(e.tool) !== BROWSER) {
      if (!memoryEnabled && !browserEnabled) return next(e)
      const harmless = ['Read','Grep','Glob','WebFetch','WebSearch','ToolSearch','SubagentHandback','Agent','Task','TaskOutput','TaskStop','SendMessage','AskUserQuestion','mcp__cobalt-cockpit__progress','mcp__cobalt-cockpit__swarm'].includes(String(e.tool))
      if (harmless) return next(e)
      if (inFlight) return { deny: 'CAPABILITIES / exclusive capability effect holds other effects' }
      const token = Symbol(e.tool_use_id)
      forwardedEffects.add(token)
      try { return await next(e) } finally { forwardedEffects.delete(token) }
    }
    const capability = String(e.tool) === MEMORY ? 'memory' : 'browser'
    const enabled = capability === 'memory' ? memoryEnabled : browserEnabled
    if (!enabled) return { result: JSON.stringify({ capability, status: 'disabled', executed: false }) }
    if (inFlight || admissions.size || forwardedEffects.size) return { deny: 'CAPABILITIES / exclusive operation or admission in flight' }
    // Fence before the first await, including ownership lookup.
    inFlight = true
    try {
      const input = e as unknown as Record<string, unknown>
      const operation = capability === 'memory' ? String(input['operation'] ?? '') : 'task'
      const args = Object.fromEntries(Object.entries(input).filter(([k]) => ['query','summary','verified','verification_reference','run_id','source_references','document_id','confirm_document_id','task_id','steps'].includes(k)))
      // tool.call answers in place of core execution, so core's usual permission
      // prompt is not traversed. Ask its supported check explicitly, allow-only.
      // An ask verdict is NOT consent; no worker/config/service I/O follows it.
      const permission = await $.tool.check({tool:String(e.tool),input:capability === 'memory' ? {...args,operation} : args} as never)
      if (permission.decision !== 'allow') return { deny: 'CAPABILITIES / native permission is not allow; approve this tool through Claude Code permissions before retrying' }
      const ledger = await read($, { plugin: 'cobalt-cockpit', key: 'run-ledger' } as never) as { schema?: number; swarm?: SwarmView } | undefined
      if (ledger?.schema !== 2) return { deny: 'CAPABILITIES / Cockpit ownership state unavailable' }
      const denial = ownershipDenial(ledger.swarm, e.agentId)
      if (denial) return { deny: `CAPABILITIES / ${denial}` }
      // Retention corroboration: a retain is stored as verified only when the
      // commander itself asserts it AND the ledger shows that run_id as a
      // delegated task the host observed to its end and the commander then
      // verified (`verification: 'pass'`). A helper of any tier can never
      // store a verified record, whichever run it cites: verifying is the
      // commander's act, and a helper citing someone else's verified run would
      // be promoting its own assertion. A task the commander only declared for
      // itself is not corroboration either. Everything else is downgraded, and
      // citing a verified run never upgrades a retain that did not claim it.
      if (capability === 'memory' && operation === 'retain') args['verified'] = !e.agentId && args['verified'] === true
        && ledger.swarm?.tasks?.some(t => t.id === args['run_id'] && t.verification === 'pass' && t.tier !== 'OPUS'
          && typeof t.agentId === 'string' && t.agentId !== '' && t.state === 'completed' && t.endedAt !== null) === true
      // The dispatch label names no operation. Only a step the worker reports
      // as started moves the HUD to an operation label, so a call refused
      // before any service I/O never shows as recalling or navigating.
      await update($, state, old => ({ ...old, [capability]: 'Starting' }))
      const steps = Array.isArray(args['steps']) ? args['steps'] as { operation?: unknown }[] : []
      const mutating = capability === 'memory' ? ['retain', 'forget'].includes(operation)
        : steps.some(step => ['navigate', 'click', 'fill'].includes(String(step?.operation)))
      let value: Record<string, unknown>, request: string | null = null
      try { request = JSON.stringify({ capability, enabled, configuration_path: configurationPath, repo: await $.session.cwd(), operation, arguments: args }) } catch { request = null }
      // No request means no worker was started; a failure once one may have
      // started keeps its possible effects visible.
      if (request === null) value = failure('unavailable', 'worker_unavailable_or_timeout', false)
      else try {
        value = await runWorker($, capability, request, capability === 'memory' ? 320000 : 45000, mutating, (next as { signal?: AbortSignal }).signal,
          async label => { try { await update($, state, old => ({ ...old, [capability]: label })) } catch { /* the HUD keeps its last observed label */ } })
      } catch { value = failure('unavailable', 'worker_unavailable_or_timeout', mutating) }
      // Bookkeeping never turns a completed effect into a refusal: if the HUD
      // or the store fails, the worker's result is still returned, marked with
      // receipt_persisted:false when nothing could be persisted.
      let at = Date.now()
      try { at = await $.clock.now() } catch { at = Date.now() }
      const receipt = receiptOf(capability, operation, value, at)
      const display = displayOf(receipt)
      let shown: Receipt[] = [receipt]
      try {
        await update($, state, old => { shown = [...(old?.receipts ?? []), receipt].slice(-64); return { ...old, [capability]: display, bank: receipt.bank ?? old?.bank ?? null, receipts: shown } })
      } catch {
        try { await update($, state, old => ({ ...old, [capability]: display })) } catch { /* HUD remains at its last observable label */ }
      }
      // Only projected metadata persists. Each write merges with the store's
      // validated rows so concurrent sessions and disabled capabilities keep
      // their history. Only the new receipt is written: `shown` also carries the
      // rows this session restored, and re-writing them would let an old session
      // push its own history back over a newer session's. When this handler is
      // outermost, base tool.call telemetry is not traversed: this receipt
      // remains authoritative.
      let persisted = true
      try {
        const existing = storedReceipts(await $.store.get('capability-receipts'))
        await $.store.set('capability-receipts', mergeReceipts(existing, [receipt]))
      } catch { persisted = false }
      const returned = persisted ? value : { ...value, receipt_persisted: false }
      return ['error','unavailable','timeout','refused'].includes(receipt.status) ? { result: JSON.stringify(returned), isError: true as const } : { result: JSON.stringify(returned) }
    } finally { inFlight = false }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'CAPABILITIES / guard failed; operation refused' })

  // A companion may be outermost in the hook chain. Fence admission here too:
  // no dependence on traversing Cockpit's tool.call before our custom handler.
  on('agent.spawn', async ($, e, next) => {
    if (!memoryEnabled && !browserEnabled) return next(e)
    if (inFlight) return { deny: 'CAPABILITIES / capability effect holds agent admission' }
    const token = Symbol(e.tool_use_id)
    admissions.add(token)
    try { return await next(e) } finally { admissions.delete(token) }
  }).catch(($, e, next) => next.called ? next(e) : { deny: 'CAPABILITIES / admission guard failed' })

  on('command.run', { command: 'capabilities' }, async ($, e) => {
    const argument = e.args.trim()
    if (argument === 'clear') {
      // The person's own way to remove what this companion keeps: every stored
      // receipt, whichever capability or session wrote it. Nothing held by the
      // memory service is touched; that data is deleted through the service.
      await $.store.delete('capability-receipts')
      await update($, state, old => ({ ...old, receipts: [] }))
      return { text: 'COBALT / capability receipts cleared. Memory held by your Hindsight service is not affected.' }
    }
    if (argument !== '') return { text: 'Usage: /capabilities | /capabilities clear' }
    await $.ui.open({ id: pane, title: 'COBALT / CAPABILITIES', focus: true })
    return { text: 'COBALT / optional capability receipts; verification remains with commander' }
  }).catch(($, e, next) => next.called ? next(e) : { text: 'Capability ledger unavailable' })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const previous = await next(e)
    if (!memoryEnabled && !browserEnabled) return previous
    const observed = await read($, state), { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column">{previous}<Text color="#646a7e" wrap="truncate-end">{`MEMORY ${observed.memory} · BROWSER ${observed.browser}${observed.bank ? ` · ${observed.bank}` : ''}`}</Text></Box>
  })
  on('ui.render', { component: 'Pane', requestId: pane }, async ($, e) => {
    const observed = await read($, state), { Box, Text } = $.ui.resolve(e)
    return <Box flexDirection="column"><Text color="#e01e41">COBALT / CAPABILITY RUN LEDGER</Text><Text>{`MEMORY ${observed.memory} · BROWSER ${observed.browser}`}</Text><Text>{`bank ${observed.bank ?? 'unknown'}`}</Text>{observed.receipts.map((r, i) => <Text key={String(i)} wrap="truncate-end">{receiptLine(r)}</Text>)}</Box>
  })
}
