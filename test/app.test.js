'use strict';
/* Integration tests: boot the real index.html + app.js in jsdom and drive
   the actual UI code paths (fetch, editor, auto-detect, download, errors).
   Skipped automatically if jsdom is not installed:  npm i --no-save jsdom */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try { JSDOM = require('jsdom').JSDOM; } catch (_) { JSDOM = null; }
const it = JSDOM ? test : test.skip;

const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const tick = (ms = 160) => new Promise((r) => setTimeout(r, ms));

function fakeRes(text, opts) {
  const o = opts || {};
  const headers = Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, o.headers || {});
  const status = o.status == null ? 200 : o.status;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(headers, String(k).toLowerCase()) ? headers[String(k).toLowerCase()] : null) },
    body: null,
    url: o.url || 'https://example.com/unknown',
    text: async () => text
  };
}

async function boot() {
  const dom = new JSDOM(HTML, {
    url: 'file://' + path.join(ROOT, 'index.html'),
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(win) {
      win.TextEncoder = TextEncoder;
      win.TextDecoder = TextDecoder;
      if (!win.AbortController) win.AbortController = AbortController;
      win.URL.createObjectURL = () => 'blob:textdown-test';
      win.URL.revokeObjectURL = () => {};
    }
  });
  await new Promise((r) => dom.window.addEventListener('load', r));
  await tick(20);
  return dom;
}

it('boots: every element resolves and the extension list is complete', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    assert.ok(win.TextDown, 'app.js did not expose its API — boot failed');
    const opts = [...doc.getElementById('extSelect').options].map((o) => o.value);
    assert.deepStrictEqual(opts, ['.txt', '.lua', '.luau', '.js', '.ts', '.json', '.html', '.css', '.xml', '.md', '__custom__']);
    assert.strictEqual(doc.getElementById('presets').children.length, 10);
    assert.strictEqual(doc.getElementById('filePreview').textContent, 'download.txt');
    assert.strictEqual(doc.getElementById('statLines').textContent, '1 line');
    assert.strictEqual(doc.getElementById('netPillText').textContent, 'Opened from disk');
    assert.strictEqual(doc.documentElement.dataset.theme, 'dark');

  } finally { dom.window.close(); }
});

it('theme toggle flips data-theme and is remembered', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    doc.getElementById('themeBtn').click();
    assert.strictEqual(doc.documentElement.dataset.theme, 'light');
    doc.getElementById('themeBtn').click();
    assert.strictEqual(doc.documentElement.dataset.theme, 'dark');
    assert.strictEqual(win.TextDown.settings.theme, 'dark');
  } finally { dom.window.close(); }
});

it('fetch populates the editor, detects name + extension + language', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    const src = 'local part = Instance.new("Part")\npart.Parent = workspace\n';
    const calls = [];
    win.fetch = async (href) => { calls.push(href); return fakeRes(src, { url: 'https://example.com/scripts/player.lua' }); };

    await win.TextDown.doFetch({ url: 'https://example.com/scripts/player.lua' });
    await tick();

    assert.deepStrictEqual(calls, ['https://example.com/scripts/player.lua'], 'direct fetch only, no relay needed');
    assert.strictEqual(doc.getElementById('ta').value, src);
    assert.ok(doc.body.classList.contains('has-content'), 'empty-state overlay should be hidden');
    assert.strictEqual(doc.getElementById('filePreview').textContent, 'player.lua');
    assert.strictEqual(doc.getElementById('extSelect').value, '.lua');
    assert.strictEqual(win.TextDown.state.lang, 'lua');
    assert.strictEqual(doc.getElementById('langSelect').value, 'lua');
    assert.match(doc.getElementById('hl').innerHTML, /tk-kw">local<\/span>/);
    assert.strictEqual(doc.getElementById('srcBar').hidden, false);
    assert.match(doc.getElementById('srcStatus').textContent, /HTTP 200/);
    assert.match(doc.getElementById('statLines').textContent, /3 lines/);
    assert.strictEqual(doc.getElementById('gutter').firstElementChild.children.length, 3);
    assert.match(doc.querySelector('.toast.ok').textContent, /Fetched/);
    assert.strictEqual(doc.getElementById('errorPanel').hidden, true);
  } finally { dom.window.close(); }
});

