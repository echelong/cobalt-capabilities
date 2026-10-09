/** Deterministic egress-policy tests. Real loopback sockets, no browser, no
 * external network: an allowlisted server, a forbidden server and the proxy.
 * A small client follows redirects through the proxy the way a browser does,
 * so "the forbidden server observed nothing" is measured, not assumed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { startEgressProxy, ATTEST_HOST } from '../egress.mjs';

async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port;
}

/** One absolute-form request to the proxy, exactly as a proxied browser sends it. */
function viaProxy(proxyPort, target, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: proxyPort, method, path: target, agent: false,
      headers: { host: new URL(target).host, ...headers } }, response => {
      const chunks = [];
      const settle = extra => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString(), ...extra });
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => settle({}));
      response.on('error', () => settle({ aborted: true }));
      response.on('aborted', () => settle({ aborted: true }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** Follow redirects hop by hop through the proxy, as a browser's navigation does. */
async function browse(proxyPort, target, limit = 6) {
  const hops = [];
  let current = target, response;
  for (let hop = 0; hop < limit; hop++) {
    response = await viaProxy(proxyPort, current);
    hops.push({ url: current, status: response.status });
    if (response.status < 300 || response.status >= 400 || !response.headers.location) break;
    current = new URL(response.headers.location, current).href;
  }
  return { ...response, hops };
}

/** An allowlisted server, a forbidden server, and a proxy that admits only the first. */
async function world({ allow, proxyOptions = {} } = {}) {
  const forbiddenRequests = [], allowedRequests = [];
  let forbiddenConnections = 0;
  const forbidden = http.createServer((request, response) => { forbiddenRequests.push(`${request.method} ${request.url}`); response.end('forbidden content'); });
  forbidden.on('connection', () => { forbiddenConnections++; });
  forbidden.on('upgrade', (request, socket) => { forbiddenRequests.push(`UPGRADE ${request.url}`); socket.destroy(); });
  forbidden.listen(0, '127.0.0.1'); await once(forbidden, 'listening');
  const forbiddenPort = forbidden.address().port, forbiddenOrigin = `http://127.0.0.1:${forbiddenPort}`;
  const allowed = http.createServer((request, response) => {
    allowedRequests.push({ line: `${request.method} ${request.url}`, host: request.headers.host, headers: request.headers });
    const url = request.url ?? '/';
    if (url === '/redirect') { response.writeHead(302, { Location: `${forbiddenOrigin}/landing` }); response.end(); return; }
    if (url === '/chain-1') { response.writeHead(302, { Location: '/chain-2' }); response.end(); return; }
    if (url === '/chain-2') { response.writeHead(307, { Location: '/chain-3' }); response.end(); return; }
    if (url === '/chain-3') { response.writeHead(303, { Location: `${forbiddenOrigin}/end-of-chain` }); response.end(); return; }
    if (url === '/alt-host') { response.writeHead(302, { Location: `http://localhost:${forbiddenPort}/alternate-name` }); response.end(); return; }
    if (url === '/port-change') { response.writeHead(302, { Location: `${forbiddenOrigin}/other-port` }); response.end(); return; }
    if (url === '/same-origin') { response.writeHead(302, { Location: '/final' }); response.end(); return; }
    if (url === '/large') { response.end(Buffer.alloc(4096, 97)); return; }
    response.setHeader('Content-Type', 'text/plain');
    response.end(`allowed ${url}`);
  });
  allowed.listen(0, '127.0.0.1'); await once(allowed, 'listening');
  const allowedPort = allowed.address().port, allowedOrigin = `http://127.0.0.1:${allowedPort}`;
  const origins = new Set(allow ?? [allowedOrigin]);
  const authorize = async url => origins.has(url.origin) ? { addresses: ['127.0.0.1'] } : null;
  const egress = await startEgressProxy({ port: await freePort(), authorize, timeoutMs: 2000, ...proxyOptions });
  const close = async () => {
    await egress.close();
    for (const server of [allowed, forbidden]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
  return { egress, port: Number(new URL(egress.origin).port), allowedOrigin, forbiddenOrigin, allowedRequests, forbiddenRequests,
    forbiddenConnections: () => forbiddenConnections, forbiddenPort, allowedPort, close };
}

test('an allowlisted origin is forwarded with its own Host and no proxy headers', async () => {
  const w = await world();
  try {
    const response = await viaProxy(w.port, `${w.allowedOrigin}/page?x=1`, { headers: { 'proxy-connection': 'keep-alive', 'x-fixture': 'kept' } });
    assert.equal(response.status, 200); assert.equal(response.body, 'allowed /page?x=1');
    assert.equal(w.allowedRequests[0].host, new URL(w.allowedOrigin).host);
    assert.equal(w.allowedRequests[0].headers['proxy-connection'], undefined);
    assert.equal(w.allowedRequests[0].headers['x-fixture'], 'kept');
    assert.equal(w.egress.forwarded, 1); assert.deepEqual(w.egress.refused, []);
  } finally { await w.close(); }
});

test('a redirect from an allowlisted origin to a forbidden origin never reaches it', async () => {
  const w = await world();
  try {
    const result = await browse(w.port, `${w.allowedOrigin}/redirect`);
    assert.deepEqual(result.hops.map(hop => hop.status), [302, 403]);
    assert.deepEqual(w.forbiddenRequests, [], 'the forbidden server must observe zero requests');
    assert.equal(w.forbiddenConnections(), 0, 'not even a TCP connection may be opened to the forbidden server');
    assert.doesNotMatch(result.body, /forbidden content/);
    assert.equal(w.egress.refused.length, 1);
    assert.equal(w.egress.refused[0].origin, w.forbiddenOrigin);
    assert.equal(w.egress.wasRefused(`${w.forbiddenOrigin}/landing`), true);
  } finally { await w.close(); }
});

test('every hop of a redirect chain is validated and the forbidden end is never contacted', async () => {
  const w = await world();
  try {
    const result = await browse(w.port, `${w.allowedOrigin}/chain-1`);
    assert.deepEqual(result.hops.map(hop => hop.status), [302, 307, 303, 403]);
    assert.deepEqual(w.allowedRequests.map(row => row.line), ['GET /chain-1', 'GET /chain-2', 'GET /chain-3']);
    assert.deepEqual(w.forbiddenRequests, []); assert.equal(w.forbiddenConnections(), 0);
  } finally { await w.close(); }
});

test('a same-origin redirect still works', async () => {
  const w = await world();
  try {
    const result = await browse(w.port, `${w.allowedOrigin}/same-origin`);
    assert.equal(result.status, 200); assert.equal(result.body, 'allowed /final');
  } finally { await w.close(); }
});

test('an alternate hostname and a port change are each a different origin', async () => {
  const w = await world();
  try {
    for (const path of ['/alt-host', '/port-change']) {
      const result = await browse(w.port, `${w.allowedOrigin}${path}`);
      assert.equal(result.status, 403, path);
    }
    // The same allowlisted server under another loopback name is not the allowlisted origin.
    const before = w.allowedRequests.length;
    assert.equal((await viaProxy(w.port, `http://localhost:${w.allowedPort}/renamed`)).status, 403);
    assert.equal(w.allowedRequests.length, before, 'a renamed origin must not be forwarded');
    assert.deepEqual(w.forbiddenRequests, []); assert.equal(w.forbiddenConnections(), 0);
  } finally { await w.close(); }
});

test('only GET and HEAD are forwarded; a write method or a body is refused before any connection', async () => {
  const w = await world();
  try {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await viaProxy(w.port, `${w.allowedOrigin}/write`, { method, body: method === 'OPTIONS' ? undefined : 'x' });
      assert.equal(response.status, 403, method);
    }
    assert.equal((await viaProxy(w.port, `${w.allowedOrigin}/get-with-body`, { headers: { 'content-length': '1' }, body: 'x' })).status, 403);
    assert.deepEqual(w.allowedRequests, []);
    assert.equal((await viaProxy(w.port, `${w.allowedOrigin}/head`, { method: 'HEAD' })).status, 200);
  } finally { await w.close(); }
});

test('credential-bearing requests are refused, never forwarded', async () => {
  const w = await world();
  try {
    for (const headers of [{ cookie: 'sid=1' }, { authorization: 'Bearer x' }, { 'proxy-authorization': 'Basic x' }])
      assert.equal((await viaProxy(w.port, `${w.allowedOrigin}/private`, { headers })).status, 403, Object.keys(headers)[0]);
    assert.equal((await viaProxy(w.port, `http://user:pass@127.0.0.1:${w.allowedPort}/userinfo`)).status, 403);
    assert.deepEqual(w.allowedRequests, []);
  } finally { await w.close(); }
});

test('CONNECT to a non-allowlisted destination is refused without opening a connection', async () => {
  const w = await world();
  try {
    const socket = net.connect(w.port, '127.0.0.1'); await once(socket, 'connect');
    socket.write(`CONNECT 127.0.0.1:${w.forbiddenPort} HTTP/1.1\r\nHost: 127.0.0.1:${w.forbiddenPort}\r\n\r\n`);
    const [reply] = await once(socket, 'data');
    assert.match(String(reply), /^HTTP\/1\.1 403 /);
    socket.destroy();
    assert.equal(w.forbiddenConnections(), 0);
    assert.equal(w.egress.refused.at(-1).method, 'CONNECT');
  } finally { await w.close(); }
});

test('CONNECT is tunnelled only to an exact allowlisted https origin, at the vetted address', async () => {
  const echo = net.createServer(socket => { socket.on('error', () => {}); socket.on('data', data => socket.write(`echo:${data}`)); });
  echo.listen(0, '127.0.0.1'); await once(echo, 'listening');
  const echoPort = echo.address().port;
  const w = await world({ allow: [`https://tunnel.example:${echoPort}`] });
  try {
    const socket = net.connect(w.port, '127.0.0.1'); await once(socket, 'connect');
    // The name is never resolved by the proxy: it dials the address the policy vetted.
    socket.write(`CONNECT tunnel.example:${echoPort} HTTP/1.1\r\nHost: tunnel.example\r\n\r\n`);
    const [reply] = await once(socket, 'data');
    assert.match(String(reply), /^HTTP\/1\.1 200 /);
    socket.write('ping');
    const [echoed] = await once(socket, 'data');
    assert.equal(String(echoed), 'echo:ping');
    socket.destroy();
    // The http origin on the same host and port was never allowlisted.
    assert.equal((await viaProxy(w.port, `http://tunnel.example:${echoPort}/plain`)).status, 403);
  } finally { await w.close(); await new Promise(resolve => echo.close(resolve)); }
});

test('a WebSocket upgrade through the proxy is refused', async () => {
  const w = await world();
  try {
    const socket = net.connect(w.port, '127.0.0.1'); await once(socket, 'connect');
    socket.on('error', () => {});
    socket.write(`GET ${w.allowedOrigin}/socket HTTP/1.1\r\nHost: 127.0.0.1:${w.allowedPort}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const [reply] = await Promise.race([once(socket, 'data'), once(socket, 'close').then(() => [''])]);
    assert.doesNotMatch(String(reply), /^HTTP\/1\.1 101 /);
    socket.destroy();
    assert.deepEqual(w.allowedRequests, []);
    assert.equal(w.egress.refused.some(row => row.reason === 'upgrade'), true);
  } finally { await w.close(); }
});

test('a request that did not come through a proxy client is refused and counted as direct', async () => {
  const w = await world();
  try {
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: w.port, path: '/origin-form', agent: false }, reply => { reply.resume(); reply.on('end', () => resolve(reply.statusCode)); }).on('error', reject);
    });
    assert.equal(status, 421);
    assert.equal(w.egress.directRequests, 1);
    assert.equal(w.egress.attested, false);
  } finally { await w.close(); }
});

test('a non-http scheme is refused', async () => {
  const w = await world();
  try {
    const socket = net.connect(w.port, '127.0.0.1'); await once(socket, 'connect');
    socket.on('error', () => {});
    socket.write('GET ftp://127.0.0.1/file HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    const [reply] = await once(socket, 'data');
    assert.match(String(reply), /^HTTP\/1\.1 4\d\d /);
    socket.destroy();
    assert.deepEqual(w.allowedRequests, []);
  } finally { await w.close(); }
});

test('attestation is recorded only for this task\'s unguessable proxied request', async () => {
  const w = await world();
  try {
    assert.equal(new URL(w.egress.attestationUrl).hostname, ATTEST_HOST);
    assert.equal(w.egress.attested, false);
    assert.equal((await viaProxy(w.port, `http://${ATTEST_HOST}/wrong-nonce`)).status, 404);
    assert.equal(w.egress.attested, false);
    const attestation = await viaProxy(w.port, w.egress.attestationUrl);
    assert.equal(attestation.status, 200);
    assert.equal(w.egress.attested, true);
    // The attestation page references the bypass canary; a proxied client asks the proxy, which refuses.
    assert.match(attestation.body, new RegExp(`http://127\\.0\\.0\\.1:${w.egress.canaryPort}/`));
    assert.equal((await viaProxy(w.port, `http://127.0.0.1:${w.egress.canaryPort}/image`)).status, 403);
    assert.equal(w.egress.bypassed, false);
    // The canary and the attestation are the proxy's own traffic, not page evidence.
    assert.deepEqual(w.egress.refused, []);
    assert.deepEqual(w.allowedRequests, []); assert.deepEqual(w.forbiddenRequests, []);
  } finally { await w.close(); }
});

test('a direct connection to the canary proves a route around the proxy', async () => {
  const w = await world();
  try {
    const socket = net.connect(w.egress.canaryPort, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect'); socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(w.egress.bypassed, true);
  } finally { await w.close(); }
});

test('the policy decides the address: a name is dialled only where the policy vetted it', async () => {
  const dialled = [];
  const target = http.createServer((request, response) => { dialled.push(request.headers.host); response.end('pinned'); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const port = target.address().port;
  const authorize = async url => url.hostname === 'pinned.example' ? { addresses: ['127.0.0.1'] } : null;
  const egress = await startEgressProxy({ port: await freePort(), authorize, timeoutMs: 2000 });
  const proxyPort = Number(new URL(egress.origin).port);
  try {
    const pinned = await viaProxy(proxyPort, `http://pinned.example:${port}/`);
    assert.equal(pinned.status, 200); assert.equal(pinned.body, 'pinned');
    assert.deepEqual(dialled, [`pinned.example:${port}`]);
    assert.equal((await viaProxy(proxyPort, `http://rebound.example:${port}/`)).status, 403);
    assert.equal(dialled.length, 1);
  } finally { await egress.close(); target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
});

test('a policy that throws or answers no usable address refuses instead of forwarding', async () => {
  for (const authorize of [async () => { throw new Error('resolver failed'); }, async () => ({ addresses: [] }), async () => ({}), async () => true,
    async () => ({ addresses: ['not-an-address'] })]) {
    const egress = await startEgressProxy({ port: await freePort(), authorize, timeoutMs: 1000 });
    try { assert.equal((await viaProxy(Number(new URL(egress.origin).port), 'http://fixture.example/')).status, 403); }
    finally { await egress.close(); }
  }
});

test('an oversized response is cut off instead of streamed without bound', async () => {
  const w = await world({ proxyOptions: { maxResponseBytes: 1024 } });
  try {
    const response = await viaProxy(w.port, `${w.allowedOrigin}/large`).catch(error => ({ failed: error.code ?? error.message }));
    assert.ok(response.failed || response.aborted || response.body.length <= 1024, 'no more than the bound may be delivered');
  } finally { await w.close(); }
});

test('closing the proxy removes the browser\'s only route', async () => {
  const w = await world();
  const { port } = w;
  await w.close();
  await assert.rejects(viaProxy(port, 'http://127.0.0.1:1/'), error => error.code === 'ECONNREFUSED');
});

test('the proxy binds loopback only and requires a real policy', async () => {
  await assert.rejects(startEgressProxy({ port: await freePort() }), /policy/i);
  const egress = await startEgressProxy({ port: await freePort(), authorize: async () => null });
  try { assert.equal(new URL(egress.origin).hostname, '127.0.0.1'); }
  finally { await egress.close(); }
});

test('a port that is already taken fails closed', async () => {
  const taken = net.createServer(); taken.listen(0, '127.0.0.1'); await once(taken, 'listening');
  try { await assert.rejects(startEgressProxy({ port: taken.address().port, authorize: async () => null })); }
  finally { await new Promise(resolve => taken.close(resolve)); }
});

test('every answer the proxy writes itself is recognisable, whatever address the page reports', async () => {
  const dead = await freePort();
  const authorize = async url => url.hostname === 'down.example' ? { addresses: ['127.0.0.1'] } : null;
  const egress = await startEgressProxy({ port: await freePort(), authorize, timeoutMs: 1000 });
  const port = Number(new URL(egress.origin).port);
  try {
    assert.match(egress.refusalTitle, /^cobalt-egress-refused-[0-9a-f]{36}$/);
    // Refused by policy, refused for a credential, and an allowlisted server that is not there.
    const answers = [await viaProxy(port, 'http://other.example/page'), await viaProxy(port, 'http://down.example:' + dead + '/a', { headers: { cookie: 'a=b' } }),
      await viaProxy(port, 'http://down.example:' + dead + '/unreachable')];
    assert.deepEqual(answers.map(answer => answer.status), [403, 403, 502]);
    for (const answer of answers) assert.ok(answer.body.includes(`<title>${egress.refusalTitle}</title>`));
    // The fragment never reaches a proxy; the page's address still has it.
    assert.equal(egress.wasRefused('http://other.example/page#section'), true);
    assert.equal(egress.wasRefused('http://down.example:' + dead + '/unreachable#x'), true);
    assert.equal(egress.wasRefused('http://down.example:' + dead + '/never-requested'), false);
    assert.equal(egress.wasRefused('not a url'), true);
    assert.equal(egress.refused.at(-1).reason, 'upstream');
  } finally { await egress.close(); }
});

test('past its bound the refusal record answers "refused" instead of forgetting', async () => {
  const egress = await startEgressProxy({ port: await freePort(), authorize: async () => null, timeoutMs: 1000 });
  const port = Number(new URL(egress.origin).port);
  try {
    for (let batch = 0; batch < 41; batch++)
      await Promise.all(Array.from({ length: 10 }, (_, index) => viaProxy(port, `http://other.example/${batch}-${index}`)));
    assert.equal(egress.refused.length, 100, 'the evidence list stays bounded');
    assert.equal(egress.wasRefused('http://other.example/40-9'), true);
    assert.equal(egress.wasRefused('http://fixture.example/never-requested'), true);
  } finally { await egress.close(); }
});

test('the attestation page probes every fetch path the engine has, including the tunnel', async () => {
  const w = await world();
  try {
    const { body } = await viaProxy(w.port, w.egress.attestationUrl);
    const canary = `127.0.0.1:${w.egress.canaryPort}`;
    for (const reference of [`href="http://${canary}/style"`, `src="http://${canary}/image"`, `src="https://${canary}/tunnel"`, `src="http://${canary}/script"`,
      `<iframe src="http://${canary}/frame">`, `fetch("http://${canary}/fetch")`, `"http://${canary}/xhr"`]) assert.ok(body.includes(reference), reference);
    // A proxied engine asks the proxy for the tunnel too, and is refused without a connection.
    const socket = net.connect(w.port, '127.0.0.1'); await once(socket, 'connect');
    socket.write(`CONNECT ${canary} HTTP/1.1\r\nHost: ${canary}\r\n\r\n`);
    const [reply] = await once(socket, 'data');
    assert.match(String(reply), /^HTTP\/1\.1 403 /); socket.destroy();
    assert.equal(w.egress.bypassed, false); assert.deepEqual(w.egress.refused, []);
  } finally { await w.close(); }
});

test('a refused or failed tunnel marks its whole origin as answered by the proxy', async () => {
  const dead = await freePort();
  const authorize = async url => url.hostname === 'down.example' ? { addresses: ['127.0.0.1'] } : null;
  const egress = await startEgressProxy({ port: await freePort(), authorize, timeoutMs: 1000 });
  const port = Number(new URL(egress.origin).port);
  const tunnel = async authority => {
    const socket = net.connect(port, '127.0.0.1'); await once(socket, 'connect');
    socket.on('error', () => {});
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    const [reply] = await once(socket, 'data'); socket.destroy();
    return String(reply).slice(9, 12);
  };
  try {
    assert.equal(egress.wasRefused('https://other.example/deep/path?x=1'), false);
    assert.equal(await tunnel('other.example:443'), '403');
    assert.equal(egress.wasRefused('https://other.example/deep/path?x=1#y'), true);
    // An allowlisted origin whose server is not there: the tunnel fails, and
    // whatever the page shows at that origin did not come from the site.
    assert.equal(await tunnel(`down.example:${dead}`), '502');
    assert.equal(egress.wasRefused(`https://down.example:${dead}/account`), true);
    assert.equal(egress.wasRefused('https://third.example/'), false);
  } finally { await egress.close(); }
});

test('a tunnel that never comes up marks its origin as answered by the proxy', async () => {
  // TEST-NET-1 is never routed: the connection either hangs until the proxy's own
  // timeout or fails at once, and both must leave the same record.
  const authorize = async url => url.hostname === 'slow.example' ? { addresses: ['192.0.2.1'] } : null;
  const egress = await startEgressProxy({ port: await freePort(), authorize, timeoutMs: 300 });
  try {
    const socket = net.connect(Number(new URL(egress.origin).port), '127.0.0.1'); await once(socket, 'connect');
    socket.on('error', () => {});
    socket.write('CONNECT slow.example:443 HTTP/1.1\r\nHost: slow.example\r\n\r\n');
    await Promise.race([once(socket, 'close'), new Promise(resolve => setTimeout(resolve, 1500))]);
    socket.destroy();
    assert.equal(egress.wasRefused('https://slow.example/account'), true);
    assert.equal(egress.refused.at(-1).reason, 'upstream');
  } finally { await egress.close(); }
});
