# 0017. Edge registry projection over Postgres LISTEN/NOTIFY

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; shipped in M2/M3)_
**Related:** `docs/platform-architecture.md` §7; `docs/features/edge-serving.md`; ADR [0001](0001-three-runtime-split.md), [0002](0002-postgres-role-split-rls.md); `apps/edge/src/registry/{projection,listener}.ts`

## Context

Every data-plane policy decision (resolve a slug to its serving entry, read a manifest's capabilities/visibility) needs the app registry on the hot path. The edge must be **stateless** and must stay up independently of the portal's availability; a per-request DB query for registry state is both a latency cost and a coupling to the control plane.

## Decision

The edge holds an **in-memory projection** (slug → effective entry) of the registry, refreshed via **Postgres `LISTEN`/`NOTIFY`** (debounced ~100 ms) with a periodic **full reconcile** (~60 s) as a safety net. The portal writes the registry; the edge only ever reads the projection. Failure posture: **fail-closed** on a malformed row (drop that entry), **fail-static** on a load error (serve the last-good projection).

## Consequences

- No per-request registry DB query; sub-second propagation of promotes/archives.
- The edge survives portal downtime — it serves from the last-good projection (the data plane has no portal dependency at request time).
- **Eventual consistency:** a registry write is visible to the edge within the debounce/reconcile bound, not instantly — acceptable for deploy/promote/visibility changes.
- The projection parser is a trust boundary (it consumes control-plane JSON) and must fail closed.
