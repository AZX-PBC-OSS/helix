# ADR-0033 — OpenAI-compatible gateway surface and multi-provider routing

## Status

Accepted. §3's scope clause is amended by
[ADR-0034](0034-structured-output-on-the-llm-gateway.md): `response_format`
(structured output) is now served on both surfaces. Tool calling remains deferred.

## Context

The LLM gateway (ADR-0008, `docs/features/llm-gateway.md`) exposes one surface,
`POST /_api/llm/chat`, in a **platform-neutral** wire shape, backed by a single
Anthropic upstream routed through `azx-egress`. Two pressures push against that:

1. **The de-facto standard is OpenAI's `/v1/chat/completions`.** Our consumers are
   vibe-coded apps and the tools/LLMs that generate them; they reach for the OpenAI
   SDK (or a framework that speaks its base-URL contract) by default. Making apps
   bind to a bespoke shape is friction the platform doesn't need to impose.
2. **Apps want to name real models across vendors** — both `claude-*` and `gpt-*`/`o*`
   — not an aliased subset routed to one vendor.

A separate, larger question — a self-hosted multi-provider gateway (Warden) — is
being evaluated (see the Warden integration discussion). This ADR must not foreclose
it, and ideally should be the seam it slots into.

## Decision

Add an **OpenAI-compatible surface alongside** the native one, and make the LLM
upstream **multi-provider**, without disturbing the security/metering spine.

1. **Wire codec seam.** `makeLlmHandler(rt, codec)` keeps all policy + metering and
   speaks the neutral shape; a `LlmWireCodec` owns only the request/response
   envelope. `nativeCodec` is the unchanged `/_api/llm/chat`; `openAiCodec` backs
   `POST /_api/openai/v1/chat/completions`. Same runtime, same guarantees, byte-
   identical native behaviour (its tests do not move).

2. **Path.** `/_api/openai/v1/…` in the reserved app-host namespace, so an app sets
   its OpenAI client `baseURL = <origin>/_api/openai/v1`. The `__Host-session`
   cookie authenticates same-origin; the SDK `apiKey` is ignored. `GET
   …/v1/models` lists the app's allowlisted models. Mirrored on the dev-gateway.

3. **Scope: text chat only (v1).** Affirmative tool use, `role:"tool"`, multimodal
   (array) content, and behaviour-changing sampling/output params
   (`seed`, `n`, `logit_bias`, `presence_penalty`,
   `frequency_penalty`, `logprobs`, `top_logprobs`) are rejected with a clear `400`
   naming the field (`error.param`), never silently dropped — the neutral seam and
   `mapAnthropicStream`/`mapOpenAiStream` carry text deltas only. `temperature`,
   `top_p`, and `stop` **are** forwarded (both vendors accept them). Opting out of
   tools (`tool_choice:"none"`, empty `tools:[]`) is served. Tool-calling
   translation is deferred. (`response_format` was originally in this list;
   ADR-0034 now serves it — structured output returns JSON as ordinary text
   deltas, so it needs none of the seam changes tool calling does.)

   **`max_tokens`** follows OpenAI convention: it is optional on the neutral shape;
   the OpenAI builder omits the upstream cap when unset (→ model max) rather than
   forcing a default (Anthropic requires the field, so its builder defaults it,
   preserving native behaviour). o-series reasoning models take
   `max_completion_tokens`, floored (`ModelPrice.minCompletionTokens`) so reasoning
   can't consume the whole budget and return billed-empty output.

   **Metering integrity:** OpenAI reports usage only in a trailing chunk, so a
   truncated stream must not record a silent $0 `ok` — `mapOpenAiStream` surfaces an
   error when a stream ends without a usage block. The app-visible `chatcmpl-` id is
   a UUID distinct from the internal egress `requestId`/`jti`.

4. **Model→upstream routing is a catalog fact.** `MODEL_PRICING` gains a `provider`
   field; `RoutingLlmProvider` dispatches on `providerForModel(model)`. Pricing and
   routing therefore share one source of truth and can't drift. There is no id-space
   overlap between the `claude-*` and `gpt-*`/`o*` families, so the flat table is
   unambiguous. A curated model whose family upstream isn't wired on this edge 503s
   before a stream opens (`supports()` pre-check).

5. **OpenAI upstream = an OpenAI-compatible base URL.** A second `EgressLlmProvider`
   (generalized to a vendor descriptor) points at `EDGE_LLM_OPENAI_ENDPOINT`
   (default `https://api.openai.com`). It is wired **symmetrically with Anthropic**:
   the connection name defaults to `openai` (`EDGE_LLM_OPENAI_CONNECTION`, mirroring
   Anthropic's default `anthropic`) and is always in the routing table when egress is
   up. **Enabling OpenAI is just seeding its `platform` key secret** — no dedicated
   toggle. The edge still never holds the key — egress resolves + injects it (default
   `header-bearer` → `Authorization: Bearer …`), exactly as for Anthropic. **Because
   the base URL is config, pointing it at Warden later is a config change, not a
   rewrite** — this is the seam Warden slots into. (`RoutingLlmProvider` still accepts
   a null vendor and 503s an unsupported model — the defensive path for a hand-wired
   or single-vendor provider — but the default server wires both.)

6. **New OpenAI models are curated (no approval).** They join `MODEL_PRICING`, so
   `CURATED_LLM_MODELS = Object.keys(MODEL_PRICING)` picks them up; the per-app
   manifest allowlist + USD budget still gate every call. Seeded: `gpt-4o`,
   `gpt-4o-mini`, `gpt-4.1{,-mini,-nano}`, `o3`, `o4-mini`.

## Consequences

- **No change to the containment model.** The edge holds no vendor key; egress is
  already vendor-agnostic (data-driven injection recipe), so OpenAI needed **zero**
  egress code — only a seeded `platform` secret. Metering stays authoritative on the
  edge, denominated in USD off the catalog.
- **Enabling OpenAI is operational and symmetric with Anthropic:** create the
  `platform` secret named `openai` (override `EDGE_LLM_OPENAI_CONNECTION`/`_ENDPOINT`
  only for a non-default upstream such as Warden). A deployment that doesn't seed it
  and doesn't allowlist `gpt-*` models runs Anthropic-only, unchanged; allowlisting a
  `gpt-*` model without the secret 502s at call time, exactly as an unseeded Anthropic
  key would.
- **Pricing is a standing maintenance item.** The seeded OpenAI rates must be
  verified against OpenAI's current published prices; they drive the cost gate.
- **o-series quirks are handled** (`max_completion_tokens`, no `temperature`;
  reasoning tokens already folded into `completion_tokens`), flagged via a catalog
  `reasoning` bit.
- **Deferred:** tool-calling translation, `/v1/embeddings` and other modalities, and
  any OpenAI model-name aliasing. Each is additive behind the same seams.
