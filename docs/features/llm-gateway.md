# LLM gateway

**What it is.** `POST /_api/llm/chat` — the gateway's first capability (architecture §6.1,
project plan §4 M4). It is the choke point that makes per-app blast radius real: an untrusted
app calls a **same-origin** endpoint, and the edge authenticates the user, proves the request
came from the app's own origin, enforces the per-app model allowlist and daily token budget,
proxies to the vendor through a seam **the app never sees the key for**, and meters every call.
The vendor-neutral wire contract is `packages/shared/src/llm.ts`.

Handler: `apps/edge/src/gateway/llm.ts` (`makeLlmHandler`). Route wiring:
`apps/edge/src/app.ts` (`POST /_api/llm/chat`). App hosts only — `sendNotFound` elsewhere.

## How it works

### The preamble (same shape as app-data)

1. **Resolve serving entry** — `resolveServingEntry(registry, slug)`; archived/missing → handled.
2. **Resolve caller** — the `CallerResolver` from [authentication.md](./authentication.md). A
   fetch with no/expired session gets the gate's 401 (or `refresh_required`); on a `public` app
   the gate is **skipped entirely** (public apps route around the auth host) and the caller is
   anonymous (`ANON_USER_OID`). An anonymous caller has no per-user budget, so on public apps a
   per-IP fixed-window limiter runs here, ahead of everything else (`anonRateLimited` →
   `429 rate_limited`, not metered).
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
the **next** request is the one that gets blocked (`apps/edge/src/gateway/llm.ts`). The
alternative (cutting an in-flight stream at the byte that crosses the line) buys nothing — the
tokens are already spent upstream — and would corrupt the response mid-sentence. Block-new keeps
the budget a coarse daily ceiling, not a hard per-token cap, and the blocked call **is** audited
(a `quota_blocked` row, distinct from the calls that record nothing — see below). An **unset**
`tokensPerDay` means unlimited: the edge only enforces a defined budget, so the most-permissive
state is no number at all (this is why the approval classifier treats removing a cap as a
privilege *increase* — see [capabilities-and-manifests.md](./capabilities-and-manifests.md)).

### Provider seam + streaming

`apps/edge/src/gateway/provider.ts` defines a vendor-agnostic `LlmProvider`:
`stream(req, {signal, appId, userOid, requestId}) → AsyncIterable<LlmStreamEvent>`, where events
are `{type: "delta", text}` then a final `{type: "done", stopReason, usage}`. It is a deliberate
**seam, not a cloned vendor API namespace** — the app speaks the platform's own
`packages/shared/src/llm.ts` wire contract, and the gateway translates. That indirection is what
keeps the key out of reach: there is no edge surface that echoes the upstream request, so the app
**never sees the vendor key** and can't smuggle raw vendor parameters past the manifest allowlist.
The implementation is **Anthropic**, streamed over undici (no SDK — the edge stays
dependency-minimal, project plan §1), always requesting `stream: true` upstream and parsing SSE.

**Where the vendor key lives.** The default provider, `EgressLlmProvider`
(`apps/edge/src/gateway/egressLlmProvider.ts`), does **not** hold the key: the key is a
`platform`-scoped secret (named by `EDGE_LLM_ANTHROPIC_CONNECTION`, default `anthropic`) managed
in the portal Secrets admin page and resolved by `azx-egress`. The edge keeps all the policy
above; it only mints an attested `llm` instruction and forwards the call over the `EgressProvider`
seam — egress injects `x-api-key` and streams the SSE back, which the edge parses for usage and
metering (shared `mapAnthropicStream`). This is the same policy/mechanism split as the fetch-proxy,
and it removes the one spot where the edge held plaintext (secrets design §1). Rotating the key in
the portal takes effect on the next call with no edge restart. A legacy direct `AnthropicProvider`
(key from `EDGE_LLM_ANTHROPIC_KEY` via `apps/edge/src/gateway/secrets-provider.ts`) remains as a
**deprecated dev fallback** for running the edge without egress; it is not used when egress is
configured.

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
outputTokens, outcome}` where outcome is `ok` / `error` / `quota_blocked` (the column also admits
`refusal`, reserved for content-policy stops; M4 emits the three above). The portal reads this
ledger (see [registry-and-deploys.md](./registry-and-deploys.md) and `packages/shared/src/usage.ts`).

What the ledger captures is deliberately narrow — **tokens, request count, outcome, capability,
model, user, app, timestamp** — and nothing more. There is **no latency, no error-detail/message,
no session count, and no request/response size**: the row is a metering + budget primitive, not an
observability sink. Two consequences worth stating plainly:

- **Tokens, not dollars.** There is no cost column; pricing is a later decision (below), and the
  dashboards render tokens rather than fabricate a currency figure.
- **Append-only by grant, not tamper-evident.** `helix_edge` has `INSERT` (and `SELECT` for the
  budget sum) but no `UPDATE`/`DELETE` on `gateway_calls` — so an edge RCE can't rewrite history.
  But there is no hash chain or signature: integrity rests on the DB grant set, not on
  cryptographic immutability. A real immutable audit sink is deferred (architecture §8).

Calls that never reach the provider record selectively: a `quota_blocked` admission is logged (it
*was* a request the app made), but a **rejected CSRF / disallowed-model / unconfigured-capability**
call records nothing — those are policy refusals at the door, not metered usage. Anonymous calls
throttled by the per-IP limiter on public apps are also **not** metered (a ledger row per throttled
request is its own write-amplification vector under flood).

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
