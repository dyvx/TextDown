'use strict';
/* Vercel serverless: GET /api/health
   The front end probes this on load; a 200 switches it into
   "Local proxy ready" mode so every fetch is relayed same-origin. */
const MAX_BYTES = Number(process.env.MAX_BYTES) || 4 * 1024 * 1024;
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS) || 20000;

module.exports = function handler(req, res) {
  const base = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-target-url',
    'access-control-allow-methods': 'GET,OPTIONS',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, base); res.end(); return; }

  res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, base));
  res.end(JSON.stringify({
    ok: true,
    name: 'textdown-proxy',
    runtime: 'vercel',
    version: 2,
    maxMB: Math.round((MAX_BYTES / 1048576) * 10) / 10,
    timeoutMs: TIMEOUT_MS,
    allowPrivate: process.env.ALLOW_PRIVATE === '1'
  }));
};
