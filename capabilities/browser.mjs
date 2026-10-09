/** Optional Obscura companion. No browser is installed or launched here. */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { startEgressProxy } from './egress.mjs';

const TEXT_LIMIT = 4000;
const MAX_STEPS = 12;
const MAX_IMAGE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 1800000;
const OPERATIONS = new Set(['navigate', 'inspect', 'snapshot', 'console', 'network', 'screenshot', 'click', 'fill']);
const sensitive = /(?:password|passwd|secret|token|api.?key|authorization|credential|session|cookie)/i;
// The same credential shapes the memory adapter refuses; heuristic, not DLP.
const SECRET_SHAPES = String.raw`-----BEGIN [A-Z ]*PRIVATE KEY|\b(?:sk-[A-Za-z0-9_-]{8,}|sk_(?:live|test)_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})|https?:\/\/[^\s\/@:]+:[^\s\/@]+@`;
const secretShaped = new RegExp(SECRET_SHAPES);
const redact = value => String(value ?? '').slice(0, TEXT_LIMIT)
  // Invisible characters are stripped by category, the same set the memory
  // adapter removes: format characters (Cf: bidi controls, zero-width
  // characters, the byte-order mark, soft hyphen, the tag block), private-use
  // and lone surrogate code points, the line and paragraph separators, both
  // variation-selector ranges, C0/C1 controls, and the letters, marks and
  // symbols that render as nothing. They carry no legible content and can hide
  // instructions or split a secret past a filter.
  .replace(/\p{Cf}|\p{Co}|\p{Cs}|\p{Zl}|\p{Zp}|[\u{E0000}-\u{E0FFF}]|[\u{FE00}-\u{FE0F}]|[\u2065\ufff0-\ufff8]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|[\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180d\u180f\u2800\u3164\uffa0]/gu, '')
  .replace(new RegExp(SECRET_SHAPES, 'g'), '[redacted]')
  .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted]')
  .replace(/((?:password|passwd|secret|token|api.?key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]');

function safeUrl(raw) {
  try { const url = new URL(raw); return url.origin.slice(0, 1024); }
  catch { return '[invalid URL]'; }
}

function ipv4Forbidden(address) {
  const [a, b, c] = address.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99) || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

export function isForbiddenAddress(address) {
  if (isIP(address) === 4) return ipv4Forbidden(address);
  if (isIP(address) !== 6) return true;
  // Only ordinary global-unicast IPv6 is admitted. Translation/tunnel prefixes
  // are conservatively refused instead of trying to infer embedded endpoints.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  return !/^2[0-9a-f]{3}:/.test(normalized) || normalized.startsWith('2001:0:') || normalized.startsWith('2001::')
    || normalized.startsWith('2001:db8:') || normalized.startsWith('2002:');
}

const loopback = host => host === 'localhost' || host === '127.0.0.1' || host === '::1';
const hostOf = url => url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
// Every loopback name and address is one host. An endpoint written
// `ws://localhost:9222` and an allowlist entry written `http://127.0.0.1:9222`
// are the same control socket, so a literal string compare would admit a page
// that can reach the browser's own control endpoint.
const sameHost = (a, b) => a === b || (loopback(a) && loopback(b));

function validateConfig(config) {
  if (config.browser_isolation_confirmed !== true) throw new Error('OS and network isolation must be explicitly confirmed');
  const endpoint = new URL(config.obscura_endpoint);
  if (endpoint.protocol !== 'ws:' || !loopback(hostOf(endpoint)) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Obscura endpoint must be a credential-free loopback ws URL');
  if (!Array.isArray(config.browser_allowed_origins) || !config.browser_allowed_origins.length || config.browser_allowed_origins.length > 32)
    throw new Error('An exact browser origin allowlist is required');
  const endpointHost = hostOf(endpoint), endpointPort = endpoint.port || '80';
  // Request interception is advisory on the supported engine, so the origin
  // policy is enforced by this worker's own egress proxy. There is no mode
  // without it: a configuration that names no proxy address is refused.
  let proxy;
  try { proxy = new URL(config.browser_egress_proxy); } catch { throw new Error('A loopback egress proxy address is required'); }
  if (config.browser_egress_proxy !== proxy.origin || proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port || Number(proxy.port) < 1024)
    throw new Error('Egress proxy must be exactly http://127.0.0.1:<port>');
  if (proxy.port === endpointPort) throw new Error('Egress proxy must not share the Obscura endpoint port');
  // The memory service is unauthenticated and holds every repository's bank;
  // a page on its origin would read around the adapter's bank scoping.
  let memory = null;
  try { memory = typeof config.hindsight_endpoint === 'string' ? new URL(config.hindsight_endpoint) : null; } catch { memory = null; }
  if (memory && loopback(hostOf(memory)) && proxy.port === (memory.port || '8888')) throw new Error('Egress proxy must not share the memory service port');
  const origins = new Set(config.browser_allowed_origins.map(raw => {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || raw !== url.origin || url.username || url.password)
      throw new Error('Browser allowlist entries must be exact HTTP(S) origins');
    // A page on the CDP endpoint origin could reach the control socket itself.
    if (sameHost(hostOf(url), endpointHost) && (url.port || (url.protocol === 'https:' ? '443' : '80')) === endpointPort)
      throw new Error('Browser allowlist must not include the Obscura endpoint origin');
    if (memory && sameHost(hostOf(url), hostOf(memory)) && (url.port || (url.protocol === 'https:' ? '443' : '80')) === (memory.port || '8888'))
      throw new Error('Browser allowlist must not include the memory service origin');
    // A page on the proxy's own origin would be a request the proxy sends to itself.
    if (loopback(hostOf(url)) && (url.port || (url.protocol === 'https:' ? '443' : '80')) === proxy.port)
      throw new Error('Browser allowlist must not include the egress proxy origin');
    return url.origin;
  }));
  const actions = config.browser_authorized_actions ?? [];
  if (!Array.isArray(actions)) throw new Error('Browser action grants must be an array');
  for (const grant of actions) {
    // Every grant is bound to the exact origin it was authorized for; the
    // worker compares it with the active page origin at execution time.
    if (!grant || typeof grant !== 'object' || !['click', 'fill'].includes(grant.operation)
      || typeof grant.task_id !== 'string' || typeof grant.selector !== 'string') throw new Error('Browser action grant must name task, click/fill operation and selector');
    let origin;
    try { origin = new URL(grant.origin); } catch { throw new Error('Browser action grant requires an exact origin'); }
    if (!['http:', 'https:'].includes(origin.protocol) || grant.origin !== origin.origin || origin.username || origin.password)
      throw new Error('Browser action grant origin must be an exact HTTP(S) origin');
  }
  const timeout = config.browser_timeout_ms ?? 10000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 30000) throw new Error('Browser timeout must be 100–30000 ms');
  if (!['none', 'ephemeral'].includes(config.screenshot_retention ?? 'none')) throw new Error('Screenshot retention must be none or ephemeral');
  return { endpoint: endpoint.href, origins, timeout, proxyPort: Number(proxy.port) };
}

/** The addresses a destination may be dialled at, or null when the policy
 * refuses it. The egress proxy connects to exactly these: the name is resolved
 * once, every answer is checked, and no later DNS answer is ever used. */
export async function vetUrl(raw, config, origins, lookup = dnsLookup) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !origins.has(url.origin)) return null;
  if ([...url.searchParams.keys()].some(key => sensitive.test(key))) return null;
  // A credential-shaped string anywhere in the URL is refused, encoded or not.
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep the raw form */ }
  if (secretShaped.test(raw) || secretShaped.test(decoded)) return null;
  const host = hostOf(url);
  if (loopback(host)) return config.browser_allow_localhost === true ? { addresses: [host === '::1' ? '::1' : '127.0.0.1'] } : null;
  if (host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !isIP(host)) return null;
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  return addresses.length > 0 && addresses.every(item => !isForbiddenAddress(item.address))
    ? { addresses: addresses.map(item => item.address) } : null;
}
const permittedUrl = async (raw, config, origins, lookup) => (await vetUrl(raw, config, origins, lookup)) !== null;

