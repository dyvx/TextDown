'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../syntax.js');

test('highlight escapes HTML so markup can never execute', () => {
  const out = S.highlight('<img src=x onerror="alert(1)">', 'plain');
  assert.ok(!out.includes('<img'), 'raw tag leaked: ' + out);
  assert.ok(out.includes('&lt;img'), out);
});

test('lua: keywords, strings, comments and numbers are tokenised', () => {
  const src = 'local hp = 100 -- health\nfunction attack(who)\n  print("hit " .. who)\nend';
  const out = S.highlight(src, 'lua');
  assert.match(out, /<span class="tk-kw">local<\/span>/);
  assert.match(out, /<span class="tk-kw">function<\/span>/);
  assert.match(out, /<span class="tk-num">100<\/span>/);
  assert.match(out, /<span class="tk-com">-- health<\/span>/);
  assert.match(out, /tk-str">&quot;hit &quot;<\/span>/);
  assert.match(out, /<span class="tk-bi">print<\/span>/);
});

test('luau aliases to the lua grammar', () => {
  assert.strictEqual(S.normalizeLang('luau'), 'lua');
  assert.match(S.highlight('local x = 1', 'luau'), /tk-kw">local/);
});

test('js: template literals, arrow functions, classes', () => {
  const out = S.highlight('const s = `hi ${name}`;\nclass A {}\nA::fn();', 'js');
  assert.match(out, /tk-kw">const/);
  assert.match(out, /tk-str">`hi \$\{name\}`/);
  assert.match(out, /tk-kw">class/);
  assert.match(out, /tk-cls">A/);
});

test('json: keys, strings and numbers', () => {
  const out = S.highlight('{"a": 1, "b": true}', 'json');
  assert.match(out, /tk-str">&quot;a&quot;/);
  assert.match(out, /tk-num">1/);
  assert.match(out, /tk-lit">true/);
});

test('html: tags, attributes and text are distinct tokens', () => {
  const out = S.highlight('<div class="a">hi</div>', 'html');
  assert.match(out, /tk-tag">&lt;div/);
  assert.match(out, /tk-attr">class/);
  assert.match(out, /tk-str">&quot;a&quot;/);
  assert.match(out, /tk-txt">hi/);
});

test('css: selectors, properties and values', () => {
  const out = S.highlight('.btn { color: #fff; }', 'css');
  assert.match(out, /tk-cls">\.btn/);
  assert.match(out, /tk-prop">color/);
  assert.match(out, /tk-num">#fff/);
});

test('markdown: heading, bold and code', () => {
  const out = S.highlight('# Title\n**bold** `code`', 'md');
  assert.match(out, /tk-hd"># Title/);
  assert.match(out, /tk-bold">\*\*bold\*\*/);
  assert.match(out, /tk-code">`code`/);
});

test('tokenizer never loses or invents characters', () => {
  const samples = [
    ['lua', 'local t = {1,2,3}\nfor i,v in ipairs(t) do print(i,v) end'],
    ['js', 'const x = a < b ? "y" : `z`; // <comment>'],
    ['html', '<!-- c --><a href="x">t</a>'],
    ['css', '@media (min-width: 10px) { a:hover { top: 0 } }'],
    ['md', '- [link](http://a.b)\n> quote'],
    ['xml', '<?xml version="1.0"?><r a="1">t</r>'],
    ['json', '{"k":[1,2,{"z":null}]}'],
    ['plain', 'weird \u0000 chars \u00e9\u00e8\u4e2d']
  ];
  for (const [lang, src] of samples) {
    const html = S.highlight(src, lang);
    const text = html
      .replace(/<span class="tk-[a-z]+">/g, '')
      .replace(/<\/span>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    assert.strictEqual(text, src, 'round-trip mismatch for ' + lang);
  }
});

test('highlight returns "" for empty input and caps huge input', () => {
  assert.strictEqual(S.highlight('', 'lua'), '');
  const big = 'a'.repeat(5000);
  const capped = S.highlight(big, 'lua', 1000);
  assert.ok(capped.includes('highlighting paused'), 'expected the pause marker');
  assert.ok(capped.length < big.length + 200);
});

test('extToLang maps every supported extension', () => {
  const map = { lua: 'lua', luau: 'lua', js: 'js', ts: 'ts', json: 'json', html: 'html', css: 'css', xml: 'xml', md: 'md', txt: 'plain' };
  for (const [ext, lang] of Object.entries(map)) assert.strictEqual(S.extToLang(ext), lang, ext);
  assert.strictEqual(S.extToLang('.LUA'), 'lua');
  assert.strictEqual(S.extToLang('zzz'), null);
});

test('sniffLang recognises content shapes', () => {
  assert.strictEqual(S.sniffLang('{"a":1}'), 'json');
  assert.strictEqual(S.sniffLang('<?xml version="1.0"?><a/>'), 'xml');
  assert.strictEqual(S.sniffLang('<!DOCTYPE html><html></html>'), 'html');
  assert.strictEqual(S.sniffLang('local part = Instance.new("Part")\npart.Parent = workspace'), 'lua');
  assert.strictEqual(S.sniffLang(''), 'plain');
  assert.strictEqual(S.sniffLang('just some words'), 'plain');
});
