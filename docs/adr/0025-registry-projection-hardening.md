# 0025. Registry projection hardening (observability, jitter, cold-start)

**Status:** Accepted (2026-06-26) — items 1–2 implemented 2026-07-31; 3–5 open
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

## Implementation notes (items 1–2, landed 2026-07-31)

Items 1 and 2 are implemented; 3–5 remain open. Four places where the code deviates from, or has to pin down, what the decision above left open:

1. **The state landed on a separate `RegistryFreshnessReader` seam, not on `RegistryReader`.** `getApp`/`isLoaded` has ~15 consumer modules that route requests and have no business knowing about freshness; only `/health` reads the new state. A second interface in the same module (`projection.ts`) satisfies the intent at the cost of two implementor edits (`LiveRegistry`, the test `FakeRegistry`) and zero consumer churn. `EdgeDeps.registry` is typed `RegistryReader & RegistryFreshnessReader`.
2. **Two clocks, not one.** `staleForMs` is measured off `performance.now()` so a wall-clock jump (NTP step, VM migration) can neither flatter freshness nor manufacture a staleness alert; `lastSuccessfulLoadAt` is a wall-clock ISO string that is **report-only** and never the basis of a decision. Injected as a `ProjectionClock` seam so the tests need no fake timers.
3. **Thresholds** (`registry/health.ts`, derived constants — not new env, since they are ratios to the already-configurable `EDGE_RECONCILE_INTERVAL_MS`): `degraded` at `> 5 ×` the interval **or** `>= 3` consecutive failures; `error` at `> 20 ×` the interval **or** never-loaded. Both dimensions are needed: the counter catches "loads are failing", the age catches "loads stopped being attempted at all" — a stalled reconcile timer produces zero failures forever, so the age rule is the authority for `error`. A non-finite or non-positive configured interval falls back to 60 s rather than silently disabling the age rule (every comparison against `NaN` is false).
4. **`/health` always answers HTTP 200**, in every state; the body carries the degradation (`status` plus a `checks[]` array on the shared `HealthStatusSchema`, `Cache-Control: no-store`). A non-200 would let a liveness probe restart a replica that is serving correctly from a stale copy — the serve-stale stance turned into the outage it exists to prevent. Nothing in `infra/azure` probes `/health` today; if that changes, it must not expect a non-200.
5. **The "load-failure metric" is a structured log event**, because the platform has no metrics channel (no `/metrics`, no OTel/App Insights; `gateway_calls` is a metering primitive, not an observability sink) and a client library would be a new runtime dependency in the trusted path (ADR [0003](0003-dependency-minimal-edge.md)). The de-facto channel is pino stdout → Log Analytics, so the deliverable is a stable `event` field — `registry.load_failed` (carrying `consecutiveLoadFailures`, `staleForMs`, `lastSuccessfulLoadAt`) and `registry.load_recovered` — that a KQL log-based metric and alert rule can count. **`event` is a new field convention in this repo**; the next log-based metric should follow it. Level ladder: first failure `error`, one further `error` when the copy crosses the 20× line, `warn` in between (~1/interval), `info` once on recovery.

### Found while verifying: the serve-stale stance didn't actually hold

Exercising the above end to end (a severable TCP proxy in front of Postgres, so a real DB path could be cut without touching the container) surfaced a defect **older than this ADR and not in its review**: no `pg.Pool` in the repo had an `'error'` listener. When an *idle* pooled connection drops — a DB restart or failover, a severed path, a pooler reaping the session — `pg-pool` re-emits the error on the Pool, and with no listener Node treats it as an unhandled `'error'` event and **kills the process.**

So the very first fault this ADR's observability exists to report did not produce stale serving at all; it produced a dead edge, taking the sessions, metering, app-data, CSP-report and counter pools down with it. Fail-static was asserted, never exercised.

Verified after that first fix, at `EDGE_RECONCILE_INTERVAL_MS=500`: the process survived the cut, `/health` went `ok → degraded → error`, exactly **2** `error`-level lines were emitted across 100 consecutive failures (first failure + the one 20×-crossing re-escalation, the rest `warn`), and healing the path produced one `registry.load_recovered` at `info` and `/health` back to `ok`.

#### …and the first fix only closed half of it

A dual review of that work found the crash **still live**, and the paragraph above overstating what had been tested. `pool.on('error')` receives only what `pg-pool`'s *idle* listener re-emits, and `_acquireClient` (`pg-pool/index.js:344`) **removes that listener the moment a client is checked out**, restoring it on release (`:385`). `Pool.query()` plugs the gap with its own temporary `client.once('error', …)` (`:464`); **`Pool.connect()` plugs nothing.** The harness described above cut the path while the registry's `pool.query()` traffic was in flight — the one path that was already safe — so it read as covered when it wasn't.

The window is reachable, not theoretical: `pg/lib/client.js:411` emits `'error'` **synchronously** on a socket death while deferring the in-flight query's rejection to `process.nextTick`, so the throw escapes from the socket read callback with none of our `try`/`catch` on the stack, and the repo installs no `process.on('uncaughtException')`. `withPartition` is the edge's only `pool.connect()` consumer, with 15 call sites across `auth/sessions.ts`, `gateway/data.ts` and `gateway/usage.ts` — including the per-request session read. A failover landing while any request held a partitioned transaction killed the replica.

