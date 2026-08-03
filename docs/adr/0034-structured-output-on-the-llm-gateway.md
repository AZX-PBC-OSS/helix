# ADR-0034 — Structured output on the LLM gateway (both surfaces)

## Status

Accepted. Amends [ADR-0033](0033-openai-compatible-gateway-surface.md) §3, which
listed `response_format` among the behaviour-changing params rejected with a `400`.

## Context

ADR-0033 scoped both gateway surfaces — the native `POST /_api/llm/chat` and the
OpenAI-compatible `POST /_api/openai/v1/chat/completions` — to **text chat only**,
rejecting `response_format` alongside `tools`, `seed`, `n`, and the rest, "never
silently dropped."

That carve-out was written for one reason: the neutral seam carries text deltas only
(`LlmStreamEvent = {type:"delta"; text} | {type:"done"; …}`). Tool calling breaks
that — a tool call is a non-text content block, so supporting it means new event
variants, new codec framing (`writeDelta` carries a `string`), and new branches in
both `mapAnthropicStream` and `mapOpenAiStream`. Bundling `response_format` into the
same deferral treated the two as one problem.

They are not. **Structured output returns schema-constrained JSON as ordinary
text** — Anthropic in `text_delta` blocks, OpenAI in `delta.content`. It rides the
existing delta path with no seam change at all. So the cost of shipping it is
request-shape translation plus a per-model capability check, while the benefit is
large: reliable machine-readable output is what a vibe-coded app needs to render a
form, a table, or a chart, and today every such app has to prompt-beg for JSON and
parse defensively.

Two facts constrain the design. First, the vendors spell it differently: Anthropic
takes `output_config.format = {type, schema}`, OpenAI takes
`response_format = {type, json_schema:{name, schema, strict}}` and *requires* a
`name`. Second, support is **not uniform within either vendor's line-up** — of the
six curated Anthropic models, `claude-fable-5`, `claude-opus-4-8` and
`claude-haiku-4-5` can enforce a schema while `claude-opus-4-7`, `claude-opus-4-6`
and `claude-sonnet-4-6` cannot.

## Decision

1. **A neutral `responseFormat` field**, not a passed-through vendor param.
   `LlmChatRequestSchema` gains an optional
   `responseFormat: {type:"json_schema", name?, schema}`. Both codecs translate into
   it and both vendor body builders translate out of it, preserving the ADR-0033
   property that the app speaks the platform's contract and never smuggles raw vendor
   parameters past the manifest allowlist. Anthropic receives `type` + `schema` only;
   `name` is OpenAI-shaped (OpenAI requires one, defaulted to `"response"`) and is
   not forwarded there.

2. **Enforcement is unconditional — there is no `strict` knob.** Anthropic's
   `output_config.format` always enforces and has no best-effort mode, so a
   `strict:false` could only ever be honored on one vendor: the *same* request would
   yield schema-violating JSON on `gpt-*` and conforming JSON on `claude-*`, which is
   precisely the provider leak this seam exists to prevent (and a live footgun for an
   app that trusts the shape). The OpenAI upstream is therefore always sent
   `strict: true`. On the OpenAI surface, an incoming `json_schema.strict` is
   **accepted and ignored** rather than rejected — stock clients routinely omit it
   (OpenAI's own default is `false`), so refusing it would break them for nothing,
   and enforcement is strictly stronger than what a `false` asks for. This is the one
   place the gateway serves something *more* than the client requested; it is safe
   only because the guarantee is being tightened, never loosened.

3. **`json_schema` is the only mode.** OpenAI's looser `{type:"json_object"}` has no
   Anthropic equivalent, so serving it would make behaviour depend on which vendor
   happens to back the model — a provider leak through a seam whose whole purpose is
   to prevent one. It is rejected with a `400` naming `response_format.type`.
   `{type:"text"}` is OpenAI's explicit default and **is** served, as a no-op, on the
   same principle that already serves `tool_choice:"none"` and `n:1`.

4. **Per-model, refused up front.** `ModelPrice` gains a `structuredOutputs?` bit
   (alongside `reasoning?`), so the curated catalog stays the single source of truth
   for pricing, routing, *and* capability. A `responseFormat` request naming a model
   that can't enforce one is refused with a `400` before any upstream call, rather
   than surfacing as an opaque `502` after a round trip. The model remains fully
   usable for plain text chat.

5. **Ungated.** No manifest field and no approval-classifier change. Structured
   output adds no egress path, no secret, and no new cost class — spend is already
   bounded by `capabilities.llm.dollarsPerDay` off the frozen `costMicroUsd` ledger
   column — so a grant would add approval friction while reducing blast radius by
   nothing. Any app already holding an `llm` grant can use it.

6. **Guards at the boundary, validation left to the vendor.** The schema is
   app-supplied input that reaches the trusted edge path and is walked before any
   quota check runs, so `LlmResponseFormatSchema` enforces an object root plus a
   budget (≤ 32,768 characters serialized, ≤ 12 levels deep). Beyond that the schema
   is forwarded as-is and the vendor validates its own JSON Schema subset — the same
   division of labour as `temperature`. The edge deliberately does not reimplement
   either vendor's subset rules; doing so would add trusted-path code that goes stale
   every time a vendor relaxes a constraint.

7. **The response envelope does not change.** `LlmChatResponse.content` and
   `choices[].message.content` stay strings holding the JSON; callers `JSON.parse`.
   This matches what both vendors return and keeps `LlmStreamEvent`, `writeDelta`,
   `mapAnthropicStream`, `mapOpenAiStream`, and every SSE frame shape untouched.

## Consequences

- **The seam is unchanged.** No new stream-event variant, no codec-interface change,
  no new `ApiErrorCode` (the refusals reuse `validation_failed`, which the OpenAI
  codec already renders as `invalid_request_error`). The whole of `llmCodec.ts` and
  both stream mappers are byte-identical.
- **One contract reversal.** `response_format` used to be a `400`; it is now served.
  The ADR-0033-era test asserting the rejection was replaced rather than removed, and
  `OPENAI_UNSUPPORTED_PARAMS` no longer lists it. Clients that relied on the `400` —
  there should be none, since it was a refusal — see a `200`.
- **`error.param` needed a neutral→wire mapping.** The handler owns policy and speaks
  the neutral vocabulary (`responseFormat`), but an OpenAI client expects `param` to
  name its own field. A small `NEUTRAL_TO_OPENAI_PARAM` record inside the OpenAI
  codec's `error` does the rename, keeping policy in the handler and wire vocabulary
  in the codec without widening `LlmWireCodec`.
- **The catalog carries a third kind of fact.** `MODEL_PRICING` now drives pricing,
  routing, and structured-output capability. That keeps them from drifting, but means
  adding a model requires deciding the bit — the tests pin the three unsupported
  models explicitly so a future edit can't flip one on silently.
- **Refusals already work.** A model can decline under a schema; OpenAI's
  `delta.refusal` was already mapped to the neutral `refusal` stop reason and metered
  as `outcome:"refusal"`, and Anthropic's arrives via `message_delta`. No change.
- **Deferred:** tool-calling translation (still, and for the original reason);
  `{type:"json_object"}`; surfacing OpenAI's `refusal` string on the response
  envelope, which *would* require the seam widening this decision avoids; and any
  ledger column recording that a call used structured output — cost is already
  token-based, so it would buy analytics, not correctness.
