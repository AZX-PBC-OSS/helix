---
name: helix-app
description: Build and deploy a web app on the Helix app platform. Use when writing, changing, or deploying an app that will be hosted on Helix — covers the static-frontend constraint, the capability manifest, the /_api/* gateway (LLM, app data, fetch-proxy), the Content-Security-Policy you must build within, and the deploy/promote flow via the helix CLI.
---

# Building an app on Helix

Helix hosts vibe-coded web apps behind SSO. Its whole design assumes **your app is
untrusted code**, so the platform contains it rather than reviewing it. That single
stance explains every rule below — read it once before writing any code, because
several of these constraints are the kind you cannot retrofit.

This deployment:

- **Portal** (control plane — API and UI): `{{PORTAL_ORIGIN}}`
- **Your app**, once deployed: `https://<slug>.{{APPS_HOST}}`
<!-- IF:DEV_API -->
- **Dev gateway** (build it from somewhere else first): `{{DEV_API_BASE}}/<slug>`
<!-- /IF:DEV_API -->

---

## 1. The hard constraints

**An app is a static frontend. There is no server code.** You ship HTML, CSS, JS,
and assets. There is no place to run a backend, no environment variables, no
secrets in your bundle, no build step on the platform. Anything dynamic — calling
a model, storing data, reaching a third-party API — goes through the platform's
**same-origin gateway at `/_api/*`**, which the edge serves on your app's own
origin. You never hold an API key.

**Every response carries a strict Content-Security-Policy.** The one that will bite
you is `connect-src 'self'`: your app **cannot `fetch()` a third-party origin
directly**. Two ways out, both requiring a grant in the manifest (§2):

- Route the call through the platform: `fetch('/_api/fetch/https://api.example.com/thing')`.
  This is the good path — audited, metered, SSRF-controlled, and it can inject a
  stored credential server-side so no key ever reaches the browser.
- Ask an admin to widen CSP for a direct browser call (`externalOrigins`). Only
  sensible for public, keyless, CORS-enabled APIs.

The full policy applied to every app response:

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' <CDNs>;
style-src  'self' 'unsafe-inline' https://fonts.googleapis.com <CDNs>;
font-src   'self' data: https://fonts.gstatic.com <CDNs>;
img-src    https: data: blob:;
media-src  'self' data: blob:;
connect-src 'self';
worker-src 'self' blob:;
form-action 'self'; frame-ancestors 'none'; base-uri 'self';
report-uri /_csp-report
```

`<CDNs>` is `cdnjs.cloudflare.com`, `cdn.jsdelivr.net`, `unpkg.com`, `esm.sh`,
`cdn.tailwindcss.com` — those load without a grant. Approved origins are appended
to `img-src` and `connect-src`.

**Other serving rules.** Do not ship a service worker — one you register is
refused (`403` on a `Service-Worker: script` request). Plain web workers are
fine. If the app needs to work with no network, ask for the **offline**
capability instead (below); the platform supplies the worker. A request that
accepts HTML and matches no asset falls back to `index.html`, so client-side
routing works. HTML is served `no-cache`; other assets get a short private cache
with ETags. The path prefixes `/_api/*`, `/_auth/*`, and `/_helix/*` are reserved
by the platform — do not route on them.

**Offline (cold boot with no network).** Declare it in the manifest:

```yaml
offline:
  scope: /app/
```

The platform then serves its own service worker confined to that prefix and
injects the registration — **write no worker code and no `register()` call**. It
must not be the domain root or a `/_…` path.

Two things this changes about your build, and the second is where people trip:

- Serve the app from the scope. Set your bundler's base path to `/app/`.
- **Nest the output under that directory too.** A URL path maps directly onto a
  stored file, so `/app/main.js` reads `app/main.js` from your bundle — with Vite
  that is `base: "./"` plus `build.outDir: "dist/app"`. Setting the base alone
  produces URLs that look correct and all 404.

The bare domain then 404s unless you ship a root `index.html` redirecting into
the scope — the platform will not do it for you. Also add a web app manifest with
`start_url: /app/`, since offline entry from the bare domain is not possible:

```html
<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials" />
```

**`crossorigin="use-credentials"` is required on any app that is not `public`.**
Browsers fetch a web app manifest with credentials omitted, so without it the
request carries no session cookie, the edge answers `401`, and the app is
silently not installable — everything else looks fine. This is the single most
likely thing to go wrong when you add a manifest.

What the grant buys is **cold boot only**: the document and its static assets
answer with no network. Everything else is still yours and needs no grant —
handling `/_api/*` failures, IndexedDB or `localStorage` for durable state,
`caches.open()` for large payloads, and draining queued work when the connection
returns. `GET /_api/me` is the reachability probe: it is root-level, so it can
never be answered from cache. See the `offline` example app.

**The transparent fetch shim works offline too.** Both platform snippets — the
shim and the worker registration — are inlined into your HTML at serve time, so
they are part of the cached document rather than something it has to fetch. On an
offline cold boot `fetch`/`XMLHttpRequest` are patched as usual, and a proxied
call fails as an ordinary network error you can catch, not as a CSP violation.

**You get an identity for free.** Unless the app is `public`, the edge only serves
signed-in users; `GET /_api/me` returns the current actor. Don't build a login
screen.

---

## 2. The capability manifest

The manifest declares what the app is allowed to do, and the gateway enforces it.
It exists **before any code is deployed** and is edited in the portal (Capabilities
tab) or over `GET`/`PUT {{PORTAL_ORIGIN}}/api/v1/apps/<slug>/manifest`. A capability
you did not declare returns `403` — that is the expected failure, not a bug.

```jsonc
{
  "app": "my-app", // the slug
  "visibility": { "mode": "internal" }, // internal | password | public ("group" needs Entra setup — ask first)
  "capabilities": {
    "llm": {
      "models": ["claude-haiku-4-5"], // exact ids; anything else is 403 model_not_allowed
      "dollarsPerDay": 5 // daily spend cap in USD; omit for unbounded
    },
    "data": {
      "user": true, // per-user private store
      "collections": ["signups"], // append-only, write-only from the app
      "sharedRead": ["config"], // app-scoped world-readable keys
      "sharedWrite": [], // a write grant never implies a read grant
      "writesPerDay": 10000,
      "bytesPerDay": 50000000
    },
    "mcp": [], // carried, not yet enforced — no transport exists
    "externalOrigins": [], // direct browser calls: widens CSP connect-src/img-src
    "fetch": {
      "shim": false, // see §3.4
      "origins": [
        { "origin": "https://api.github.com" },
        { "origin": "https://api.stripe.com", "connection": "stripe-test" }
      ],
      "requestsPerDay": 10000
    }
  }
}
```

Models this platform prices and will serve: `{{LLM_MODELS}}`. Ask for the cheapest
one that does the job — `claude-haiku-4-5` is the sensible default for classification,
extraction, and short generation.

**Some grants need a human.** Staying inside the baseline (curated models,
≤ $50/day of LLM, ≤ 10 000 writes/day, ≤ 50 MB/day, ≤ 10 000 proxied requests/day)
applies immediately. Adding an `externalOrigins` entry, any `fetch.origins` entry,
any `mcp` server, going `public`, or exceeding a baseline queues an **approval** for
a platform admin. Plan for the wait; don't design around it by, say, hardcoding a
key in the bundle.

`connection` names a secret the platform stores and injects server-side. You never
see its value, and you never put credentials in app code or in the manifest.

---

## 3. The gateway — `/_api/*`

Same-origin, cookie-authenticated, no CORS, no key. Call it with a plain `fetch`
from your app. Mutating calls are Origin-checked, so they must come from the app's
own page — not from a `curl` in a terminal.

### 3.1 LLM — `POST /_api/llm/chat`

Provider-neutral on purpose; do not reach for an OpenAI or Anthropic SDK.

```js
const res = await fetch("/_api/llm/chat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-haiku-4-5", // must be in capabilities.llm.models
    system: "You are terse.", // top-level, NOT a message with role "system"
    messages: [{ role: "user", content: "hello" }], // roles: user | assistant only
    maxTokens: 1024, // default 1024, max 128000
    stream: true, // default true
  }),
});
```

With `stream: true` (the default) the response is Server-Sent Events:

```
event: delta   data: {"text":"..."}                       zero or more
event: done    data: {"stopReason":"...","usage":{...}}   terminal, success
event: error   data: {"code":"...","message":"..."}       terminal, failure
```

Read it with a `fetch` body reader — `EventSource` cannot POST. With
`stream: false` you get one JSON body: `{ model, content, stopReason, usage }`.

Every call is priced and metered against the app's daily budget, and the owner can
see it in the portal.

**Structured output.** Add `responseFormat` to get JSON that matches a schema
instead of prompt-begging for it and parsing defensively:

```js
body: JSON.stringify({
  model: "claude-haiku-4-5",
  messages: [{ role: "user", content: "Rome, 3 days" }],
  maxTokens: 4096, // give the JSON room — see the truncation note below
  stream: false,
  responseFormat: {
    type: "json_schema", // the only mode
    name: "itinerary", // optional, [A-Za-z0-9_-]{1,64}
    schema: {
      type: "object", // the root must be an object
      properties: { days: { type: "array", items: { type: "string" } } },
      required: ["days"],
      additionalProperties: false, // required — the schema is always enforced
    },
  },
});
```

The JSON comes back as ordinary `content` (or ordinary `delta` frames when
streaming) — `JSON.parse` it yourself. The schema is always **enforced** (there is
no best-effort mode), so write to the strict subset: every key in `required`,
`additionalProperties: false`, no recursion, and no `minLength`/`minimum`-style
constraints. Keep schemas under 32 KB and 12 levels deep.

**Set `maxTokens` generously, and check `stopReason` before parsing.** Prose degrades
gracefully when it hits the cap; JSON does not — you get a truncated, unparseable
fragment and a `JSON.parse` throw. Omitting `maxTokens` on a `claude-*` model means
`1024`, which a nested schema will blow through. Check
`stopReason !== "max_tokens"` (non-streaming) or the `done` frame's `stopReason`
(streaming) first.

If the platform returns `400 validation_failed` mentioning `responseFormat.schema`,
the vendor rejected your schema for being outside the strict subset above — fix the
schema; retrying unchanged will not help.

Not every model can enforce a schema. `claude-haiku-4-5`, `claude-opus-4-8`,
`claude-opus-5`, `claude-sonnet-5` and `claude-fable-5` can; `claude-opus-4-7`,
`claude-opus-4-6` and `claude-sonnet-4-6` cannot, and asking gets a `400` — they
still work fine for plain text chat.

### 3.2 App data — `/_api/data/*`

Three named access patterns, not a symmetric key-value store. Values are opaque
JSON up to **64 KiB**; keys are ≤ 256 characters with no control characters.

```
PUT    /_api/data/user/:key          store a value for the signed-in user
GET    /_api/data/user/:key          read it back
DELETE /_api/data/user/:key
GET    /_api/data/user               list this user's keys
POST   /_api/data/collections/:name  append one item  → 201, empty body
GET    /_api/data/shared/:key        app-scoped, readable by every user
PUT    /_api/data/shared/:key
```

- **`user`** is partitioned by the signed-in user by the database itself. A `public`
  app has no user scope and gets `403`.
- **`collections`** are **append-only and unreadable from the app** — there is no
  list, get, or delete verb, and adding one is not possible from app code. This is
  the right shape for a signup form, a feedback box, a survey. The owner drains the
  collection from the portal. Anonymous visitors of a `public` app may append.
- **`shared`** keys are visible to everyone who can open the app. Never put anything
  user-specific or sensitive there.

```js
await fetch("/_api/data/user/prefs", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ theme: "dark" }),
});
const prefs = await (await fetch("/_api/data/user/prefs")).json();
```

### 3.3 Outbound HTTP — `/_api/fetch/<url>`

Prefix the absolute target URL onto the path. The method, headers, and body pass
through; the platform resolves and injects any `connection` credential, blocks
private/loopback/metadata addresses, refuses redirects, and streams the response
back.

```js
const r = await fetch("/_api/fetch/https://api.github.com/repos/vercel/next.js");
```

The target's origin must be listed in `capabilities.fetch.origins`. Your own
`cookie` and `authorization` headers are never forwarded upstream. WebSocket,
`EventSource`, and `<img>`/`<form>`/font loads do **not** go through the proxy —
those need `externalOrigins` instead.

### 3.4 The transparent shim

Setting `capabilities.fetch.shim: true` makes the edge inject a small script into
your HTML that patches `fetch` and `XMLHttpRequest` so calls to granted origins are
rewritten onto `/_api/fetch/<url>` automatically. Useful when porting code that
already calls a third-party API directly. Prefer writing the `/_api/fetch/` path
yourself in new code — it is explicit and it works without the shim.

### 3.5 Errors worth handling

| Status | Code                     | Meaning                                                              |
| ------ | ------------------------ | -------------------------------------------------------------------- |
| 401    | —                        | Not signed in (a fetch after the session expired; reload to re-auth) |
| 400    | `validation_failed`      | Bad request body — or a `responseFormat` this model can't enforce    |
| 403    | `forbidden`              | The capability isn't in the manifest                                 |
| 403    | `model_not_allowed`      | Model isn't in `capabilities.llm.models`                             |
| 429    | `quota_exceeded`         | Daily budget spent — in-flight calls finish, new ones are refused    |
| 429    | `rate_limited`           | Anonymous per-IP limit on a `public` app                             |
| 503    | `capability_unavailable` | The platform isn't configured for this capability here               |
| 502    | —                        | Upstream provider failed                                             |

Surface these to the user as themselves. A `403` means a missing grant, and
retrying will not fix it.

---

## 4. Build and deploy

Any static-site toolchain works — Vite is the well-trodden path, and plain
HTML/CSS/JS is entirely fine. Build to a directory (`dist/` by convention); the
**contents** of that directory become the site root, so `dist/index.html` is served
at `/`.

**Always add a `helix.json` next to your project** — the CLI reads it, and it also
makes the bundle self-describing: it names the build directory, so if the archive is
ever uploaded by hand through the portal, the platform can find your build inside it
rather than guessing.

```json
{ "slug": "my-app", "dir": "dist", "portalUrl": "{{PORTAL_ORIGIN}}" }
```

Then, with the `helix` CLI on your PATH:

```bash
helix login                          # browser sign-in (OIDC device flow)
helix create --display-name "My App" # once, if the app doesn't exist yet
helix deploy                         # uploads dist/ as a new *preview* version
helix versions                       # see what's preview vs live
helix promote 3                      # flip the live pointer
helix rollback                       # back to the previous live version
```

`helix deploy --promote` does the last two steps in one. Deploys always land as
**preview** first — promotion is deliberately separate, and versions are immutable.

Install the CLI from npm (needs Node 24+):

```bash
npm i -g @azx-pbc/helix-cli          # puts `helix` on your PATH
```

For CI, set `HELIX_TOKEN` and `HELIX_PORTAL_URL` instead of running `helix login`.

**Upload limits:** {{MAX_FILE_MB}} MB per file, {{MAX_BUNDLE_MB}} MB per bundle,
5 000 entries, 200:1 compression ratio. Only static asset types are accepted; symlinks and paths that
escape the archive root are rejected. The upload also runs a **non-blocking CSP
lint** and warns about third-party origins it will block at serve time — read those
warnings, they are telling you about a `403` you are about to hit in production.

<!-- IF:DEV_API -->

---

## 5. Developing before you deploy

You can build against the **real** platform — real LLM proxy, real app data, real
fetch-proxy, real manifest enforcement — while the app still lives on your laptop or
in a browser-based builder, by talking to the **dev gateway**. It serves an isolated
`dev` partition of your app: separate data, separate budget, separate credentials.
Nothing you do there can touch production.

Set-up, in the portal:

1. Create the app and grant its capabilities. The manifest is enforced in dev too —
   which is the point: you find the missing grant now, not after promoting.
2. In the app's **Dev mode** tab, register the **exact origins** your dev environment
   loads from (`http://localhost:5173`, `https://<preview>.your-builder.app` — no
   wildcards) and mint a **dev token**. It is shown once.
3. If you use a secret-backed `connection`, add a **dev-tier** credential in the
   **Secrets** tab.

Then point your calls at the dev gateway instead of `/_api/*`. The slug moves into
the path, and the token replaces the session cookie — **everything else about the
request is identical**, so keep the base URL in one constant and swap it at build
time:

```js
const API = import.meta.env.DEV ? "{{DEV_API_BASE}}/<slug>" : "";

await fetch(`${API}/_api/llm/chat`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(API && { authorization: `Bearer ${import.meta.env.VITE_HELIX_DEV_TOKEN}` }),
  },
  body: JSON.stringify({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] }),
});
```

Deploying moves **code**, never data — there is no "copy my dev rows to prod", and
the portal offers a reset for the throwaway dev partition.

<!-- /IF:DEV_API -->

---

## Checklist before you call it done

- [ ] No server code, no `.env`, no API key anywhere in the bundle.
- [ ] Every third-party call goes through `/_api/fetch/<url>` (or has an approved
      `externalOrigins` grant) — nothing relies on plain cross-origin `fetch`.
- [ ] Every capability the code uses is declared in the manifest, with a budget.
- [ ] `403` and `429` from the gateway are handled and shown to the user.
- [ ] User-specific state is in `/_api/data/user/*`, not in `shared`.
- [ ] Nothing sensitive is written to a `shared` key or logged to the console.
- [ ] The build output has an `index.html` at its root and deploys clean of CSP
      lint warnings.
