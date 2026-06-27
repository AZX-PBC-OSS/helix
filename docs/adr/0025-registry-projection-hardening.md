# 0025. Registry projection hardening (observability, jitter, cold-start)

**Status:** Proposed (2026-06-26)
**Related:** ADR [0017](0017-registry-listen-notify-projection.md) (the pattern this hardens), [0011](0011-in-memory-rate-limiting.md) (sibling in-memory-state concern)
**Code:** `apps/edge/src/registry/projection.ts`, `apps/edge/src/registry/listener.ts`, `apps/portal/prisma/migrations/20260612183907_registry_notify_trigger/migration.sql`

## Context

ADR [0017](0017-registry-listen-notify-projection.md)'s pattern — an in-memory `slug → entry` projection on the edge, refreshed via Postgres `LISTEN/NOTIFY` (DB trigger, fires on COMMIT), with a periodic reconcile poll as backstop and a **serve-stale-on-failure** stance — was put through a 5-model adversarial review (GLM, DeepSeek, Kimi, Qwen, MiniMax) + Brave best-practice grounding on 2026-06-26.

**Outcome: the pattern is a best practice and the implementation is sound** — unanimous "Sound with caveats," **zero Critical findings**, zero correctness/availability bugs. Reviewers confirmed the hard parts are right: the LISTEN-setup race is closed (reload after `LISTEN`), the disconnect gap is backstopped (reload-on-reconnect + reconcile poll), reads are torn-free (atomic Map swap), NOTIFY bursts collapse (100 ms debounce + `#inFlight`/`#dirty` coalescing), and serving is gated until the first successful load. The integration test exercises the full trigger→NOTIFY→LISTEN→reload loop. Grounding matched the canonical recipe ("LISTEN, reset from source of truth, process events, *periodically reconcile* — be capable of missing events").

The caveats are **operational hardening, not design flaws.** The one genuinely sharp edge: a **sustained DB failure serves stale data indefinitely with no signal** (`onLoadError` only logs; `isLoaded()` never flips back), flagged by **all 5 reviewers**.

## Decision

Keep the pattern (0017). Land the following hardening, in priority order. None requires a redesign.

1. **Staleness observability — `[5/5]`, must-do.** `onLoadError` currently only `warn`-logs. Expose `lastSuccessfulLoadAt` (monotonic) + a `consecutiveLoadFailures` counter on `RegistryReader`; **degrade `/health`** (the edge already validates `HealthStatusSchema`) to `degraded`/`error` once staleness exceeds a threshold (e.g. `5 × reconcileInterval`) or after N consecutive failures; emit a load-failure metric; promote the first failure to `error`-level. Removes the "serves stale forever, silently" edge.
2. **Jitter the reconcile poll — `[3/5]`.** `listener.ts` reconcile uses a fixed `setInterval`, so N replicas query the DB in a synchronized herd. Wrap it in a jittered `setTimeout` chain (reuse the reconnect-backoff jitter already at `listener.ts:125`, `±20%`).
3. **Cold-start when the DB is down — `[2/5]`.** A replica that can't reach the DB at boot never sets `isLoaded`, so it 503s all apps while `/health` may read green; a rolling restart during a DB outage blacks out the edge. Decide the trade-off explicitly: emit a `registry-load-pending` health signal while waiting, and/or bootstrap the projection from a durable snapshot (object store) so a cold replica can serve last-known-good.
4. **Connection budget + pooler caveat — `[1/5]` + grounded.** ~3 Postgres sessions per replica (2-conn pool + 1 dedicated LISTEN client) caps replicas at ~30 on `max_connections=100`. **Caveat:** the obvious fix (PgBouncer) collides with LISTEN — **transaction-pooling poolers drop LISTEN registrations** (confirmed by grounding). If a pooler fronts Postgres in prod, use **session-pooling mode** or give the LISTEN client a reserved direct connection; the reconcile poll is the fallback if LISTEN silently degrades.
5. **Scale ceiling — `[1/5]`.** The single global channel forces a **full-table reload on every commit, on every replica** (JSON-parse all `capabilities`). Fine at ~10⁴ apps; before ~10⁵, add a `last_modified_at` cursor so reloads can be deltas (and the NOTIFY can carry the timestamp).

### Minor (fold in opportunistically)
- Trigger covers `apps` INSERT/UPDATE/DELETE only — add `TRUNCATE` coverage and document the "`versions.blobPrefix` is immutable, so `versions` needs no NOTIFY" invariant so a future migration can't silently break it `[3/5]`.
- Quote the LISTEN identifier (`` LISTEN "helix_registry_changed" ``) or assert the channel pattern — constant today, latent injection if ever made dynamic; also ADR [0003](0003-dependency-minimal-edge.md) `[4/5]`.
- Export `REGISTRY_CHANNEL` as a shared constant referenced by both the edge and the migration, instead of two copies kept in sync by comment `[1/5]`.
- Use `clearInterval` (not `clearTimeout`) on the reconcile handle `[1/5]`; freeze `RegistryEntry`'s inner `Map`/arrays to stop consumer mutation of shared projection state `[1/5]`.

## Consequences

- Closes the only sharp edge (silent permanent staleness) and makes freshness/health observable to operators.
- Items 1–2 are small, local changes; 3–5 are scoped to the path to multi-replica / higher scale and can land with M5.
- The pattern, channel, trigger, and serve-stale stance from ADR 0017 are unchanged — this ADR only adds guardrails and telemetry.

## Provenance

Multi-model parallel-code-review + Brave grounding, 2026-06-26. Agreement tags `[n/5]` above are the count of the five reviewers that raised each item; the observability gap was unanimous. No Critical findings; verdict **best practice, sound with caveats**.
