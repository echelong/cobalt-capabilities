/** Egress policy proxy for the optional Obscura companion.
 *
 * The browser's request interception is advisory on the supported engine: a
 * redirect hop and a parser-inserted subresource are fetched before, or
 * regardless of, the interception answer. So the origin policy is enforced
 * here instead, outside the browser: the browser service is started with this
 * proxy as its only route, every request (a navigation, each redirect hop, a
 * subresource, a scripted request) arrives here first, and a destination the
 * policy does not admit is refused before any connection to it is opened.
 *
 * The proxy lives only for one browser task. It is bound to numeric loopback,
 * forwards GET/HEAD without credentials to the exact address the policy
 * vetted (never a second DNS answer), tunnels CONNECT only to an allowlisted
 * https origin, refuses upgrades, and follows no redirect itself.
 */
import http from 'node:http';
import net from 'node:net';
import { randomBytes } from 'node:crypto';

/** Reserved name (RFC 6761): it resolves nowhere, so only a browser that is
 * really routed through this proxy can deliver a request for it. */
export const ATTEST_HOST = 'cobalt-egress-attest.invalid';

const HOP_BY_HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade']);
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];
const MAX_RECORDS = 100;
const MAX_REFUSED_URLS = 400;
const MAX_CONNECTIONS = 128;

const originOf = url => { try { return url.origin.slice(0, 1024); } catch { return '[invalid URL]'; } };

