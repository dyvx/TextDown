#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════
   TextDown — local dev server: static host + same-origin CORS proxy.
   Zero dependencies, Node 18+ (uses global fetch).

     node server.js                 → http://localhost:5173
     PORT=8080 node server.js
     ALLOW_PRIVATE=1 node server.js → also permit LAN/localhost targets

   Production (Vercel) uses api/fetch.js + api/health.js, which share the
   exact same rules through proxy-core.js.
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const core = require('./proxy-core.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BYTES = Number(process.env.MAX_BYTES) || 8 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 25000;
const MAX_REDIRECTS = 3;
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE === '1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/* ── static files ───────────────────────────────────────────────── */
function safeJoin(root, urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const full = path.resolve(root, rel || 'index.html');
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

async function serveStatic(req, res) {
  const urlPath = (req.url || '/').split('?')[0];
  const full = safeJoin(ROOT, urlPath);
  if (!full) { res.writeHead(403).end('forbidden'); return; }
  let stat;
  try { stat = await fs.promises.stat(full); }
  catch (_) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 — nothing at ' + urlPath);
    return;
  }
  if (stat.isDirectory()) {
    const index = path.join(full, 'index.html');
    try { stat = await fs.promises.stat(index); }
    catch (_) { res.writeHead(404).end('404'); return; }
    return sendFile(index, stat, res);
  }
  return sendFile(full, stat, res);
}

function sendFile(full, stat, res) {
  const ext = path.extname(full).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    'x-content-type-options': 'nosniff'
  });
  fs.createReadStream(full).pipe(res);
}

/* ── the proxy ──────────────────────────────────────────────────── */
async function handleFetch(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const target = (req.headers['x-target-url'] || u.searchParams.get('url') || '').trim();
  if (!target) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('missing target: send the x-target-url header or ?url=');
    return;
  }

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), TIMEOUT_MS);
  req.on('close', () => ac.abort());

  try {
    const { res: upstream, finalUrl } = await core.fetchTarget(target, {
      signal: ac.signal, allowPrivate: ALLOW_PRIVATE, maxRedirects: MAX_REDIRECTS
    });

    if (!upstream.ok) {
      const body = (await upstream.text().catch(() => '')).slice(0, 400);
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'x-upstream-status': String(upstream.status) });
      res.end('upstream returned HTTP ' + upstream.status + (body ? ' — ' + body.replace(/\s+/g, ' ') : ''));
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    // Buffered (not streamed) so `x-truncated` can be set before the body —
    // mutating headers after the first write throws ERR_HTTP_HEADERS_SENT.
    const out = await core.readBodyCapped(upstream, MAX_BYTES);
    const headers = {
      'content-type': contentType,
      'content-length': String(out.buffer.length),
      'x-final-url': finalUrl,
      'x-upstream-status': String(upstream.status),
      'x-content-type': contentType,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    };
    if (out.truncated) headers['x-truncated'] = '1';
    res.writeHead(200, Object.assign(headers, core.corsHeaders()));
    res.end(out.buffer);
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    const status = err instanceof core.HttpError ? err.status : (aborted ? 504 : 502);
    const message = aborted
      ? 'upstream timed out after ' + Math.round(TIMEOUT_MS / 1000) + 's'
      : (err && err.message) || 'fetch failed';
    if (!res.headersSent) {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(status + ' — ' + message);
    } else {
      res.destroy();
    }
  } finally {
    clearTimeout(timeout);
  }
}

/* ── server ─────────────────────────────────────────────────────── */
function createServer_() {
  return http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    res.setHeader('x-content-type-options', 'nosniff');
    if (urlPath === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true, name: 'textdown-proxy', runtime: 'node-server', version: 2,
        maxMB: Math.round((MAX_BYTES / 1048576) * 10) / 10,
        timeoutMs: TIMEOUT_MS, allowPrivate: ALLOW_PRIVATE
      }));
      return;
    }
    if (urlPath === '/api/fetch') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, core.corsHeaders());
        res.end();
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('GET only');
        return;
      }
      handleFetch(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500).end(String((err && err.message) || err));
        else res.destroy();
      });
      return;
    }
    if (urlPath.startsWith('/api/')) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('unknown api route');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    serveStatic(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end('static error');
    });
  });
}

if (require.main === module) {
  createServer_().listen(PORT, HOST, () => {
    const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
    console.log('TextDown · http://' + shown + ':' + PORT);
    console.log('  static files  → ' + ROOT);
    console.log('  proxy         → GET /api/fetch  (header: x-target-url)');
    console.log('  limits        → ' + Math.round(MAX_BYTES / 1048576) + ' MB per response, ' +
      Math.round(TIMEOUT_MS / 1000) + ' s timeout, private IPs ' + (ALLOW_PRIVATE ? 'ALLOWED (dev)' : 'blocked'));
  });
}

module.exports = Object.assign({
  createServer: createServer_, safeJoin, MAX_BYTES, TIMEOUT_MS, MIME
}, core);
