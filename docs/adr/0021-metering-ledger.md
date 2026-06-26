# 0021. Metering/audit ledger: `gateway_calls`, append-only, token budgets + frozen cost

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; shipped in M4)_
**Related:** `docs/features/llm-gateway.md`; `packages/shared/src/{usage,pricing}.ts`; `apps/edge/src/gateway/usage.ts`; `apps/portal/prisma/schema.prisma`; ADR [0002](0002-postgres-role-split-rls.md)

## Context

Every gateway call (LLM, data, fetch) must be metered, audited, and budget-enforced. Pricing may change over time, and the audit trail must resist tampering by a compromised edge.

## Decision

One **append-only** `gateway_calls` row per call: `(appId, userOid, capability, model, inputTokens, outputTokens, outcome)` plus a **frozen, as-charged `costMicroUsd`** priced at write time from a **code-resident rate table** (`@helix/shared/pricing.ts`). `helix_edge` has **INSERT-only** (+ `SELECT` for budget sums) — no `UPDATE`/`DELETE` — so integrity rests on the DB grant set, not a hash chain.

- **Daily budgets are token/request-denominated** (`tokensPerDay`, `requestsPerDay`), not USD — a coarse, predictable ceiling.
- **Quota is block-new / finish-in-flight:** an admitted request always runs to completion; the *next* request is the one blocked once the budget is crossed.
- The portal recomputes `costUsd` for dashboards from the same rate table at read time.

## Consequences

- Append-only-by-grant resists edge-RCE tampering (but is **not** cryptographically immutable — a real immutable sink is deferred).
- Cost is **frozen per call**, so a later rate change never rewrites history; pricing lives in versioned code.
- Token-denominated budgets stay stable across price changes; dollars are a derived view, not the enforcement unit.
- The ledger is a metering + budget primitive, deliberately narrow (no latency/error-detail/size) — not an observability sink.

> Note: `docs/features/llm-gateway.md` still says "tokens, not dollars … no cost column" — **stale**; the `costMicroUsd` column exists. Reconcile that doc.
