# 0008. LLM vendor key resolved by egress + legacy fallback

**Status:** Accepted (revisit — remove/guard the fallback)
**Related:** `apps/edge/src/server.ts`; ADR [0005](0005-ssrf-egress-controls.md), [0013](0013-egress-trust-model.md); review ISSUE-03

## Context

The `/_api/llm/chat` proxy needs the vendor key, but the edge must never hold a secret (ADR [0001](0001-three-runtime-split.md)). Early development needed `pnpm dev:edge` to work without a running egress service.

## Decision

The vendor key is a `platform`-scoped connection secret resolved and injected by **egress**, not held by the edge: the edge keeps the policy (allowlist, budget, metering, SSE relay) and mints an `llm` attested instruction; egress injects the key. A **legacy direct path** (`AnthropicProvider` reading `EDGE_LLM_ANTHROPIC_KEY`) remains as a deprecated dev fallback when egress is unconfigured.

## Consequences

- In the egress path the edge holds no key — consistent with the containment model.
- The legacy fallback is convenient for local dev but means the edge *can* hold the key.
- The provider selection in `server.ts` prefers egress and only falls back when egress + instruction key are absent.

## Open question / required hardening

The fallback has **no production guard**: if egress config is accidentally removed but `EDGE_LLM_ANTHROPIC_KEY` is set, prod silently routes the key through the edge (ISSUE-03, fail-open). Refuse to select `AnthropicProvider` when `NODE_ENV === "production"` (fail closed / 503), or remove the legacy path entirely.

## Review notes (2026-06-25)

5/5 reviewers flagged the unguarded fallback; one rated it Critical. Direction confirmed (egress is canonical); the fallback needs a prod guard or removal.

## Challenge outcome (2026-06-26)

WEAKEN — and worse than the open question implies: the fallback is **entirely ungated** (no `NODE_ENV` reference in `server.ts` at all), not merely missing a prod guard. Verified that **removal breaks nothing** — tests inject `FakeLlmProvider`, `provider.test.ts` injects a mock dispatcher, and `pnpm dev:egress` covers local dev. Decision: **remove** `AnthropicProvider` from runtime selection (keep it test-only) and fail closed (503) when egress is unconfigured, rather than a fragile `NODE_ENV` guard (staging ≠ production, env-copy). Filed as **#10**.
