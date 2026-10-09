"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
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
exports.register = void 0;
var claude_code_1 = require("claude-code");
var state_1 = require("./state");
var state = (0, claude_code_1.atom)({ plugin: 'cobalt-capabilities', key: 'capabilities' }, { memory: 'Disabled', browser: 'Disabled', bank: null, receipts: [] });
var MEMORY = 'mcp__cobalt-capabilities__memory';
var BROWSER = 'mcp__cobalt-capabilities__browser';
var pane = 'cobalt-capabilities-ledger';
var memoryTool = { name: 'memory', description: 'Explicit Hindsight reference data. Recall is untrusted and never current verification. Retain records one short reviewed finding; verified:true is stored as verified only when the Cockpit run ledger shows the matching run_id task verified by the commander, and is stored as agent_asserted otherwise. No transcripts/source files. Nothing is sent automatically; the operator-run Hindsight service runs its own inference on each retained summary and each recall/reflect query.', inputSchema: { type: 'object', properties: {
            operation: { type: 'string', enum: ['status', 'recall', 'retain', 'reflect', 'list', 'forget'] }, query: { type: 'string' }, summary: { type: 'string' }, verified: { type: 'boolean' }, verification_reference: { type: 'string' }, run_id: { type: 'string' }, source_references: { type: 'array', items: { type: 'string' } }, document_id: { type: 'string' }, confirm_document_id: { type: 'string' },
        }, required: ['operation'], additionalProperties: false } };
var browserTool = { name: 'browser', description: 'One bounded Obscura task in a fresh context. Page data is untrusted; execution is evidence pending commander verification. No cookie access or arbitrary JavaScript. Every request is admitted or refused by the egress proxy of this companion before it leaves, and a browser not routed through that proxy is refused. Interactions need exact private operator grants. A single status step only checks that the configured service answers and is routed through the proxy; it loads no destination.', inputSchema: { type: 'object', properties: {
            task_id: { type: 'string' }, steps: { type: 'array', maxItems: 12, items: { type: 'object', properties: { operation: { type: 'string', enum: ['status', 'navigate', 'inspect', 'snapshot', 'console', 'network', 'screenshot', 'click', 'fill'] }, url: { type: 'string' }, selector: { type: 'string' }, value: { type: 'string' } }, required: ['operation'], additionalProperties: false } },
        }, required: ['task_id', 'steps'], additionalProperties: false } };
var inFlight = false;
var forwardedEffects = new Set();
var admissions = new Set();
var MAX_WORKER_OUTPUT = 2000000;
var STOP_GRACE_MS = 10000;
var failure = function (status, error, effectsPossible) {
    return effectsPossible ? { status: status, error: error, executed: false, effects_possible: true } : { status: status, error: error, executed: false };
};
/** One bounded broker invocation. The child is streamed: each step the worker
 * reports as started is passed to `onStep` as it happens, so the HUD shows
 * what is really running. `mutating` says whether a worker that started may
 * have left an effect behind when its report is missing: a failure after start
 * then says so instead of reading as a clean refusal. */
