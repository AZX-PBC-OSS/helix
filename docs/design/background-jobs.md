# Background jobs — the jobs plane, and what job #1 needs

**Status:** Research memo v1 · 2026-09-11
**Companion to:** [ADR-0045](../adr/0045-app-triggered-durable-jobs-plane.md) (the decision), `custom-backends.md` (the rung ladder this sits on), `fetch-proxy.md` and `secrets-and-connections.md` (the mechanism job #1 uses)
**Purpose:** Evaluate a job runner and the first job type's model-vendor access.
ADR-0045 defines the jobs plane but leaves these implementation choices open.
External claims were checked against primary sources on the date above;
conclusions from repository code are identified separately.

---

## 1. What job #1 has to do

The pilot app that forced [ADR-0041](../adr/0041-app-data-write-concurrency.md) and [ADR-0042](../adr/0042-shared-prefix-grants-and-list-verb.md) is the first caller. Stripped of its domain, its core operation is:

1. **A research phase.** One model call with **provider-side web search** and a strict JSON schema, producing a structured document. Wall time dominates here; the model runs many searches inside the single call.
2. **An enrichment phase.** A second call with no search, taking phase 1's output plus some app-held context, producing narrative fields merged into the document.
3. **A compression phase.** A third call, no schema, best-effort — a failure here must not invalidate the work already done.

Typical end-to-end is **30–90 seconds**. A separate aggregate operation over many documents runs for minutes at a higher reasoning setting. The vendor client is configured with a 45-minute timeout, which is the honest upper bound on how long one of these calls can take.

Generalized, that is: **an N-phase pipeline where each phase carries a prompt, an optional output schema, and an optional request for provider-side search.** Phase count, prompts and schemas are payload. This is ADR-0045 decision 8.

Three properties of the reference implementation are worth carrying forward because they are requirements in disguise:

- **Partial results are written between phases**, so a caller can render progress rather than a spinner. The job's progress events must be able to carry a phase boundary, not just a percentage.
- **Later phases can be re-run alone** against an earlier phase's stored output. The job type should not assume all phases always run.
- **A phase can be declared non-fatal.** Phase 3 failing leaves the job successful.

---

## 2. Provider-side web search

This is the one capability job #1 needs that the LLM gateway does not have, and the research changed the recommendation, so it is worked in full.

### 2.1 It is not the tool use the gateway rejects

`tools` / `tool_choice` are declared in `packages/shared/src/llmOpenai.ts` specifically so the codec can `400` them. That rejection is about **app-defined function calling**: the model asks the caller to run a function, the caller runs it and calls back, repeat. On this platform the caller would be untrusted app code, so the loop is a real design problem.

**Provider-side search is a different thing.** The vendor runs the searches inside its own infrastructure and returns a completed response. Nothing of ours executes, nothing app-defined is involved, and there is no callback. From the gateway's side it is closer to a flag on the request than to a tool loop.

The distinction matters enough to state plainly, because scoping them as one feature would make job #1 depend on the hardest thing in the LLM roadmap rather than one of the easier ones.

### 2.2 The one place it *is* a loop: `pause_turn`

Server-side tool use runs a sampling loop with a default limit of **10 iterations**. Hitting it returns `stop_reason: "pause_turn"`; continuing means re-sending the paused assistant message unchanged. No client-side execution happens — but the request/response relationship is no longer strictly one-to-one.

For a pipeline whose prompt says to search aggressively, reaching the iteration cap is likely rather than theoretical. **A job has no user to ask**, so the policy must be decided rather than defaulted: auto-continue with a hard cap (3 is a reasonable starting point) and surface exhaustion as a terminal job error. This is ADR-0045 open question 4.

Two related mechanics with teeth:

- **Search results must be round-tripped byte-exact.** Results carry encrypted content that the vendor decrypts on later turns; if it is missing or modified the next request fails validation. A gateway that normalizes or re-serializes content blocks breaks multi-turn search. Single-phase jobs are unaffected; a chat surface would not be.
- **On the newer tool versions, filtering runs inside provider-side code execution.** The vendor provisions it automatically at no extra charge beyond tokens, and it exists to keep irrelevant search content out of the context window. Nothing untrusted of *ours* runs — but "the platform's model calls now involve a provider-side code-execution sandbox" is a sentence that belongs in a threat model deliberately rather than by discovery. It can be opted out of by requesting direct calls only.

### 2.3 The two vendors are not symmetric, and that is the finding

| | Anthropic | OpenAI |
| --- | --- | --- |
| Endpoint the edge already calls | **`/v1/messages`** (`provider.ts:333`, `:467`) | `/v1/chat/completions` (`:475`) |
| Where full search lives | `/v1/messages`, as a `tools` entry | **the Responses API**, as a `tools` entry |
| On the endpoint we use today | n/a | **degraded** — search-specific model variants only, without domain filtering or source lists |
| Request shape | `{type: "web_search_<version>", name: "web_search"}` plus optional `max_uses`, `allowed_domains`/`blocked_domains`, `user_location` | `{type: "web_search"}` |
| Search count in usage | `usage.server_tool_use.web_search_requests` | not confirmed — see §6 |
| Price | **$10 / 1,000 searches** + tokens for retrieved content | ~$10 / 1,000 calls + ~8,000 input tokens billed per search |
| Errors | HTTP 200 with an error object in the result block; failed searches are not billed | not confirmed |
| Streaming | supported; the stream pauses while a search runs | supported |

So: **on Anthropic this is a change to a request body and a stream mapper. On OpenAI it is a new upstream integration** — a different endpoint, a different request and response shape, a new vendor descriptor, and a new codec.

### 2.4 What supporting it on Anthropic would actually take

| Where | Change |
| --- | --- |
| `packages/shared/src/llm.ts` | A bounded `webSearch` field on the neutral request (`maxUses`; domain lists **platform- or owner-declared, never app-supplied** — see §2.5) |
| `packages/shared/src/pricing.ts` | A `webSearch?: boolean` per model — the existing `structuredOutputs` flag is the exact precedent — **plus a per-search rate, which is a new kind of rate in a table that is per-MTok only** |
| `provider.ts:74` `anthropicRequestBody` | Append the tool entry |
| `provider.ts:98` `mapAnthropicStream` | It currently emits only `text_delta` and ignores every other block, so search results would be **silently dropped**. It needs the server-tool block types and the search count from usage |
| stream handling | A `pause_turn` policy with a continuation cap (§2.2) |
| `LlmUsageSchema`, `GatewayCall` | A search-count field and column |

**The metering gap is the part to get right.** [ADR-0021](../adr/0021-metering-ledger.md)'s ledger records *tokens*, and `costUsd` derives dollars from per-million-token rates at read time. A per-search charge is not a token charge, so today a search-heavy call **under-bills and under-counts against `dollarsPerDay`**. That is a budget-enforcement hole rather than a reporting nicety, and it has to land with the feature rather than after it.

### 2.5 Security notes

- **Search results are untrusted content entering a structured-output pipeline.** The model reads arbitrary pages and emits JSON the app stores and renders. This is an indirect prompt-injection surface the platform does not have today, and it is not hypothetical for a job whose purpose is reading pages it found. It crosses no boundary the platform enforces — the output is still app data — but "a job's output can be influenced by a page it read" belongs in the threat model.
- **Domain filtering is a real platform policy lever, and only Anthropic's full surface has it.** `allowed_domains` / `blocked_domains` are enforced vendor-side. Declared by the *platform or the app owner* — never settable by app code at runtime — this is exactly a platform-authored grant the app merely names, and it is classifiable in `classifyChange` like any other capability field. An app that can aim the search wherever it likes at runtime has been handed something meaningfully larger.
- **The search capability can be disabled org-wide at the vendor**, in which case a request carrying the tool fails with a `400` rather than returning a per-search error. Worth distinguishing in error handling, because the two look nothing alike operationally.

---

## 3. How job #1 reaches a vendor: four options

The pilot app is built on OpenAI, uses its Responses API, and its prompts have been tuned against OpenAI's search behaviour over months of real use. Its own code prices its model at **$1.25 in / $10 out** per million tokens. The platform's curated catalogue is materially more expensive at the capability tier this workload needs.

That combination is why "just use Anthropic" is a weaker recommendation than it first appears: it optimizes **platform build cost** while charging the app a re-tune and a higher bill.

| | Platform work | App re-tune | Governance | Per-token cost |
| --- | --- | --- | --- | --- |
| **A.** LLM gateway + Anthropic + web search (§2.4) | Moderate | **Full re-tune and re-validation** | Full: model allowlist, USD ledger, `dollarsPerDay` | **2.4–4× higher** |
| **B.** Fetch-proxy + a vendor connection secret | **~none** | **none** | `requestsPerDay` only | unchanged |
| **C.** LLM gateway + OpenAI Responses API | **Large** — new upstream, codec, catalogue entry | none | Full | unchanged |
| **D.** B now; A or C later, on measurement | staged | deferred | degraded, then full | unchanged now |

**Recommendation: D.** Ship job #1 on the fetch-proxy so the jobs plane can be built and proven against a real workload with no dependency on unbuilt gateway features. The durability gap is the problem worth solving first, and it is entirely independent of which vendor the job calls.

Option B satisfies ADR-0045's invariants, which is what makes it acceptable rather than a shortcut: the jobs plane **holds no vendor key** (egress injects it), it has **no ambient network** (the call goes through the proxy), and SSRF controls apply. The app speaks the vendor's wire protocol unedited, including the Responses API and provider-side search.

Its cost is real and is recorded in ADR-0045's consequences: **the platform's most expensive workload sits outside the USD ledger**, with only `requestsPerDay` bounding it. Two partial mitigations belong with job #1 — a per-job cost ceiling enforced in the jobs plane, and a cap on provider-side search calls per job, which is the dominant marginal cost.

One fact that holds regardless of the option chosen: **the pilot app's pinned model is not in `MODEL_PRICING`**, so the native gateway refuses it today, and that vendor's line-up has moved on since the app pinned it. Some model re-tune is coming for that app whether or not the platform is involved.

---

## 4. Runner implementations

ADR-0045 decision 2 makes this an implementation choice behind an HTTP contract. This section is evaluation, not decision.

### 4.1 What the plane needs from a runner

Durable enqueue; at-least-once dispatch with a lease; heartbeat-based lock renewal so a dead worker's job is reclaimed; a sweeper for expired leases; retry with backoff; cooperative cancellation; progress events; **results stored as values with a size cap and a TTL**; and observability that does not drag in a vendor SDK.

The lease-and-sweeper part is the whole point: it is exactly what the reference implementation lacks, and what ADR-0041 refused to fake with compare-and-swap.

### 4.2 The candidate on the table

`taskq-py` ([AZX-PBC-OSS/TaskQ](https://github.com/AZX-PBC-OSS/TaskQ)) — MIT, Postgres-backed, `asyncpg`, actively maintained, pre-1.0 (SemVer 0.x: breaking changes land in minor bumps). Verified by reading the repository at v0.2.2:

**Fits, and more closely than a generic library would:**

| Property | Why it matters here |
| --- | --- |
| Core depends on the OpenTelemetry **API only** — no SDK, no exporters | The same boundary [ADR-0037](../adr/0037-platform-observability-otlp-boundary.md) draws, for the same reason |
| All tables isolated into a configurable schema; several clusters can share a database | Resolves the "portal owns the schema, Prisma owns migrations" conflict without contortion |
| Rotating-credential support via a zero-arg async factory seam | The same one-function-seam shape as `GetVaultToken` / `GetGraphToken`, and it covers managed identity |
| `result` stored as JSON with a size cap and expiry; typed retrieval | Exactly the by-value result model of ADR-0045 decision 4 — and its cap is **65536 bytes, identical to `MAX_VALUE_BYTES`** |
| `SKIP LOCKED` dispatch, advisory-lock leader election, `LISTEN/NOTIFY` wake, heartbeat renewal, watchdogs | The durability machinery in §4.1, already built |
| Forward-only checksummed migrations under an advisory lock | Same discipline as the portal's |
| Documented Container Apps deployment and health probes; Postgres 18 baseline | Matches where and how the planes already run |

**Costs and caveats, stated plainly:**

- **It is Python.** The repo's stated convention is TypeScript everywhere. Confined to one container this is a toolchain and CI cost rather than an architectural one, but it is a real cost: a second dependency-audit surface, and no shared zod schemas across the boundary (payload contracts would be maintained twice, or generated).
- **There is no HTTP enqueue API.** The web surface is an admin UI, progress streaming and health. The plane's API server (ADR-0045 decision 1) is ours to write regardless — which is fine, and is what keeps decision 2's seam honest.
- **No workflow graph.** Chaining is imperative (a job enqueues the next from inside its own body) plus batch fan-out. The eventual DAG ambition is a layer above any runner, not something a runner supplies.
- **Session-scoped Postgres features mean direct connections** for most of its pools — several per worker replica, on a server that already has a filed connection-budget item.
- **Multi-replica progress fanout wants Redis.** A Postgres-backed progress path exists; real-time fanout across replicas is what the optional dependency is for.
- **Pre-1.0.** Pin an exact version.

### 4.3 What has not been evaluated

No security review of the runner was performed — this was a fit assessment from documentation and source structure, not an audit. Before adoption: review its input validation and deserialization path (payloads originate, indirectly, from app callers), confirm the admin UI can be disabled entirely rather than merely authenticated, and confirm behaviour when the jobs database is unreachable at boot.

### 4.4 The alternative

If a second language runtime is refused, the decision becomes **build a minimal TypeScript runner**: enqueue, lease, heartbeat, sweep, retry, result-with-TTL, progress. That is a much smaller feature than any candidate above — no cron, no DI, no admin UI, no rate limiting, no batches — and a much larger build than adopting one, with the lease/sweeper correctness being the part that is easy to get subtly wrong. ADR-0045's seam means this choice can be revisited without touching anything outside the container.

---

## 5. Questions for the pilot app's owners

None of these has been put to them, and the first two have been open since the original fit assessment.

1. **Is the research quality tied to OpenAI's search behaviour, or would a re-tuned equivalent on Anthropic be acceptable?** This decides A vs C in §3 and is the single highest-value unknown.
2. **Does the work need to survive the tab closing and the server restarting?** The reference implementation's own recovery path suggests they have been bitten; confirm rather than assume.
3. **Who is allowed to edit the prompt templates?** Today they are runtime-editable shared state with no history table and no per-editor authorization. On this platform that is a per-app RBAC question, and per-app RBAC is not built.

---

## 6. Research gaps

Honest list of what is asserted rather than verified:

- **OpenAI's usage reporting for search counts and its error semantics** were not confirmed against primary documentation; the Anthropic equivalents were. This matters for §2.4's metering work if option C is ever taken.
- **Vendor pricing moves.** Both per-search prices and the per-token rates in `MODEL_PRICING` carry an existing "verify before relying on these for billing" caveat. The §3 cost multipliers are directional, not quotable.
- **The per-search cost of a real run is unmeasured.** The dominant variable is how many searches one phase actually performs, which the prompt strongly influences and nobody has instrumented. A single measured run would convert most of §3's cost argument from estimate to fact, and is the cheapest next experiment available.
- **Connection-budget impact is reasoned, not measured**, against an item that is itself filed as unmeasured.
