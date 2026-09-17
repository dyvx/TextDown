/* ═══════════════════════════════════════════════════════════════════════
   TextDown — app.js
   Fetch · edit · save. No frameworks, no build step, no accounts.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const S = window.TextDownSyntax;

  /* ═══ constants ══════════════════════════════════════════════════ */
  const MAX_BYTES = 8 * 1024 * 1024;      // hard ceiling we will buffer
  const SOFT_BYTES = 1.5 * 1024 * 1024;   // warn above this
  const HL_LIMIT = 300000;                // characters we bother colouring
  const GUTTER_CAP = 5000;                // line numbers we render
  const STORE_KEY = 'textdown.settings.v1';

  const EXTENSIONS = ['.txt', '.lua', '.luau', '.js', '.ts', '.json', '.html', '.css', '.xml', '.md'];

  /* Public relays, tried only when the browser cannot read the origin
     directly and the user has left "Public CORS fallback" switched on. */
  const PROXY_LIST = [
    { name: 'corsproxy.io', build: (u) => 'https://corsproxy.io/?' + encodeURIComponent(u) },
    { name: 'allorigins', build: (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
    { name: 'r.jina.ai', build: (u) => 'https://r.jina.ai/' + u }
  ];

  /* ═══ tiny helpers ═══════════════════════════════════════════════ */
  const $ = (id) => document.getElementById(id);
  const els = {};
  const IDS = [
    'netPill', 'netPillText', 'themeBtn', 'fetchForm', 'urlInput', 'recentUrls', 'fetchBtn',
    'uploadBtn', 'fileInput', 'useProxy', 'timeoutSel', 'errorPanel', 'errTitle', 'errMsg',
    'errExplain', 'errRoutes', 'errRouteCount', 'errActions', 'errClose', 'editorHint',
    'langSelect', 'wrapBtn', 'copyBtn', 'clearBtn', 'editor', 'gutter', 'editorScroll',
    'hl', 'ta', 'editorOverlay', 'statChars', 'statLines', 'statBytes', 'statSel', 'statEnc',
    'srcBar', 'srcStatus', 'srcType', 'srcSize', 'srcRoute', 'srcTime', 'asIsBtn', 'srcLink',
    'autoBtn', 'nameInput', 'extSelect', 'customExtField', 'customExtInput', 'presets',
    'filePreview', 'eolSel', 'encSel', 'dlModeSel', 'downloadBtn', 'saveHint', 'toasts',
    'loading', 'loadTitle', 'loadSub', 'dropzone'
  ];
  IDS.forEach((id) => { els[id] = $(id); });
  els.pre = document.querySelector('.editor-pre');

  const enc = new TextEncoder();

  const fmtBytes = (n) => {
    if (!Number.isFinite(n) || n < 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  };
  const fmtMs = (ms) => (ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s');
  const encLabel = (v) => (v === 'utf8bom' ? 'UTF-8 BOM' : v === 'utf16le' ? 'UTF-16LE' : 'UTF-8');

  /* ═══ persistent settings ════════════════════════════════════════ */
  const DEFAULTS = {
    theme: null, name: 'download', ext: '.txt', eol: 'lf', encoding: 'utf8',
    saveMode: 'auto', wrap: false, useProxy: true, timeout: 25, recent: []
  };
  let settings = Object.assign({}, DEFAULTS);
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) settings = Object.assign(settings, JSON.parse(raw) || {});
  } catch (_) { /* private mode / storage disabled — defaults it is */ }

  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) {}
    }, 200);
  }

  /* ═══ runtime state ══════════════════════════════════════════════ */
  const state = {
    original: '',   // exactly what arrived from the network or the local file
    meta: null,     // { status, contentType, finalUrl, route, ms, bytes, suggested, origin }
    lang: 'plain',
    dirty: false,
    busy: false,
    server: null    // null | {ok:true, mode:'proxy'} | {ok:false, mode:'static'|'file'}
  };

  /* ═══ theme ══════════════════════════════════════════════════════ */
  function systemTheme() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'light' ? '#eef1f9' : '#06080f');
  }
  applyTheme(settings.theme || systemTheme());
  els.themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    settings.theme = next;
    applyTheme(next);
    persist();
  });

  /* ═══ toasts ═════════════════════════════════════════════════════ */
  const ICONS = {
    ok: '<path d="m4.5 12.5 4.8 4.8L19.5 7"/>',
    err: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v6"/><circle cx="12" cy="17" r="1" fill="currentColor" stroke="none"/>',
    warn: '<path d="M10.3 3.9 2.6 17.4a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 8.5v5"/><circle cx="12" cy="16.8" r="1" fill="currentColor" stroke="none"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle cx="12" cy="7.8" r="1" fill="currentColor" stroke="none"/>'
  };
  function toast(message, opts) {
    const o = opts || {};
    const type = o.type || 'ok';
    const node = document.createElement('div');
    node.className = 'toast ' + type;
    node.setAttribute('role', type === 'err' ? 'alert' : 'status');
    node.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      (ICONS[type] || ICONS.info) + '</svg><div><span></span>' + (o.detail ? '<small></small>' : '') + '</div>';
    node.querySelector('span').textContent = message;
    if (o.detail) node.querySelector('small').textContent = o.detail;
    els.toasts.appendChild(node);
    setTimeout(() => {
      node.classList.add('out');
      setTimeout(() => node.remove(), 320);
    }, o.duration || (type === 'err' ? 6500 : 3600));
    while (els.toasts.children.length > 3) els.toasts.firstChild.remove();
  }

  /* ═══ loading overlay ════════════════════════════════════════════ */
  function showLoading(title, sub) {
    els.loadTitle.textContent = title || 'Fetching…';
    els.loadSub.textContent = sub || '';
    els.loading.hidden = false;
    els.fetchBtn.classList.add('is-loading');
  }
  function setLoadSub(sub) { els.loadSub.textContent = sub; }
  function hideLoading() {
    els.loading.hidden = true;
    els.fetchBtn.classList.remove('is-loading');
  }

  /* ═══ error panel ════════════════════════════════════════════════ */
  function hideError() { els.errorPanel.hidden = true; }
  els.errClose.addEventListener('click', hideError);

  function showError(e) {
    els.errTitle.textContent = e.title || 'Something went wrong';
    els.errMsg.textContent = e.message || '';
    els.errExplain.hidden = !e.explain;
    if (e.explain) els.errExplain.textContent = e.explain;

    els.errRoutes.innerHTML = '';
    const routes = e.routes || [];
    els.errRouteCount.textContent = routes.length ? '(' + routes.length + ')' : '';
    routes.forEach((r) => {
      const li = document.createElement('li');
      const b = document.createElement('b'); b.textContent = r.label;
      const via = document.createElement('span'); via.className = 'via'; via.textContent = r.via || '';
      const why = document.createElement('span'); why.className = 'why'; why.textContent = r.why || r.result || '';
      li.append(b, via, why);
      els.errRoutes.appendChild(li);
    });

    els.errActions.innerHTML = '';
    (e.actions || []).forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-xs ' + (a.primary ? 'btn-primary' : 'btn-ghost');
      btn.textContent = a.label;
      btn.addEventListener('click', a.onClick);
      els.errActions.appendChild(btn);
    });

    els.errorPanel.hidden = false;
    if (typeof els.errorPanel.scrollIntoView === 'function') {
      els.errorPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  /* ═══ editor ═════════════════════════════════════════════════════ */
  S.LANGS.forEach((l) => {
    const o = document.createElement('option');
    o.value = l.id; o.textContent = l.label;
    els.langSelect.appendChild(o);
  });

  let hlTimer = null;
  function renderHighlight() {
    els.hl.innerHTML = S.highlight(els.ta.value, state.lang, HL_LIMIT);
    requestAnimationFrame(sizeEditor);
  }
  function scheduleHighlight() {
    clearTimeout(hlTimer);
    hlTimer = setTimeout(renderHighlight, 90);
  }

  let gutterLines = -1;
  function renderGutter(count) {
    const inner = els.gutter.firstElementChild;
    if (count === gutterLines) { markCurrentLine(); return; }
    gutterLines = count;
    const shown = Math.min(count, GUTTER_CAP);
    let html = '';
    for (let i = 1; i <= shown; i++) html += '<span>' + i + '</span>';
    inner.innerHTML = html;
    markCurrentLine();
  }

  function markCurrentLine() {
    const inner = els.gutter.firstElementChild;
    if (!inner.children.length) return;
    const line = els.ta.value.slice(0, els.ta.selectionStart).split('\n').length;
    const prev = inner.querySelector('.cur');
    if (prev) prev.classList.remove('cur');
    const cur = inner.children[line - 1];
    if (cur) cur.classList.add('cur');
  }

  let statsTimer = null;
  function updateStats() {
    const delay = els.ta.value.length > 60000 ? 180 : 0;
    clearTimeout(statsTimer);
    statsTimer = setTimeout(paintStats, delay);
  }
  function paintStats() {
    const v = els.ta.value;
    const lines = v === '' ? 1 : v.split('\n').length;
    const bytes = enc.encode(v).length;
    els.statChars.textContent = v.length.toLocaleString() + ' chars';
    els.statLines.textContent = lines.toLocaleString() + (lines === 1 ? ' line' : ' lines');
    els.statBytes.textContent = fmtBytes(bytes);
    const s = els.ta.selectionStart;
    const e = els.ta.selectionEnd;
    els.statSel.textContent = e > s ? (e - s).toLocaleString() + ' selected' : 'no selection';
    renderGutter(lines);
  }

  function sizeEditor() {
    if (!els.pre) return;
    const h = Math.max(els.pre.scrollHeight, els.editorScroll.clientHeight);
    els.ta.style.height = h + 'px';
  }

  function syncEditor() {
    scheduleHighlight();
    updateStats();
    requestAnimationFrame(sizeEditor);
  }

  function setContent(text, silent) {
    els.ta.value = text == null ? '' : String(text);
    document.body.classList.toggle('has-content', els.ta.value.length > 0);
    if (silent) { renderHighlight(); paintStats(); requestAnimationFrame(sizeEditor); }
    else syncEditor();
  }

  els.ta.addEventListener('input', () => {
    state.dirty = true;
    document.body.classList.toggle('has-content', els.ta.value.length > 0);
    syncEditor();
  });
  els.editorScroll.addEventListener('scroll', () => { els.gutter.scrollTop = els.editorScroll.scrollTop; });
  els.ta.addEventListener('select', updateStats);
  els.ta.addEventListener('click', markCurrentLine);
  els.ta.addEventListener('keyup', (e) => {
    if (e.key.indexOf('Arrow') === 0 || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') markCurrentLine();
  });
  els.ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      els.ta.setRangeText('  ', els.ta.selectionStart, els.ta.selectionEnd, 'end');
      state.dirty = true;
      syncEditor();
    }
  });
  window.addEventListener('resize', () => requestAnimationFrame(sizeEditor));

  els.langSelect.addEventListener('change', () => {
    state.lang = els.langSelect.value;
    renderHighlight();
  });

  function setWrap(on) {
    settings.wrap = !!on;
    document.body.classList.toggle('wrap-on', settings.wrap);
    els.ta.setAttribute('wrap', settings.wrap ? 'soft' : 'off');
    els.wrapBtn.setAttribute('aria-pressed', settings.wrap ? 'true' : 'false');
    persist();
    requestAnimationFrame(sizeEditor);
  }
  els.wrapBtn.addEventListener('click', () => setWrap(!settings.wrap));

  /* ═══ filename + extension ═══════════════════════════════════════ */
  function sanitizeName(v) {
    const s = String(v == null ? '' : v)
      .replace(/[\u0000-\u001f<>:"/\\|?*]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 80);
    return s || 'download';
  }

  function sanitizeExt(v) {
    const s = String(v == null ? '' : v).trim().toLowerCase().replace(/^\.+/, '').replace(/[^a-z0-9_+-]/g, '').slice(0, 11);
    return s ? '.' + s : null;
  }

  function currentExt() {
    if (els.extSelect.value === '__custom__') return sanitizeExt(els.customExtInput.value) || '.txt';
    return els.extSelect.value || '.txt';
  }

  function setExt(ext) {
    const e = sanitizeExt(ext) || '.txt';
    if (EXTENSIONS.indexOf(e) !== -1) {
      els.extSelect.value = e;
      els.customExtField.hidden = true;
    } else {
      els.extSelect.value = '__custom__';
      els.customExtField.hidden = false;
      els.customExtInput.value = e.slice(1);
    }
    settings.ext = e;
    syncPresets();
    updatePreview();
    persist();
  }

  function buildFilename() { return sanitizeName(els.nameInput.value) + currentExt(); }
  function updatePreview() { els.filePreview.textContent = buildFilename(); }

  EXTENSIONS.forEach((e) => {
    const o = document.createElement('option');
    o.value = e; o.textContent = e;
    els.extSelect.appendChild(o);
  });
  const customOpt = document.createElement('option');
  customOpt.value = '__custom__';
  customOpt.textContent = 'custom…';
  els.extSelect.appendChild(customOpt);

  EXTENSIONS.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.textContent = e; b.dataset.ext = e;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => { setExt(e); els.nameInput.focus(); });
    els.presets.appendChild(b);
  });

  function syncPresets() {
    const active = currentExt();
    Array.prototype.forEach.call(els.presets.children, (c) => {
      c.setAttribute('aria-pressed', c.dataset.ext === active ? 'true' : 'false');
    });
  }

  els.extSelect.addEventListener('change', () => {
    els.customExtField.hidden = els.extSelect.value !== '__custom__';
    if (els.extSelect.value === '__custom__') { els.customExtInput.focus(); els.customExtInput.select(); }
    settings.ext = currentExt();
    syncPresets(); updatePreview(); persist();
  });
  els.customExtInput.addEventListener('input', () => { settings.ext = currentExt(); syncPresets(); updatePreview(); persist(); });
  els.nameInput.addEventListener('input', () => { settings.name = sanitizeName(els.nameInput.value); updatePreview(); persist(); });

  /* ═══ source info bar ════════════════════════════════════════════ */
  function renderSourceBar() {
    const m = state.meta;
    if (!m) { els.srcBar.hidden = true; return; }
    els.srcBar.hidden = false;
    const dot = els.srcStatus.querySelector('.dot');
    dot.className = 'dot ' + (m.status >= 200 && m.status < 300 ? 'dot-ok' : m.status ? 'dot-err' : 'dot-warn');
    els.srcStatus.lastElementChild.textContent = m.origin === 'file' ? 'local file' : (m.status ? 'HTTP ' + m.status : 'loaded');
    els.srcType.textContent = m.contentType ? m.contentType.split(';')[0] : (m.origin === 'file' ? (m.mime || 'text') : 'unknown type');
    els.srcSize.textContent = fmtBytes(m.bytes) + (m.truncated ? ' (truncated)' : '');
    els.srcRoute.textContent = m.route || '';
    els.srcTime.textContent = m.ms != null ? fmtMs(m.ms) : '';
    els.srcLink.href = m.finalUrl || '#';
    els.srcLink.style.display = m.finalUrl ? '' : 'none';
  }

  /* ═══ auto-detect name + extension ═══════════════════════════════ */
  function detectFromUrl(rawUrl) {
    if (!rawUrl) return { name: null, ext: null };
    let u;
    try { u = new URL(rawUrl, location.href); } catch (_) { return { name: null, ext: null }; }
    let base = '';
    ['filename', 'file', 'name', 'path', 'f'].forEach((k) => {
      if (base) return;
      const v = u.searchParams.get(k);
      if (v && v.indexOf('.') !== -1) base = v.split('/').pop();
    });
    if (!base) {
      const last = u.pathname.split('/').filter(Boolean).pop() || '';
      try { base = decodeURIComponent(last); } catch (_) { base = last; }
    }
    if (!base) return { name: null, ext: null };
    const dot = base.lastIndexOf('.');
    if (dot > 0 && dot < base.length - 1) return { name: base.slice(0, dot), ext: base.slice(dot) };
    return { name: base, ext: null };
  }

  const SNIFF_EXT = { lua: '.lua', js: '.js', ts: '.ts', json: '.json', html: '.html', css: '.css', xml: '.xml', md: '.md', py: '.py', sh: '.sh', yaml: '.yml' };

  function autoDetect(opts) {
    const o = opts || {};
    const url = (state.meta && state.meta.finalUrl) || els.urlInput.value.trim();
    const guess = detectFromUrl(url);
    let ext = guess.ext ? sanitizeExt(guess.ext) : null;
    let langHint = ext ? S.extToLang(ext.slice(1)) : null;

    if (!ext) {
      const sniffed = S.sniffLang(els.ta.value || state.original || '');
      ext = SNIFF_EXT[sniffed] || null;
      if (ext) langHint = sniffed;
    }
    if (!ext) ext = '.txt';
    if (guess.name) els.nameInput.value = sanitizeName(guess.name);

    setExt(ext);
    setLang(langHint || S.sniffLang(els.ta.value) || 'plain');
    updatePreview();
    if (!o.silent) {
      toast('Detected ' + buildFilename(), { type: 'info', detail: currentExt() + ' · ' + (S.LANG_LABEL[state.lang] || state.lang) });
    }
    return buildFilename();
  }
  els.autoBtn.addEventListener('click', () => autoDetect());

  function setLang(lang) {
    state.lang = S.normalizeLang(lang);
    els.langSelect.value = state.lang;
    renderHighlight();
  }

  /* ═══ download ═══════════════════════════════════════════════════ */
  function applyEol(text, mode) {
    if (mode === 'keep') return text;
    const norm = text.replace(/\r\n?/g, '\n');
    return mode === 'crlf' ? norm.replace(/\n/g, '\r\n') : norm;
  }

  function encodeText(text, encoding) {
    if (encoding === 'utf16le') {
      const buf = new ArrayBuffer(2 + text.length * 2);
      const view = new DataView(buf);
      view.setUint16(0, 0xfeff, true);
      for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
      return new Blob([buf], { type: 'text/plain;charset=utf-16le' });
    }
    const bytes = enc.encode(text);
    if (encoding === 'utf8bom') {
      return new Blob([new Uint8Array([0xef, 0xbb, 0xbf]), bytes], { type: 'text/plain;charset=utf-8' });
    }
    return new Blob([bytes], { type: 'text/plain;charset=utf-8' });
  }

  async function saveBlob(blob, filename) {
    const mode = els.dlModeSel.value;
    const canFSA = typeof window.showSaveFilePicker === 'function';
    if (canFSA && (mode === 'dialog' || mode === 'auto')) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'Text file', accept: { 'text/plain': [currentExt()] } }]
        });
        const w = await handle.createWritable();
        await w.write(blob);
        await w.close();
        return 'dialog';
      } catch (err) {
        if (err && err.name === 'AbortError') return 'aborted';
        if (mode === 'dialog') toast('Save dialog unavailable — used a direct download instead', { type: 'warn' });
      }
    } else if (mode === 'dialog') {
      toast('This browser has no “Save As…” API — used a direct download', { type: 'warn' });
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
    return 'blob';
  }

  async function doDownload(useOriginal) {
    const raw = useOriginal ? state.original : els.ta.value;
    if (!raw) {
      toast('Nothing to download yet', { type: 'warn', detail: 'Fetch a URL, upload a file, or type something first.' });
      return;
    }
    const filename = useOriginal && state.meta && state.meta.suggested ? state.meta.suggested : buildFilename();
    const text = useOriginal ? raw : applyEol(raw, els.eolSel.value);
    const blob = encodeText(text, els.encSel.value);
    const how = await saveBlob(blob, filename);
    if (how === 'aborted') return;
    toast('Downloaded ' + filename, {
      type: 'ok',
      detail: fmtBytes(blob.size) + (how === 'dialog' ? ' · saved via Save As…' : ' · saved to your downloads')
    });
  }

  els.downloadBtn.addEventListener('click', () => doDownload(false));
  els.asIsBtn.addEventListener('click', () => doDownload(true));

  els.eolSel.addEventListener('change', () => { settings.eol = els.eolSel.value; persist(); });
  els.encSel.addEventListener('change', () => {
    settings.encoding = els.encSel.value;
    els.statEnc.textContent = encLabel(els.encSel.value);
    persist();
  });
  els.dlModeSel.addEventListener('change', () => { settings.saveMode = els.dlModeSel.value; persist(); });

  /* ═══ copy + reset ═══════════════════════════════════════════════ */
  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => reject(fr.error || new Error('read failed'));
      fr.readAsText(file);
    });
  }

  async function copyContent() {
    const text = els.ta.value;
    if (!text) { toast('Nothing to copy', { type: 'warn' }); return; }
    try {
      if (!navigator.clipboard) throw new Error('no clipboard api');
      await navigator.clipboard.writeText(text);
      toast('Copied ' + text.length.toLocaleString() + ' characters', { type: 'ok' });
    } catch (_) {
      try {
        els.ta.focus();
        els.ta.select();
        document.execCommand('copy');
        toast('Copied to clipboard', { type: 'ok' });
      } catch (__) {
        toast('Clipboard blocked by the browser', { type: 'err', detail: 'Select the text and press Ctrl/⌘+C.' });
      }
    }
  }
  els.copyBtn.addEventListener('click', copyContent);

  els.clearBtn.addEventListener('click', () => {
    if (!els.ta.value && !els.urlInput.value) { toast('Already empty', { type: 'info' }); return; }
    setContent('');
    state.original = '';
    state.meta = null;
    state.lang = 'plain';
    state.dirty = false;
    els.urlInput.value = '';
    els.langSelect.value = 'plain';
    els.editorHint.textContent = 'Nothing loaded yet — fetch a URL, upload a file, or just start typing.';
    renderSourceBar();
    hideError();
    els.urlInput.focus();
    toast('Cleared', { type: 'info' });
  });

  /* ═══ fetching ═══════════════════════════════════════════════════ */
  function validateUrl(input) {
    const raw = String(input || '').trim();
    if (!raw) return { ok: false, title: 'Enter a URL', message: 'Paste the address of a text or code file to continue.' };
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
      const guess = 'https://' + raw.replace(/^\/+/, '');
      return { ok: false, title: 'That does not look like a URL', message: '“' + raw.slice(0, 120) + '” has no scheme.', suggest: guess };
    }
    let u;
    try { u = new URL(raw); } catch (_) {
      return { ok: false, title: 'Invalid URL', message: 'The browser could not parse “' + raw.slice(0, 120) + '”.' };
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, title: 'Unsupported protocol', message: u.protocol + ' links cannot be fetched from a web page — only http: and https: are allowed.' };
    }
    if (!u.hostname || u.hostname.indexOf('.') === -1) {
      return { ok: false, title: 'Unknown host', message: '“' + u.hostname + '” is not a public hostname.' };
    }
    return { ok: true, url: u };
  }

  function looksBinary(text) {
    const sample = text.slice(0, 2048);
    if (!sample.length) return false;
    let bad = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      if (c === 0) return true;
      if (c < 9 || (c > 13 && c < 32) || c === 127) bad++;
    }
    return bad / sample.length > 0.06;
  }

  function isBinaryMime(ct) {
    if (!ct) return false;
    const t = ct.split(';')[0].trim().toLowerCase();
    if (t.indexOf('text/') === 0) return false;
    if (/(json|xml|javascript|ecmascript|yaml|sql|graphql|toml|csv|html|x-sh|perl|python|rtf|x-empty)/.test(t)) return false;
    return /^(image|audio|video|font)\//.test(t) ||
      /(octet-stream|zip|pdf|gzip|x-tar|x-7z|x-rar|x-executable|x-msdownload|wasm|protobuf|x-font)/.test(t);
  }

  function corsExplain(host) {
    return 'The server at ' + host + ' did not return an Access-Control-Allow-Origin header for this page, so the browser refuses to hand the response body to the script. ' +
      'That is a browser security rule, not a broken link — the file may open fine in a new tab. ' +
      'Ways around it: leave “Public CORS fallback” on so the request is relayed; run the bundled same-origin proxy (node server.js) and reload; ask the site for a CORS header; or download the file and drop it onto this page.';
  }

  async function readCapped(res, cap) {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const parts = [];
      let bytes = 0;
      let truncated = false;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const v = chunk.value;
        bytes += v.byteLength;
        parts.push(v);
        setLoadSub(fmtBytes(bytes) + ' received');
        if (bytes > cap) {
          truncated = true;
          try { await reader.cancel(); } catch (_) {}
          break;
        }
      }
      const buf = new Uint8Array(bytes);
      let off = 0;
      parts.forEach((p) => { buf.set(p, off); off += p.byteLength; });
      let text = decoder.decode(buf);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return { bytes, text, truncated };
    }
    let text = await res.text();
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { bytes: enc.encode(text).length, text, truncated: false };
  }

  async function attempt(route, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(route.href, {
        method: 'GET',
        signal: ac.signal,
        mode: 'cors',
        redirect: 'follow',
        cache: 'no-store',
        headers: route.headers || {}
      });
    } catch (err) {
      clearTimeout(timer);
      const timedOut = !!(err && err.name === 'AbortError');
      return {
        ok: false,
        kind: timedOut ? 'timeout' : 'network',
        ms: performance.now() - t0,
        error: timedOut ? 'no response in time' : ((err && err.message) || 'blocked by the browser')
      };
    }
    clearTimeout(timer);
    if (!res.ok) {
      let detail = 'HTTP ' + res.status + ' ' + (res.statusText || '');
      try {
        const body = (await res.text()).trim().replace(/\s+/g, ' ').slice(0, 200);
        if (body) detail += ' — ' + body;
      } catch (_) {}
      return { ok: false, kind: 'http', status: res.status, ms: performance.now() - t0, error: detail };
    }
    const data = await readCapped(res, MAX_BYTES);
    return {
      ok: true,
      status: res.status,
      ms: performance.now() - t0,
      contentType: res.headers.get('content-type') || '',
      finalUrl: res.url || route.href,
      proxyFinalUrl: res.headers.get('x-final-url') || '',
      proxyType: res.headers.get('x-content-type') || '',
      bytes: data.bytes,
      text: data.text,
      truncated: data.truncated || res.headers.get('x-truncated') === '1'
    };
  }

  function buildRoutes(url, opts) {
    const routes = [];
    if (state.server && state.server.ok && state.server.mode === 'proxy') {
      routes.push({ label: 'Local proxy', via: '/api/fetch', href: '/api/fetch', headers: { 'x-target-url': url.href }, proxy: true });
    }
    routes.push({ label: 'Direct', via: url.hostname, href: url.href });
    if (opts.forceProxy || els.useProxy.checked) {
      PROXY_LIST.forEach((p) => routes.push({ label: 'Relay', via: p.name, href: p.build(url.href) }));
    }
    return routes;
  }

  async function doFetch(opts) {
    const o = opts || {};
    if (state.busy) return;
    hideError();

    const check = validateUrl(o.url != null ? o.url : els.urlInput.value);
    if (!check.ok) {
      const actions = [];
      if (check.suggest) {
        actions.push({
          label: 'Try ' + check.suggest,
          primary: true,
          onClick: () => { els.urlInput.value = check.suggest; doFetch({ url: check.suggest }); }
        });
      }
      showError({ title: check.title, message: check.message, actions });
      return;
    }

    const url = check.url;
    els.urlInput.value = url.href;
    const timeoutMs = (parseInt(els.timeoutSel.value, 10) || 25) * 1000;
    const routes = buildRoutes(url, o);
    const log = [];

    state.busy = true;
    showLoading('Fetching…', url.hostname);

    let result = null;
    let usedRoute = null;

    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      setLoadSub(r.label + ' → ' + r.via);
      // eslint-disable-next-line no-await-in-loop
      const res = await attempt(r, timeoutMs);
      const entry = { label: r.label, via: r.via, result: res.ok ? 'HTTP ' + res.status : res.kind, why: '' };

      if (res.ok) {
        const binary = isBinaryMime((r.proxy && res.proxyType) || res.contentType) || looksBinary(res.text);
        if (binary) {
          entry.why = 'response is not text';
          log.push(entry);
          if (i === routes.length - 1) {
            state.busy = false;
            hideLoading();
            showError({
              title: 'That response is not text',
              message: url.hostname + ' answered with ' + (((r.proxy && res.proxyType) || res.contentType || 'an unknown type').split(';')[0]) + ' · ' + fmtBytes(res.bytes) + '.',
              explain: 'TextDown refuses to pass binary bytes through a text editor, because they would be silently corrupted on save. Open the link in a new tab and save it with your browser, or point it at a raw text endpoint instead.',
              routes: log
            });
            toast('That response is not text', { type: 'err' });
            return;
          }
          continue;
        }
        if (res.bytes === 0 && res.text === '') {
          entry.why = 'empty body';
          log.push(entry);
          if (i === routes.length - 1) {
            state.busy = false;
            hideLoading();
            showError({
              title: 'The server sent an empty response',
              message: 'HTTP ' + res.status + ' with a 0-byte body from ' + url.hostname + '.',
              explain: 'Nothing was fetched, so there is nothing to show or save — TextDown never invents content. The endpoint may need query parameters or authentication, or it may simply be empty.',
              routes: log
            });
            return;
          }
          continue;
        }
        entry.why = res.truncated ? 'larger than 8 MB — truncated' : '';
        log.push(entry);
        result = res;
        usedRoute = r;
        break;
      }

      entry.why = res.error;
      log.push(entry);
    }

    state.busy = false;
    hideLoading();

    if (!result) {
      const anyHttp = log.find((l) => l.result === 'http');
      const anyTimeout = log.find((l) => l.result === 'timeout');
      const allNetwork = log.length > 0 && log.every((l) => l.result === 'network');

      let title = 'Could not fetch that URL';
      let message = 'Every route to ' + url.hostname + ' failed.';
      let explain = '';
      const actions = [];

      if (anyHttp) {
        title = 'The server returned an error';
        message = anyHttp.why || 'HTTP error';
        explain = 'The request reached the server, so this is not a CORS problem. Check the path, any token in the URL, and whether the resource needs authentication — a private GitHub gist, for example, needs its raw link.';
      } else if (anyTimeout) {
        title = 'The request timed out';
        message = 'No response within ' + (timeoutMs / 1000) + ' seconds.';
        explain = 'The host may be slow, blocking datacentre traffic, or rate-limiting relays. Raise the timeout and try again, or use a direct/raw link.';
      } else if (allNetwork) {
        title = 'The browser could not read the response';
        message = url.hostname + ' blocked the cross-origin request, or is unreachable from here.';
        explain = corsExplain(url.hostname);
        if (!o.forceProxy) {
          actions.push({ label: 'Retry with public relays', primary: true, onClick: () => doFetch({ url: url.href, forceProxy: true }) });
        }
        if (!(state.server && state.server.ok)) {
          actions.push({
            label: 'How to run the local proxy',
            onClick: () => showError({
              title: 'Same-origin proxy — fixes CORS for good',
              message: 'Run the bundled Node server in this folder. It fetches on your behalf, so the browser never has to ask for CORS headers.',
              explain: 'cd text-url-downloader && node server.js — then open the http://localhost:5173 address it prints. The pill in the header turns green once the proxy is detected, and every fetch is relayed through /api/fetch automatically. The server refuses private/internal addresses and caps responses at 8 MB.',
              routes: log
            })
          });
        }
      }
      if (!actions.length) actions.push({ label: 'Try again', primary: true, onClick: () => doFetch({ url: url.href }) });

      showError({ title, message, explain, routes: log, actions });
      toast(title, { type: 'err' });
      return;
    }

    applyResult(result, usedRoute, url);
  }

  function applyResult(res, route, url) {
    const finalUrl = (route.proxy && res.proxyFinalUrl) || res.finalUrl;
    const contentType = (route.proxy && res.proxyType) || res.contentType;
    const suggested = detectFromUrl(finalUrl || url.href);
    const suggestedName = suggested.name
      ? sanitizeName(suggested.name) + (suggested.ext ? (sanitizeExt(suggested.ext) || '') : '')
      : null;

    state.original = res.text;
    state.meta = {
      status: res.status,
      contentType,
      finalUrl,
      route: route.label + (route.label === 'Relay' ? ' · ' + route.via : ''),
      ms: res.ms,
      bytes: res.bytes,
      truncated: res.truncated,
      suggested: suggestedName
    };
    state.dirty = false;

    setContent(res.text);
    renderSourceBar();
    els.editorHint.textContent = res.truncated
      ? 'Loaded ' + fmtBytes(res.bytes) + ' — the response was bigger than 8 MB, so the editor holds the first 8 MB only.'
      : 'Loaded from ' + (url ? url.hostname : 'the source') + ' · edit freely, then save.';
    autoDetect({ silent: true });
    rememberUrl(url.href);
    hideError();

    if (res.truncated) {
      toast('Response truncated at 8 MB', { type: 'warn', detail: 'Only the first 8 MB is in the editor.' });
    } else if (res.bytes > SOFT_BYTES) {
      toast('Large file loaded', { type: 'info', detail: fmtBytes(res.bytes) + ' · colouring pauses above ' + Math.round(HL_LIMIT / 1000) + 'k chars' });
    } else {
      toast('Fetched ' + fmtBytes(res.bytes), {
        type: 'ok',
        detail: (res.status ? 'HTTP ' + res.status + ' · ' : '') + fmtMs(res.ms) + ' via ' + state.meta.route
      });
    }
  }

  function rememberUrl(href) {
    const list = (settings.recent || []).filter((u) => u !== href);
    list.unshift(href);
    settings.recent = list.slice(0, 8);
    persist();
    renderRecent();
  }

  function renderRecent() {
    els.recentUrls.innerHTML = '';
    (settings.recent || []).forEach((u) => {
      const o = document.createElement('option');
      o.value = u;
      els.recentUrls.appendChild(o);
    });
  }

  els.fetchForm.addEventListener('submit', (e) => { e.preventDefault(); doFetch(); });
  els.useProxy.addEventListener('change', () => { settings.useProxy = els.useProxy.checked; persist(); });
  els.timeoutSel.addEventListener('change', () => { settings.timeout = parseInt(els.timeoutSel.value, 10) || 25; persist(); });

  /* ═══ local files: upload + drag & drop ══════════════════════════ */
  async function openFiles(fileList) {
    const files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return;
    const file = files[0];
    if (files.length > 1) toast('Loaded the first of ' + files.length + ' files', { type: 'info' });
    if (file.size > MAX_BYTES) {
      toast('“' + file.name + '” is ' + fmtBytes(file.size) + ' — over the 8 MB limit', { type: 'err' });
      return;
    }
    let text;
    try {
      text = typeof file.text === 'function' ? await file.text() : await readAsText(file);
    } catch (err) {
      toast('Could not read that file', { type: 'err', detail: (err && err.message) || 'unknown read error' });
      return;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (looksBinary(text)) {
      toast('“' + file.name + '” does not look like text', { type: 'err', detail: 'Binary files are not supported.' });
      return;
    }

    const dot = file.name.lastIndexOf('.');
    const base = dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = dot > 0 ? sanitizeExt(file.name.slice(dot)) : null;
    const sniffed = S.sniffLang(text);

    state.original = text;
    state.meta = {
      status: 0, contentType: file.type || '', origin: 'file', mime: file.type || 'text/plain',
      finalUrl: '', route: 'local file', bytes: file.size, truncated: false, suggested: file.name
    };
    state.dirty = false;
    els.urlInput.value = '';
    setContent(text);
    renderSourceBar();
    els.nameInput.value = sanitizeName(base);
    setExt(ext || SNIFF_EXT[sniffed] || '.txt');
    setLang((ext && S.extToLang(ext.slice(1))) || sniffed || 'plain');
    els.editorHint.textContent = 'Loaded from ' + file.name + ' · ' + fmtBytes(file.size) +
      (files.length > 1 ? ' (first of ' + files.length + ')' : '');
    hideError();
    updatePreview();
    toast('Loaded ' + file.name, { type: 'ok', detail: fmtBytes(file.size) + ' · ' + (S.LANG_LABEL[state.lang] || 'Plain text') });
  }

  els.uploadBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => { openFiles(els.fileInput.files); els.fileInput.value = ''; });

  let dragDepth = 0;
  const hasFiles = (e) => !!(e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], (t) => t === 'Files'));
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) document.body.classList.remove('dragging');
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    openFiles(e.dataTransfer.files);
  });

  /* ═══ optional same-origin proxy probe ═══════════════════════════ */
  function setNetPill(kind, text, title) {
    els.netPill.querySelector('.dot').className = 'dot ' + (kind === 'ok' ? 'dot-ok' : kind === 'warn' ? 'dot-warn' : 'dot-idle');
    els.netPillText.textContent = text;
    if (title) els.netPill.title = title;
  }

  async function probeServer() {
    if (location.protocol === 'file:') {
      state.server = { ok: false, mode: 'file' };
      setNetPill('warn', 'Opened from disk', 'Running from a local file, so a same-origin proxy cannot be reached. Direct fetches and public relays still work.');
      return;
    }
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const info = await res.json().catch(() => ({}));
      state.server = { ok: true, mode: 'proxy', maxMB: info.maxMB || 8 };
      setNetPill('ok', 'Local proxy ready', 'Fetches are relayed through /api/fetch on this origin, so CORS never blocks you.');
    } catch (_) {
      state.server = { ok: false, mode: 'static' };
      setNetPill('warn', 'Static host', 'No same-origin proxy here. Fetches go direct, then through public relays if the origin blocks CORS.');
    }
  }

  /* ═══ keyboard shortcuts ═════════════════════════════════════════ */
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); doFetch(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copyContent(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); doDownload(false); }
    else if (e.altKey && e.key.toLowerCase() === 'z') { e.preventDefault(); setWrap(!settings.wrap); }
    else if (e.key === 'Escape' && !els.errorPanel.hidden) hideError();
  });

  /* ═══ boot ═══════════════════════════════════════════════════════ */
  function boot() {
    els.nameInput.value = sanitizeName(settings.name || 'download');
    setExt(EXTENSIONS.indexOf(settings.ext) !== -1 || (settings.ext && settings.ext !== '__custom__') ? settings.ext : '.txt');
    els.eolSel.value = settings.eol || 'lf';
    els.encSel.value = settings.encoding || 'utf8';
    els.dlModeSel.value = settings.saveMode || 'auto';
    els.useProxy.checked = settings.useProxy !== false;
    els.timeoutSel.value = String(settings.timeout || 25);
    els.statEnc.textContent = encLabel(settings.encoding || 'utf8');
    els.langSelect.value = 'plain';
    setWrap(!!settings.wrap);
    renderRecent();
    updatePreview();
    renderGutter(1);
    syncEditor();

    if (typeof window.showSaveFilePicker !== 'function') {
      els.saveHint.textContent = 'Your browser saves straight to the downloads folder — the content never leaves this page.';
    }
    probeServer();
  }

  /* small debug surface, handy from the console */
  window.TextDown = {
    state, settings, doFetch, doDownload, openFiles, validateUrl, detectFromUrl,
    buildFilename, sanitizeName, sanitizeExt, currentExt, looksBinary, isBinaryMime,
    applyEol, encodeText, autoDetect, EXTENSIONS, PROXY_LIST, MAX_BYTES
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
