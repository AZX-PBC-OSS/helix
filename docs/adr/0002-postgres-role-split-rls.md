# 0002. Postgres least-privilege role split + RLS

**Status:** Accepted
**Related:** ADR [0001](0001-three-runtime-split.md); review ISSUE-05, ISSUE-12, ISSUE-13

## Context

The runtime split (ADR [0001](0001-three-runtime-split.md)) is a process boundary. An in-process compromise (RCE) bypasses it unless the database enforces the same boundary independently.

## Decision

Each runtime connects as a distinct least-privilege Postgres role:

- **`helix_portal`** — full DML runtime role for the control plane. It is **not** the schema owner: migrations run as the `helix` owner (Prisma), so a portal RCE holds DML but cannot `DROP TABLE` or bypass RLS as owner/superuser.
- **`helix_edge`** — explicit per-table grants only: read the registry projection, append-only metering, INSERT-only on collection items, RLS-partitioned `app_data`. **No grant on `app_secrets` at all.**
- **`helix_egress`** — `SELECT` on secrets + `UPDATE` on one `lastUsedAt` column.

App-data isolation uses Row-Level Security with `FORCE ROW LEVEL SECURITY` and `SET LOCAL` GUCs (`app.app_id`, `app.user_oid`) derived from the verified session, set via parameterized `set_config` inside the request transaction. `helix_edge` is `NOBYPASSRLS`.

## Consequences

- An edge RCE cannot read a secret, write the registry, or enumerate another tenant's `app_data` — the grant simply isn't there.
- `SET LOCAL` is transaction-scoped, so a pooled connection can't leak one request's tenant context into the next.
- Cost: hand-managed grants/migrations and RLS policies; mistakes are silent (a missing grant fails closed, an over-broad grant fails open).

## Review notes (2026-06-25)

Verified **sound**: `set_config` is parameterized (no injection), RLS fails closed (missing GUC → NULL → zero rows), `app_secrets` deny confirmed by integration test. Residual hardening, not breaches:
- ~~No `statement_timeout` on edge pools → pool-exhaustion DoS (ISSUE-05).~~ **Resolved (2026-07-21):** every edge pg pool is built through `createEdgePool` (`apps/edge/src/db/pool.ts`), which applies a per-query `statement_timeout` (Postgres-enforced, so it holds even under a starved event loop). Default 10 s, `EDGE_STATEMENT_TIMEOUT_MS` to tune; covers all five stores plus the registry listener's pool and LISTEN client.
- ~~`gateway_calls` global SELECT, no RLS → cross-tenant read (ISSUE-12).~~ **Resolved (2026-07-21):** `gateway_calls` now carries the same `app.app_id`-partitioned FORCE RLS as `app_data` (migration `20260721033820_rls_gateway_calls_collection_items`). The edge sets the GUC on every metering path via the shared `withPartition` helper (`apps/edge/src/db/partition.ts`; `usage.ts` wraps the budget SUMs + the per-call INSERT). See the framing note below — this is a fail-closed backstop, not RCE containment. Isolation asserted in `usage.rls.integration.test.ts`; the control plane's cross-app reads (usage rollups/audit) keep working via a permissive `gateway_calls_portal_all` policy (`portal-rls.integration.test.ts`).
- ~~`app_collection_items` has no RLS → cross-app write pollution (ISSUE-13).~~ **Resolved (2026-07-21):** same migration adds a `WITH CHECK` partition policy so an INSERT can only land in the GUC's app — an appId-confusion bug fails closed instead of polluting another app's collection. INSERT-only grant (the §3.2 write-only containment) is unchanged; `appendCollection` now runs through `withPartition` (`apps/edge/src/gateway/data.ts`). Tested in `data.integration.test.ts`; the owner-facing drain reads via `app_collection_items_portal_all`.
- **`sessions` full DML remains without RLS — deferred, tracked in TODO.md.** Its GC sweeper (`PgSessionStore.sweep`) is deliberately global (no `appId` in scope), which conflicts with an `app.app_id` partition policy; every non-sweep session query is already app-scoped. Needs its own decision (a sweeper carve-out) rather than riding this change.
- Make `NOBYPASSRLS` explicit in the role bootstrap.

