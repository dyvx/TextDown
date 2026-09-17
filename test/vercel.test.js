'use strict';
/* Tests for the Vercel serverless handlers. They are plain
   (req, res) => {} functions, so they can be driven directly — no
   deployment needed to prove the code path works. */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Readable } = require('node:stream');

const fetchHandler = require('../api/fetch.js');
const healthHandler = require('../api/health.js');
const { readBodyCapped, isPrivateIp } = require('../proxy-core.js');

function mockRes() {
  const r = {
    status: null, headers: null, body: null, ended: false,
    writeHead(status, headers) { r.status = status; r.headers = headers || {}; return r; },
    setHeader(k, v) { r.headers = r.headers || {}; r.headers[k] = v; },
    end(body) { r.ended = true; if (body !== undefined) r.body = body; }
  };
  return r;
}
const req = (opts) => Object.assign({ method: 'GET', headers: {}, url: '/api/fetch' }, opts);

const LUA = 'local part = Instance.new("Part")\nprint(part.Name)\n';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) { return new Promise((r) => server.close(() => r())); }

function makeOrigin() {
  return http.createServer((rq, rs) => {
    const p = rq.url.split('?')[0];
    if (p === '/script.lua') rs.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(LUA);
    else if (p === '/hop') rs.writeHead(302, { location: '/script.lua' }).end();
    else if (p === '/missing') rs.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
    else rs.writeHead(404).end();
  });
}

test('vercel health handler advertises the serverless runtime', async () => {
  const res = mockRes();
  await healthHandler(req({ url: '/api/health' }), res);
  assert.strictEqual(res.status, 200);
  const body = JSON.parse(res.body);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.runtime, 'vercel');
  assert.strictEqual(body.maxMB, 4, 'must stay under the 4.5 MB Vercel response limit');
  assert.strictEqual(body.allowPrivate, false);
});

test('vercel fetch relays a real text response with metadata', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  process.env.ALLOW_PRIVATE = '1'; // opt in for this test only; production default stays deny
  try {
    const res = mockRes();
    await fetchHandler(req({ headers: { 'x-target-url': 'http://127.0.0.1:' + originPort + '/script.lua' } }), res);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.toString(), LUA);
    assert.strictEqual(res.headers['x-upstream-status'], '200');
    assert.strictEqual(res.headers['x-content-type'], 'text/plain; charset=utf-8');
    assert.strictEqual(res.headers['content-length'], String(Buffer.byteLength(LUA)));
    assert.strictEqual(res.headers['access-control-expose-headers'],
      'x-final-url, x-upstream-status, x-content-type, x-truncated');
    assert.ok(res.headers['x-final-url'].endsWith('/script.lua'));
  } finally { delete process.env.ALLOW_PRIVATE; await close(origin); }
});

test('vercel fetch follows redirects and accepts ?url=', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  process.env.ALLOW_PRIVATE = '1'; // opt in for this test only; production default stays deny
  try {
    const res = mockRes();
    await fetchHandler(req({ url: '/api/fetch?url=' + encodeURIComponent('http://127.0.0.1:' + originPort + '/hop') }), res);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.toString(), LUA);
  } finally { delete process.env.ALLOW_PRIVATE; await close(origin); }
});

test('vercel fetch rejects missing target, bad schemes and dead hosts', async () => {
  const missing = mockRes();
  await fetchHandler(req({}), missing);
  assert.strictEqual(missing.status, 400);

  const scheme = mockRes();
  await fetchHandler(req({ headers: { 'x-target-url': 'file:///etc/passwd' } }), scheme);
  assert.strictEqual(scheme.status, 400);
  assert.match(scheme.body, /only http/);

  const dead = mockRes();
  await fetchHandler(req({ headers: { 'x-target-url': 'https://textdown-no-such-host.invalid/x.lua' } }), dead);
  assert.strictEqual(dead.status, 403);
  assert.match(dead.body, /DNS lookup failed/);
});

test('vercel fetch turns an upstream 404 into a 502 carrying the status', async () => {
  const origin = makeOrigin();
  const originPort = await listen(origin);
  process.env.ALLOW_PRIVATE = '1'; // opt in for this test only; production default stays deny
  try {
    const res = mockRes();
    await fetchHandler(req({ headers: { 'x-target-url': 'http://127.0.0.1:' + originPort + '/missing' } }), res);
    assert.strictEqual(res.status, 502);
    assert.strictEqual(res.headers['x-upstream-status'], '404');
    assert.match(res.body.toString(), /HTTP 404/);
  } finally { delete process.env.ALLOW_PRIVATE; await close(origin); }
});

test('vercel fetch refuses non-GET verbs', async () => {
  const res = mockRes();
  await fetchHandler(req({ method: 'POST', headers: { 'x-target-url': 'https://example.com/' } }), res);
  assert.strictEqual(res.status, 405);
});

test('readBodyCapped stops exactly at the limit and flags truncation', async () => {
  const payload = Buffer.alloc(5000, 0x61);
  const upstream = { body: Readable.toWeb(Readable.from([payload.subarray(0, 3000), payload.subarray(3000)])) };

  const whole = await readBodyCapped(upstream, 10000);
  assert.strictEqual(whole.buffer.length, 5000);
  assert.strictEqual(whole.truncated, false);

  const capped = await readBodyCapped(
    { body: Readable.toWeb(Readable.from([payload.subarray(0, 3000), payload.subarray(3000)])) }, 4096);
  assert.strictEqual(capped.buffer.length, 4096, 'must stop at the cap, got ' + capped.buffer.length);
  assert.strictEqual(capped.truncated, true);
  assert.strictEqual(capped.bytes, 4096);
});

test('the SSRF guard the serverless build relies on is shared, not duplicated', () => {
  const serverExports = require('../server.js');
  assert.strictEqual(serverExports.isPrivateIp, isPrivateIp, 'server.js must reuse proxy-core');
  assert.strictEqual(isPrivateIp('169.254.169.254'), true, 'cloud metadata IP must be blocked');
  assert.strictEqual(isPrivateIp('10.0.0.5'), true);
  assert.strictEqual(isPrivateIp('8.8.8.8'), false);
});
