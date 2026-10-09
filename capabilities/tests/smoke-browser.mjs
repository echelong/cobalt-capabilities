/** Opt-in real test. Run ONLY inside an OS/network sandbox with no external
 * egress and no secrets mounted. Requires installed Obscura render binary and
 * optional puppeteer-core; never downloads or installs dependencies.
 *
 * The browser is started with the worker's egress proxy as its only route. The
 * forbidden server counts every request AND every TCP connection it receives,
 * and the run fails unless both stay at zero through redirects, redirect
 * chains, parser-inserted resources, scripted navigations, an alternate
 * hostname and a port change. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { executeBrowser } from '../browser.mjs';

if (process.env.COBALT_BROWSER_SMOKE_ISOLATED !== '1' || !process.env.OBSCURA_BINARY)
  throw new Error('Explicit isolated smoke execution and OBSCURA_BINARY required');

let browserProcess;
const servers = [], spawned = [];
async function listen(handler, everyLoopbackFamily = false) {
  const server = http.createServer(handler);
  servers.push(server);
  // The forbidden server answers on IPv4 and IPv6 loopback alike, so a request
  // for `localhost` is counted whichever family the engine picks.
  if (everyLoopbackFamily) {
    try { server.listen({ port: 0, host: '::', ipv6Only: false }); await Promise.race([once(server, 'listening'), once(server, 'error').then(([error]) => { throw error; })]); }
    catch { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  } else { server.listen(0, '127.0.0.1'); await once(server, 'listening'); }
  return `http://127.0.0.1:${server.address().port}`;
}
async function freePort() {
  const server = http.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

try {
  let refusedServerRequests = 0, refusedServerConnections = 0;
  const refusedOrigin = await listen((_, response) => { refusedServerRequests++; response.end('window.forbiddenScriptRan = true;'); }, true);
  servers.at(-1).on('connection', () => { refusedServerConnections++; });
  servers.at(-1).on('upgrade', (_, socket) => { refusedServerRequests++; socket.destroy(); });
  const refusedPort = new URL(refusedOrigin).port;
  const allowedRequests = [];
  const origin = await listen((request, response) => {
    allowedRequests.push(`${request.headers.host} ${request.url}`);
    if (request.url === '/asset') { response.end('fixture asset'); return; }
    if (request.url === '/slow') { setTimeout(() => response.end('<p>late</p>'), 1500); return; }
    if (request.url === '/redirect' || request.url?.startsWith('/r/')) { response.writeHead(302, { Location: `${refusedOrigin}/blocked` }); response.end(); return; }
    if (request.url === '/chain') { response.writeHead(302, { Location: '/chain-2' }); response.end(); return; }
    if (request.url === '/chain-2') { response.writeHead(307, { Location: '/redirect' }); response.end(); return; }
    if (request.url === '/alternate-name') { response.writeHead(302, { Location: `http://localhost:${refusedPort}/blocked` }); response.end(); return; }
    if (request.url === '/same-origin') { response.writeHead(302, { Location: '/landed' }); response.end(); return; }
    if (request.url === '/landed') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>landed</title><p>landed after an allowed redirect</p>'); return; }
    if (request.url === '/scripted') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>scripted</title><p>scripted</p><script>location.href=${JSON.stringify(`${refusedOrigin}/blocked`)}</script>`); return;
    }
    if (request.url === '/form') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>form</title><form id=f method=get action="${refusedOrigin}/blocked"><input name=a value=1></form><script>document.getElementById('f').submit()</script>`); return;
    }
    if (request.url === '/resources') {
      // Every way the engine fetches without waiting for an interception answer:
      // a direct reference to the forbidden origin and a redirect to it.
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><title>resources</title><p id=state>resources loaded</p>
        <link rel=stylesheet href="${refusedOrigin}/blocked"><img src="${refusedOrigin}/blocked"><script src="${refusedOrigin}/blocked"></script><iframe src="${refusedOrigin}/blocked"></iframe>
        <link rel=stylesheet href="/r/css"><img src="/r/img"><script src="/r/script"></script><iframe src="/r/iframe"></iframe>
        <img src="http://localhost:${refusedPort}/blocked"><img src="https://127.0.0.1:${refusedPort}/blocked">
        <script>
          fetch('/r/fetch').catch(() => {}); fetch(${JSON.stringify(`${refusedOrigin}/blocked`)}, { method: 'POST', body: 'x' }).catch(() => {});
          try { const x = new XMLHttpRequest(); x.open('GET', '/r/xhr'); x.onerror = () => {}; x.send(); } catch { /* unsupported */ }
          try { new WebSocket('ws://127.0.0.1:${refusedPort}/blocked'); } catch { /* unsupported */ }
          try { new EventSource(${JSON.stringify(`${refusedOrigin}/blocked`)}); } catch { /* unsupported */ }
          try { navigator.sendBeacon(${JSON.stringify(`${refusedOrigin}/blocked`)}, 'x'); } catch { /* unsupported */ }
          try { window.open(${JSON.stringify(`${refusedOrigin}/blocked`)}); } catch { /* unsupported */ }
          document.getElementById('state').textContent += window.forbiddenScriptRan ? '; forbidden script ran' : '; forbidden script absent';
        </script>`); return;
    }
    const owner = /^\/page-([ab])$/.exec(request.url ?? '')?.[1];
    if (owner) {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<!doctype html><html><title>page ${owner}</title><body><p id=who>marker-${owner}</p>
        <script>console.log('console-${owner}'); document.getElementById('who').textContent += localStorage.getItem('owner') ? ' shared' : ' alone'; localStorage.setItem('owner','${owner}');</script></body></html>`);
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><title>Obscura fixture</title><body><p id=result>not executed</p><button id=toggle>toggle</button><input id=search><input id=locked readonly value=locked><input id=hidden-field type=hidden value=secret-token><input id=name oninput="document.getElementById('result').textContent='named:'+this.value">
      <script>
        document.getElementById('result').textContent='JS rendered; isolation '+(localStorage.getItem('seen')?'leaked':'fresh');
        localStorage.setItem('seen','yes');
        console.error('fixture console error');
        fetch('/asset').then(()=>console.log('asset fetched'));
        fetch(${JSON.stringify(`${refusedOrigin}/blocked`)}).catch(()=>console.log('foreign request blocked'));
        document.getElementById('toggle').onclick=()=>document.getElementById('result').textContent+='; clicked';
      </script></body></html>`);
  });
  const port = await freePort(), proxyPort = await freePort();
  const egressProxy = `http://127.0.0.1:${proxyPort}`;
  let runtimeLogs = '';
  const startBrowser = (cdpPort = port, proxied = true) => {
    const started = spawn(process.env.OBSCURA_BINARY, ['serve', '--port', String(cdpPort), '--host', '127.0.0.1', ...(proxied ? ['--proxy', egressProxy] : []), '--allow-private-network'], {
      env: { PATH: '/usr/bin:/bin', OBSCURA_NAV_TIMEOUT_MS: '3000', OBSCURA_SCRIPT_DEADLINE_MS: '2000',
        OBSCURA_CDP_COMMAND_TIMEOUT_MS: '4000', OBSCURA_FETCH_TIMEOUT_MS: '2000' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    started.stdout.on('data', data => { runtimeLogs = `${runtimeLogs}${data}`.slice(-4000); });
    started.stderr.on('data', data => { runtimeLogs = `${runtimeLogs}${data}`.slice(-4000); });
    started.on('error', () => {});
    spawned.push(started);
    return started;
  };
  const stopBrowser = async () => {
    if (browserProcess.exitCode === null && browserProcess.signalCode === null) { browserProcess.kill('SIGKILL'); await once(browserProcess, 'exit'); }
  };
  browserProcess = startBrowser();
  const config = { browser_enabled: true, obscura_endpoint: `ws://127.0.0.1:${port}`,
    browser_allowed_origins: [origin], browser_allow_localhost: true, browser_isolation_confirmed: true,
    browser_egress_proxy: egressProxy, browser_timeout_ms: 8000, screenshot_retention: 'ephemeral' };
  const untilReady = async () => {
    let ready;
    for (let attempt = 0; attempt < 30; attempt++) {
      ready = await executeBrowser(config, { task_id: 'readiness', steps: [{ operation: 'navigate', url: origin }] });
      if (ready.status === 'observed') break;
      if (browserProcess.exitCode !== null) throw new Error('Obscura exited before readiness');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(ready.status, 'observed', 'real CDP readiness');
  };
  await untilReady();
  const task = { task_id: 'real-browser-smoke', steps: [
    { operation: 'navigate', url: origin }, { operation: 'inspect' }, { operation: 'screenshot' },
    { operation: 'console' }, { operation: 'network' },
  ] };
  const observed = await executeBrowser(config, task);
  assert.equal(observed.status, 'observed');
  assert.match(observed.results[1].evidence.text, /JS rendered; isolation fresh/);
  assert.doesNotMatch(observed.results[1].evidence.text, /leaked/);
  const image = observed.results[2].evidence;
  assert.equal(image.mime_type, 'image/png'); assert.ok(image.bytes > 100);
  assert.ok(observed.results[3].evidence.messages.some(message => message.text.includes('fixture console error')));
  assert.ok(observed.results[4].evidence.requests.some(request => request.status === 200));
  assert.ok(observed.refused_request_count >= 1); assert.equal(refusedServerRequests, 0);
  // This page's only foreign request is a scripted fetch, which interception
  // does stop; the proxy is what holds for the requests interception cannot.
  assert.equal(observed.egress_verified, true);
  const unauthorized = await executeBrowser(config, { task_id: 'unauthorized', steps: [{ operation: 'click', selector: '#toggle' }] });
  assert.equal(unauthorized.status, 'error');
  const interactiveConfig = { ...config, browser_authorized_actions: [{ task_id: 'approved', origin, operation: 'click', selector: '#toggle' }] };
  const interacted = await executeBrowser(interactiveConfig, { task_id: 'approved', steps: [
    { operation: 'navigate', url: origin }, { operation: 'click', selector: '#toggle' }, { operation: 'snapshot' },
  ] });
  assert.equal(interacted.status, 'observed'); assert.match(interacted.results[2].evidence.text, /clicked/);
  // Form filling needs the same exact private grant, and must mutate the real DOM.
  const unauthorizedFill = await executeBrowser(config, { task_id: 'unauthorized-fill', steps: [
    { operation: 'navigate', url: origin }, { operation: 'fill', selector: '#name', value: 'Ada Lovelace' },
  ] });
  assert.equal(unauthorizedFill.status, 'error');
  const fillConfig = { ...config, browser_authorized_actions: [{ task_id: 'approved-fill', origin, operation: 'fill', selector: '#name', value: 'Ada Lovelace' }] };
  const mismatchedFill = await executeBrowser(fillConfig, { task_id: 'approved-fill', steps: [
    { operation: 'navigate', url: origin }, { operation: 'fill', selector: '#name', value: 'Grace Hopper' },
  ] });
  assert.equal(mismatchedFill.status, 'error');
  const filled = await executeBrowser(fillConfig, { task_id: 'approved-fill', steps: [
    { operation: 'navigate', url: origin }, { operation: 'fill', selector: '#name', value: 'Ada Lovelace' }, { operation: 'snapshot' },
  ] });
  assert.equal(filled.status, 'observed');
  assert.equal(filled.results[1].evidence.action, 'filled');
  assert.match(filled.results[2].evidence.text, /named:Ada Lovelace/);
  // Readonly and hidden fields are refused before anything is cleared or typed.
  for (const [selector, value] of [['#locked', 'overwrite'], ['#hidden-field', 'probe']]) {
    const guarded = await executeBrowser({ ...config, browser_authorized_actions: [{ task_id: 'guarded-fill', origin, operation: 'fill', selector, value }] }, {
      task_id: 'guarded-fill', steps: [{ operation: 'navigate', url: origin }, { operation: 'fill', selector, value }],
    });
    assert.equal(guarded.status, 'error', selector);
    assert.deepEqual(guarded.operations_completed, ['navigate'], selector);
    assert.equal(guarded.effects_possible, true, selector);
  }
  // Redirect containment. The engine follows a redirect itself, before and
  // regardless of any interception answer, so each hop is judged by the egress
  // proxy instead: the forbidden server must receive no request and no
  // connection, and the task is never reported observed.
  const untouched = label => {
    assert.equal(refusedServerRequests, 0, `${label}: the forbidden server received a request`);
    assert.equal(refusedServerConnections, 0, `${label}: a connection was opened to the forbidden server`);
  };
  // The forbidden server is the same machine on another port, so the plain
  // redirect is also the port-change case.
  for (const [label, path] of [['redirect to another port', '/redirect'], ['redirect chain', '/chain'], ['alternate hostname', '/alternate-name'],
    ['scripted navigation', '/scripted'], ['form navigation', '/form']]) {
    const redirected = await executeBrowser(config, { task_id: 'redirect', steps: [{ operation: 'navigate', url: `${origin}${path}` }, { operation: 'snapshot' }] });
    assert.equal(redirected.status, 'error', label); assert.equal(redirected.egress_verified, true, label);
    assert.equal(redirected.executed, false, label); assert.equal(redirected.effects_possible, true, label);
    assert.deepEqual(redirected.results, [], label);
    untouched(label);
  }
  // A direct navigation to another port or another name for the same machine is refused before the browser is contacted.
  for (const target of [`${refusedOrigin}/blocked`, `http://localhost:${new URL(origin).port}/`, `https://127.0.0.1:${new URL(origin).port}/`]) {
    const direct = await executeBrowser(config, { task_id: 'direct', steps: [{ operation: 'navigate', url: target }] });
    assert.equal(direct.status, 'error', target); assert.equal(direct.effects_possible, false, target);
  }
  untouched('direct navigation');
  // A redirect that stays on the allowlist still works.
  const sameOrigin = await executeBrowser(config, { task_id: 'same-origin', steps: [{ operation: 'navigate', url: `${origin}/same-origin` }, { operation: 'snapshot' }] });
  assert.equal(sameOrigin.status, 'observed'); assert.match(sameOrigin.results[1].evidence.text, /landed after an allowed redirect/);
  // Parser-inserted resources, redirected resources and scripted requests: the
  // page stays on the allowlist, and nothing it references off it is fetched.
  const resources = await executeBrowser(config, { task_id: 'resources', steps: [{ operation: 'navigate', url: `${origin}/resources` }, { operation: 'snapshot' }, { operation: 'network' }] });
  assert.equal(resources.status, 'observed');
  assert.match(resources.results[1].evidence.text, /resources loaded; forbidden script absent/);
  assert.ok(resources.egress_refused_count >= 8, `expected the proxy to refuse each reference, got ${resources.egress_refused_count}`);
  untouched('subresources');
  const redirectHits = refusedServerRequests;
  // A browser that was not started behind the proxy is refused before it loads anything.
  const unproxiedPort = await freePort();
  const unproxied = startBrowser(unproxiedPort, false);
  const unproxiedConfig = { ...config, obscura_endpoint: `ws://127.0.0.1:${unproxiedPort}` };
  let unrouted;
  for (let attempt = 0; attempt < 30; attempt++) {
    unrouted = await executeBrowser(unproxiedConfig, { task_id: 'unproxied', steps: [{ operation: 'navigate', url: origin }, { operation: 'snapshot' }] });
    if (unrouted.status !== 'unavailable') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const allowedBefore = allowedRequests.length;
  assert.equal(unrouted.status, 'error'); assert.equal(unrouted.error, 'browser_egress_unverified');
  assert.equal(unrouted.egress_verified, false); assert.equal(unrouted.effects_possible, false); assert.deepEqual(unrouted.results, []);
  const unroutedProbe = await executeBrowser(unproxiedConfig, { task_id: 'unproxied-probe', steps: [{ operation: 'status' }] });
  assert.equal(unroutedProbe.status, 'error'); assert.equal(unroutedProbe.error, 'browser_egress_unverified');
  assert.equal(allowedRequests.length, allowedBefore, 'an unverified browser must not be sent anywhere');
  unproxied.kill('SIGKILL'); await once(unproxied, 'exit');
  untouched('unproxied browser');
  const metadata = await executeBrowser({ ...config, browser_allowed_origins: ['http://169.254.169.254'] }, {
    task_id: 'metadata-denied', steps: [{ operation: 'navigate', url: 'http://169.254.169.254/' }],
  });
  assert.equal(metadata.status, 'error');
  const timed = await executeBrowser({ ...config, browser_timeout_ms: 100 }, { task_id: 'timeout', steps: [{ operation: 'navigate', url: `${origin}/slow` }] });
  assert.equal(timed.status, 'error'); assert.equal(timed.verification_status, 'not_verified');
  const recovery = await executeBrowser(config, { task_id: 'recovery', steps: [{ operation: 'navigate', url: origin }, { operation: 'snapshot' }] });
  assert.equal(recovery.status, 'observed'); assert.match(recovery.results[1].evidence.text, /isolation fresh/);
  // Readiness probe against the real control endpoint: no context, no page.
  const probed = [];
  const probe = await executeBrowser(config, { task_id: 'probe', steps: [{ operation: 'status' }] }, { onStep: name => probed.push(name) });
  assert.equal(probe.status, 'ready'); assert.deepEqual(probe.operations_completed, ['status']); assert.deepEqual(probed, ['status']);
  assert.equal(probe.egress_verified, true);
  // Step telemetry follows the order the real browser executed.
  const order = [];
  const walked = await executeBrowser(config, { task_id: 'ordered', steps: [
    { operation: 'navigate', url: origin }, { operation: 'snapshot' }, { operation: 'console' }, { operation: 'network' }, { operation: 'screenshot' },
  ] }, { onStep: name => order.push(name) });
  assert.equal(walked.status, 'observed'); assert.deepEqual(order, ['navigate', 'snapshot', 'console', 'network', 'screenshot']);
  assert.deepEqual(walked.results.map(row => row.operation), order);
  // Localhost needs its own explicit authorization on top of the allowlist entry,
  // and that authorization opens no other private range.
  const noLocalhost = await executeBrowser({ ...config, browser_allow_localhost: false }, { task_id: 'no-localhost', steps: [{ operation: 'navigate', url: origin }] });
  assert.equal(noLocalhost.status, 'error'); assert.equal(noLocalhost.effects_possible, false);
  for (const target of ['http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.1.1', 'http://100.64.0.1']) {
    const refused = await executeBrowser({ ...config, browser_allowed_origins: [target] }, { task_id: 'private-range', steps: [{ operation: 'navigate', url: `${target}/` }] });
    assert.equal(refused.status, 'error', target); assert.equal(refused.effects_possible, false, target);
  }
  // Bounded input is refused before the browser is contacted.
  const oversized = await executeBrowser(config, { task_id: 'oversized', steps: Array.from({ length: 13 }, () => ({ operation: 'snapshot' })) });
  assert.equal(oversized.status, 'error'); assert.equal(oversized.steps_completed, 0);
  // Two tasks running at once each get their own context, storage and evidence.
  const [taskA, taskB] = await Promise.all(['a', 'b'].map(owner => executeBrowser(config, { task_id: `owner-${owner}`, steps: [
    { operation: 'navigate', url: `${origin}/page-${owner}` }, { operation: 'snapshot' }, { operation: 'console' },
  ] })));
  for (const [result, owner, other] of [[taskA, 'a', 'b'], [taskB, 'b', 'a']]) {
    assert.equal(result.status, 'observed', owner); assert.equal(result.task_id, `owner-${owner}`);
    assert.match(result.results[1].evidence.text, new RegExp(`marker-${owner} alone`)); assert.equal(result.results[1].evidence.title, `page ${owner}`);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(`marker-${other}|console-${other}|page ${other}`));
    assert.ok(result.results[2].evidence.messages.some(message => message.text.includes(`console-${owner}`)));
  }
  // Browser failure: a killed browser mid-task is never reported observed and
  // keeps the navigation's possible effect visible.
  const dying = executeBrowser(config, { task_id: 'killed-mid-task', steps: [{ operation: 'navigate', url: `${origin}/slow` }, { operation: 'snapshot' }] });
  await new Promise(resolve => setTimeout(resolve, 300));
  await stopBrowser();
  const killed = await dying;
  assert.notEqual(killed.status, 'observed'); assert.equal(killed.executed, false); assert.equal(killed.effects_possible, true);
  assert.deepEqual(killed.results, []);
  // With the browser gone both a task and the probe report unavailable.
  const gone = await executeBrowser(config, { task_id: 'browser-gone', steps: [{ operation: 'navigate', url: origin }, { operation: 'snapshot' }] });
  assert.equal(gone.status, 'unavailable'); assert.equal(gone.error, 'browser_unavailable'); assert.equal(gone.executed, false);
  const goneProbe = await executeBrowser(config, { task_id: 'probe-gone', steps: [{ operation: 'status' }] });
  assert.equal(goneProbe.status, 'unavailable'); assert.equal(goneProbe.effects_possible, false);
  // Restart on the same endpoint: fresh state, nothing carried over.
  browserProcess = startBrowser();
  await untilReady();
  const restarted = await executeBrowser(config, { task_id: 'after-restart', steps: [{ operation: 'navigate', url: origin }, { operation: 'snapshot' }] });
  assert.equal(restarted.status, 'observed'); assert.match(restarted.results[1].evidence.text, /isolation fresh/);
  assert.equal((await executeBrowser(config, { task_id: 'probe-restarted', steps: [{ operation: 'status' }] })).status, 'ready');
  process.stdout.write(`${JSON.stringify({ kind: 'real_obscura_smoke', runtime: 'v0.2.4', passed: true,
    checks: ['real_js_dom', 'png_screenshot', 'console_error', 'network_observed', 'foreign_request_blocked',
      'metadata_refused', 'fresh_context_storage_isolation', 'unauthorized_action_refused', 'approved_click',
      'unauthorized_fill_refused', 'fill_value_mismatch_refused', 'approved_fill_dom_mutation',
      'readonly_fill_refused', 'hidden_fill_refused', 'redirect_never_reaches_forbidden_origin', 'redirect_chain_contained',
      'alternate_hostname_contained', 'port_change_contained', 'scripted_and_form_navigation_contained', 'allowed_redirect_followed',
      'parser_and_redirected_subresources_contained', 'forbidden_script_not_executed', 'unproxied_browser_refused', 'egress_attested',
      'timeout_not_verified', 'recovery', 'readiness_probe', 'step_order_reported', 'localhost_requires_authorization',
      'private_ranges_refused', 'oversized_task_refused', 'concurrent_task_evidence_attribution',
      'killed_browser_not_observed', 'browser_gone_unavailable', 'restart_recovery'],
    killed_mid_task_status: killed.status, killed_mid_task_error: killed.error,
    screenshot_bytes: image.bytes, refused_request_count: observed.refused_request_count,
    page_request_refusals: observed.refused_request_count, egress_refusals_on_resource_page: resources.egress_refused_count,
    redirect_hop_hits: redirectHits, forbidden_server_requests: refusedServerRequests, forbidden_server_connections: refusedServerConnections,
    forbidden_listener_family: servers[0].address().family, screenshot_persisted: false, external_egress: false })}\n`);
  assert.equal(refusedServerRequests, 0); assert.equal(refusedServerConnections, 0);
} finally {
  for (const child of spawned) if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 1000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const server of servers) { server.closeAllConnections(); server.close(); }
}
