# ADR-0047 — Operator-declared servable model set (allowlist/blocklist), catalogue-side only

**Related:** ADR [0036](0036-deployment-capability-catalogue.md) (the catalogue, whose v1 scoping
this amends), ADR [0046](0046-azure-ai-foundry-keyless-llm-backend.md) (the deployment shape that
forced this), ADR [0016](0016-capability-manifest-approval-classifier.md) (the classifier this
deliberately does not touch).

## Status

Accepted.

## Context

The platform's model catalogue is a build-time constant (`MODEL_PRICING` in
`packages/shared/src/pricing.ts`), and ADR-0036's catalogue endpoint derives the *servable* subset
at runtime from seeded `platform` secrets. Two pressures showed that derivation is not enough:

1. **Keyless Foundry is invisible to it.** ADR-0046's default wires the LLM families to managed
   identity (`foundry`/`foundry-openai` connections) and seeds no `anthropic`/`openai` secret at
   all — so on exactly the deployment shape ADR-0046 sells, the heuristic reports **zero** servable
   models and the rendered skill lists none, while the SPA's model picker (build-time
   `Object.keys(MODEL_PRICING)` — it never called the catalogue endpoint) showed all ~20, including
   models the account has no deployment for. Both surfaces wrong, in opposite directions.
2. **Per-subscription liveness is real and per-model.** Measured against a live pay-as-you-go
   subscription (eastus2, 2026-09-16): the Foundry RP refuses any model whose *default* version is
   `Deprecating`, and `claude-sonnet-5` / the Fable line have **zero** `GlobalStandard` quota on a
   fresh subscription — and because `foundry.bicep` applies `@batchSize(1)`, the first refusal
   aborts the whole apply. Which models are live is a fact about *this* deployment's subscription
   and upstreams, not about the platform build.

The full-fat answer — a dynamic catalogue discovered from the upstream — was considered and
rejected: pricing, routing, and structured-output capability are per-model code facts
(`ModelPrice`), and a discovered model the code doesn't know would be unpriceable and uncallable.
The investment isn't warranted.

## Decision

1. **The `foundryModels` default ships only what a fresh subscription can deploy.** Audited
   2026-09-16: out come the Deprecating-default models (`gpt-4o-mini`, `o3`, `o4-mini`), the
   zero-quota Claude entries (`claude-sonnet-5`, `claude-fable-5`, `claude-fable-5-1`), and the
   unverifiable `gpt-4.1` family. The Deprecating three also leave `MODEL_PRICING` itself (cut from
   the catalogue as well as the default — the current generation covers their price points, and
   "kept curated so old manifests work" stops being a reason once the biggest deployment path
   refuses them outright). Everything else stays catalogued: zero quota is per-subscription, so the
   platform must keep supporting those models for first-party and quota-having Foundry installs.
2. **Two operator env vars declare the servable set** (portal-only, parsed per call in
   `apps/portal/src/policy/modelPolicy.ts`): `PORTAL_LLM_MODEL_ALLOWLIST` — when set, it **is** the
   servable set, *replacing* the seeded-secret heuristic (the only semantics that fixes keyless
   Foundry, where the heuristic's inputs legitimately don't exist); and
   `PORTAL_LLM_MODEL_BLOCKLIST`, subtracted in either mode. Both are intersected with
   `MODEL_PRICING`; entries naming no catalog model are dropped and warn-logged
   (`catalogue.unknown_model_policy_entries`) at catalogue-build time. An allowlist can therefore
   narrow but never extend the catalog — that is the dynamic-catalogue refusal, enforced.
3. **The Bicep derives the allowlist from `foundryModels` when `deployFoundry` is on and no
   explicit `llmModelAllowlist` is set.** Deployment names are catalog ids by construction
   (ADR-0046), so the deploy-time truth the operator already wrote flows to the portal env, and
   pruning `foundryModels` prunes the catalogue on the next apply. BYO/first-party installs get the
   same two params by hand.
4. **The SPA's model picker renders the catalogue**, not the bundle: `ModelAllowlist` consumes
   `GET /api/v1/capabilities` (`llm.models`) and keeps rates from the build-time `priceForModel` (a
   price is a per-model fact; only the list varies per deployment). A granted-but-withheld model
   renders flagged ("withheld on this deployment") and removable, never invisible. Until the
   catalogue lands the picker shows a loading/failed note — the same null-is-deliberate posture as
   the rendered skill (ADR-0036).
5. **The classifier is untouched.** The restriction is display-surface policy: a hand-written
   manifest naming a withheld-but-priced model still classifies baseline (it *is* curated), saves,
   and then fails at the upstream — the documented backstop for a catalog model with no deployment.
   Elevating it instead was considered and rejected for v1: the honest surfaces (picker, skill,
   catalogue) are where a model gets chosen, and the failure mode for a bypassing manifest is loud
   at call time, not silent.

## Consequences

- **The keyless-Foundry catalogue bug is closed by construction**, and the ADR-0036 v1 scoping
  bullet ("servable models are derived from seeded `platform` secrets") is amended: that heuristic
  is now the *fallback*, consulted only when no allowlist is declared.
- **A stale allowlist misadvertises in the safe direction.** Prune a model from the upstream
  without updating a hand-set allowlist and the catalogue offers a model that 404s at call time —
  the same accepted failure as any not-deployed catalog model. The Foundry auto-derivation makes
  the common path self-maintaining; the failure requires overriding it and then drifting.
- **The three cuts from `MODEL_PRICING` are a real break**: an existing manifest naming
  `gpt-4o-mini`/`o3`/`o4-mini` now gets `403 model_not_allowed` (no price configured). Accepted
  pre-pilot — no deployed app holds one, and the alternative was advertising models the primary new
  deployment path refuses.
- **Two places enumerate OpenAI model ids, one of them historical.** `docs/adr/0033` keeps its
  2026 snapshot (ADRs are dated records); `docs/features/llm-gateway.md` tracks the cut. The
  rendered skill's structured-output prose still names the Fable line's capability bit — true of
  the catalog regardless of what a deployment serves; accepted drift rather than a fourth template
  variable.
- **Operator typos cannot hurt.** Unknown ids drop with a warn at catalogue-build time (a
  low-traffic route); boot is never blocked on a display-policy value.
- **Deferred, unchanged:** catalogue-driven manifest validation in the CLI (ADR-0036), an
  edge-side refusal for withheld models (the upstream 404 remains the backstop), and any
  `/health`-based edge family reporting to close the single-vendor-wiring gap the heuristic still
  has when no allowlist is set (ADR-0036 Implementation notes).
