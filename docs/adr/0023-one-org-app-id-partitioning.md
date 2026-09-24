# 0023. One org now, app-id partitioning everywhere (additive multi-tenancy)

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; forward-compat posture)_
**Related:** `docs/platform-architecture.md` §3 (decision #8), §9; ADR [0002](0002-postgres-role-split-rls.md); `apps/portal/prisma/schema.prisma`

## Context

v1 serves one organization. Data should be partitioned by app now so future
organization-level tenancy can be added without building unused multi-org
administration in v1.

## Decision

Build for **one org**, but **partition by `appId` everywhere** — every table, every RLS GUC (`app.app_id`), every gateway/metering record. There is **no `orgId` column today**. Because app-id partitioning is already the isolation unit end to end, introducing an `orgId` layer later is an **additive migration** (a new column + a scoping predicate above app-id), not a rewrite.

## Consequences

- Avoids premature multi-tenant complexity while not foreclosing it.
- `appId` is already the unit of isolation (RLS partition, role grants, metering, registry), so multi-org slots in above it.
- No cross-org concept exists yet — `platform-admin` is global; that becomes org-scoped if/when multi-org lands.
- Keeps the door open for the explicit non-goal ("multi-org tenancy") to become a goal without re-architecting storage.
