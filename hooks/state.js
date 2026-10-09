"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.receiptOf = exports.mergeReceipts = exports.storedReceipts = exports.storedReceipt = exports.receiptLine = exports.displayOf = exports.stepLines = exports.stepLabel = exports.ownershipDenial = void 0;
/** Same conservative rule as Cockpit custom effects, enforced even when its
 * orchestration toggle is off. Unknown ownership cannot authorize an agent,
 * and a renamed or malformed ledger field refuses instead of failing open. */
var ownershipDenial = function (swarm, agent) {
    if (!swarm || swarm.version !== 2 || !Array.isArray(swarm.tasks))
        return 'Cockpit ownership state unavailable';
    var shaped = swarm.tasks.every(function (t) { return typeof (t === null || t === void 0 ? void 0 : t.id) === 'string' && typeof t.tier === 'string' && typeof t.state === 'string'
        && typeof t.mode === 'string' && Array.isArray(t.owned) && typeof t.cancellationRequested === 'boolean'
        && (t.agentId === null || typeof t.agentId === 'string')
        && (t.startedAt === null || typeof t.startedAt === 'number')
        && (t.endedAt === null || typeof t.endedAt === 'number')
        && ['pending', 'pass', 'fail', 'unknown'].includes(t.verification); });
    if (!shaped)
        return 'Cockpit ownership state unavailable';
    var occupied = swarm.tasks.filter(function (t) { return t.endedAt === null && (t.startedAt !== null || t.agentId !== null || ['reserved', 'running'].includes(t.state)); });
    if (!agent)
        return occupied.some(function (t) { return t.tier !== 'OPUS'; }) ? 'Active agent ownership holds commander effects' : null;
    var task = occupied.find(function (t) { return t.agentId === agent; });
    if (!task || !['running', 'reserved'].includes(task.state) || task.cancellationRequested || task.mode !== 'write' || !task.owned.includes('*'))
        return 'Exclusive wildcard task ownership required';
    return occupied.some(function (t) { return t.id !== task.id; }) ? 'Another task holds resources' : null;
};
exports.ownershipDenial = ownershipDenial;
var token = function (v, pattern) { return typeof v === 'string' && pattern.test(v) ? v : null; };
var finite = function (v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(v, 1e9) : null; };
/** Wall-clock stamps are not clampable: a realistic epoch millisecond value
 * must survive a restore, or the next write persists the corrupted value. */
var stamp = function (v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null; };
var STATUS = /^(disabled|ready|unavailable|error|success|refused|timeout|observed)$/;
var OPERATION = /^(status|recall|retain|reflect|list|forget|task)$/;
var STEP = /^(status|navigate|inspect|snapshot|console|network|screenshot|click|fill)$/;
var ERROR = /^(interrupted|timeout|service_unavailable|operation_refused_or_invalid_response|repository_not_enabled|browser_timeout|browser_output_limit|browser_unavailable|browser_egress_unverified|browser_egress_unavailable|browser_policy_or_execution_error|browser_cleanup_failed|browser_invalid_input|worker_unavailable_or_timeout|worker_failed|resource_busy|lock_storage_unavailable|invalid_configuration_or_request)$/;
/** HUD label for a step the worker reported as started. The tables are the
 * whole vocabulary: a name the worker did not report, or one outside them,
 * yields null and leaves the HUD as it was. */
var MEMORY_LABELS = { status: 'Checking', recall: 'Recalling', retain: 'Retaining', reflect: 'Reflecting', list: 'Listing', forget: 'Forgetting' };
var BROWSER_LABELS = { status: 'Checking', navigate: 'Navigating', inspect: 'Inspecting', snapshot: 'Inspecting',
    console: 'Capturing evidence', network: 'Capturing evidence', screenshot: 'Capturing evidence', click: 'Interacting', fill: 'Interacting' };
var stepLabel = function (capability, step) {
    var labels = capability === 'memory' ? MEMORY_LABELS : BROWSER_LABELS;
    return Object.hasOwn(labels, step) ? labels[step] : null;
};
exports.stepLabel = stepLabel;
/** Split worker stderr into the step names it reported. Only a complete line
 * of the one fixed shape counts; runtime warnings and anything else on the
 * pipe are dropped unread, and an unterminated tail is kept only while short. */
var stepLines = function (buffer) {
    var _a;
    var lines = buffer.split('\n'), rest = (_a = lines.pop()) !== null && _a !== void 0 ? _a : '';
    var steps = [];
    for (var _i = 0, lines_1 = lines; _i < lines_1.length; _i++) {
        var line = lines_1[_i];
        var match = /^\{"cobalt_step": ?"([a-z]{1,16})"\}\r?$/.exec(line);
        if (match)
            steps.push(match[1]);
    }
    return { steps: steps, rest: rest.length > 64 ? '' : rest };
};
exports.stepLines = stepLines;
/** The resting HUD label an observed result leaves behind. */
var displayOf = function (receipt) { return receipt.status === 'disabled' ? 'Disabled'
    : receipt.status === 'observed' ? 'Completed'
        : receipt.status === 'ready' || receipt.status === 'success' ? 'Ready'
            : receipt.status === 'unavailable' ? 'Unavailable' : 'Error'; };
