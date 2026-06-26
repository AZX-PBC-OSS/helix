# 0015. App-data: three scopes (user / collection / shared), writer ≠ reader

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; shipped in M4)_
**Related:** `docs/design/app-data-storage.md`; `docs/features/app-data-gateway.md`; ADR [0002](0002-postgres-role-split-rls.md); `apps/edge/src/gateway/data-handler.ts`, `data.ts`

## Context

Apps need persistent storage, but a naïve key/value store lets a hostile app harvest other users' data (the "contact-harvester": a form that collects submissions the app author then reads back). The storage model has to make that structurally impossible, not policy-dependent.

## Decision

App-data is a Postgres-backed KV exposed in **three named scopes**:

- **`user`** — per-user private data, RLS-partitioned by the verified session OID (`SET LOCAL` GUCs from the gate). An app can only ever touch the calling user's rows.
- **`collection`** — **append-only**: the app may `INSERT` but can **never read or enumerate** (`helix_edge` has INSERT-only on `app_collection_items`). The owner drains/exports via the portal, off the app path.
- **`shared`** — app-wide key/value readable and writable by the app.

The load-bearing rule: **a write grant never implies a read grant.** Three scopes, not two, because *append-only write* is a distinct security primitive.

## Consequences

- The contact-harvester is defeated by construction — a collecting form uses `collection`, which the app cannot read back.
- Cross-user isolation rests on RLS + session-derived GUCs (ADR-0002); the INSERT-only grant is the structural enforcement, not application code.
- Owner access to collection data is a portal export, deliberately not an app-facing read.
- Reversing the writer≠reader asymmetry would re-open the harvesting class — costly and security-regressive.
