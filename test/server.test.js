'use strict';
/* End-to-end tests for the bundled proxy: it must really fetch, really
   refuse SSRF targets, really follow redirects, and really cap size. */
process.env.ALLOW_PRIVATE = '1'; // let the tests point the proxy at 127.0.0.1

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer, isPrivateIp, safeJoin, MAX_BYTES } = require('../server.js');

const LUA = 'local part = Instance.new("Part")\nprint(part.Name)\n';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/* fetch() normalises "/../x" before sending, so path-traversal has to be
   tested with a raw request line that reaches the server untouched. */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* a tiny stand-in "origin" that serves text, redirects and errors */
function makeOrigin() {
  return http.createServer((req, res) => {
    const p = req.url.split('?')[0];
    if (p === '/script.lua') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(LUA);
    } else if (p === '/hop') {
      res.writeHead(302, { location: '/script.lua' }).end();
    } else if (p === '/loop') {
      res.writeHead(302, { location: '/loop' }).end();
    } else if (p === '/missing') {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
    } else if (p === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const tick = () => {
        if (sent >= 2 * 1024 * 1024) return res.end();
        sent += chunk.length;
        if (!res.write(chunk)) res.once('drain', tick); else tick();
      };
      tick();
    } else {
      res.writeHead(404).end();
    }
  });
}

test('isPrivateIp blocks loopback, LAN, link-local, multicast and CGNAT', () => {
  ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '172.31.255.255', '169.254.1.1',
    '0.0.0.0', '224.0.0.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '[::1]'].forEach((ip) => {
    assert.strictEqual(isPrivateIp(ip), true, ip + ' should be private');
  });
  ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:2800:220:1::'].forEach((ip) => {
    assert.strictEqual(isPrivateIp(ip), false, ip + ' should be public');
  });
});

test('safeJoin stays inside the served folder', () => {
  const root = path.resolve(__dirname, '..');
  assert.strictEqual(safeJoin(root, '/index.html'), path.join(root, 'index.html'));
  assert.strictEqual(safeJoin(root, '/'), path.join(root, 'index.html'));
  assert.strictEqual(safeJoin(root, '/../server.js'), null);
  assert.strictEqual(safeJoin(root, '/..%2fserver.js'), null);
});

test('health endpoint reports the proxy limits', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/health');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.maxMB, 8);
    assert.strictEqual(body.timeoutMs, 25000);
  } finally { await close(server); }
});

test('proxy relays a real text response with metadata headers', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/fetch', {
      headers: { 'x-target-url': 'http://127.0.0.1:' + originPort + '/script.lua' }
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), LUA);
    assert.strictEqual(res.headers.get('x-upstream-status'), '200');
    assert.strictEqual(res.headers.get('x-content-type'), 'text/plain; charset=utf-8');
    assert.strictEqual(res.headers.get('x-final-url'), 'http://127.0.0.1:' + originPort + '/script.lua');
  } finally { await close(server); await close(origin); }
});

test('proxy also accepts ?url= and follows redirects to the final URL', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/fetch?url=' +
      encodeURIComponent('http://127.0.0.1:' + originPort + '/hop'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), LUA);
    assert.ok(res.headers.get('x-final-url').endsWith('/script.lua'), res.headers.get('x-final-url'));
  } finally { await close(server); await close(origin); }
});

test('upstream 404 becomes a 502 that carries the real status', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/fetch', {
      headers: { 'x-target-url': 'http://127.0.0.1:' + originPort + '/missing' }
    });
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.headers.get('x-upstream-status'), '404');
    assert.match(await res.text(), /HTTP 404/);
  } finally { await close(server); await close(origin); }
});

test('missing target and non-http schemes are rejected', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const noTarget = await fetch('http://127.0.0.1:' + port + '/api/fetch');
    assert.strictEqual(noTarget.status, 400);

    const fileScheme = await fetch('http://127.0.0.1:' + port + '/api/fetch', {
      headers: { 'x-target-url': 'file:///etc/passwd' }
    });
    assert.strictEqual(fileScheme.status, 400);
    assert.match(await fileScheme.text(), /only http/);
  } finally { await close(server); }
});

test('unresolvable host is refused instead of hanging', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/fetch', {
      headers: { 'x-target-url': 'https://textdown-no-such-host.invalid/a.lua' }
    });
    assert.strictEqual(res.status, 403);
    assert.match(await res.text(), /DNS lookup failed/);
  } finally { await close(server); }
});

test('redirect loops stop instead of spinning', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/fetch', {
      headers: { 'x-target-url': 'http://127.0.0.1:' + originPort + '/loop' }
    });
    assert.strictEqual(res.status, 508);
  } finally { await close(server); await close(origin); }
});

test('a large body streams through intact when it is under the cap', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  const server = createServer();
  const port = await listen(server);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/fetch', {
      headers: { 'x-target-url': 'http://127.0.0.1:' + originPort + '/big' }
    });
    assert.strictEqual(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.length, 2 * 1024 * 1024, 'origin served exactly 2 MB');
    assert.ok(buf.length <= MAX_BYTES);
  } finally { await close(server); await close(origin); }
});

test('response body is hard-capped (child server with MAX_BYTES=4096)', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  const child = spawn(process.execPath, ['-e', [
    "process.env.ALLOW_PRIVATE = '1';",
    "const { createServer } = require(" + JSON.stringify(path.resolve(__dirname, '..', 'server.js')) + ");",
    "createServer().listen(0, '127.0.0.1', function () { console.log('PORT ' + this.address().port); });"
  ].join('\n')], { env: Object.assign({}, process.env, { MAX_BYTES: '4096' }) });

  const port = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('child server did not start')), 10000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/PORT (\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });

  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/fetch', {
      headers: { 'x-target-url': 'http://127.0.0.1:' + originPort + '/big' }
    });
    assert.strictEqual(res.status, 200);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length <= 4096, 'expected at most 4096 bytes, got ' + buf.length);
    assert.ok(buf.length > 3000, 'expected the cap to be filled, got ' + buf.length);
    assert.strictEqual(res.headers.get('x-truncated'), '1', 'truncation must be signalled');
  } finally {
    child.kill('SIGKILL');
    await close(origin);
  }
});

test('static files are served with the right content types', async () => {
  const server = createServer();
  const port = await listen(server);
  try {
    const root = await fetch('http://127.0.0.1:' + port + '/');
    assert.strictEqual(root.status, 200);
    assert.match(root.headers.get('content-type'), /text\/html/);
    assert.match(await root.text(), /TextDown/);

    const css = await fetch('http://127.0.0.1:' + port + '/styles.css');
    assert.strictEqual(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    const missing = await fetch('http://127.0.0.1:' + port + '/nope.js');
    assert.strictEqual(missing.status, 404);

    const dotdot = await rawGet(port, '/../server.js');
    assert.strictEqual(dotdot.status, 403, 'raw /../ must be refused');

    const encoded = await rawGet(port, '/%2e%2e/server.js');
    assert.strictEqual(encoded.status, 403, 'encoded traversal must be refused');

    const backslash = await rawGet(port, '/..%5cserver.js');
    assert.notStrictEqual(backslash.status, 200);
  } finally { await close(server); }
});
