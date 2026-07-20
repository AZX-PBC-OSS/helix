# 0008. LLM vendor key resolved by egress (legacy fallback removed)

**Status:** Accepted; amended 2026-07-20 — legacy fallback removed (issue #10)
**Related:** `apps/edge/src/server.ts`; ADR [0005](0005-ssrf-egress-controls.md), [0013](0013-egress-trust-model.md); review ISSUE-03

## Context

The `/_api/llm/chat` proxy needs the vendor key, but the edge must never hold a secret (ADR [0001](0001-three-runtime-split.md)). Early development needed `pnpm dev:edge` to work without a running egress service.

## Decision

The vendor key is a `platform`-scoped connection secret resolved and injected by **egress**, not held by the edge: the edge keeps the policy (allowlist, budget, metering, SSE relay) and mints an `llm` attested instruction; egress injects the key. This is the **only** runtime path — there is no direct edge→Anthropic fallback. When egress is unconfigured the LLM capability fails **closed** (503), like the other unconfigured capabilities.

## Consequences

- The edge never holds the vendor key — consistent with the containment model, in every environment.
- Provider selection in `server.ts` is binary: egress + instruction key present → `EgressLlmProvider`; otherwise `null` → 503.
- Local dev runs the canonical path via `pnpm dev:egress`; the key is provisioned once by sealing it into the secret store (`pnpm --filter @azx-pbc/portal seed:llm`), not read from the edge env.
- The `AnthropicProvider` class is retained but **test-only** (unit-tested with a constructor-injected mock dispatcher); it is never selected at runtime.

## Resolution (2026-07-20, issue #10)

The legacy direct path (`AnthropicProvider` reading `EDGE_LLM_ANTHROPIC_KEY`) was **removed** rather than guarded. It had no production guard at all: if egress config was accidentally removed but `EDGE_LLM_ANTHROPIC_KEY` was set, prod silently routed the key through the edge (ISSUE-03, fail-open). A `NODE_ENV === "production"` guard was rejected as fragile (staging ≠ production; env-copy mistakes). Removal was verified to break nothing — tests inject `FakeLlmProvider` / a mock dispatcher, and `pnpm dev:egress` covers local dev. `EnvSecretProvider` (`secrets-provider.ts`) was deleted with it; the edge no longer reads `EDGE_LLM_ANTHROPIC_KEY`.

## Review notes (2026-06-25)

5/5 reviewers flagged the unguarded fallback; one rated it Critical. Direction confirmed (egress is canonical); the fallback needs a prod guard or removal.

## Challenge outcome (2026-06-26)

WEAKEN — and worse than the open question implies: the fallback is **entirely ungated** (no `NODE_ENV` reference in `server.ts` at all), not merely missing a prod guard. Verified that **removal breaks nothing** — tests inject `FakeLlmProvider`, `provider.test.ts` injects a mock dispatcher, and `pnpm dev:egress` covers local dev. Decision: **remove** `AnthropicProvider` from runtime selection (keep it test-only) and fail closed (503) when egress is unconfigured, rather than a fragile `NODE_ENV` guard (staging ≠ production, env-copy). Filed as **#10**.
