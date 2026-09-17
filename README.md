# TextDown — Text & Code URL Downloader

Paste any URL that returns text or code → fetch it → edit it in a syntax-highlighted
editor → download it with the exact filename and extension you choose.
No account, no upload, no server storage. Everything is written by the browser.

## Run it locally

**Option A — zero setup.** Open `index.html` directly (double-click, or
`file://…/text-url-downloader/index.html`). Fetching works, and CORS-blocked
origins fall back to a public relay.

**Option B — recommended.** Run the bundled same-origin proxy so CORS never applies:

```bash
cd text-url-downloader
node server.js            # → http://localhost:5173
```

The pill in the header turns green ("Local proxy ready") once the app detects
`/api/health`, and every fetch is relayed through `/api/fetch` automatically.

```
PORT=8080 node server.js        # custom port
MAX_BYTES=16777216 node server.js   # raise the 8 MB response cap
ALLOW_PRIVATE=1 node server.js  # permit LAN/localhost targets (dev only)
```

Node 18+ for the dev server. The front end has no dependencies and no build step.

## Deploy to Vercel

The repo is deploy-ready. Static files sit at the root and `api/*.js` become
serverless functions, so `/api/health` and `/api/fetch` keep working in production
and the header pill still reads "Local proxy ready".

**Dashboard:** [vercel.com/new](https://vercel.com/new) → import this repository →
Framework preset **Other** → Deploy. No build command, no output directory, no
environment variables required.

**CLI:**

```bash
npm i -g vercel
vercel            # preview deployment
vercel --prod     # production
```

`vercel.json` pins `maxDuration: 30` for the proxy function and adds
`nosniff` / referrer / frame security headers.

### Differences between the two runtimes

| | `server.js` (local) | `api/fetch.js` (Vercel) |
| --- | --- | --- |
| Body | streamed to the client | buffered, capped at **4 MiB** to stay under Vercel's 4.5 MB response limit |
| Cap override | `MAX_BYTES` env | `MAX_BYTES` env |
| Private/loopback targets | blocked (opt in with `ALLOW_PRIVATE=1`) | blocked; `ALLOW_PRIVATE` is never set in production |
| Shared rules | `proxy-core.js` — SSRF guard, redirect re-validation, body capping | same module |

## Workflow

1. Paste a text/code URL and hit **Fetch** (or ⌘/Ctrl+Enter).
2. The response lands in the editor with line numbers and highlighting.
3. Edit freely — or leave it untouched.
4. Set **File name** + **Extension** (ten presets, or `custom…`).
5. **Download File** writes `name + extension` locally.

## Features

| Area | Details |
| --- | --- |
| Editor | line numbers, current-line highlight, hand-written tokenizers (Lua/Luau, JS, TS, JSON, HTML, CSS, XML, Markdown, Python, Shell, YAML), word wrap (Alt+Z), Tab inserts spaces |
| Input | URL fetch, file picker, drag & drop anywhere on the page, or just type |
| Save | filename + extension combine automatically, custom extension, LF/CRLF/keep, UTF-8 / UTF-8 BOM / UTF-16LE, "Save As…" via the File System Access API where available, **Download original** for untouched bytes |
| Detection | filename/extension from the URL path or `?filename=`, content sniffing when the URL has no extension, language picked to match |
| Feedback | live char/line/byte/selection counts, HTTP status, content type, size, route used, elapsed time, copy, clear/reset, toasts, error panel with a per-route attempt log |
| Preferences | theme, filename, extension, EOL, encoding, save mode, wrap, timeout and recent URLs persist in `localStorage` |

Shortcuts: `⌘/Ctrl+Enter` fetch · `⌘/Ctrl+S` download · `⌘/Ctrl+Shift+C` copy ·
`Alt+Z` wrap · `Esc` dismiss the error panel.

## How CORS is handled

Browsers refuse to hand a cross-origin response body to a script unless the origin
sends `Access-Control-Allow-Origin`. TextDown never pretends that worked:

1. **Same-origin proxy** — if `/api/health` answers (local server *or* Vercel),
   requests go to `/api/fetch`, so no CORS is involved at all.
2. **Direct fetch** — tried next; works whenever the origin allows it.
3. **Public relays** — `corsproxy.io`, `allorigins`, `r.jina.ai`, only when
   "Public CORS fallback" is on (or via *Retry with public relays*).

If every route fails, the error panel states which kind of failure it was
(CORS block, HTTP status, timeout), lists each attempt, explains the cause and
offers the next step. Content is **never** faked: binary payloads and empty bodies
are refused with an explanation instead of being shown as blank success.

> The public relays are third-party services — anything routed through them is
> visible to those operators. Prefer the same-origin proxy for private content.

## Safety and limits

* `http:`/`https:` only — `file:`, `javascript:`, `data:` and friends are rejected before any request.
* 8 MB cap locally / 4 MiB on Vercel, enforced while reading the stream.
* Highlighting pauses above 300 000 characters so huge files stay editable.
* The proxy resolves each hostname and refuses private/loopback/link-local/multicast/CGNAT
  addresses (including the `169.254.169.254` cloud metadata IP), re-checks every
  redirect hop (max 3), and caps the response.
* Static file serving is confined to this folder; traversal attempts get a 403.
* Filenames and extensions are sanitised; HTML is escaped before it is ever highlighted.

## Layout

```
index.html       markup
styles.css       dark + light themes, glass cards, mobile-first
syntax.js        tokenizer (browser global + CommonJS export for tests)
app.js           UI state, fetch waterfall, editor, downloads
proxy-core.js    shared SSRF guard + capped body reader
server.js        local static host + CORS proxy (zero dependencies)
api/fetch.js     Vercel serverless proxy
api/health.js    Vercel health probe
vercel.json      function limits + security headers
test/            node --test test/
```

## Tests

```bash
npm i --no-save jsdom   # only needed for the DOM integration suite
npm test
```

Coverage: the tokenizer (including a round-trip proof that no character is lost or
invented), the local proxy end-to-end against a live origin (relay, redirects,
redirect loops, 404→502, SSRF refusal, size cap, traversal), the Vercel handlers
driven directly as `(req, res)` functions, markup/JS wiring, and the real
`index.html` + `app.js` booted in jsdom (fetch → editor → auto-detect → download,
plus every error path).
