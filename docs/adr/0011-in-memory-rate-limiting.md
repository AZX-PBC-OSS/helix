# 0011. In-memory rate-limit / throttle state (single-replica)

**Status:** Accepted (revisit before multi-replica deployment)
**Related:** `apps/edge/src/gateway/ipRateLimiter.ts`, `apps/edge/src/auth/loginThrottle.ts`; review ISSUE-07, ISSUE-15

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
