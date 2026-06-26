# 0010. Anonymous writes to `shared` keys on public apps

**Status:** Accepted (revisit — document/tighten the threat model)
**Related:** `apps/edge/src/gateway/data.ts`, `data-handler.ts`; review DEC-02

## Context

`public`-visibility apps serve anonymous callers (no session). Some demo apps (e.g. a public guestbook or counter) need to write app-`shared` data without forcing sign-in.

## Decision

The app-data `shared` scope permits writes from an anonymous caller on a `public` app: `putShared` runs with `app.user_oid = ""` (the RLS row has `userOid = NULL`), gated by the manifest's `sharedWrite` key allowlist and the per-app `writesPerDay` budget.

## Consequences

- Public demo apps can persist shared state with no auth friction.
- The only controls on anonymous writes are the manifest allowlist and the daily budget — there is no per-writer attribution or abuse signal.
- The empty-string GUC correctness relies on the RLS policy's `userOid IS NULL` disjunct; a future tightening of that predicate could silently change isolation.

## Open question

Decide whether `sharedWrite` should require authentication (and make `public`+`sharedWrite` an explicit opt-in), and document the anonymous-write threat model. Consider a sentinel GUC value instead of `""`.

## Review notes (2026-06-25)

Surfaced by one reviewer as an unstated authz/threat-model gap, not a bug. Tracked as DEC-02.

## Challenge outcome (2026-06-26)

WEAKEN — verified, no overreach. `writesPerDay` is a **single per-app counter** summed over `user.put` + `collection.append` + `shared.put` (`usage.ts:76,106-116`), so an anonymous flood through the un-elevated `sharedWrite` surface **self-DoSes the app's own** authenticated user/collection writes (`admitWrite` blocks all once the budget is hit). Also confirmed: enabling `sharedWrite` is **not** approval-gated (`classifyChange` treats it baseline / low risk). The RLS fragility is precisely the `userOid IS NULL` disjunct (not an empty-string bug). Separate or attribute the anonymous budget; approval-gate `public` + `sharedWrite` (DEC-02).