exports.displayOf = displayOf;
/** One row of the capability ledger pane: fixed fields only, never content. */
var receiptLine = function (r) { var _a, _b, _c; return "".concat(r.capability, " ").concat(r.operation, " ").concat(r.status, " \u00B7 ").concat(r.durationMs === null ? 'duration unknown' : "".concat(r.durationMs, "ms"), " \u00B7 count ").concat((_a = r.count) !== null && _a !== void 0 ? _a : 'unknown', " \u00B7 task ").concat((_b = r.task) !== null && _b !== void 0 ? _b : 'unknown', " \u00B7 ").concat(r.operations.join(','), " \u00B7 verification ").concat(r.verification).concat(r.executed ? ' · executed' : r.effectsPossible ? ' · evidence invalid, effects possible' : '').concat(r.fallback ? " \u00B7 fallback ".concat((_c = r.error) !== null && _c !== void 0 ? _c : 'unknown') : ''); };
exports.receiptLine = receiptLine;
/** Re-validate a previously projected receipt from the plugin store. A stored
 * row is untrusted input: anything malformed is dropped, never displayed. */
var storedReceipt = function (value) {
    if (typeof value !== 'object' || value === null)
        return null;
    var row = value;
    var capability = row['capability'] === 'memory' || row['capability'] === 'browser' ? row['capability'] : null;
    var operation = token(row['operation'], OPERATION), status = token(row['status'], STATUS), at = stamp(row['at']);
    if (!capability || !operation || !status || at === null)
        return null;
    var verification = row['verification'] === 'pending' || row['verification'] === 'unknown' ? row['verification'] : 'unknown';
    return {
        capability: capability,
        operation: operation,
        status: status,
        at: at,
        durationMs: finite(row['durationMs']), count: finite(row['count']),
        bank: token(row['bank'], /^cobalt-[a-f0-9]{32,64}$/), task: token(row['task'], /^[a-zA-Z0-9_.-]{1,80}$/),
        executed: row['executed'] === true, effectsPossible: row['effectsPossible'] === true,
        verification: verification,
        operations: Array.isArray(row['operations']) ? row['operations'].slice(0, 12).map(function (step) { return token(step, STEP); }).filter(function (step) { return step !== null; }) : [],
        fallback: row['fallback'] === true,
        error: token(row['error'], ERROR),
    };
};
exports.storedReceipt = storedReceipt;
var storedReceipts = function (value) {
    return Array.isArray(value) ? value.slice(-64).map(exports.storedReceipt).filter(function (row) { return row !== null; }) : [];
};
exports.storedReceipts = storedReceipts;
/** Union two bounded receipt lists, newest last, deduplicated by identity.
 * Store writes merge instead of overwriting so a concurrent session or a
 * currently disabled capability cannot erase another session's history. */
var mergeReceipts = function (existing, incoming) {
    var _a;
    var seen = new Set();
    var rows = [];
    for (var _i = 0, _b = __spreadArray(__spreadArray([], existing, true), incoming, true); _i < _b.length; _i++) {
        var row = _b[_i];
        var key = "".concat(row.capability, "|").concat(row.operation, "|").concat(row.at, "|").concat(row.status, "|").concat((_a = row.task) !== null && _a !== void 0 ? _a : '', "|").concat(row.verification);
        if (seen.has(key))
            continue;
        seen.add(key);
        rows.push(row);
    }
    // Bounded by time, not by insertion order: a session that restores its own
    // older rows and appends one new one must not evict the newer history another
    // session wrote; the oldest rows are the ones to drop.
    return rows.sort(function (a, b) { return a.at - b.at; }).slice(-64);
};
exports.mergeReceipts = mergeReceipts;
/** Explicit projection: no page text, query, summary, URLs, screenshots or errors. */
var receiptOf = function (capability, operation, value, at) {
    var _a, _b;
    return ({
        capability: capability,
        operation: (_a = token(operation, /^(status|recall|retain|reflect|list|forget|task)$/)) !== null && _a !== void 0 ? _a : 'task',
        status: (_b = token(value['status'], STATUS)) !== null && _b !== void 0 ? _b : 'error',
        at: at,
        durationMs: finite(value['duration_ms']), count: finite(value['result_count']),
        bank: token(value['bank_id'], /^cobalt-[a-f0-9]{32,64}$/), task: token(value['task_id'], /^[a-zA-Z0-9_.-]{1,80}$/),
        executed: value['executed'] === true, effectsPossible: value['effects_possible'] === true,
        verification: value['executed'] === true ? 'pending' : 'unknown',
        // The worker names its completed steps in `operations_completed` whenever it
        // knows them, including a failed task whose evidence rows are withheld; an
        // empty `results` array alongside it means "no evidence returned", never "no
        // step ran". Reading `results` first erased the names of every failed task.
        operations: (Array.isArray(value['operations_completed'])
            ? value['operations_completed'].slice(0, 12).map(function (step) { return token(step, STEP); })
            : Array.isArray(value['results'])
                ? value['results'].slice(0, 12).map(function (row) { return token(row === null || row === void 0 ? void 0 : row['operation'], STEP); })
                : []).filter(function (v) { return v !== null; }),
        fallback: value['fallback'] === true || ['error', 'unavailable', 'timeout', 'refused'].includes(String(value['status'])),
        error: token(value['error'], ERROR),
    });
};
exports.receiptOf = receiptOf;
