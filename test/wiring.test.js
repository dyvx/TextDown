'use strict';
/* Wiring tests: the DOM ids app.js touches must actually exist, otherwise
   every handler would silently bind to null. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

const ids = app.match(/const IDS = \[([\s\S]*?)\];/)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test('index.html declares a substantial set of ids', () => {
  assert.ok(htmlIds.size > 40, 'only ' + htmlIds.size + ' ids found');
});

test('every id listed in app.js exists in index.html', () => {
  const missing = ids.filter((id) => !htmlIds.has(id));
  assert.deepStrictEqual(missing, [], 'missing ids: ' + missing.join(', '));
});

test('every els.X referenced by app.js is registered', () => {
  const used = new Set([...app.matchAll(/\bels\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]));
  const known = new Set(ids.concat(['pre']));
  const unknown = [...used].filter((u) => !known.has(u));
  assert.deepStrictEqual(unknown, [], 'unregistered element refs: ' + unknown.join(', '));
});

test('no stray getElementById calls outside the $ helper', () => {
  const hits = app.match(/document\.getElementById/g) || [];
  assert.strictEqual(hits.length, 1, 'getElementById should appear only inside $()');
});

test('index.html loads syntax.js before app.js and links styles.css', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, ['./syntax.js', './app.js']);
  assert.match(html, /<link rel="stylesheet" href="\.\/styles\.css"/);
});

test('every relative asset referenced by index.html exists on disk', () => {
  const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 3);
  refs.forEach((r) => {
    assert.ok(fs.existsSync(path.join(root, r)), 'missing asset: ' + r);
  });
});

test('extension selector offers exactly the requested list', () => {
  const list = app.match(/const EXTENSIONS = \[([^\]]*)\]/)[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
  assert.deepStrictEqual(list, ['.txt', '.lua', '.luau', '.js', '.ts', '.json', '.html', '.css', '.xml', '.md']);
});

test('panels toggled with the hidden attribute are guarded in CSS', () => {
  // .loading/.srcbar/.field set display:grid|flex, which outranks the UA
  // [hidden] rule, so the sheet must carry its own guard.
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  const toggled = [...app.matchAll(/els\.(\w+)\.hidden = /g)].map((m) => m[1]);
  assert.ok(toggled.length >= 4, 'expected several toggled panels, got ' + toggled.length);
  toggled.forEach((ref) => assert.ok(ids.includes(ref), ref + ' is not a registered element'));
  ['loading', 'errorPanel', 'srcBar', 'customExtField'].forEach((id) =>
    assert.match(html, new RegExp('id="' + id + '"[^>]*hidden'), '#' + id + ' should start hidden'));
});

test('styles.css defines both themes and the token colours it uses', () => {
  assert.match(css, /\[data-theme="light"\]/);
  assert.match(css, /:root \{/);
  const used = new Set([...css.matchAll(/var\((--tk-[a-z]+)/g)].map((m) => m[1]));
  used.forEach((v) => assert.match(css, new RegExp(v.replace(/[-]/g, '\\-') + ':'), 'undefined token colour ' + v));
});

test('the required UI affordances are present in the markup', () => {
  const need = ['fetchBtn', 'uploadBtn', 'fileInput', 'copyBtn', 'clearBtn', 'wrapBtn', 'autoBtn',
    'downloadBtn', 'asIsBtn', 'errorPanel', 'toasts', 'dropzone', 'themeBtn', 'statChars',
    'statLines', 'statBytes', 'presets', 'filePreview', 'customExtInput', 'recentUrls'];
  need.forEach((id) => assert.ok(htmlIds.has(id), 'missing #' + id));
});
