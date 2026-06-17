# LLM gateway

**What it is.** `POST /_api/llm/chat` — the gateway's first capability (architecture §6.1,
project plan §4 M4). It is the choke point that makes per-app blast radius real: an untrusted
app calls a **same-origin** endpoint, and the edge authenticates the user, proves the request
came from the app's own origin, enforces the per-app model allowlist and daily token budget,
proxies to the vendor through a seam **the app never sees the key for**, and meters every call.
The vendor-neutral wire contract is `packages/shared/src/llm.ts`.

Handler: `apps/edge/src/gateway/llm.ts` (`makeLlmHandler`). Route wiring:
`apps/edge/src/app.ts:245`. App hosts only — `sendNotFound` elsewhere.

## How it works

### The preamble (same shape as app-data)

1. **Resolve serving entry** — `resolveServingEntry(registry, slug)`; archived/missing → handled.
2. **Resolve caller** — the `CallerResolver` from [authentication.md](./authentication.md). A
   fetch with no/expired session gets the gate's 401 (or `refresh_required`); on a `public` app
   the caller is anonymous (`ANON_USER_OID`).
3. **CSRF** — `isSameOrigin(req.headers.origin, …)`; a sibling subdomain must not POST on the
   user's session (SameSite doesn't cover cross-subdomain — Origin does). Mismatch → `403`.
4. **Capability configured?** — if no vendor key/usage ledger on this edge → `503`
   `capability_unavailable`.
5. **Validate body** — `LlmChatRequestSchema.safeParse`; bad → `400`.
6. **Authz** — the app must hold an `llm` grant (`entry.llm`) and the requested `model` must be
   in `entry.llm.models` (else `403 forbidden` / `403 model_not_allowed`).

### Quota (block-new, finish-in-flight)

If `entry.llm.tokensPerDay` is set, the budget is checked **once at admission**:
`usage.tokensUsedToday(appId) >= budget` → record a `quota_blocked` row and return `429`
`quota_exceeded`. An admitted request always runs to completion even if it tips the app over —
the **next** request is the one that gets blocked (`apps/edge/src/gateway/llm.ts:115`).

### Provider seam + streaming

`apps/edge/src/gateway/provider.ts` defines a vendor-agnostic `LlmProvider`:
`stream(req, {signal}) → AsyncIterable<LlmStreamEvent>`, where events are `{type: "delta",
text}` then a final `{type: "done", stopReason, usage}`. The M4 implementation is **Anthropic**,
streamed over undici (no SDK), always requesting `stream: true` upstream and parsing SSE; the
vendor key comes from a `SecretProvider` (`apps/edge/src/gateway/secrets-provider.ts`), never
from edge config the app could reach.

The handler relays this two ways:

- **Streaming** (`chat.stream`, the default) — hijacks the reply and writes
  `text/event-stream` with `x-accel-buffering: no` (defeats proxy buffering). Emits
  `event: delta` records as text arrives, then `event: done` with `{stopReason, usage}`; on
  failure, `event: error` `{code, message}`.
- **Non-streaming** — accumulates deltas into a single `LlmChatResponseSchema` JSON body;
  upstream failures become `502`.

The client is aborted when it goes away: `req.raw.on("close", () => abort.abort())` cancels the
upstream stream — the edge never blocks the event loop buffering a response (project plan §1).

### Metering

Every call records exactly once (`recordOnce`) into `gateway_calls` via
`apps/edge/src/gateway/usage.ts`: `{appId, userOid, capability: "llm", model, inputTokens,
outputTokens, outcome}` where outcome is `ok` / `error` / `quota_blocked`. The portal reads this
ledger (see [registry-and-deploys.md](./registry-and-deploys.md) and `packages/shared/src/usage.ts`).

## Try it

`examples/chatbot` streams Claude through this gateway — the app ships only a frontend and never
holds an API key. See [examples.md](./examples.md).

## Planned / not yet built

- **More providers** behind the `LlmProvider` seam (the interface is vendor-neutral; only
  Anthropic is implemented).
- **Cost, not just tokens** — the ledger records tokens; dollar cost is a later pricing decision
  (`packages/shared/src/usage.ts`).
- **MCP-as-REST** — `capabilities.mcp` exists in the manifest but has no gateway transport yet
  (see [capabilities-and-manifests.md](./capabilities-and-manifests.md) and
  `docs/platform-custom-backends-and-apis.md`).
