# 0011. In-memory rate-limit / throttle state (single-replica)

**Status:** Superseded (2026-07-21) — the counters moved to a shared Postgres store; see Resolution below.
**Related:** `apps/edge/src/gateway/ipRateLimiter.ts`, `apps/edge/src/auth/loginThrottle.ts`, `apps/edge/src/gateway/counterStore.ts`; review ISSUE-07, ISSUE-15, issue #13

## Context

The edge needs a per-IP anonymous rate limiter and a per-(IP, app) password-login throttle. A shared store (Redis/DB) adds infrastructure and latency the pilot doesn't yet need.

## Decision

Keep rate-limit and login-throttle counters in per-process in-memory maps for v0, with periodic sweeping of expired buckets. This is documented as a deliberate single-replica scope.

## Consequences

- Simple, fast, no extra infrastructure.
- **Per-process state does not hold across replicas**: with N edge instances the effective limit is N × the configured limit — a real weakening of the login throttle, which (with ADR [0004](0004-auth-model.md)'s scrypt cost) is the economic defense for shared-password apps.
- In-memory maps must be swept or they grow unbounded.

## Open question / required hardening

- `loginThrottle.sweep()` is currently **never scheduled** → unbounded map growth (ISSUE-07). Wire it on an interval like `anonRateLimiter`.
- Check-then-increment is non-atomic (TOCTOU); concurrent attempts multiply the budget (ISSUE-15).
- Move to a shared atomic counter (DB `UPDATE … RETURNING` / Redis) before the edge goes multi-replica.

## Review notes (2026-06-25)

The single-replica trade-off is acknowledged in-code; the un-scheduled sweep and TOCTOU are concrete bugs on top of the documented scope.

## Challenge outcome (2026-06-26)

WEAKEN → **premise falsified** (filed **#13**). The "single-replica scope" is contradicted by the shipped infra: `infra/azure/modules/containerapp.bicep:40,43` set `minReplicas=1, maxReplicas=3` and the edge inherits it (no override in `main.bicep`), so the N× / uncoordinated throttle weakening this ADR warns about is **live in the M5 pilot**, not deferred. The unscheduled `loginThrottle.sweep()` and the check-then-increment TOCTOU above are confirmed in source. Newly noted: `trustProxy` is unset (`app.ts:112-116`), so `req.ip` behind the Container Apps Envoy may collapse to one bucket (or be XFF-spoofable if flipped on naively). **Before M5:** pin `maxReplicas=1` or land a shared atomic counter (a `gateway_calls`-style row — `helix_edge` already has INSERT); schedule the sweep; configure `trustProxy` correctly.

## Resolution (2026-07-21, issue #13)

Took the shared-atomic-counter branch — **not Redis**: adding a stateful service and a runtime/network dependency to the dependency-minimal trusted edge wasn't warranted for three small counters, and Postgres is already an edge dependency (the same reasoning ADR [0013](0013-egress-trust-model.md)'s resolution applies to the egress burn). Both counters now go through a `CounterStore` seam (`apps/edge/src/gateway/counterStore.ts`): `PgCounterStore` does one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING count` per admission against a `rate_counters` table (migration `20260721215912`, `helix_edge` full CRUD), keyed `anon:`/`login:` so the two limiters share one store without colliding.

This closes every item above: the limit **holds across replicas** (no more N×); the atomic upsert makes the login throttle **reserve-first**, closing the TOCTOU (ISSUE-15); one interval sweep in `server.ts` GCs both tables (fixes the never-scheduled sweep, ISSUE-07); and `EDGE_TRUST_PROXY` is now a config knob wired to Fastify `trustProxy` (default off). The in-memory maps survive only as `InMemoryCounterStore` for tests / single-process dev.

**Residual closed (2026-07).** The Container Apps ingress hop count has been verified against the live deployment and is set (`edgeTrustProxy` in `infra/azure`, applied to the edge and the dev-gateway), so `req.ip` resolves to the real client and per-client limits mean what they say. One qualification the closure should carry: the correct value is a property of a *deployment's* ingress topology, not of Helix. Under ADR [0028](0028-deployment-model-customer-deployed.md) each deployment applies its own IaC, so putting a CDN, WAF, or second proxy in front of the edge changes the hop count — too low and every client collapses into one bucket again, too high and `x-forwarded-for` becomes spoofable. Re-verify per deployment rather than treating this as settled platform-wide.
