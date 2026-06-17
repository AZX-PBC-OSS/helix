# Example apps

**What they are.** Reference apps under `examples/` that you can `azx deploy` to the platform —
the canonical answer to "what does a hosted AZX app look like?" They are **static frontends
only**; every dynamic capability flows through the edge gateway at `/_api/*`. Full notes:
[`examples/README.md`](../../examples/README.md).

| App | What it demonstrates | Gateway |
| --- | --- | --- |
| `hello-world` | The smallest deployable bundle (HTML + CSS + a line of JS). | — |
| `notes` | A realistic self-contained SPA (localStorage, multiple asset types). | — |
| `chatbot` | Streams Claude through the gateway — no key in the app, manifest-granted, metered. | `/_api/llm/chat` |
| `waitlist` | A **public** contact harvester: write-only collections + owner-seeded shared read. | `/_api/data/*` |

## How they fit the platform

- Each app is a **standalone Vite project**, deliberately **not** a pnpm workspace member — they
  model the untrusted user apps the platform hosts, not platform code. Rebuild in isolation:
  `pnpm install --ignore-workspace && pnpm build` from inside the app dir.
- The built `dist/` is **committed to git** (a negation rule in the root `.gitignore` re-includes
  `examples/**/dist/`), so the primary workflow — `azx deploy` — needs no build step.
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

## Planned / not yet built

- More examples will follow as gateway capabilities land (e.g. MCP-as-REST). The set today
  covers static serving, the LLM proxy, and app-data.
