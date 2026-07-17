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

## Challenge outcome (2026-06-26)

The Phase-1 P0 admin story demands a **tamper-evident** audit log; this ledger is not one, and "append-only by grant" is weaker than the Decision implies (filed as **#17**, Important).

- **"Append-only" binds only the edge.** `helix_edge` is INSERT-only, but **`helix_portal` has `UPDATE`/`DELETE`** on `gateway_calls` (`migration.sql:30-31`), so the control-plane role / schema owner / a portal RCE can rewrite or delete history. (The `schema.prisma:187` comment claiming the portal "never writes" these rows contradicts that grant.)
- **Hash-chaining alone is not the fix.** It's the right primitive (RFC 9162 CT, QLDB), but against a *privileged writer* an in-DB chain is forgeable — the writer recomputes every downstream hash. **External anchoring** of the chain head to a write-only sink outside the writer's control (the §8 immutable sink, `platform-architecture.md:285`) is the **load-bearing** part. Tamper-evident ≠ tamper-proof.
- **GDPR:** two defensible paths, not one — crypto-shredding (per-subject key, hashes over ciphertext) for content/PII rows; a documented legal-obligation/legitimate-interest retention basis (Art. 17(3)) for the metering tuple.

**Sequenced fix:** (1) pre-M5, one line — revoke `helix_portal` `UPDATE`/`DELETE` on `gateway_calls` (makes append-only true for every writer role, aligns the grant with the `schema.prisma:187` comment); (2) fast-follow before any external audit — hash chain + Merkle + external anchoring; (3) GDPR per above. Severity Important (the single-trusted-operator pilot bounds insider risk today).
