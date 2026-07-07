# builder/ — "Lovable at home" prototype (bolt.diy overlay)

A web app builder (à la Lovable/bolt.new) for vibe-coding Helix apps, prototyped
on **bolt.diy**. See `docs/` and the platform architecture for the bigger picture;
this directory is the **in-repo overlay** that wires upstream bolt.diy to the
platform without standing up a separate repo yet.

## Layout

| Path | Committed? | What |
| --- | --- | --- |
| `setup.sh` | ✅ | Clone upstream bolt.diy + install (standalone) |
| `run.sh` | ✅ | Launch it with the CA trust + port fixes it needs |
| `bolt.env.example` | ✅ | Template for the clone's `.env.local` |
| `bolt.diy/` | ❌ (gitignored) | The upstream clone — never committed |

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

## Known open question (Track C)

bolt's in-browser **WebContainer** preview runs client-side and can't reach the
platform's `/_api/*` gateway without a proxy shim — so an app that calls the
gateway may behave differently in preview vs. once deployed. Deciding between a
WebContainer proxy shim and running preview in the dev partition
(`develop-against-the-platform`) is Track C.