export async function startEgressProxy({ port, authorize, timeoutMs = 10000, maxResponseBytes = 16 * 1024 * 1024, maxTunnelBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof authorize !== 'function') throw new Error('An egress policy is required');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('An egress proxy port is required');
  const nonce = randomBytes(18).toString('hex');
  const sockets = new Set();
  const refused = [], refusedUrls = new Set(), refusedTunnels = new Set();
  let attested = false, bypassed = false, directRequests = 0, forwarded = 0, closed = false, refusedOverflow = false;
  // Every answer the proxy writes itself is a small page with this title. It
  // names the task, so the worker can tell "the proxy answered" from "the site
  // answered" by reading the document, whatever URL the page claims to be at.
  const refusalTitle = `cobalt-egress-refused-${nonce}`;
  const refusalPage = `<!doctype html><title>${refusalTitle}</title><p>refused by egress policy</p>`;
  const plain = url => { const copy = new URL(url.href); copy.hash = ''; return copy.href; };
  const track = socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); return socket; };

  // The canary is a destination no policy admits. A proxied browser asks the
  // proxy for it and is refused; any connection that reaches it directly is a
  // route around the proxy.
  const canary = net.createServer(socket => { bypassed = true; socket.destroy(); });
  await new Promise((resolve, reject) => { canary.once('error', reject); canary.listen(0, '127.0.0.1', resolve); });
  canary.on('error', () => {});
  const canaryPort = canary.address().port;
  const canaryOrigin = `http://127.0.0.1:${canaryPort}`;

  const refuse = (url, method, reason) => {
    // The proxy's own canary and attestation traffic is not page evidence.
    if (url && (url.hostname === ATTEST_HOST || url.port === String(canaryPort) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) return;
    if (refused.length < MAX_RECORDS) refused.push({ origin: url ? originOf(url) : '[invalid URL]', method: String(method).slice(0, 16), reason });
    // Past the bound nothing is forgotten silently: every later question about
    // a refused address is answered "refused".
    if (url && refusedUrls.size < MAX_REFUSED_URLS) refusedUrls.add(plain(url)); else if (url) refusedOverflow = true;
  };
  /** The vetted addresses for a destination, or null. Fails closed on anything unexpected. */
  const vet = async url => {
    try {
      const verdict = await authorize(url);
      const addresses = verdict && Array.isArray(verdict.addresses) ? verdict.addresses.filter(address => net.isIP(String(address)) !== 0) : [];
      return addresses.length ? addresses : null;
    } catch { return null; }
  };
  const deny = (response, status = 403) => {
    response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
    response.end(refusalPage);
  };

  const server = http.createServer((request, response) => {
    void (async () => {
      const raw = String(request.url ?? '');
      // A proxy client sends the absolute form. Anything else reached this port
      // without being routed through it, and is evidence the browser is not proxied.
      if (!/^https?:\/\//i.test(raw)) {
        if (raw.startsWith('/')) directRequests++;
        return deny(response, raw.startsWith('/') ? 421 : 400);
      }
      let url;
      try { url = new URL(raw); } catch { return deny(response, 400); }
      const method = String(request.method ?? '').toUpperCase();
      if (url.hostname === ATTEST_HOST) {
        if (url.protocol !== 'http:' || method !== 'GET' || url.pathname !== `/${nonce}`) return deny(response, 404);
        attested = true;
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
        // Fixed markup only. Each reference is one way an engine fetches without
        // asking interception first; all of them must come back through the proxy.
        // The https reference exercises the tunnel path; the frame and the
        // scripted requests exercise the remaining ones the engine implements.
        response.end(`<!doctype html><title>egress attestation</title><link rel="stylesheet" href="${canaryOrigin}/style"><img src="${canaryOrigin}/image" alt=""><img src="https://127.0.0.1:${canaryPort}/tunnel" alt=""><script src="${canaryOrigin}/script"></script><iframe src="${canaryOrigin}/frame"></iframe>`
          + `<script>try{fetch(${JSON.stringify(`${canaryOrigin}/fetch`)}).catch(function(){})}catch(e){}try{var x=new XMLHttpRequest();x.open('GET',${JSON.stringify(`${canaryOrigin}/xhr`)});x.onerror=function(){};x.send()}catch(e){}</script>`);
        return;
      }
      const headers = request.headers;
      const hasBody = Number(headers['content-length'] ?? 0) > 0 || headers['transfer-encoding'] !== undefined;
      if (url.protocol !== 'http:' || !['GET', 'HEAD'].includes(method) || hasBody || url.username || url.password
        || CREDENTIAL_HEADERS.some(name => headers[name] !== undefined)) {
        refuse(url, method, 'request'); return deny(response);
      }
      const addresses = await vet(url);
      if (!addresses || closed) { refuse(url, method, 'origin'); return deny(response); }
      const outgoing = {};
      for (const [name, value] of Object.entries(headers)) if (!HOP_BY_HOP.has(name)) outgoing[name] = value;
      outgoing.host = url.host;
      outgoing.connection = 'close';
      forwarded++;
      const upstream = http.request({ host: addresses[0], port: url.port || 80, method, path: `${url.pathname}${url.search}`,
        headers: outgoing, agent: false, setHost: false, timeout: timeoutMs });
      upstream.on('socket', track);
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
      // An upstream failure is answered by the proxy, so it is recorded like
      // any other page the site did not serve.
      upstream.on('error', () => { refuse(url, method, 'upstream'); if (!response.headersSent) deny(response, 502); else response.destroy(); });
      upstream.on('response', reply => {
        const answer = {};
        for (const [name, value] of Object.entries(reply.headers)) if (!HOP_BY_HOP.has(name)) answer[name] = value;
        answer.connection = 'close';
        // A status or header the server cannot relay ends this one response, not the worker.
        try { response.writeHead(reply.statusCode ?? 502, answer); }
        catch { refuse(url, method, 'upstream'); reply.destroy(); upstream.destroy(); response.destroy(); return; }
        let delivered = 0;
        reply.on('data', chunk => {
          delivered += chunk.length;
          if (delivered > maxResponseBytes) { reply.destroy(); upstream.destroy(); response.destroy(); return; }
          if (!response.write(chunk)) { reply.pause(); response.once('drain', () => reply.resume()); }
        });
        reply.on('end', () => response.end());
        reply.on('error', () => response.destroy());
      });
      response.on('close', () => upstream.destroy());
      upstream.end();
    })().catch(() => { try { if (!response.headersSent) deny(response, 502); else response.destroy(); } catch { /* socket already gone */ } });
  });
  server.on('connection', track);
  server.on('clientError', (_, socket) => { socket.destroy(); });
  // A tunnel is opaque, so it is opened only to an exact allowlisted https
  // origin and only at the address the policy vetted.
  server.on('connect', (request, client, head) => {
    track(client);
    void (async () => {
      const method = 'CONNECT';
      let url;
      try {
        const match = /^(\[[0-9a-fA-F:.]+\]|[^:\s/]+):(\d{1,5})$/.exec(String(request.url ?? ''));
        if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('invalid authority');
        url = new URL(`https://${match[1]}:${match[2]}`);
      } catch { refuse(null, method, 'request'); client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); return; }
      const addresses = await vet(url);
      // A refused tunnel has no page of the proxy's to recognise, and the
      // request named only the origin: every address on that origin counts as
      // answered by the proxy for the rest of the task.
      const refuseTunnel = reason => { refuse(url, method, reason); if (refusedTunnels.size < MAX_RECORDS) refusedTunnels.add(url.origin); else refusedOverflow = true; };
      if (!addresses || closed) { refuseTunnel('origin'); client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return; }
      forwarded++;
      const upstream = track(net.connect({ host: addresses[0], port: Number(url.port || 443) }));
      let carried = 0;
      const meter = (from, to) => from.on('data', chunk => {
        carried += chunk.length;
        if (carried > maxTunnelBytes) { client.destroy(); upstream.destroy(); return; }
        if (!to.write(chunk)) { from.pause(); to.once('drain', () => from.resume()); }
      });
      // A tunnel that never came up is recorded like one that was refused.
      upstream.setTimeout(timeoutMs, () => { if (!established) refuseTunnel('upstream'); upstream.destroy(); client.destroy(); });
      let established = false;
      upstream.once('connect', () => {
        established = true;
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) { carried += head.length; upstream.write(head); }
        meter(client, upstream); meter(upstream, client);
      });
      // Before the tunnel exists the client gets an HTTP answer; afterwards
      // the stream is the tunnel's and is simply ended.
      upstream.on('error', () => { if (established) client.destroy(); else { refuseTunnel('upstream'); client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } });
      upstream.on('close', () => client.destroy());
      client.on('close', () => upstream.destroy());
    })().catch(() => { client.destroy(); });
  });
  // No WebSocket or other protocol switch is an admitted resource.
  server.on('upgrade', (request, socket) => {
    track(socket);
    let url = null;
    try { url = new URL(String(request.url ?? '')); } catch { /* recorded without an origin */ }
    refuse(url, request.method ?? 'GET', 'upgrade');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });
  server.maxConnections = MAX_CONNECTIONS;
  server.keepAliveTimeout = 1000;
  server.headersTimeout = Math.min(Math.max(timeoutMs, 1000), 15000);
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  } catch (error) {
    await new Promise(resolve => canary.close(resolve));
    throw error;
  }
  server.on('error', () => {});

  return {
    origin: `http://127.0.0.1:${port}`,
    attestationUrl: `http://${ATTEST_HOST}/${nonce}`,
    canaryPort,
    get attested() { return attested; },
    get bypassed() { return bypassed; },
    get directRequests() { return directRequests; },
    get forwarded() { return forwarded; },
    refused,
    refusalTitle,
    /** True when the proxy, not the site, answered for this address (fragment ignored). */
    wasRefused: href => {
      if (refusedOverflow) return true;
      try { const url = new URL(String(href)); return refusedUrls.has(plain(url)) || refusedTunnels.has(url.origin); } catch { return true; }
    },
    /** Ends every connection: between tasks the browser has no route at all. */
    async close() {
      if (closed) return;
      closed = true;
      const done = Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => canary.close(resolve))]);
      for (const socket of sockets) socket.destroy();
      await done;
    },
  };
}
