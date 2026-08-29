# 0021. Metering/audit ledger: `gateway_calls`, append-only, token budgets + frozen cost

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; shipped in M4)_
**Related:** `docs/features/llm-gateway.md`; `packages/shared/src/{usage,pricing}.ts`; `apps/edge/src/gateway/usage.ts`; `apps/portal/prisma/schema.prisma`; ADR [0002](0002-postgres-role-split-rls.md)

## Context

Every gateway call (LLM, data, fetch) must be metered, audited, and budget-enforced. Pricing may change over time, and the audit trail must resist tampering by a compromised edge.

## Decision

One **append-only** `gateway_calls` row per call: `(appId, userOid, capability, model, inputTokens, outputTokens, outcome)` plus a **frozen, as-charged `costMicroUsd`** priced at write time from a **code-resident rate table** (`@azx-pbc/shared/pricing.ts`). `helix_edge` has **INSERT-only** (+ `SELECT` for budget sums) — no `UPDATE`/`DELETE` — so integrity rests on the DB grant set, not a hash chain.

- **Daily budgets are token/request-denominated** (`tokensPerDay`, `requestsPerDay`), not USD — a coarse, predictable ceiling.
- **Quota is block-new / finish-in-flight:** an admitted request always runs to completion; the *next* request is the one blocked once the budget is crossed.
- The portal recomputes `costUsd` for dashboards from the same rate table at read time.

## Consequences

- Append-only-by-grant resists edge-RCE tampering (but is **not** cryptographically immutable — a real immutable sink is deferred).
- Cost is **frozen per call**, so a later rate change never rewrites history; pricing lives in versioned code.
- Token-denominated budgets stay stable across price changes; dollars are a derived view, not the enforcement unit.
- The ledger is a metering + budget primitive, deliberately narrow (no latency/error-detail/size) — not an observability sink.

> Note: `docs/features/llm-gateway.md` was reconciled (2026-07) to document the frozen `costMicroUsd` column — the earlier "tokens, not dollars / no cost column" wording is gone.

## Challenge outcome (2026-06-26)

The Phase-1 P0 admin story demands a **tamper-evident** audit log; this ledger is not one, and "append-only by grant" is weaker than the Decision implies (filed as **#17**, Important).

- **"Append-only" binds only the edge.** `helix_edge` is INSERT-only, but **`helix_portal` has `UPDATE`/`DELETE`** on `gateway_calls` (`migration.sql:30-31`), so the control-plane role / schema owner / a portal RCE can rewrite or delete history. (The `schema.prisma:187` comment claiming the portal "never writes" these rows contradicts that grant.)
- **Hash-chaining alone is not the fix.** It's the right primitive (RFC 9162 CT, QLDB), but against a *privileged writer* an in-DB chain is forgeable — the writer recomputes every downstream hash. **External anchoring** of the chain head to a write-only sink outside the writer's control (the §8 immutable sink, `platform-architecture.md:285`) is the **load-bearing** part. Tamper-evident ≠ tamper-proof.
- **GDPR:** two defensible paths, not one — crypto-shredding (per-subject key, hashes over ciphertext) for content/PII rows; a documented legal-obligation/legitimate-interest retention basis (Art. 17(3)) for the metering tuple.

**Sequenced fix:** (1) pre-M5, one line — revoke `helix_portal` `UPDATE`/`DELETE` on `gateway_calls` (makes append-only true for every writer role, aligns the grant with the `schema.prisma:187` comment); (2) fast-follow before any external audit — hash chain + Merkle + external anchoring; (3) GDPR per above. Severity Important (the single-trusted-operator pilot bounds insider risk today).

## Amendment (2026-08-28): the metering tuple now includes a request path

The fetch-proxy records the proxied request's `path` and `method`
(`docs/features/fetch-proxy.md`). This widens "the metering tuple" that the
challenge outcome above rests an Art. 17(3) retention basis on, and the widening
is not neutral for the GDPR question:

- A third-party request path routinely embeds personal data — `/users/<email>`,
  `/customers/<id>`, `/documents/<doc-id>`. The rest of the tuple (app, user oid,
  capability, model, tokens, outcome) is platform-generated; a path is not.
- The "it is already logged" argument does **not** fully carry. `redactFetchTarget`
  does keep `origin + pathname` in request logs, but those expire (30-day Log
  Analytics retention, ADR-0037), whereas `gateway_calls` has no `DELETE` grant
  for any role and no pruning job. This moves the value from an expiring store
  into a non-expiring one.

Accepted, with the mitigations below. The erasure path stays open under sequenced
fix (3) — `path` is a reason to prefer crypto-shredding over the retention-basis
argument alone if the ledger ever holds a subject's data that Art. 17 reaches.

**Correction (same date): excluding the query string does not make `path`
credential-free.** An earlier draft of this amendment, and several code comments,
framed the query-string exclusion as the mitigation *for credentials*. That is
wrong, and the claim has been removed everywhere it appeared. The query is where
credentials are *conventionally* placed, but a real class of APIs puts the secret
in a path segment — Telegram `/bot<TOKEN>/sendMessage`, Slack and Discord webhooks
`/services/T…/B…/<secret>`, various signed-URL schemes. Those are now retained.

**No detection heuristic will be added**, and this is a decision rather than an
omission. A token segment and a REST resource id are the same shape: any entropy
or length test that catches `/bot<TOKEN>` also catches `/customers/<uuid>/orders`,
which is precisely the value the column exists to capture. A heuristic would
degrade the feature while still missing structured tokens — the worst of both.

The mitigations are therefore **bounding, not detection**, and none of them is a
substitute for retention:

- The query string is still excluded — it removes the largest and most
  conventional share of the exposure, just not all of it.
- `path` is truncated at write time (`fetchPathOf`), and `model`/`errorDetail`
  are truncated in the store (`clampRecord`), because all three are app-controlled.
- Allowlist-denial rows — the ones whose paths cleared no authorization check at
  all — are rate-capped per (app, env) by `DenialThrottle`, so an app cannot
  append to this table at line rate.

**That cap bounds the rate, not the total.** N per window forever is still
unbounded growth on a table with no `DELETE` grant for any role and no pruning
job. Retention (sequenced fix 3, and the deferred item in `TODO.md`) remains the
actual fix; nothing in the fetch-path work closes it.
