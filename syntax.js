/* ═══════════════════════════════════════════════════════════════════
   syntax.js — tiny, dependency-free multi-language tokenizer
   Exposes: TextDownSyntax.highlight(code, lang) -> HTML string
            TextDownSyntax.LANGS, .extToLang(), .sniffLang()
   Works in the browser (global) and in Node (module.exports) for tests.
   ═══════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TextDownSyntax = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── HTML escaping ─────────────────────────────────────────────── */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return s.replace(/[&<>"']/g, (c) => ESC[c]);
  }

  /* ── helpers ───────────────────────────────────────────────────── */
  const re = (src, flags) => new RegExp(src, (flags || '') + 'y');
  const word = (list) => re('\\b(?:' + list.join('|') + ')\\b');

  /* ── grammars ──────────────────────────────────────────────────── */
  const LUA_KW = ['and','break','do','else','elseif','end','false','for','function','goto','if','in','local','nil','not','or','repeat','return','then','true','until','while','continue'];
  const LUA_BI = ['print','require','pcall','xpcall','error','assert','ipairs','pairs','next','select','setmetatable','getmetatable','rawget','rawset','rawequal','rawlen','tonumber','tostring','type','unpack','table','string','math','os','io','coroutine','debug','loadstring','load','dofile','loadfile','warn','typeof','task','spawn','delay','wait','game','workspace','script','Instance','Vector3','Vector2','CFrame','Color3','UDim2','Enum','tick','time','warn'];

  const JS_KW = ['async','await','break','case','catch','class','const','constructor','continue','debugger','declare','default','delete','do','else','enum','export','extends','finally','for','from','function','get','if','implements','import','in','infer','instanceof','interface','is','keyof','let','namespace','new','of','override','private','protected','public','readonly','return','satisfies','set','static','super','switch','this','throw','try','type','typeof','var','void','while','with','yield'];
  const JS_LIT = ['true','false','null','undefined','NaN','Infinity'];
  const JS_BI = ['console','window','document','globalThis','global','process','module','exports','require','Math','JSON','Object','Array','String','Number','Boolean','Promise','Map','Set','WeakMap','WeakSet','Symbol','Proxy','Reflect','Error','TypeError','RangeError','Date','RegExp','Function','parseInt','parseFloat','isNaN','isFinite','setTimeout','setInterval','clearTimeout','clearInterval','fetch','URL','URLSearchParams','TextEncoder','TextDecoder','Blob','File','FileReader','AbortController','localStorage','sessionStorage','crypto','performance','structuredClone','queueMicrotask'];

  const C_LIKE = [
    { t: 'com', r: re('\\/\\/[^\\n]*') },
    { t: 'com', r: re('\\/\\*[\\s\\S]*?(?:\\*\\/|$)') },
    { t: 'str', r: re('`(?:\\\\.|\\$\\{[^{}]*\\}|[^`\\\\])*`?') },
    { t: 'str', r: re("'(?:\\\\.|[^'\\n\\\\])*'?") },
    { t: 'str', r: re('"(?:\\\\.|[^"\\n\\\\])*"?') },
    { t: 'num', r: re('0[xXbBoO][0-9a-fA-F_]+(?:n)?|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?n?') },
    { t: 'kw', r: word(JS_KW) },
    { t: 'lit', r: word(JS_LIT) },
    { t: 'bi', r: word(JS_BI) },
    { t: 'cls', r: re('\\b[A-Z][A-Za-z0-9_$]*\\b') },
    { t: 'fn', r: re('[A-Za-z_$][\\w$]*(?=\\s*\\()') },
    { t: 'id', r: re('[A-Za-z_$][\\w$]*') },
    { t: 'op', r: re('=>|\\.\\.\\.|[+\\-*/%=<>!&|^~?:]+') },
    { t: 'pun', r: re('[{}()\\[\\];,.]') },
    { t: 'plain', r: re('[ \\t]+') },
    { t: 'plain', r: re('\\n') },
    { t: 'plain', r: re('[^\\s]') }
  ];

  const GRAMMARS = {
    plain: [{ t: 'plain', r: re('[^\\n]*\\n?') }],

    lua: [
      { t: 'com', r: re('--\\[\\[[\\s\\S]*?(?:\\]\\]|$)') },
      { t: 'com', r: re('--[^\\n]*') },
      { t: 'str', r: re('\\[\\[[\\s\\S]*?(?:\\]\\]|$)') },
      { t: 'str', r: re('"(?:\\\\.|[^"\\n\\\\])*"?') },
      { t: 'str', r: re("'(?:\\\\.|[^'\\n\\\\])*'?") },
      { t: 'num', r: re('0[xX][0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?') },
      { t: 'kw', r: word(LUA_KW) },
      { t: 'bi', r: word(LUA_BI) },
      { t: 'fn', r: re('[A-Za-z_][\\w:]*(?=\\s*\\()') },
      { t: 'id', r: re('[A-Za-z_][\\w]*') },
      { t: 'op', r: re('#|\\.\\.\\.|[+\\-*/%^=<>~]+') },
      { t: 'pun', r: re('[{}()\\[\\];,.:]') },
      { t: 'plain', r: re('[ \\t]+') },
      { t: 'plain', r: re('\\n') },
      { t: 'plain', r: re('[^\\s]') }
    ],

    js: C_LIKE,
    ts: C_LIKE,
    json: C_LIKE,
    py: C_LIKE,
    sh: C_LIKE,
    yaml: C_LIKE,

    html: [
      { t: 'com', r: re('<!--[\\s\\S]*?(?:-->|$)') },
      { t: 'doc', r: re('<!doctype[^>]*>', 'i') },
      { t: 'tag', r: re('</?[A-Za-z][\\w:.-]*') },
      { t: 'tag', r: re('/?>') },
      { t: 'str', r: re('"(?:[^"\\n])*"?') },
      { t: 'str', r: re("'(?:[^'\\n])*'?") },
      { t: 'attr', r: re('[A-Za-z_:][-\\w:.]*(?=\\s*=)') },
      { t: 'op', r: re('=') },
      { t: 'txt', r: re('[^<>\\s"]+') },
      { t: 'plain', r: re('[ \\t]+') },
      { t: 'plain', r: re('\\n') },
      { t: 'plain', r: re('[^\\s]') }
    ],

    xml: [
      { t: 'com', r: re('<!--[\\s\\S]*?(?:-->|$)') },
      { t: 'doc', r: re('<\\?[\\s\\S]*?(?:\\?>|$)') },
      { t: 'doc', r: re('<!\\[[\\s\\S]*?(?:\\]\\]>|$)') },
      { t: 'tag', r: re('</?[A-Za-z_][\\w:.-]*') },
      { t: 'tag', r: re('/?>') },
      { t: 'str', r: re('"(?:[^"\\n])*"?') },
      { t: 'str', r: re("'(?:[^'\\n])*'?") },
      { t: 'attr', r: re('[A-Za-z_:][-\\w:.]*(?=\\s*=)') },
      { t: 'op', r: re('=') },
      { t: 'txt', r: re('[^<>\\s"]+') },
      { t: 'plain', r: re('[ \\t]+') },
      { t: 'plain', r: re('\\n') },
      { t: 'plain', r: re('[^\\s]') }
    ],

    css: [
      { t: 'com', r: re('\\/\\*[\\s\\S]*?(?:\\*\\/|$)') },
      { t: 'str', r: re('"(?:\\\\.|[^"\\n\\\\])*"?') },
      { t: 'str', r: re("'(?:\\\\.|[^'\\n\\\\])*'?") },
      { t: 'kw', r: re('@[\\w-]+') },
      { t: 'prop', r: re('[-\\w]+(?=\\s*:)') },
      { t: 'var', r: re('--[\\w-]+') },
      { t: 'fn', r: re('[\\w-]+(?=\\()') },
      { t: 'cls', r: re('\\.[A-Za-z_][\\w-]*') },
      { t: 'num', r: re('#[0-9a-fA-F]{3,8}\\b|\\d+(?:\\.\\d+)?(?:%|[a-zA-Z]{1,4})?') },
      { t: 'id', r: re('#[A-Za-z_][\\w-]*') },
      { t: 'tag', r: re('[a-zA-Z][\\w-]*(?=[\\s,{:.>\\[~+])') },
      { t: 'op', r: re('[~*^$|!>+]?=|:|[>+~*]') },
      { t: 'pun', r: re('[{}()\\[\\];,.]') },
      { t: 'plain', r: re('[ \\t]+') },
      { t: 'plain', r: re('\\n') },
      { t: 'plain', r: re('[^\\s]') }
    ],

    md: [
      { t: 'code', r: re('```[\\s\\S]*?(?:```|$)') },
      { t: 'hd', r: re('^#{1,6}[^\\n]*', 'm') },
      { t: 'quote', r: re('^\\s*>[^\\n]*', 'm') },
      { t: 'list', r: re('^\\s*(?:[-*+]|\\d+\\.)\\s', 'm') },
      { t: 'hr', r: re('^(?:\\s*[-*_]){3,}[^\\n]*$', 'm') },
      { t: 'code', r: re('`[^`\\n]*`?') },
      { t: 'bold', r: re('(\\*\\*|__)(?!\\s)[^\\n]*?\\1') },
      { t: 'em', r: re('\\*[^*\\n]+\\*') },
      { t: 'link', r: re('!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)?') },
      { t: 'link', r: re('^\\s*\\[[^\\]\\n]+\\]:\\s*\\S+', 'm') },
      { t: 'plain', r: re('[^*`#>\\[!\\n]+') },
      { t: 'plain', r: re('\\n') },
      { t: 'plain', r: re('[^\\s]') }
    ]
  };

  const ALIAS = {
    luau: 'lua', txt: 'plain', text: 'plain', log: 'plain', htm: 'html',
    xhtml: 'html', vue: 'html', svg: 'xml', plist: 'xml', rss: 'xml',
    jsonc: 'json', json5: 'json', jsx: 'js', mjs: 'js', cjs: 'js',
    tsx: 'ts', mts: 'ts', cts: 'ts', markdown: 'md', scss: 'css',
    sass: 'css', less: 'css', ini: 'yaml', toml: 'yaml', env: 'yaml',
    cfg: 'yaml', conf: 'yaml', properties: 'yaml', py: 'py', sh: 'sh', bash: 'sh'
  };

  const EXT_LANG = {
    lua: 'lua', luau: 'lua', js: 'js', mjs: 'js', cjs: 'js', jsx: 'js',
    ts: 'ts', tsx: 'ts', json: 'json', jsonc: 'json', html: 'html', htm: 'html',
    css: 'css', scss: 'css', less: 'css', xml: 'xml', svg: 'xml', md: 'md',
    markdown: 'md', txt: 'plain', text: 'plain', log: 'plain', yml: 'yaml',
    yaml: 'yaml', toml: 'yaml', ini: 'yaml', py: 'py', sh: 'sh'
  };

  const LANG_LABEL = {
    plain: 'Plain text', lua: 'Lua', js: 'JavaScript', ts: 'TypeScript',
    json: 'JSON', html: 'HTML', css: 'CSS', xml: 'XML', md: 'Markdown',
    py: 'Python', sh: 'Shell', yaml: 'YAML'
  };

  const LANGS = Object.keys(GRAMMARS).map((k) => ({ id: k, label: LANG_LABEL[k] || k }));

  function normalizeLang(lang) {
    if (!lang) return 'plain';
    const l = String(lang).toLowerCase();
    if (GRAMMARS[l]) return l;
    if (ALIAS[l]) return ALIAS[l];
    if (EXT_LANG[l]) return EXT_LANG[l];
    return 'plain';
  }

  function extToLang(ext) {
    if (!ext) return null;
    const e = String(ext).toLowerCase().replace(/^[.*\s]+/, '').trim();
    return EXT_LANG[e] || ALIAS[e] || null;
  }

  /* ── content sniffing ──────────────────────────────────────────── */
  function sniffLang(text) {
    if (typeof text !== 'string') return null;
    const head = text.slice(0, 4096);
    const trimmed = text.trim();
    if (trimmed.length === 0) return 'plain';
    if (trimmed.charCodeAt(0) === 0xfeff) return sniffLang(trimmed.slice(1));

    if (trimmed[0] === '{' || trimmed[0] === '[') {
      try { JSON.parse(trimmed); return 'json'; } catch (_) { /* not strict JSON */ }
    }
    if (/^<\?xml[\s?]/i.test(trimmed)) return 'xml';
    if (/^<!doctype\s+html/i.test(trimmed)) return 'html';
    if (/^<svg[\s>]/i.test(trimmed)) return 'xml';
    if (/^<(html|head|body|div|section|main|article|p|span|script|style|nav|footer|header)\b/i.test(trimmed)) return 'html';
    if (/^<\?php\b/i.test(trimmed)) return 'html';
    if (/^#!\/[^\n]*\b(?:bash|sh|zsh|fish)\b/.test(trimmed)) return 'sh';
    if (/^#!\/[^\n]*\bpython[0-9.]*\b/.test(trimmed)) return 'py';

    const luaish =
      /\blocal\s+[A-Za-z_][\w]*\s*=/.test(head) ||
      /\bfunction\s*[\w.:]*\s*\([^)]*\)/.test(head) ||
      /\bend\s*\)?\s*$/m.test(head) ||
      /\brequire\s*\(\s*['"]/.test(head) ||
      /\bgame:GetService\s*\(/.test(head);
    if (luaish && !/[<>;{}]\s*\n/.test(head)) return 'lua';

    if (/^(---|\.\.\.)\s*$/m.test(head) && /^\s*[\w.-]+\s*:\s/m.test(head)) return 'yaml';
    if (/^```|^\s{0,3}#{1,6}\s|^\s*[-*+]\s+\S/.test(head)) return 'md';
    if (/^[.#@&*:>~]|\{\s*$|\}\s*$/m.test(head) && /[{;]\s*$/m.test(head)) return 'css';
    return 'plain';
  }

  /* ── tokenizer ─────────────────────────────────────────────────── */
  function highlight(code, lang, limit) {
    const src = code == null ? '' : String(code);
    const MAX = limit == null ? 300000 : limit;
    if (src.length === 0) return '';
    if (src.length > MAX) return esc(src.slice(0, MAX)) + '<span class="tk-com">… highlighting paused above 300 000 characters …</span>';

    const rules = GRAMMARS[normalizeLang(lang)] || GRAMMARS.plain;
    const out = [];
    let i = 0;
    let plainBuf = '';
    const n = src.length;

    const flushPlain = () => {
      if (plainBuf) { out.push(esc(plainBuf)); plainBuf = ''; }
    };

    outer: while (i < n) {
      for (let k = 0; k < rules.length; k++) {
        const rule = rules[k];
        rule.r.lastIndex = i;
        const m = rule.r.exec(src);
        if (m && m[0].length > 0) {
          if (rule.t === 'plain') plainBuf += m[0];
          else {
            flushPlain();
            out.push('<span class="tk-' + rule.t + '">' + esc(m[0]) + '</span>');
          }
          i += m[0].length;
          continue outer;
        }
      }
      // Safety: nothing matched at this position — never loop forever.
      plainBuf += src[i];
      i += 1;
    }
    flushPlain();
    return out.join('');
  }

  return { highlight, esc, LANGS, LANG_LABEL, EXT_LANG, ALIAS, normalizeLang, extToLang, sniffLang, GRAMMARS };
});