Both windows now live in `apps/edge/src/db/pool.ts`: `createEdgePool` attaches the idle listener and registers a per-pool reporting sink, and **`withPooledClient` is the only sanctioned `pool.connect()`** — it guards the checkout, removes its listener before releasing (a leftover accumulates on a long-lived pooled client), and passes the error to `release(err)` so `pg-pool` destroys a socket-dead client instead of parking it for the next caller. `withPartition` composes it, so all 15 call sites are covered without touching one of them. A `no-restricted-syntax` rule in `eslint.config.mjs` keeps it that way.

Reporting was also wired properly: five of six stores had been rebuilding the opts object field-by-field and silently dropping the hook, so six of seven edge pools discarded client errors with no log line at all. One `onClientError(err, {phase, label})` hook now covers both windows — deliberately one, not two, because two can be half-forwarded exactly as the first pair was — reported under a single `db.pool_client_error` event. Egress's two hand-built pools get the same (a crash there is a fetch-proxy outage).

Coverage that fails without the fix, which the first round's tests did not: `db/pool.test.ts` fakes the checkout layer with a real `EventEmitter` (pre-fix the synchronous emit throws), `db/partition.test.ts` guards the composition, and `db/partition.integration.test.ts` destroys a real socket mid-transaction — pre-fix that does not merely fail its assertions, it takes down the vitest worker with an unhandled error. (`pg_terminate_backend` does **not** reproduce it: that sends an ErrorResponse, which rejects the active query through the normal path.)

Re-verified with the harness the first round should have used — the severable TCP proxy again, but cut **while a real `withPartition` transaction was open** rather than while only projection queries were in flight:

| | pre-fix | post-fix |
| --- | --- | --- |
| process | `throw er; // Unhandled 'error' event` → **exit 1** | survived |
| caller | (process dead) | rejected with `Connection terminated unexpectedly` |
| reported | nothing | `db.pool_client_error`, `phase: "checked-out"` |
| dead client | `totalCount: 1, idleCount: 1` — parked for the next request | `0 / 0` — destroyed |

The same review found four smaller things, all fixed: a throwing log sink could turn a *successful* load into a reported failure (`#onLoadRecovered` ran inside the `try`, so the throw fell into the `catch` — corrupting the very freshness state `/health` grades, and paging for a perfectly fresh projection); an unsanitized `EDGE_RECONCILE_INTERVAL_MS` (`NaN` → `setTimeout` coerces to ~0 ms → a DB hot loop from every replica, with `/health` green throughout because the loads keep succeeding) now fails the boot in `config.ts`, with the shared `safeInterval` guard keeping the health grading and the log ladder in agreement; the never-loaded state could never re-escalate, because its `staleForMs` is null forever, so it now escalates on the failure count under its own `registry.never_loaded` event; and a load in flight during `stop()` reported the `error`-level first-failure line on every graceful shutdown, now guarded and awaited.

**Item 3 is now half-closed:** a never-loaded projection reports `error` with an explicit "app hosts are serving 503" detail, so the cold-start blind spot is visible. The durable-snapshot bootstrap (letting a cold replica serve last-known-good) is untouched and still open, as is the question of a separate `/ready`.

**Accepted risk — `/health` detail is unauthenticated.** The verbose body (`lastSuccessAt`, `staleForSeconds`, `consecutiveLoadFailures`) is readable by anyone who can reach the edge: `classifyHost` returns `platform` for any unrecognised or absent `Host`, the auth host is internet-facing, and the route has no preHandler. Accepted rather than gated. It is operational metadata, not credentials — knowing the projection is stale grants nothing on its own, and a principal whose access was just revoked observes that directly rather than needing `/health` to tell them. A shared-secret gate would add config surface and break the documented human-polling workflow for a low-severity leak. **What would change this:** adding any field that names apps, users or groups, or anything that distinguishes *which* access rule is stale. Revisit then.

**Residuals:** no metrics pipeline and no alert rule yet exist to consume any of this — until one is created in Log Analytics, the degradation is only visible to a human. `consecutiveLoadFailures` counts *attempts*, not time, since NOTIFY-driven loads can inflate it faster than the reconcile interval — which is why the age rule is the authority for `error` wherever an age exists. Egress's two pools still bypass `createEdgePool` entirely and so get no `statement_timeout` (ADR-0002 ISSUE-05 applies to them too); tracked in `TODO.md`, not fixed here.

## Consequences

- Closes the only sharp edge (silent permanent staleness) and makes freshness/health observable to operators.
- Items 1–2 are small, local changes; 3–5 are scoped to the path to multi-replica / higher scale and can land with M5.
- The pattern, channel, trigger, and serve-stale stance from ADR 0017 are unchanged — this ADR only adds guardrails and telemetry.

## Provenance

Multi-model parallel-code-review + Brave grounding, 2026-06-26. Agreement tags `[n/5]` above are the count of the five reviewers that raised each item; the observability gap was unanimous. No Critical findings; verdict **best practice, sound with caveats**.