it('typing updates counts and marks the document dirty', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    const ta = doc.getElementById('ta');
    ta.value = 'one\ntwo\nthree';
    ta.dispatchEvent(new win.Event('input', { bubbles: true }));
    await tick();
    assert.strictEqual(doc.getElementById('statChars').textContent, '13 chars');
    assert.strictEqual(doc.getElementById('statLines').textContent, '3 lines');
    assert.strictEqual(doc.getElementById('statBytes').textContent, '13 B');
    assert.strictEqual(doc.getElementById('gutter').firstElementChild.children.length, 3);
    assert.strictEqual(win.TextDown.state.dirty, true);
  } finally { dom.window.close(); }
});

it('downloads filename + extension as one file with the chosen encoding', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    doc.getElementById('ta').value = 'hello';
    doc.getElementById('nameInput').value = 'my script';
    doc.getElementById('extSelect').value = '.js';
    doc.getElementById('extSelect').dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.strictEqual(doc.getElementById('filePreview').textContent, 'my script.js');

    let saved = null;
    win.URL.createObjectURL = (blob) => { saved = blob; return 'blob:textdown-test'; };
    win.HTMLAnchorElement.prototype.click = function () { saved.download = this.download; };

    await win.TextDown.doDownload(false);
    assert.strictEqual(saved.download, 'my script.js');
    assert.strictEqual(saved.size, 5);
    assert.match(saved.type, /text\/plain/);

    // UTF-8 BOM adds three bytes
    doc.getElementById('encSel').value = 'utf8bom';
    doc.getElementById('encSel').dispatchEvent(new win.Event('change', { bubbles: true }));
    await win.TextDown.doDownload(false);
    assert.strictEqual(saved.size, 8);
  } finally { dom.window.close(); }
});

it('custom extension is sanitised and remembered in the preview', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    const sel = doc.getElementById('extSelect');
    sel.value = '__custom__';
    sel.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.strictEqual(doc.getElementById('customExtField').hidden, false);

    const custom = doc.getElementById('customExtInput');
    custom.value = '..CFG';
    custom.dispatchEvent(new win.Event('input', { bubbles: true }));
    assert.strictEqual(doc.getElementById('filePreview').textContent, 'download.cfg');
    assert.strictEqual(win.TextDown.currentExt(), '.cfg');
  } finally { dom.window.close(); }
});

it('CORS failure explains itself and offers a relay retry', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    const tried = [];
    win.fetch = async (href) => {
      tried.push(href);
      throw Object.assign(new TypeError('Failed to fetch'), { name: 'TypeError' });
    };

    await win.TextDown.doFetch({ url: 'https://blocked.example.org/data.json' });
    await tick();

    assert.strictEqual(tried.length, 4, 'direct + 3 relays: ' + JSON.stringify(tried));
    assert.strictEqual(doc.getElementById('errorPanel').hidden, false);
    assert.strictEqual(doc.getElementById('errTitle').textContent, 'The browser could not read the response');
    assert.match(doc.getElementById('errExplain').textContent, /Access-Control-Allow-Origin/);
    assert.strictEqual(doc.getElementById('errRoutes').children.length, 4);
    const labels = [...doc.getElementById('errActions').children].map((b) => b.textContent);
    assert.ok(labels.includes('Retry with public relays'), labels.join('|'));
    assert.strictEqual(doc.getElementById('ta').value, '', 'must never invent content');
    assert.match(doc.querySelector('.toast.err').textContent, /could not read the response/i);
  } finally { dom.window.close(); }
});