**Framing (2026-07-21):** the `gateway_calls` / `app_collection_items` RLS above (like `app_data`'s) is keyed on a `SET LOCAL` GUC the edge sets itself. That is a **fail-closed backstop against application bugs** — a forgotten/wrong `WHERE "appId"` matches zero rows / fails the `WITH CHECK` — and it defeats a naive no-GUC smash-and-grab (`SELECT * FROM gateway_calls` → 0 rows). It is **not** RCE containment: an RCE owns the connection and can `set_config('app.app_id', …)` to any app itself. The genuine RCE boundary in this system is **grant-absence** (no SELECT on `app_secrets`, no registry write), which is unchanged. Earlier "cross-tenant read under edge RCE" phrasing overstated what a GUC-keyed policy delivers.

## Challenge outcome (2026-06-26)

WEAKEN — code claims verified; two **undisclosed** gaps to add (the `statement_timeout` / `sessions`-DML / `NOBYPASSRLS` items are already above):
- An **owner-DSN fallback** — `apps/edge/src/config.ts:304` `EDGE_DATABASE_URL ?? DATABASE_URL`, where `DATABASE_URL` is the schema **owner**. If the role DSN is unset the edge connects as owner and the split is silently defeated. The running compose *does* set the role DSN, so this is a latent footgun — **boot-fail when the role DSN is absent** rather than fall back.
- ~~The **portal connects as the schema owner**, not `helix_portal` (no `PORTAL_DATABASE_URL` exists), so the `helix_portal` grants are effectively dead code.~~ **Resolved (2026-07-21):** the portal runtime now connects as `helix_portal` via `PORTAL_DATABASE_URL` (`apps/portal/src/db/client.ts` `resolvePortalRuntimeUrl`, wired in the dev compose; required in production, owner-DSN fallback refused there — the same prod-strict shape as the edge's `EDGE_DATABASE_URL`). Migrations still run as the `helix` owner. The `helix_portal` grants are now live; the only remaining owner-bypass path in ADR-0002's model is closed. (The "split is silently defeated" thesis was otherwise an overstatement — the live config already ran least-privilege for the edge and the role-split test passed.)

### Shared-table RLS is *not* the classic foot-gun (2026-06-26)

A review flagged "shared-table RLS is a cross-app leak foot-gun." True as a *pattern* (pool tenancy is the most fragile model; some sources avoid RLS), but **not for this implementation** (5-model red-team + best-practice grounding). The classic foot-gun fails *open* (a forgotten `WHERE tenant_id` exposes all rows); Helix's `app_data` policy fails **closed**: a missing GUC → `current_setting(...,true)` is NULL → **zero rows**, INSERT fails the WITH CHECK (`migrations/20260616231036_app_data/migration.sql:35-37`). Combined with `FORCE` + `ENABLE` RLS, `helix_edge` non-owner/NOBYPASSRLS, a **server-derived** predicate, and `SET LOCAL` in an explicit txn (`gateway/data.ts:83-89`) — this is exactly the AWS-recommended pool-model hardening. The two best-practice CI guards already exist: a cross-app isolation test (`data.integration.test.ts:52`) and a forgotten-GUC zero-rows test (`:143`).

The only *present* cross-tenant read path is the **owner/superuser bypass** (a superuser bypasses RLS even with `FORCE`) — i.e. the portal-as-owner / edge owner-DSN items above, not the shared-table choice. **Physical isolation (schema/DB-per-app) is not warranted** — it trades a fail-closed risk for migration explosion + dynamic DDL from the trusted path and doesn't fix the owner bypass. Severity of the shared-table design itself: **Minor** (pattern-awareness). Only additive hygiene: a lint/banned-import forbidding raw `app_data` queries outside `withPartition`, and codifying explicit `NOBYPASSRLS` on `helix_edge` in the prod role bootstrap.