// One task at a time owns the egress proxy port. The broker's cross-session
// lock serializes separate processes; this serializes tasks inside one.
const turns = new Map();
async function takeTurn(port) {
  const previous = turns.get(port) ?? Promise.resolve();
  let release;
  const mine = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => mine);
  turns.set(port, tail);
  await previous;
  return () => { release(); if (turns.get(port) === tail) turns.delete(port); };
}

function granted(config, taskId, step, origin) {
  return Array.isArray(config.browser_authorized_actions) && config.browser_authorized_actions.some(grant =>
    grant.task_id === taskId && grant.operation === step.operation && grant.selector === step.selector
    && (step.operation !== 'fill' || grant.value === step.value)
    // Pre-flight passes no origin; execution requires the exact grant origin.
    && (origin === undefined || grant.origin === origin));
}

/** Returned text is untrusted evidence, never instructions or a passed gate.
 * Every request the browser makes is admitted or refused by this worker's
 * egress proxy before a connection is opened, at the address the policy vetted.
 * No step runs until the browser has proved it is routed through that proxy.
 * OS isolation is still the operator's: it contains a compromised engine.
 */
export async function executeBrowser(config = {}, args = {}, { connect, lookup = dnsLookup, onStep } = {}) {
  config ??= {};
  args ??= {};
  if (config.browser_enabled !== true) return { status: 'disabled', executed: false, results: [] };
  const started = Date.now();
  let browser, context, egress, releaseTurn, expired = false, timer, outcome, stepInFlight = null, effectsPossible = false;
  const results = [], consoleMessages = [], network = [], blocked = [];
  const check = () => { if (expired) throw new Error('Browser task timed out'); };
  // Progress telemetry names the step that is actually starting, never its
  // content, and can never change the task's outcome.
  const report = name => { try { onStep?.(name); } catch { /* telemetry only */ } };
  let settings;
  try {
    settings = validateConfig(config);
    if (typeof args.task_id !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(args.task_id)) throw new Error('A bounded task_id is required');
    if (!Array.isArray(args.steps) || !args.steps.length || args.steps.length > MAX_STEPS) throw new Error('Browser task requires 1–12 steps');
    // A lone `status` step is a readiness probe: it only checks that the
    // configured control endpoint answers. It opens no context or page and
    // navigates nowhere, so it cannot be combined with any other step.
    const probe = args.steps.length === 1 && args.steps[0]?.operation === 'status';
    if (!probe) for (const step of args.steps) {
      if (!step || !OPERATIONS.has(step.operation)) throw new Error('Unsupported browser operation');
      if (['click', 'fill'].includes(step.operation)) {
        if (typeof step.selector !== 'string' || step.selector.length > 256 || sensitive.test(step.selector)
          || !granted(config, args.task_id, step)) throw new Error('Browser interaction lacks an exact operator grant');
        if (step.operation === 'fill' && (typeof step.value !== 'string' || !step.value.length || step.value.length > 1000 || sensitive.test(step.value)))
          throw new Error('Sensitive, empty or oversized fill refused');
      }
      if (step.operation === 'screenshot' && config.screenshot_retention !== 'ephemeral') throw new Error('Screenshot requires ephemeral evidence consent');
      if (step.operation === 'navigate' && typeof step.url !== 'string') throw new Error('Navigation URL required');
    }
    const work = async () => {
      // Validate all planned navigations before contacting the browser service.
      for (const step of args.steps) if (step.operation === 'navigate' && !await permittedUrl(step.url, config, settings.origins, lookup))
        throw new Error('Navigation refused by browser policy');
      check();
      // The turn and the proxy are handed to the outer cleanup together: a
      // task that expired while waiting releases both here, in order, so the
      // next task never finds the port still bound.
      const turn = await takeTurn(settings.proxyPort);
      if (expired) { turn(); check(); }
      let opened;
      try {
        opened = await startEgressProxy({ port: settings.proxyPort, timeoutMs: settings.timeout,
          authorize: url => vetUrl(url.href, config, settings.origins, lookup) });
      } catch { turn(); throw new Error('Egress proxy unavailable'); }
      if (expired) { await opened.close(); turn(); check(); }
      egress = opened; releaseTurn = turn;
      if (probe) { stepInFlight = 'status'; report('status'); }
      if (!connect) {
        let puppeteer;
        try {
          // Only the dependency installed beside this worker is loaded; a
          // same-named package in any parent directory is never picked up.
          const beside = new URL('./node_modules/', import.meta.url).href;
          const resolved = import.meta.resolve('puppeteer-core');
          if (!resolved.startsWith(beside)) throw new Error('outside the worker directory');
          puppeteer = await import(resolved);
        } catch { throw new Error('Optional puppeteer-core dependency unavailable'); }
        connect = puppeteer.connect;
      }
      const connected = await connect({ browserWSEndpoint: settings.endpoint, protocolTimeout: settings.timeout });
      if (expired) { connected.disconnect(); check(); }
      browser = connected;
      const created = await browser.createBrowserContext();
      if (expired) { await created.close(); check(); }
      context = created;
      // Mandatory, before anything else is loaded: a throwaway page asks for a
      // name that resolves nowhere. Only a browser routed through this task's
      // proxy can deliver that request, and the page it gets back references a
      // canary no policy admits. An unattested browser, a request that reached
      // the proxy port directly, or any connection to the canary means there is
      // a route around the policy, and the task is refused before it navigates.
      const attestation = await context.newPage(); check();
      try { await attestation.goto(egress.attestationUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(settings.timeout, 5000) }); }
      catch { /* judged by what the proxy observed, not by the navigation's own report */ }
      await new Promise(resolve => setTimeout(resolve, 150));
      try { await attestation.close(); } catch { /* the context close below still applies */ }
      check();
      if (!egress.attested || egress.bypassed || egress.directRequests > 0) throw new Error('Browser egress is not verified');
      if (probe) return { status: 'ready', executed: true, task_id: args.task_id, verification_status: 'not_applicable',
        operations_completed: ['status'], results: [], refused_request_count: 0, egress_verified: true, duration_ms: Date.now() - started };
      const page = await context.newPage(); check();
      // New windows are not an admitted task resource. A popup's requests go
      // through the same egress proxy as every other request.
      page.on('popup', popup => { void popup.close().catch(() => {}); });
      page.setDefaultTimeout(settings.timeout);
      page.setDefaultNavigationTimeout(settings.timeout);
      await page.setViewport({ width: 1280, height: 720 }); check();
      page.on('console', message => { if (consoleMessages.length < 100) consoleMessages.push({ type: redact(message.type()), text: redact(message.text()) }); });
      page.on('pageerror', error => { if (consoleMessages.length < 100) consoleMessages.push({ type: 'pageerror', text: redact(error.message) }); });
      page.on('response', response => { if (network.length < 100) network.push({ url: safeUrl(response.url()), status: response.status() }); });
      page.on('request', request => {
        void (async () => {
          const headers = request.headers();
          const allowed = !expired && ['GET', 'HEAD'].includes(request.method())
            && !Object.keys(headers).some(name => ['authorization', 'proxy-authorization', 'cookie'].includes(name.toLowerCase()))
            && await permittedUrl(request.url(), config, settings.origins, lookup);
          if (!allowed || expired) {
            if (blocked.length < 100) blocked.push({ url: safeUrl(request.url()), method: request.method() });
            await request.abort('blockedbyclient');
          } else await request.continue();
        })().catch(() => { void request.abort('blockedbyclient').catch(() => {}); });
      });
      // Interception is a second observer, not the boundary: the engine may
      // fetch a redirect hop or a parser-inserted resource whatever it answers.
      // The egress proxy has already refused those before any connection.
      await page.setRequestInterception(true); check();
      // A page that ends anywhere off the allowlist holds the proxy's refusal
      // text, not a site: it is refused instead of reported as observed evidence.
      const requireAllowlisted = async () => {
        if (egress.bypassed || egress.directRequests > 0) throw new Error('Browser egress is not verified');
        const current = page.url();
        // A fresh context has loaded nothing yet; there is no origin to check
        // until the first navigate. `about:blank` is not evidence of anything.
        if (current === 'about:blank') return;
        const landed = new URL(current).origin;
        if (!settings.origins.has(landed)) throw new Error('Active page origin is not allowlisted');
        // The proxy may have answered for an allowlisted address too (a refused
        // method or credential, an unreachable server). Its page carries this
        // task's own title, so the document is asked directly: an address
        // comparison alone would miss a fragment or a rewritten history entry.
        if (egress.wasRefused(current) || await page.title() === egress.refusalTitle) throw new Error('Active page was refused by egress policy');
      };
      for (const step of args.steps) {
        check();
        // Re-checked before every step, not only after navigate and click: a
        // redirect or scripted navigation that commits after the previous step
        // returns could otherwise be read, snapshotted or screenshotted from an
        // off-allowlist page and reported here as observed evidence.
        await requireAllowlisted();
        stepInFlight = step.operation;
        report(step.operation);
        // Effects may outlive a later failure; record that a mutating step
        // started before its outcome is known.
        if (['navigate', 'click', 'fill'].includes(step.operation)) effectsPossible = true;
        let evidence;
        switch (step.operation) {
          case 'navigate':
            await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: settings.timeout });
            // A navigation that committed nothing is not an observed page.
            if (page.url() === 'about:blank') throw new Error('Navigation did not commit');
            await requireAllowlisted();
            evidence = { url: safeUrl(page.url()) }; break;
          case 'inspect':
          case 'snapshot': {
            // Fixed code only. Never return passwords, form values, cookies,
            // storage or page-authored executable snippets to the agent.
            const observed = await page.evaluate(() => ({
              title: String(document.title).slice(0, 512),
              text: String(document.body?.innerText ?? '').slice(0, 4000),
              elements: Array.from(document.querySelectorAll('a,button,input,select,textarea')).slice(0, 50)
                .map(el => ({ tag: el.tagName, type: el.getAttribute('type') ?? '', text: String(el.innerText ?? '').slice(0, 100) }))
            }));
            evidence = { url: safeUrl(page.url()), title: redact(observed.title), text: redact(observed.text),
              elements: observed.elements.slice(0, 50).map(el => ({ tag: redact(el.tag), type: redact(el.type), text: redact(el.text) })) }; break;
          }
          case 'console': evidence = { messages: consoleMessages.slice() }; break;
          case 'network': evidence = { requests: network.slice(), refused: blocked.slice(), egress_refused: egress.refused.slice() }; break;
          case 'screenshot': {
            const image = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));
            if (image.length > MAX_IMAGE_BYTES || !image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Screenshot missing or oversized');
            evidence = { mime_type: 'image/png', bytes: image.length, base64: image.toString('base64'), retention: 'ephemeral' }; break;
          }
          case 'click': {
            if (!granted(config, args.task_id, step, new URL(page.url()).origin)) throw new Error('Click grant does not match the active origin');
            await page.click(step.selector);
            await requireAllowlisted();
            evidence = { action: 'clicked' }; break;
          }
          case 'fill': {
            // Obscura 0.2.4 does not apply Puppeteer's locator.fill() protocol
            // path: the input/change events fire but the value is never
            // committed, so a naive fill would report success without effect.
            // Fill through fixed code plus real keyboard input instead, then
            // read the value back and refuse success unless it actually landed.
            // Only a connected, enabled, editable text control can be written:
            // a non-input, hidden, disabled, readonly, checkbox, radio or file
            // target is refused before anything is cleared or typed.
            if (!granted(config, args.task_id, step, new URL(page.url()).origin)) throw new Error('Fill grant does not match the active origin');
            const target = await page.$(step.selector);
            if (!target) throw new Error('Fill target not found');
            const editable = await target.evaluate(element => {
              const attribute = name => { try { return element.getAttribute(name); } catch { return null; } };
              const tag = String(element.tagName ?? '');
              if ((tag !== 'INPUT' && tag !== 'TEXTAREA') || element.isConnected === false) return false;
              // Attribute and property are both checked: a rendering engine may
              // implement only one of them, and a readonly field must never be
              // written or programmatically cleared.
              if (element.disabled === true || attribute('disabled') !== null) return false;
              if (element.readOnly === true || attribute('readonly') !== null) return false;
              if (tag === 'INPUT') {
                const type = String(attribute('type') ?? element.type ?? 'text').toLowerCase();
                if (['hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image'].includes(type)) return false;
              }
              return true;
            });
            if (editable !== true) throw new Error('Fill target is not an editable text control');
            // Keystrokes go to whatever the document has focused, so focus is
            // confirmed before typing: a CSS-hidden input passes the editable
            // check, `focus()` silently fails, and type() would otherwise send
            // the value into an unrelated element that then keeps it.
            const focused = await target.evaluate(element => {
              element.focus();
              try { element.select(); } catch { element.value = ''; }
              return document.activeElement === element;
            });
            if (focused !== true) throw new Error('Fill target could not take focus');
            await target.type(step.value);
            const applied = await target.evaluate((element, expected) => element.value === expected, step.value);
            if (applied !== true) throw new Error('Fill did not apply');
            evidence = { action: 'filled' }; break;
          }
        }
        check();
        results.push({ operation: step.operation, evidence, trust: 'untrusted_reference' });
        if (Buffer.byteLength(JSON.stringify(results)) > MAX_OUTPUT_BYTES - 2048) throw new Error('Browser evidence output limit');
      }
      // A canary connection at any point of the task invalidates its evidence.
      await requireAllowlisted();
      return { status: 'observed', executed: true, task_id: args.task_id, verification_status: 'requires_commander_review', results,
        refused_request_count: blocked.length, egress_verified: true, egress_refused_count: egress.refused.length,
        duration_ms: Date.now() - started };
    };
    return outcome = await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error('Browser task timed out')); }, settings.timeout);
    })]);
  } catch (error) {
    // Upstream errors can embed URLs, page content and credentials. Export
    // enumerated codes only; never return raw exceptions or stack traces.
    const message = String(error?.message ?? '');
    const unavailable = message === 'Optional puppeteer-core dependency unavailable'
      || error?.code === 'ECONNREFUSED' || /ECONNREFUSED|WebSocket/i.test(message);
    const noProxy = message === 'Egress proxy unavailable';
    const code = message === 'Browser task timed out' ? 'browser_timeout'
      : message === 'Browser evidence output limit' ? 'browser_output_limit'
      : message === 'Browser egress is not verified' ? 'browser_egress_unverified'
      : noProxy ? 'browser_egress_unavailable'
      : unavailable ? 'browser_unavailable' : 'browser_policy_or_execution_error';
    // Failed evidence must still disclose effects that may already have
    // happened, so the model can reconcile instead of retrying a
    // non-idempotent step: completed operation names only, never their content.
    return outcome = { status: unavailable || noProxy ? 'unavailable' : 'error',
      executed: false, task_id: /^[A-Za-z0-9_.-]{1,80}$/.test(args.task_id ?? '') ? args.task_id : undefined,
      verification_status: 'not_verified', error: code,
      egress_verified: Boolean(egress?.attested && !egress.bypassed && egress.directRequests === 0),
      effects_possible: effectsPossible, steps_completed: results.length, step_in_flight: stepInFlight,
      operations_completed: results.map(row => row.operation).slice(0, MAX_STEPS),
      results: [], duration_ms: Date.now() - started };
  } finally {
    expired = true;
    clearTimeout(timer);
    if (context) {
      let cleanupTimer;
      const closed = await Promise.race([context.close().then(() => true, () => false),
        new Promise(resolve => { cleanupTimer = setTimeout(() => resolve(false), 1000); })]);
      clearTimeout(cleanupTimer);
      if (outcome) outcome.cleanup_confirmed = closed;
      if (!closed && outcome) {
        const completed = Array.isArray(outcome.results) ? outcome.results : [];
        Object.assign(outcome, { status: 'error', executed: false,
          error: 'browser_cleanup_failed', verification_status: 'not_verified',
          effects_possible: outcome.effects_possible === true || completed.length > 0,
          steps_completed: Math.max(Number(outcome.steps_completed ?? 0), completed.length),
          operations_completed: Array.from(new Set([...(outcome.operations_completed ?? []), ...completed.map(row => row.operation)])).slice(0, MAX_STEPS),
          results: [] });
      }
    }
    // Each release is attempted whatever the one before it did: a failed
    // disconnect must not leave the proxy port bound or the next task waiting.
    try { if (browser) browser.disconnect(); } catch { /* the service is already gone */ }
    // Closing the proxy ends every connection it carried: between tasks the
    // browser has no route at all.
    try { if (egress) await egress.close(); } catch { /* nothing further to release */ }
    releaseTurn?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let input = '';
    // Config plus arguments must both fit: the bridge caps each source at 24 KiB.
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 65536) throw new Error('Input exceeds 64 KiB'); }
    const { config, arguments: args } = JSON.parse(input);
    // One fixed-shape line per started step on stderr; the result stays alone on stdout.
    // A reader that has gone away must not crash the task it was watching.
    process.stderr.on('error', () => {});
    const onStep = name => { process.stderr.write(`${JSON.stringify({ cobalt_step: name })}\n`); };
    const report = `${JSON.stringify(await executeBrowser(config, args, { onStep }))}\n`;
    // Exit once the report is flushed: a lingering socket must not hold the
    // process past its result and turn a finished task into a timeout.
    process.stdout.write(report, () => process.exit(0));
  } catch { process.stdout.write(`${JSON.stringify({ status: 'error', executed: false, error: 'browser_invalid_input', results: [] })}\n`, () => process.exit(0)); }
}