it('HTTP 404 is reported as a server error, not a CORS problem', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    doc.getElementById('useProxy').checked = false;
    win.fetch = async () => fakeRes('Not Found', { status: 404, url: 'https://example.org/missing.txt' });

    await win.TextDown.doFetch({ url: 'https://example.org/missing.txt' });
    await tick();

    assert.strictEqual(doc.getElementById('errTitle').textContent, 'The server returned an error');
    assert.match(doc.getElementById('errMsg').textContent, /HTTP 404/);
    assert.match(doc.getElementById('errExplain').textContent, /not a CORS problem/);
  } finally { dom.window.close(); }
});

it('binary responses are refused instead of mangled into text', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    doc.getElementById('useProxy').checked = false;
    win.fetch = async () => fakeRes('\u0089PNG\u0000\u0001\u0002\u0003', { headers: { 'content-type': 'image/png' }, url: 'https://example.org/a.png' });

    await win.TextDown.doFetch({ url: 'https://example.org/a.png' });
    await tick();

    assert.strictEqual(doc.getElementById('errTitle').textContent, 'That response is not text');
    assert.strictEqual(doc.getElementById('ta').value, '');
  } finally { dom.window.close(); }
});

it('empty responses are surfaced, never shown as blank success', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    doc.getElementById('useProxy').checked = false;
    win.fetch = async () => fakeRes('', { url: 'https://example.org/empty.txt' });

    await win.TextDown.doFetch({ url: 'https://example.org/empty.txt' });
    await tick();

    assert.strictEqual(doc.getElementById('errTitle').textContent, 'The server sent an empty response');
    assert.match(doc.getElementById('errExplain').textContent, /never invents content/);
  } finally { dom.window.close(); }
});

it('invalid and non-http URLs are rejected before any request', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    let called = 0;
    win.fetch = async () => { called++; return fakeRes('x'); };

    await win.TextDown.doFetch({ url: 'not a url at all' });
    assert.strictEqual(doc.getElementById('errTitle').textContent, 'That does not look like a URL');

    await win.TextDown.doFetch({ url: 'file:///etc/passwd' });
    assert.strictEqual(doc.getElementById('errTitle').textContent, 'Unsupported protocol');

    await win.TextDown.doFetch({ url: 'javascript:alert(1)' });
    assert.strictEqual(doc.getElementById('errTitle').textContent, 'Unsupported protocol');

    await win.TextDown.doFetch({ url: '' });
    assert.strictEqual(doc.getElementById('errTitle').textContent, 'Enter a URL');
    assert.strictEqual(called, 0, 'no network call should have been made');
  } finally { dom.window.close(); }
});

it('local files load through the same editor pipeline', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    const file = new win.File(['{"hp": 100, "name": "boss"}'], 'enemy.json', { type: 'application/json' });
    await win.TextDown.openFiles([file]);
    await tick();

    assert.strictEqual(doc.getElementById('ta').value, '{"hp": 100, "name": "boss"}');
    assert.strictEqual(doc.getElementById('filePreview').textContent, 'enemy.json');
    assert.strictEqual(doc.getElementById('extSelect').value, '.json');
    assert.strictEqual(win.TextDown.state.lang, 'json');
    assert.match(doc.getElementById('hl').innerHTML, /tk-num">100/);
    assert.match(doc.getElementById('srcStatus').textContent, /local file/);
  } finally { dom.window.close(); }
});

it('copy button reports the copied size and clear resets the workspace', async () => {
  const dom = await boot();
  try {
    const { window: win, window: { document: doc } } = dom;
    let copied = null;
    win.navigator.clipboard = { writeText: async (t) => { copied = t; } };
    doc.getElementById('ta').value = 'abc';
    doc.getElementById('copyBtn').click();
    await tick();
    assert.strictEqual(copied, 'abc');

    doc.getElementById('clearBtn').click();
    await tick();
    assert.strictEqual(doc.getElementById('ta').value, '');
    assert.strictEqual(doc.getElementById('srcBar').hidden, true);
    assert.ok(!doc.body.classList.contains('has-content'));
    assert.strictEqual(doc.getElementById('statLines').textContent, '1 line');
  } finally { dom.window.close(); }
});
