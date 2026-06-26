# 0002. Postgres least-privilege role split + RLS

**Status:** Accepted
**Related:** ADR [0001](0001-three-runtime-split.md); review ISSUE-05, ISSUE-12, ISSUE-13

## Context

The runtime split (ADR [0001](0001-three-runtime-split.md)) is a process boundary. An in-process compromise (RCE) bypasses it unless the database enforces the same boundary independently.

## Decision

Each runtime connects as a distinct least-privilege Postgres role:

- **`helix_portal`** — full DML; owns the schema and migrations (Prisma).
- **`helix_edge`** — explicit per-table grants only: read the registry projection, append-only metering, INSERT-only on collection items, RLS-partitioned `app_data`. **No grant on `app_secrets` at all.**
- **`helix_egress`** — `SELECT` on secrets + `UPDATE` on one `lastUsedAt` column.

App-data isolation uses Row-Level Security with `FORCE ROW LEVEL SECURITY` and `SET LOCAL` GUCs (`app.app_id`, `app.user_oid`) derived from the verified session, set via parameterized `set_config` inside the request transaction. `helix_edge` is `NOBYPASSRLS`.

## Consequences

- An edge RCE cannot read a secret, write the registry, or enumerate another tenant's `app_data` — the grant simply isn't there.
- `SET LOCAL` is transaction-scoped, so a pooled connection can't leak one request's tenant context into the next.
- Cost: hand-managed grants/migrations and RLS policies; mistakes are silent (a missing grant fails closed, an over-broad grant fails open).

## Review notes (2026-06-25)

Verified **sound**: `set_config` is parameterized (no injection), RLS fails closed (missing GUC → NULL → zero rows), `app_secrets` deny confirmed by integration test. Residual hardening, not breaches:
- No `statement_timeout` on edge pools → pool-exhaustion DoS (ISSUE-05).
- `gateway_calls` global SELECT + `sessions` full DML, no RLS → cross-tenant read under edge RCE (ISSUE-12).
- `app_collection_items` has no RLS → cross-app write pollution (ISSUE-13).
- Make `NOBYPASSRLS` explicit in the role bootstrap.

## Challenge outcome (2026-06-26)

WEAKEN — code claims verified; two **undisclosed** gaps to add (the `statement_timeout` / `sessions`-DML / `NOBYPASSRLS` items are already above):
- An **owner-DSN fallback** — `apps/edge/src/config.ts:304` `EDGE_DATABASE_URL ?? DATABASE_URL`, where `DATABASE_URL` is the schema **owner**. If the role DSN is unset the edge connects as owner and the split is silently defeated. The running compose *does* set the role DSN, so this is a latent footgun — **boot-fail when the role DSN is absent** rather than fall back.
- The **portal connects as the schema owner**, not `helix_portal` (no `PORTAL_DATABASE_URL` exists), so the `helix_portal` grants are effectively dead code. Realise the role or correct the Decision text. (The "split is silently defeated" thesis is otherwise an overstatement — the live config runs least-privilege and the role-split test passes.)
