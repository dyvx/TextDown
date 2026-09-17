'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Vercel serverless: GET /api/fetch   (header: x-target-url)

   Same rules as the local dev server — they share proxy-core.js.
   Differences that matter on a serverless platform:
     · the body is buffered, not streamed, and capped at 4 MiB so it
       stays under Vercel's 4.5 MB response limit
     · private/internal addresses are always refused (no dev escape hatch)
   ═══════════════════════════════════════════════════════════════════ */
const core = require('../proxy-core.js');

const MAX_BYTES = Number(process.env.MAX_BYTES) || 4 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 20000;
const MAX_REDIRECTS = 3;

function send(res, status, headers, body) {
  res.writeHead(status, Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, headers));
  res.end(body == null ? undefined : body);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, core.corsHeaders()); res.end(); return; }
  if (req.method !== 'GET') { send(res, 405, core.corsHeaders(), 'GET only'); return; }

  const query = (req.query && req.query.url) ||
    (typeof req.url === 'string' ? new URLSearchParams(req.url.split('?')[1] || '').get('url') : null);
  const target = String((req.headers && req.headers['x-target-url']) || query || '').trim();

  if (!target) {
    send(res, 400, core.corsHeaders(), 'missing target: send the x-target-url header or ?url=');
    return;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);

  try {
    // Default deny. Only an explicit ALLOW_PRIVATE=1 (local testing) relaxes this;
    // Vercel never sets it, so private/internal targets stay blocked in production.
    const { res: upstream, finalUrl } = await core.fetchTarget(target, {
      signal: ac.signal, allowPrivate: process.env.ALLOW_PRIVATE === '1', maxRedirects: MAX_REDIRECTS
    });

    if (!upstream.ok) {
      const body = (await upstream.text().catch(() => '')).slice(0, 400);
      send(res, 502, Object.assign({ 'x-upstream-status': String(upstream.status) }, core.corsHeaders()),
        'upstream returned HTTP ' + upstream.status + (body ? ' — ' + body.replace(/\s+/g, ' ') : ''));
      return;
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const out = await core.readBodyCapped(upstream, MAX_BYTES);

    const headers = Object.assign({
      'content-type': contentType,
      'content-length': String(out.buffer.length),
      'x-final-url': finalUrl,
      'x-upstream-status': String(upstream.status),
      'x-content-type': contentType,
      'cache-control': 'no-store'
    }, core.corsHeaders());
    if (out.truncated) headers['x-truncated'] = '1';

    res.writeHead(200, headers);
    res.end(out.buffer);
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    const status = err instanceof core.HttpError ? err.status : (aborted ? 504 : 502);
    const message = aborted
      ? 'upstream timed out after ' + Math.round(TIMEOUT_MS / 1000) + 's'
      : (err && err.message) || 'fetch failed';
    send(res, status, core.corsHeaders(), status + ' — ' + message);
  } finally {
    clearTimeout(timer);
  }
};
