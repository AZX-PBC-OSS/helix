# builder/ — "Lovable at home" prototype (bolt.diy overlay)

A web app builder (à la Lovable/bolt.new) for vibe-coding Helix apps, prototyped
on **bolt.diy**. See `docs/` and the platform architecture for the bigger picture;
this directory is the **in-repo overlay** that wires upstream bolt.diy to the
platform without standing up a separate repo yet.

## Layout

| Path | Committed? | What |
| --- | --- | --- |
| `setup.sh` | ✅ | Clone upstream bolt.diy + install + apply `patches/` |
| `run.sh` | ✅ | Launch it with the CA trust + port fixes it needs |
| `bolt.env.example` | ✅ | Template for the clone's `.env.local` |
| `patches/` | ✅ | Overlay diffs applied to the clone (our fork's diff) |
| `bolt.diy/` | ❌ (gitignored) | The upstream clone — never committed |

**Overlay patches** (`patches/*.patch`, applied by `setup.sh`):
- `openai-like-helix-limits.patch` — bolt's OpenAILike provider hardcodes
  `maxTokenAllowed: 8000` for every custom model (so the picker shows "8K
  tokens" and output caps at ~8K, truncating long generations). This reads the
  real `context_window` / `max_output_tokens` our `/v1/models` advertises, so
  the picker shows the true window (1M for opus) and output isn't truncated.

When we later decide to fork/open-source bolt.diy properly, this overlay is the
diff that becomes the fork.

## How it's wired

The mandate is *no lock-in to a provider/model*. We satisfy it by pointing
bolt's built-in **OpenAILike** provider at the platform's **OpenAI-compatible**
endpoint on the edge (`apps/edge/src/gateway/builder-llm.ts`, Track A):

```
OPENAI_LIKE_API_BASE_URL=https://api.localtest.me:8080/v1
OPENAI_LIKE_API_KEY=<EDGE_BUILDER_API_KEY from apps/edge/.env.local>
```

bolt fetches `${baseURL}/models` (→ the curated catalog) and posts to
`${baseURL}/chat/completions`. The edge routes it through the same `LlmProvider`
seam the hosted apps use — so the Anthropic key stays in egress/the platform
secret store, and bolt never sees a vendor key. Swap the upstream behind the
seam and bolt is unaffected: that's the whole point.

## Run

Prereqs: the edge is up (`pnpm dev:edge`) with `EDGE_BUILDER_API_KEY` set, and
its LLM provider is live (egress + the platform `anthropic` secret, or the
`EDGE_LLM_ANTHROPIC_KEY` dev fallback).

```bash
builder/setup.sh     # one-time: clone + install
builder/run.sh       # launch on http://localhost:5180
```

Then in the browser: open **:5180**, pick provider **OpenAILike** and one of the
`claude-*` models, and prompt. Traffic flows bolt → edge `/v1/chat/completions`
→ `LlmProvider` → Anthropic.

### Gotchas the run script handles

- **TLS**: bolt's server-side fetch hits the mkcert-signed
  `https://api.localtest.me:8080`. `run.sh` sets `NODE_EXTRA_CA_CERTS` to the dev
  root CA (`.devcontainer/certs/caroot/rootCA.pem`), else every call fails to
  verify the cert.
- **Port**: bolt defaults to `:5173`, colliding with `pnpm dev:web`. `run.sh`
  moves it to `:5180`.

## Track C — preview transport + deploy

The WebContainer preview is a *cross-origin* page, so it can't reach a deployed
app's same-origin `/_api/*` (see `docs/design/dev-mode.md` §1). Resolution: the
preview talks to a **dev-gateway** (the doc's §3 cross-origin surface), and app
code stays identical via the **SDK**.

### Preview transport (`@helix/app-sdk`)

Apps reach capabilities through `@helix/app-sdk` (`packages/app-sdk`), which
picks its transport from config:

- **Deployed** (served by the edge): same-origin `/_api/*` under the session
  cookie — empty config.
- **Preview** (cross-origin): the throwaway dev-gateway on `dev-api.<base>` with
  a bearer dev-token + the app slug, injected as `globalThis.__HELIX__`.

```js
import { createHelixClient } from "@helix/app-sdk";
const helix = createHelixClient(); // reads globalThis.__HELIX__ in preview, same-origin when deployed
await helix.llm.chat({ model, messages: [...] }, { onDelta: (t) => append(t) });
```

**bolt-side wiring** (in the gitignored clone — capture as an overlay patch):
1. Teach the scaffold/system-prompt to build apps that call `@helix/app-sdk`
   (not hand-rolled `fetch('/_api/...')`), so dev↔prod code is identical.
2. Inject the dev config into the WebContainer preview — write a script tag /
   config file setting `window.__HELIX__ = { base: "https://dev-api.localtest.me:8080", token: "<EDGE_DEV_GATEWAY_TOKEN>", app: "<slug>" }`. Register that
   preview origin in `EDGE_DEV_GATEWAY_ORIGINS`.

Today the dev-gateway is **LLM-only** (stateless → no prod-partition risk);
`data`/`fetch` wait for the real `env`-partition dev tier (`dev-mode.md` §5).

### Deploy to Helix (TODO)

Replace bolt's Netlify deploy: WebContainer `npm run build` → bolt's Node server
zips `dist/` → `POST` the portal deploy API with the developer's bearer token
(the portal has no CORS, so this must be server-to-server, not a browser call).
