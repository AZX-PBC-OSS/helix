# Example apps

> **Related ADRs:** [ADR-0020](../adr/0020-static-only-apps-v1.md) (static-only apps).

**What they are.** Reference apps under `examples/` that you can `helix deploy` to the platform —
the canonical answer to "what does a hosted AZX app look like?" They are **static frontends
only**; every dynamic capability flows through the edge gateway at `/_api/*`. Full notes:
[`examples/README.md`](../../examples/README.md).

| App | What it demonstrates | Gateway |
| --- | --- | --- |
| `hello-world` | The smallest deployable bundle (HTML + CSS + a line of JS). | — |
| `notes` | A realistic self-contained SPA (localStorage, multiple asset types). | — |
| `chatbot` | Streams Claude through the gateway — no key in the app, manifest-granted, metered. | `/_api/llm/chat` |
| `waitlist` | A **public** contact harvester: write-only collections + owner-seeded shared read. | `/_api/data/*` |
| `github-stars` | Calls a public API **directly** — CSP-blocked until an admin grants the origin (approval loop). | — (CSP) |
| `fetch-proxy` | Calls the GitHub API **through the proxy** — keyless, then secret-injected, then via the transparent shim. | `/_api/fetch/*` |

## How they fit the platform

- Each app is a **standalone Vite project**, deliberately **not** a pnpm workspace member — they
  model the untrusted user apps the platform hosts, not platform code. Rebuild in isolation:
  `pnpm install --ignore-workspace && pnpm build` from inside the app dir.
- The built `dist/` is **committed to git** (a negation rule in the root `.gitignore` re-includes
  `examples/**/dist/`), so the primary workflow — `helix deploy` — needs no build step.
- All are fully self-hosted, so they **deploy clean** through the CSP courtesy lint (no external
  origins outside the curated CDN allowlist — see [registry-and-deploys.md](./registry-and-deploys.md)).

### `chatbot` — the LLM gateway in practice

Ships only a frontend; it `POST`s to `/_api/llm/chat` and renders the SSE stream. The app never
holds an API key — the edge proxies to the vendor, enforces the manifest's model allowlist +
token budget, and meters the call. See [llm-gateway.md](./llm-gateway.md).

### `waitlist` — the app-data gateway in practice

A public app that appends submissions to a **write-only** collection via
`POST /_api/data/collections/:name` and reads owner-seeded state via shared-read. The app cannot
read the collection back — the owner drains it through the portal export API, on the privileged
DB role. See [app-data-gateway.md](./app-data-gateway.md).

### `github-stars` — the CSP approval loop in practice

The **deliberate counterpoint to `chatbot`**: instead of routing through the gateway, it calls
`api.github.com` **directly from app code** — exactly what the static `connect-src 'self'` CSP
blocks. No app change can lift it; only an approved `externalOrigins` grant in the control plane
can. So the app is purpose-built to exercise the **CSP violation → one-click origin-grant →
approval → CSP-widen** loop: the blocked fetch auto-POSTs to the edge `report-uri`, the report
surfaces on the portal **Violations** screen, an admin approves, and the edge rebuilds the app's
CSP from the projection — no redeploy. GitHub is chosen because public-repo reads need **no key**
and it returns `Access-Control-Allow-Origin: *`, so there's no CORS wall once CSP allows the
origin. It also reads `/_api/me` to show the M3 session, and trips the non-blocking deploy CSP lint
— which is the point. See [registry-and-deploys.md](./registry-and-deploys.md) (CSP lint) and the
approvals design.

### `fetch-proxy` — the fetch-proxy + secret injection in practice

Four probes against the GitHub API, the counterpoint to `github-stars` (which trips CSP): (1)
explicit path-prefix `fetch('/_api/fetch/https://api.github.com/rate_limit')`; (2) an auth-only
call demonstrating **server-side secret injection**; (3) a native `fetch()` rewritten by the
transparent shim; (4) a raw `XMLHttpRequest` showing the shim also covers XHR (what axios uses).
GitHub's PAT is chosen for **observable** injection — a PAT is two clicks, needs no scopes, and the
API works both keyless (60 req/hr) and authenticated (5000), so the injected token's effect is
directly visible: probe 1 jumps `60 → 5000` and probe 2 flips `401 → your account`. No
"trust-me-it-worked." Needs `pnpm dev:egress` running, or the proxy probes return 503. See
[fetch-proxy.md](./fetch-proxy.md) and [secrets-and-connections.md](./secrets-and-connections.md).

## Planned / not yet built

- More examples will follow as gateway capabilities land (e.g. MCP-as-REST). The set today
  covers static serving, the LLM proxy, app-data, the CSP approval loop, and the fetch-proxy.