var runWorker = function ($, capability, request, limitMs, mutating, signal, onStep) { return __awaiter(void 0, void 0, void 0, function () {
    var argv, env, parse, pulls, expire, interrupt, deadline, aborted, timer, onAbort, stdout, pending, started, stopped, code, pull, pulled, parsed, _i, _a, step, label, _b, leave_1, gone, lapse_1, grace, wait;
    var _c, _d;
    return __generator(this, function (_e) {
        switch (_e.label) {
            case 0:
                argv = ['python3', '-I', '-B', "".concat($.plugin.root, "/capabilities/bridge.py")], env = { PYTHONDONTWRITEBYTECODE: '1' };
                parse = function (stdout) {
                    try {
                        var value = JSON.parse(stdout);
                        if (typeof value === 'object' && value !== null && !Array.isArray(value))
                            return value;
                    }
                    catch ( /* an unusable report is a worker failure */_a) { /* an unusable report is a worker failure */ }
                    return failure('error', 'worker_failed', mutating);
                };
                pulls = $.process.spawn({ argv: argv, input: request, env: env })[Symbol.asyncIterator]();
                deadline = new Promise(function (resolve) { expire = resolve; });
                aborted = new Promise(function (resolve) { interrupt = resolve; });
                timer = $.clock.after(limitMs, function () { return expire('timeout'); });
                onAbort = function () { return interrupt('interrupted'); };
                if (signal === null || signal === void 0 ? void 0 : signal.aborted)
                    onAbort();
                else
                    signal === null || signal === void 0 ? void 0 : signal.addEventListener('abort', onAbort, { once: true });
                stdout = '', pending = '', started = false, stopped = null, code = null;
                _e.label = 1;
            case 1:
                _e.trys.push([1, 10, 11, 14]);
                _e.label = 2;
            case 2:
                pull = pulls.next();
                pull.catch(function () { });
                return [4 /*yield*/, Promise.race([pull, deadline, aborted])];
            case 3:
                pulled = _e.sent();
                if (pulled === 'timeout' || pulled === 'interrupted') {
                    stopped = pulled;
                    return [3 /*break*/, 9];
                }
                started = true;
                if (pulled.done) {
                    code = (_d = (_c = pulled.value) === null || _c === void 0 ? void 0 : _c.code) !== null && _d !== void 0 ? _d : null;
                    return [3 /*break*/, 9];
                }
                if (!(pulled.value.stream === 'stdout')) return [3 /*break*/, 4];
                stdout += pulled.value.text;
                if (stdout.length > MAX_WORKER_OUTPUT) {
                    stopped = 'overflow';
                    return [3 /*break*/, 9];
                }
                return [3 /*break*/, 8];
            case 4:
                parsed = (0, state_1.stepLines)(pending + pulled.value.text);
                pending = parsed.rest;
                _i = 0, _a = parsed.steps;
                _e.label = 5;
            case 5:
                if (!(_i < _a.length)) return [3 /*break*/, 8];
                step = _a[_i];
                label = (0, state_1.stepLabel)(capability, step);
                if (!label) return [3 /*break*/, 7];
                return [4 /*yield*/, onStep(label)];
            case 6:
                _e.sent();
                _e.label = 7;
            case 7:
                _i++;
                return [3 /*break*/, 5];
            case 8: return [3 /*break*/, 2];
            case 9: return [3 /*break*/, 14];
            case 10:
                _b = _e.sent();
                // The first pull rejects when the child cannot start: nothing ran. A later
                // rejection is a child that did start and whose report is lost.
                return [2 /*return*/, started ? failure('error', 'worker_failed', mutating) : failure('unavailable', 'worker_unavailable_or_timeout', false)];
            case 11:
                signal === null || signal === void 0 ? void 0 : signal.removeEventListener('abort', onAbort);
                if (!stopped) return [3 /*break*/, 13];
                leave_1 = pulls.return;
                gone = typeof leave_1 === 'function'
                    ? Promise.resolve().then(function () { return leave_1.call(pulls, undefined); }).then(function () { return 'gone'; }, function () { return 'gone'; })
                    : new Promise(function () { });
                grace = new Promise(function (resolve) { lapse_1 = resolve; });
                wait = stopped === 'timeout' ? $.clock.after(STOP_GRACE_MS, function () { return lapse_1('timeout'); }) : null;
                return [4 /*yield*/, Promise.race([gone, stopped === 'timeout' ? grace : deadline])];
            case 12:
                _e.sent();
                wait === null || wait === void 0 ? void 0 : wait.cancel();
                _e.label = 13;
            case 13:
                timer.cancel();
                return [7 /*endfinally*/];
            case 14:
                if (stopped === 'interrupted')
                    return [2 /*return*/, failure('error', 'interrupted', mutating)];
                if (stopped === 'timeout')
                    return [2 /*return*/, failure('unavailable', 'worker_unavailable_or_timeout', mutating)];
                if (stopped === 'overflow' || code !== 0)
                    return [2 /*return*/, failure('error', 'worker_failed', mutating)];
                return [2 /*return*/, parse(stdout)];
        }
    });
}); };
var register = function (on, options) {
    var memoryEnabled = options['memoryEnabled'] === true, browserEnabled = options['browserEnabled'] === true;
    var configurationPath = typeof options['configurationPath'] === 'string' ? options['configurationPath'] : '';
    on('session.start', function ($, e, next) { return __awaiter(void 0, void 0, void 0, function () {
        var stored, _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    // Off means absent: a disabled capability registers no tool, so its schema
                    // never reaches the model, and with both off nothing is registered or written.
                    if (!memoryEnabled && !browserEnabled)
                        return [2 /*return*/, next(e)];
                    if (!memoryEnabled) return [3 /*break*/, 2];
                    return [4 /*yield*/, $.tool.register(memoryTool)];
                case 1:
                    _c.sent();
                    _c.label = 2;
                case 2:
                    if (!browserEnabled) return [3 /*break*/, 4];
                    return [4 /*yield*/, $.tool.register(browserTool)];
                case 3:
                    _c.sent();
                    _c.label = 4;
                case 4: return [4 /*yield*/, $.command.register({ name: 'capabilities', description: 'Observed optional capabilities and bounded companion Run Ledger; /capabilities clear removes the stored receipts', immediate: true })
                    // Restore only re-validated receipts from the plugin store. An enabled
                    // capability starts UNKNOWN: readiness is never inferred from configuration,
                    // and the bank stays null until this session observes one (a restored bank
                    // would present repository inference as an active observation).
                ];
                case 5:
                    _c.sent();
                    stored = [];
                    _c.label = 6;
                case 6:
                    _c.trys.push([6, 8, , 9]);
                    _a = state_1.storedReceipts;
                    return [4 /*yield*/, $.store.get('capability-receipts')];
                case 7:
                    stored = _a.apply(void 0, [_c.sent()]).filter(function (row) { return row.capability === 'memory' ? memoryEnabled : browserEnabled; });
                    return [3 /*break*/, 9];
                case 8:
                    _b = _c.sent();
                    stored = [];
                    return [3 /*break*/, 9];
                case 9: return [4 /*yield*/, (0, claude_code_1.update)($, state, function (old) { return (__assign(__assign({}, old), { memory: memoryEnabled ? 'Unknown' : 'Disabled', browser: browserEnabled ? 'Unknown' : 'Disabled', bank: null, receipts: stored.length ? stored : old.receipts })); })];
                case 10:
                    _c.sent();
                    return [2 /*return*/, next(e)];
            }
        });
    }); }).catch(function ($, e, next) { return next(e); });
    on('tool.call', function ($, e, next) { return __awaiter(void 0, void 0, void 0, function () {
        var harmless, token, capability, enabled, input, operation, args_1, permission, ledger, denial, steps, mutating, value, request, _a, _b, _c, _d, at, _e, receipt_1, display_1, shown_1, _f, _g, persisted, existing, _h, _j, returned;
        var _k;
        var _l, _m, _o;
        return __generator(this, function (_p) {
            switch (_p.label) {
                case 0:
                    if (!(String(e.tool) !== MEMORY && String(e.tool) !== BROWSER)) return [3 /*break*/, 4];
                    if (!memoryEnabled && !browserEnabled)
                        return [2 /*return*/, next(e)];
                    harmless = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'SubagentHandback', 'Agent', 'Task', 'TaskOutput', 'TaskStop', 'SendMessage', 'AskUserQuestion', 'mcp__cobalt-cockpit__progress', 'mcp__cobalt-cockpit__swarm'].includes(String(e.tool));
                    if (harmless)
                        return [2 /*return*/, next(e)];
                    if (inFlight)
                        return [2 /*return*/, { deny: 'CAPABILITIES / exclusive capability effect holds other effects' }];
                    token = Symbol(e.tool_use_id);
                    forwardedEffects.add(token);
                    _p.label = 1;
                case 1:
                    _p.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, next(e)];
                case 2: return [2 /*return*/, _p.sent()];
                case 3:
                    forwardedEffects.delete(token);
                    return [7 /*endfinally*/];
                case 4:
                    capability = String(e.tool) === MEMORY ? 'memory' : 'browser';
                    enabled = capability === 'memory' ? memoryEnabled : browserEnabled;
                    if (!enabled)
                        return [2 /*return*/, { result: JSON.stringify({ capability: capability, status: 'disabled', executed: false }) }];
                    if (inFlight || admissions.size || forwardedEffects.size)
                        return [2 /*return*/, { deny: 'CAPABILITIES / exclusive operation or admission in flight' }
                            // Fence before the first await, including ownership lookup.
                        ];
                    // Fence before the first await, including ownership lookup.
                    inFlight = true;
                    _p.label = 5;
                case 5:
                    _p.trys.push([5, , 34, 35]);
                    input = e;
                    operation = capability === 'memory' ? String((_l = input['operation']) !== null && _l !== void 0 ? _l : '') : 'task';
                    args_1 = Object.fromEntries(Object.entries(input).filter(function (_a) {
                        var k = _a[0];
                        return ['query', 'summary', 'verified', 'verification_reference', 'run_id', 'source_references', 'document_id', 'confirm_document_id', 'task_id', 'steps'].includes(k);
                    }));
                    return [4 /*yield*/, $.tool.check({ tool: String(e.tool), input: capability === 'memory' ? __assign(__assign({}, args_1), { operation: operation }) : args_1 })];
                case 6:
                    permission = _p.sent();
                    if (permission.decision !== 'allow')
                        return [2 /*return*/, { deny: 'CAPABILITIES / native permission is not allow; approve this tool through Claude Code permissions before retrying' }];
                    return [4 /*yield*/, (0, claude_code_1.read)($, { plugin: 'cobalt-cockpit', key: 'run-ledger' })];
                case 7:
                    ledger = _p.sent();
                    if ((ledger === null || ledger === void 0 ? void 0 : ledger.schema) !== 2)
                        return [2 /*return*/, { deny: 'CAPABILITIES / Cockpit ownership state unavailable' }];
                    denial = (0, state_1.ownershipDenial)(ledger.swarm, e.agentId);
                    if (denial)
                        return [2 /*return*/, { deny: "CAPABILITIES / ".concat(denial) }
                            // Retention corroboration: a retain is stored as verified only when the
                            // commander itself asserts it AND the ledger shows that run_id as a
                            // delegated task the host observed to its end and the commander then
                            // verified (`verification: 'pass'`). A helper of any tier can never
                            // store a verified record, whichever run it cites: verifying is the
                            // commander's act, and a helper citing someone else's verified run would
                            // be promoting its own assertion. A task the commander only declared for
                            // itself is not corroboration either. Everything else is downgraded, and
                            // citing a verified run never upgrades a retain that did not claim it.
                        ];
                    // Retention corroboration: a retain is stored as verified only when the
                    // commander itself asserts it AND the ledger shows that run_id as a
                    // delegated task the host observed to its end and the commander then
                    // verified (`verification: 'pass'`). A helper of any tier can never
                    // store a verified record, whichever run it cites: verifying is the
                    // commander's act, and a helper citing someone else's verified run would
                    // be promoting its own assertion. A task the commander only declared for
                    // itself is not corroboration either. Everything else is downgraded, and
                    // citing a verified run never upgrades a retain that did not claim it.
                    if (capability === 'memory' && operation === 'retain')
                        args_1['verified'] = !e.agentId && args_1['verified'] === true
                            && ((_o = (_m = ledger.swarm) === null || _m === void 0 ? void 0 : _m.tasks) === null || _o === void 0 ? void 0 : _o.some(function (t) { return t.id === args_1['run_id'] && t.verification === 'pass' && t.tier !== 'OPUS'
                                && typeof t.agentId === 'string' && t.agentId !== '' && t.state === 'completed' && t.endedAt !== null; })) === true;
                    // The dispatch label names no operation. Only a step the worker reports
                    // as started moves the HUD to an operation label, so a call refused
                    // before any service I/O never shows as recalling or navigating.
                    return [4 /*yield*/, (0, claude_code_1.update)($, state, function (old) {
                            var _a;
                            return (__assign(__assign({}, old), (_a = {}, _a[capability] = 'Starting', _a)));
                        })];
                case 8:
                    // The dispatch label names no operation. Only a step the worker reports
                    // as started moves the HUD to an operation label, so a call refused
                    // before any service I/O never shows as recalling or navigating.
                    _p.sent();
                    steps = Array.isArray(args_1['steps']) ? args_1['steps'] : [];
                    mutating = capability === 'memory' ? ['retain', 'forget'].includes(operation)
                        : steps.some(function (step) { return ['navigate', 'click', 'fill'].includes(String(step === null || step === void 0 ? void 0 : step.operation)); });
                    value = void 0, request = null;
                    _p.label = 9;
                case 9:
                    _p.trys.push([9, 11, , 12]);
                    _b = (_a = JSON).stringify;
                    _k = { capability: capability, enabled: enabled, configuration_path: configurationPath };
                    return [4 /*yield*/, $.session.cwd()];
                case 10:
                    request = _b.apply(_a, [(_k.repo = _p.sent(), _k.operation = operation, _k.arguments = args_1, _k)]);
                    return [3 /*break*/, 12];
                case 11:
                    _c = _p.sent();
                    request = null;
                    return [3 /*break*/, 12];
                case 12:
                    if (!(request === null)) return [3 /*break*/, 13];
                    value = failure('unavailable', 'worker_unavailable_or_timeout', false);
                    return [3 /*break*/, 16];
                case 13:
                    _p.trys.push([13, 15, , 16]);
                    return [4 /*yield*/, runWorker($, capability, request, capability === 'memory' ? 320000 : 45000, mutating, next.signal, function (label) { return __awaiter(void 0, void 0, void 0, function () { var _a; return __generator(this, function (_b) {
                            switch (_b.label) {
                                case 0:
                                    _b.trys.push([0, 2, , 3]);
                                    return [4 /*yield*/, (0, claude_code_1.update)($, state, function (old) {
                                            var _a;
                                            return (__assign(__assign({}, old), (_a = {}, _a[capability] = label, _a)));
                                        })];
                                case 1:
                                    _b.sent();
                                    return [3 /*break*/, 3];
                                case 2:
                                    _a = _b.sent();
                                    return [3 /*break*/, 3];
                                case 3: return [2 /*return*/];
                            }
                        }); }); })];
                case 14:
                    value = _p.sent();
                    return [3 /*break*/, 16];
                case 15:
                    _d = _p.sent();
                    value = failure('unavailable', 'worker_unavailable_or_timeout', mutating);
                    return [3 /*break*/, 16];
                case 16:
                    at = Date.now();
                    _p.label = 17;
                case 17:
                    _p.trys.push([17, 19, , 20]);
                    return [4 /*yield*/, $.clock.now()];
                case 18:
                    at = _p.sent();
                    return [3 /*break*/, 20];
                case 19:
                    _e = _p.sent();
                    at = Date.now();
                    return [3 /*break*/, 20];
                case 20:
                    receipt_1 = (0, state_1.receiptOf)(capability, operation, value, at);
                    display_1 = (0, state_1.displayOf)(receipt_1);
                    shown_1 = [receipt_1];
                    _p.label = 21;
                case 21:
                    _p.trys.push([21, 23, , 28]);
                    return [4 /*yield*/, (0, claude_code_1.update)($, state, function (old) {
                            var _a;
                            var _b, _c, _d;
                            shown_1 = __spreadArray(__spreadArray([], ((_b = old === null || old === void 0 ? void 0 : old.receipts) !== null && _b !== void 0 ? _b : []), true), [receipt_1], false).slice(-64);
                            return __assign(__assign({}, old), (_a = {}, _a[capability] = display_1, _a.bank = (_d = (_c = receipt_1.bank) !== null && _c !== void 0 ? _c : old === null || old === void 0 ? void 0 : old.bank) !== null && _d !== void 0 ? _d : null, _a.receipts = shown_1, _a));
                        })];
                case 22:
                    _p.sent();
                    return [3 /*break*/, 28];
                case 23:
                    _f = _p.sent();
                    _p.label = 24;
                case 24:
                    _p.trys.push([24, 26, , 27]);
                    return [4 /*yield*/, (0, claude_code_1.update)($, state, function (old) {
                            var _a;
                            return (__assign(__assign({}, old), (_a = {}, _a[capability] = display_1, _a)));
                        })];
                case 25:
                    _p.sent();
                    return [3 /*break*/, 27];
                case 26:
                    _g = _p.sent();
                    return [3 /*break*/, 27];
                case 27: return [3 /*break*/, 28];
                case 28:
                    persisted = true;
                    _p.label = 29;
                case 29:
                    _p.trys.push([29, 32, , 33]);
                    _h = state_1.storedReceipts;
                    return [4 /*yield*/, $.store.get('capability-receipts')];
                case 30:
                    existing = _h.apply(void 0, [_p.sent()]);
                    return [4 /*yield*/, $.store.set('capability-receipts', (0, state_1.mergeReceipts)(existing, [receipt_1]))];
                case 31:
                    _p.sent();
                    return [3 /*break*/, 33];
                case 32:
                    _j = _p.sent();
                    persisted = false;
                    return [3 /*break*/, 33];
                case 33:
                    returned = persisted ? value : __assign(__assign({}, value), { receipt_persisted: false });
                    return [2 /*return*/, ['error', 'unavailable', 'timeout', 'refused'].includes(receipt_1.status) ? { result: JSON.stringify(returned), isError: true } : { result: JSON.stringify(returned) }];
                case 34:
                    inFlight = false;
                    return [7 /*endfinally*/];
                case 35: return [2 /*return*/];
            }
        });
    }); }).catch(function ($, e, next) { return next.called ? next(e) : { deny: 'CAPABILITIES / guard failed; operation refused' }; });
    // A companion may be outermost in the hook chain. Fence admission here too:
    // no dependence on traversing Cockpit's tool.call before our custom handler.
    on('agent.spawn', function ($, e, next) { return __awaiter(void 0, void 0, void 0, function () {
        var token;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!memoryEnabled && !browserEnabled)
                        return [2 /*return*/, next(e)];
                    if (inFlight)
                        return [2 /*return*/, { deny: 'CAPABILITIES / capability effect holds agent admission' }];
                    token = Symbol(e.tool_use_id);
                    admissions.add(token);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, , 3, 4]);
                    return [4 /*yield*/, next(e)];
                case 2: return [2 /*return*/, _a.sent()];
                case 3:
                    admissions.delete(token);
                    return [7 /*endfinally*/];
                case 4: return [2 /*return*/];
            }
        });
    }); }).catch(function ($, e, next) { return next.called ? next(e) : { deny: 'CAPABILITIES / admission guard failed' }; });
    on('command.run', { command: 'capabilities' }, function ($, e) { return __awaiter(void 0, void 0, void 0, function () {
        var argument;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    argument = e.args.trim();
                    if (!(argument === 'clear')) return [3 /*break*/, 3];
                    // The person's own way to remove what this companion keeps: every stored
                    // receipt, whichever capability or session wrote it. Nothing held by the
                    // memory service is touched; that data is deleted through the service.
                    return [4 /*yield*/, $.store.delete('capability-receipts')];
                case 1:
                    // The person's own way to remove what this companion keeps: every stored
                    // receipt, whichever capability or session wrote it. Nothing held by the
                    // memory service is touched; that data is deleted through the service.
                    _a.sent();
                    return [4 /*yield*/, (0, claude_code_1.update)($, state, function (old) { return (__assign(__assign({}, old), { receipts: [] })); })];
                case 2:
                    _a.sent();
                    return [2 /*return*/, { text: 'COBALT / capability receipts cleared. Memory held by your Hindsight service is not affected.' }];
                case 3:
                    if (argument !== '')
                        return [2 /*return*/, { text: 'Usage: /capabilities | /capabilities clear' }];
                    return [4 /*yield*/, $.ui.open({ id: pane, title: 'COBALT / CAPABILITIES', focus: true })];
                case 4:
                    _a.sent();
                    return [2 /*return*/, { text: 'COBALT / optional capability receipts; verification remains with commander' }];
            }
        });
    }); }).catch(function ($, e, next) { return next.called ? next(e) : { text: 'Capability ledger unavailable' }; });
    on('ui.render', { component: 'AbovePrompt' }, function ($, e, next) { return __awaiter(void 0, void 0, void 0, function () {
        var previous, observed, _a, Box, Text;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0: return [4 /*yield*/, next(e)];
                case 1:
                    previous = _b.sent();
                    if (!memoryEnabled && !browserEnabled)
                        return [2 /*return*/, previous];
                    return [4 /*yield*/, (0, claude_code_1.read)($, state)];
                case 2:
                    observed = _b.sent(), _a = $.ui.resolve(e), Box = _a.Box, Text = _a.Text;
                    return [2 /*return*/, <Box flexDirection="column">{previous}<Text color="#646a7e" wrap="truncate-end">{"MEMORY ".concat(observed.memory, " \u00B7 BROWSER ").concat(observed.browser).concat(observed.bank ? " \u00B7 ".concat(observed.bank) : '')}</Text></Box>];
            }
        });
    }); });
    on('ui.render', { component: 'Pane', requestId: pane }, function ($, e) { return __awaiter(void 0, void 0, void 0, function () {
        var observed, _a, Box, Text;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0: return [4 /*yield*/, (0, claude_code_1.read)($, state)];
                case 1:
                    observed = _c.sent(), _a = $.ui.resolve(e), Box = _a.Box, Text = _a.Text;
                    return [2 /*return*/, <Box flexDirection="column"><Text color="#e01e41">COBALT / CAPABILITY RUN LEDGER</Text><Text>{"MEMORY ".concat(observed.memory, " \u00B7 BROWSER ").concat(observed.browser)}</Text><Text>{"bank ".concat((_b = observed.bank) !== null && _b !== void 0 ? _b : 'unknown')}</Text>{observed.receipts.map(function (r, i) { return <Text key={String(i)} wrap="truncate-end">{(0, state_1.receiptLine)(r)}</Text>; })}</Box>];
            }
        });
    }); });
};
exports.register = register;
