'use strict';
/* ═══════════════════════════════════════════════════════════════════
   proxy-core.js — the fetch/SSRF logic shared by both runtimes:
     · server.js      (long-lived Node server for local dev)
     · api/fetch.js   (Vercel serverless function)
   ═══════════════════════════════════════════════════════════════════ */
const net = require('node:net');
const dns = require('node:dns/promises');

/* ── SSRF guard ─────────────────────────────────────────────────── */
const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.0\.(0|2)\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^198\.(1[89])\./, /^198\.51\.100\./, /^203\.0\.113\./,
  /^(22[4-9]|2[3-5]\d)\./
];
const PRIVATE_V6 = [/^::1?$/i, /^::$/i, /^fe80:/i, /^f[cd][0-9a-f]{2}:/i, /^::ffff:/i, /^64:ff9b:/i];

function isPrivateIp(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return true;
  const v4 = s.includes(':') && s.includes('.') ? s.split(':').pop() : (s.includes('.') ? s : null);
  if (v4 && net.isIPv4(v4)) return PRIVATE_V4.some((r) => r.test(v4));
  return PRIVATE_V6.some((r) => r.test(s));
}

async function assertPublicHost(hostname, allowPrivate) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!host) return { err: 'missing host' };
  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateIp(host)) return { err: 'refused: ' + host + ' is a private or reserved address' };
    return { ips: [host] };
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    return { err: 'DNS lookup failed (' + (e.code || e.message) + ')' };
  }
  if (!records.length) return { err: 'host does not resolve' };
  if (!allowPrivate) {
    for (const r of records) {
      if (isPrivateIp(r.address)) return { err: 'refused: ' + host + ' resolves to a private or reserved address' };
    }
  }
  return { ips: records.map((r) => r.address) };
}

/* ── upstream fetch with per-hop re-validation ──────────────────── */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function fetchTarget(rawUrl, opts) {
  const o = opts || {};
  const maxRedirects = o.maxRedirects == null ? 3 : o.maxRedirects;
  let current = String(rawUrl || '');

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(current); } catch (_) { throw new HttpError(400, 'target url could not be parsed'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new HttpError(400, 'only http: and https: targets are allowed');
    }
    const check = await assertPublicHost(u.hostname, o.allowPrivate);
    if (check.err) throw new HttpError(403, check.err);

    const res = await fetch(u, { redirect: 'manual', signal: o.signal });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      try { await res.body.cancel(); } catch (_) {}
      current = new URL(loc, u).href;
      continue;
    }
    return { res, finalUrl: u.href };
  }
  throw new HttpError(508, 'too many redirects (limit ' + maxRedirects + ')');
}

/* ── shared response helpers ────────────────────────────────────── */
const EXPOSE = 'x-final-url, x-upstream-status, x-content-type, x-truncated';

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-target-url',
    'access-control-allow-methods': 'GET,OPTIONS',
    'access-control-expose-headers': EXPOSE
  };
}

/* Read the upstream body, stopping hard at `maxBytes`.
   Returns a Buffer (serverless) or streams via onChunk (long-lived server). */
async function readBodyCapped(upstream, maxBytes, onChunk) {
  if (!upstream.body) return { buffer: Buffer.alloc(0), bytes: 0, truncated: false };
  const reader = upstream.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    let v = chunk.value;
    total += v.byteLength;
    if (total > maxBytes) {
      const keep = Math.max(0, v.byteLength - (total - maxBytes));
      v = v.subarray(0, keep);
      truncated = true;
    }
    if (v.byteLength) {
      if (onChunk) onChunk(v);
      else chunks.push(Buffer.from(v));
    }
    if (truncated) {
      try { await reader.cancel(); } catch (_) {}
      break;
    }
  }
  return {
    buffer: onChunk ? null : Buffer.concat(chunks),
    bytes: Math.min(total, maxBytes),
    truncated
  };
}

module.exports = {
  isPrivateIp, assertPublicHost, fetchTarget, HttpError,
  readBodyCapped, corsHeaders, PRIVATE_V4, PRIVATE_V6, EXPOSE
};
