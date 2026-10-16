# @azx-pbc/jobs

The `helix-jobs` runner package (ADR-0045, background-jobs-plane design §1):
Node 24, TypeScript, and the exact-pinned pg-boss 12.37.0 baseline. This
package owns the storage seam — the installed-handler policy, the private
migration/configuration command, the startup compatibility check — the service
boot: the health-first listener, the storage-readiness supervisor and the
shared health vocabulary, and the signed internal operation receiver: every
edge→jobs and portal→jobs instruction is verified and its nonce durably burned
before its operation runs. The operations' own semantics land in their own
tickets and compose from here — lifecycle delivery (the app-generation
authority's apply-before-acknowledge receiver, `src/lifecycle.ts`) and
submission (the acceptance transaction, `src/acceptance.ts`) are served; the
rest answer the protocol's retryable unavailable error until their tickets
replace the placeholder, and the log line is where that gap is named.

## Signed internal operations (`src/instructionAuth.ts`, `src/app.ts`)

The five receiving routes of the shared operation matrix
(`@azx-pbc/shared/jobsSigning`) are registered verbatim from it, so a route
and its signed binding cannot drift: `POST /internal/jobs/v1/jobs` (submit),
`GET …/jobs/:jobId` (snapshot), `GET …/jobs/:jobId/result`,
`DELETE …/jobs/:jobId` (cancel), and `POST /internal/jobs/v1/lifecycle/:appId`
(the portal's lifecycle delivery). Each verifies the `x-helix-instruction`
token against what ITS route serves — operation, direction, method, resource
built from the route's own params, exact body bytes — then durably burns the
validated `jti` before anything else happens. Missing, forged, altered,
wrong-server and replayed instructions all answer the fixed 401
`unauthorized` envelope before any effect; the reject reason is bounded
evidence for the logs and spans, never the response. A burn store that cannot
answer denies with the retryable 503 `jobs_unavailable` — fail closed, no
verdict.

Replay protection is the burn store (`src/burns.ts`), the service's own
durable nonce table in its own database: one row per consumed `jti`, scoped by
signing direction, inserted with `ON CONFLICT DO NOTHING` so two replicas race
a unique constraint and exactly one proceeds. Burns are retained for the
shared floor `JOBS_INSTRUCTION_BURN_RETENTION_SECONDS` (60 s — the longest a
burned token could still verify anywhere), with no weaker knob; a bounded
sweep loop (batched, counted, never throwing) removes what has expired. The
store's table and the runtime role's grants on it are created by the
migration command below; the startup compatibility check reports its absence
(`burn_missing`) rather than serving instructions against a store that cannot
remember burns.

A legitimate HTTP retry mints a fresh instruction (fresh `jti`) carrying
the same optional retry identity — the signed `idempotencyKey` claim, compared
at admission (`src/acceptance.ts`), never overridden by an unsigned header.

## The acceptance transaction (`src/acceptance.ts`)

Submission is decided in ONE transaction against the service's private store
(ADR-0003, design §4), in the adopted order, each precedence load-bearing:

1. The app's lifecycle row is locked `FOR UPDATE` (`lifecycleEligibilityInTx`,
   the serialization boundary from `src/lifecycle.ts`) — held to the
   transaction's end, so a lifecycle apply cannot land between the decision
   and its effect and same-app admissions cannot interleave.
2. The **retained-key comparison** — the scoped retry key
   (`server/appId/env/ownerKind/ownerOid/type/key`, unique-constrained) is
   looked up and its stored digest compared against the exact input bytes,
   BEFORE new-input validation and BEFORE the eligibility verdict is applied:
   identical bytes recover the original job (202 with its current status) even
   when validation rules have since changed or intake has closed; different
   bytes answer 409 `idempotency_conflict` with the job's state, even when
   they are invalid for new work. Neither answer creates work or consumes a
   slot.
3. New-work validation — the type's installed policy (a type this server has
   no policy for is refused 403) and its input contract (refused 400
   `payload_invalid`), creating no job and no key claim.
4. The eligibility verdict — `closed` refuses new work finally (403);
   `unseen` waits for the portal's delivery (retryable 503), never auto-opening
   a generation.
5. The **capacity comparison** — new work is admitted only inside one
   server-wide, transaction-scoped admission lock (design §4: "a local
   admission lock and bounded indexed counts"), against the unfinished and
   retained occupancy of both the app/environment and the whole server, under
   the resolved capacity limits (below). Full or lowered capacity answers 429
   `jobs_capacity_exceeded` and evicts nothing; the occupancy counts are
   bounded indexed counts on `jobs.job_record` (the
   `idx_job_record_server_app_env_status` index). Because only admissions
   consume capacity — completion and physical cleanup only free it — the
   counts the lock guards cannot move in the unsafe direction between the
   check and the insert.
6. The runner enqueue over the **borrowed connection** (pg-boss's public
   `db.executeSql` adapter — the runner row joins the transaction), then the
   wrapper record insert into `jobs.job_record`: the immutable attribution,
   the admitted generation, the status projection (`queued` at admission),
   the retry key and the body digest. The scoped-key unique constraint is the
   concurrent-retry backstop; a claim lost to it rolls the already-enqueued
   runner job back with the transaction, and the retry identity resolves
   against the winner's committed mapping.

A failure anywhere throws: nothing is committed, and the submit route answers
the protocol's retryable 503 — a timeout is uncertainty, never proof of
nonacceptance; the same keyed POST recovers the committed job. The send-time
options are the type's installed policy (attempts, claim bound) and the
trusted `(appId, env)` fairness group (`jobsAppEnvGroupId`).

## Capacity limits (`src/acceptance.ts`, `src/config.ts`)

New work is refused 429 `jobs_capacity_exceeded` when it would exceed any of
the four occupancy caps (design §4): **unfinished** (every nonterminal job —
queued or running, including delayed retries and pending cancellation) and
**retained** (every physically stored job, active or terminal, whatever
transient state the runner's own row is in — the wrapper record and its input
bytes are the retained storage), each per app/environment and server-wide.
Completion releases unfinished capacity; only physical cleanup releases
retained capacity; a retained-key replay uses no slot and is never counted
against a cap. Refusals are ordinary busy answers — the 429 keeps the span
UNSET, nothing degrades, and each refusal logs one bounded
`jobs.admission.capacity_refused` event (the cap, the limit, the occupancy)
that never becomes a persistent audit row.

The limits are the shared platform defaults (`JOBS_CAPACITY_DEFAULTS`) with
this deployment's optional `JOBS_LIMITS` override applied — the JSON form of
the shared override schema, resolved through `resolveJobsCapacityLimits` at
boot; a malformed or unbounded override is a startup error, never a silently
partial tuning. Apps cannot change any limit through input or manifest.

## The runtime runner (`src/runner.ts`)

The one pg-boss instance the service composes — the enqueue half of the
acceptance seam, and the worker execution registers on. Its start is supervised
and health-first: the instance's own start is a read-only schema check
(`migrate: false`) that refuses a missing or behind schema, so the runner
retries with capped backoff until the store verifies, logging each failed
attempt; until it converges the enqueue refuses (retryable unavailability),
which is honest — nothing can be durably enqueued into a store that has not
come up. The composition's worker registration runs as part of every start
attempt: a registration failure is a failed start (the half-started instance is
discarded and the loop retries), so a listener without its worker never reports
healthy — `/health`'s `jobs_worker` check grades the runner's snapshot
(`started`, `workerRegistered`). The instance's `error` containment — pg-boss
emits the errors its own loops absorbed on the instance's event emitter, and
unhandled they kill the process — attaches in `buildBoss()`, so every retried
attempt's fresh instance carries it too. Shutdown stops the runner first (its
worker with it), then the stores.

## The execution seam (`src/execution.ts`)

One pg-boss worker on the single queue dispatches each claim to the handler
registered for the record's qualified type, and every attempt's state is
projected into the `jobs.job_record` wrapper the observation paths read. The
options are the shared policy's derivation (`jobsWorkOptions` — per-process
total and per-app/environment group concurrency), one job per batch, metadata
on — the attempt's retry decision reads the runner row's own policy.

- **The start gate.** An attempt begins in the transaction that judges the
  record's admitted lifecycle generation (`lifecycleEligibilityInTx`, the row
  locked to the commit): work starts only under an eligible generation, and a
  lifecycle apply cannot land between the gate's decision and the recorded
  start. A refused claim does not run the handler and leaves the wrapper record
  untouched — the durable cancellation of closed-generation work is the
  recovery path's.
- **The attempt projection.** Begin writes `running` at the attempt number
  (`retryCount + 1`), resets the progress and clears the previous attempt's
  error; a handler reports bounded progress (`{step, of, label}`, validated at
  the seam) which persists only while its attempt is the record's current one.
  A failure whose type permits retries writes `queued` — the failed attempt's
  error and its progress stay clearly identified while waiting — and a
  terminal failure writes `failed` with the error's code. A success writes
  `succeeded` with the bounded result (a complete JSON value within 64 KiB;
  `result_invalid` / `result_too_large` are the terminal refusals).
- **The claim is the arbiter.** The runner's own attempt-fenced
  `complete`/`fail` settle FIRST; only a settle that reports the claim held may
  write the wrapper. A late completion whose claim lapsed (a claim timeout, a
  lost lease) is discarded, never stored — the timeout outcome the claim's
  expiry produced is the truth, and the recovery path projects it.
- **Execution-time validation.** The job's input is re-validated against the
  type's CURRENT contract before the handler runs: a job accepted under older
  rules terminates with the distinct `execution_input_invalid` reason (never a
  re-run of admission). A type with no registered handler cannot execute —
  the dispatch refuses with the terminal platform error.
- **The handler registry.** Registration requires an installed execution
  policy — a synthetic or non-catalogue type cannot register, and a second
  registration of one type fails loudly. The production registrations (the
  outbound fetch handler, the development fixtures) are their own tickets'
  work.
- **Telemetry.** One root consumer span per attempt (`helix.jobs.execute`)
  carries the app, the qualified type, the job's public id and the attempt
  number; its outcome is `JOBS_EXECUTE_OUTCOMES` and a failure's code rides
  `helix.reason`. `helix.jobs.executions` counts the attempts by outcome. The
  redaction rules hold: no input, result, retry key, owner identity or URL
  anywhere on the span.
- **The absolute deadline.** The start gate also judges the record's
  acceptance-to-now against the type's `deadlineSeconds` (queue wait and every
  retry delay included): a claim arriving after the deadline terminates the
  record with the timeout outcome in the same transaction that decided it —
  recovery never authorizes execution after the deadline. The write is
  `terminatePastDeadline`, shared with the recovery sweeper.

## The recovery sweeper (`src/recovery.ts`)

The supervised loop that owns interruption recovery (ADR-0009): the runner's
own maintenance settles a dead worker's claim, and the wrapper record it was
projecting stays mid-flight — this loop reads the runner rows back (through
the runner's own `jobState`, the pinned adapter's public job read — no second
pg-boss instance, no second copy of its schema) and projects the truth into
the wrapper. The reconciliation is a projection, never a re-driver: only the
runner's retry policy re-runs work, so a single-attempt fetch job whose worker
died is projected `crashed` — execution lost, never reissued.

- **The cadence.** Every 15 seconds, oldest non-terminal records first, at
  most 100 per pass; every write is conditional (non-terminal, or the exact
  attempt read), so a worker settling, a cancellation or another replica's
  sweeper fences a loser instead of racing one.
- **The decision.** The deadline arm decides first (no runner I/O — deadline
  enforcement never depends on the runner being up). Then the runner row:
  waiting (`created`/`retry`) requeues a record still reading `running` with
  the lost attempt's attribution retained; `active` is consistent work;
  terminal `failed` projects the worker's own reported code when the settle
  carried one, else `crashed` (execution lost); `completed` projects `crashed`
  (the result was lost with the attempt's process — never a fabricated
  success); `cancelled` projects the cancellation. A record with no runner
  row is corruption: logged at error and left for the deadline arm's bounded
  termination.
- **Supervision.** `start()` never throws; a failed pass is logged, counted
  and never ends the cadence (a pass whose own reporting threw rejects to its
  caller, clears the in-flight guard, and the timer's next pass runs);
  `stop()` releases the pool and the timer on every exit path and does not
  restart.
- **Health and telemetry.** The `jobs_sweeper` check grades the snapshot
  (never ran → `error`; no successful pass → `error` naming the last pass's
  age; stale beyond three cadences → `degraded`). One root consumer span per
  dispositioned job (`helix.jobs.recover`, outcome `JOBS_RECOVER_OUTCOMES`)
  and the `helix.jobs.recoveries` counter — `row_missing` grades ERROR (a
  corrupt store); everything else is the sweeper working as designed.

## The app-lifecycle authority (`src/lifecycle.ts`)

The portal is the generation authority (ADR-0007); this service owns the
jobs-side state its delivery lands in — one row per known app in the
`jobs.app_lifecycle` table: the highest lifecycle generation durably applied
and whether that generation is archived. The lifecycle route applies a
delivered `{generation, archived}` in one transaction — ensure the row, lock
it, merge, write, commit — and acknowledges **after** the commit with the
highest applied generation, never the delivered one: a redelivery or an
out-of-order older change acknowledges the highest and changes nothing, so
older deliveries can never reopen a closed generation (each new generation's
watermark already closes every generation below it — an immediate
archive/unarchive delivered in either order keeps every pre-archive
generation ineligible).

The same row is the **admission/start gate**: `lifecycleEligibility` (pure,
unit-pinned) judges a claimed generation as `admit` (applied and open),
`closed` (older, or applied while archived — final), or `unseen` (newer than
anything applied, or an app not yet known — temporary; the caller reports the
retryable 503 and waits for the portal's delivery, never opening a generation
itself). `lifecycleEligibilityInTx` runs the judged read under the caller's
transaction with the row locked `FOR UPDATE` — the serialization boundary an
acceptance transaction (and a worker start) holds to its commit, so a
lifecycle apply cannot land between a gate decision and its effect. The
cancelled-work recovery that consumes the gate's closed generations is its own
supervised loop.

The store's table and the runtime role's grants (SELECT/INSERT/UPDATE — never
DELETE: the rows are tombstone state a future app deletion must still deliver
against) are created by the migration command; the startup compatibility
check reports the store's absence (`lifecycle_missing`) rather than serving
a gate that cannot answer.

## The installed-handler policy (`src/policy.ts`)

One registry read by the migration command and by worker registration. Every
value in it is platform-owned: manifests, job inputs and approvals cannot set
attempt limits, retry delays, execution deadlines, concurrency allowances or
retention periods.

- **One queue** (`jobs`) carries all installed types, so cross-type
  concurrency applies per process: `runningPerWorker` (8) total and
  `runningPerAppEnv` (2) per trusted app/environment group, from the shared
  capacity defaults (`resolveJobsCapacityLimits`), not a second copy of the
  numbers.
- **Retention is closed to native pruning.** pg-boss's deletion sweep is
  disabled on both arms (`deleteAfterSeconds: 0`, `retentionSeconds` at the
  column's maximum), so the jobs cleanup loop is the only deleter of primary
  rows and removes them together with their wrapper identity at the 30-day
  record horizon. A native sweep racing that loop would orphan retry
  mappings and drop accepted work silently.
- **Attempts and deadlines.** The queue-level default is no automatic retry
  (`retryLimit: 0`) with the 60-minute absolute deadline as the per-attempt
  claim bound; each installed type's policy tightens from there. The fetch
  type (`jobs:fetch`) has one execution attempt and the five-minute
  deadline. Catalogue↔policy exhaustiveness is screened at import in both
  directions, so a drift fails the process at boot.
- **The runtime never migrates.** `jobsRuntimeBossOptions()` sets
  `migrate: false` — pg-boss runs a read-only schema check at start and
  refuses a missing or behind schema — plus no schedules and no native
  OpenTelemetry. The migration command is the only configuration that
  migrates.

## Migration/configuration command (`src/migrate.ts`)

The only path that changes the jobs runner's own database. It runs under the
migration identity, never a runtime credential:

```
JOBS_MIGRATE_DATABASE_URL=postgresql://helix_jobs_migrate:…@db:5432/helix_jobs \
  pnpm --filter @azx-pbc/jobs db:migrate
```

It refuses a DSN whose role holds no CREATE on the database (the runtime
DSN's shape), installs or migrates the pg-boss schema, creates the platform
queue with the policy above, converges policy drift that pg-boss can update
(failing on drift fixed at queue creation), creates the instruction burn
store (schema `jobs`, table `instruction_burns`, its `burn_until` index), the
app-lifecycle store (table `app_lifecycle`) and the job-record store (table
`job_record`, the retry namespace's unique constraint, the public-status
check, the execution projection's columns — attempt, progress, error_code,
result, with the state-machine checks that keep a result only where the
public record projects it — and the occupancy index the capacity counts
use), grants the runtime role DML
on all of it — provisioning sets no default privileges, so grants arrive by
migration — and verifies the effective state by re-reading it. Later
jobs-owned migrations extend this command the same way: a step under the
migration identity, after the schema they depend on exists.

## Startup compatibility check (`src/compat.ts`)

`checkJobsStorageCompatibility(pool)` answers, read-only, whether the
runtime may rely on its store: schema installed at the pinned dependency's
version, the queue carrying the platform's effective policy, the instruction
burn store, the app-lifecycle store and the job-record store present with its
execution columns, and the
runtime identity holding its DML. The verdict union (`compatible`,
`unreachable`, `schema_missing`, `schema_version`, `queue_missing`,
`queue_policy`, `burn_missing`, `lifecycle_missing`, `record_missing`,
`record_schema`, `runtime_privileges`) is what the
storage supervisor and health reporting consume; the expected schema version
is read from the installed pg-boss package, so a catalog bump moves the
expectation with the dependency.

## Service boot (`src/server.ts`) and the storage lifecycle (`src/storage.ts`)

The boot contract is health-first (design §8, ADR-0009): the listener and
`/health` come up before the store is usable, and the storage supervisor —
which owns the store connection — probes with bounded, capped-backoff
retries while `/health` reports the store unavailable. A later probe that
verifies compatible recovers the service without a restart; a store that
verified and later dies degrades the same way.

- **`/health` always answers 200.** The body carries the degradation: the
  `jobs_database` check grades the storage supervisor's snapshot, the
  `jobs_worker` check grades the runner's, and the `jobs_sweeper` check
  grades the recovery sweeper's (names in `@azx-pbc/shared`,
  `JOBS_HEALTH_CHECK_NAMES`), and **unknown readiness never appears
  healthy** — before any probe has answered, the state is `error`; a listener
  without its worker is `error`, not ok; a sweeper that never completed a
  pass, or whose last successful pass is older than three sweep cadences, is
  `error`/`degraded`, never ok.
- **Invalid configuration is an explicit startup error.** `loadJobsConfig`
  (`src/config.ts`) refuses a missing or malformed `JOBS_SERVER_ID`,
  `JOBS_DATABASE_URL` or either receiver signing root
  (`JOBS_EDGE_TO_JOBS_SECRET`, `JOBS_PORTAL_TO_JOBS_SECRET`) before anything
  listens; the roots derive to their direction keys at boot, so a malformed
  one stops the process, not the first instruction.
- **Shutdown releases what startup acquired.** The `onClose` hook stops the
  recovery sweeper first (its runner-row reads ride the runner's instance), then
  the runner (its retry timer, its instance and the worker on it), then every
  store's pool — the execution store, the acceptance store, the lifecycle
  store, the burn store's sweep timer, the storage supervisor's probe timer —
  and flushes telemetry; the graceful-shutdown install bounds the drain. The
  failed-partial-initialization exit releases the same set.
- **Probes are counted.** Every probe emits `helix.jobs.storage.probes`
  with `outcome` ∈ {`ok`, `unavailable`} — the retries an outage absorbs are
  visible; the _reason_ rides the `jobs_database` check body and the
  `jobs.storage.unavailable` log event. Telemetry stays inert unless an OTLP
  endpoint is configured, and the service's behavior is identical without it.

## Pooled clients (`src/pool.ts`)

Every jobs store builds its pool through `createJobsPool` and checks clients
out only through `withJobsClient` — the edge's and egress's pooled-client
discipline (`apps/edge/src/db/pool.ts`), copied after this service
reproduced the hazard the pattern exists to prevent: pg-pool strips a
checked-out client's `'error'` listener and pg emits `'error'` synchronously
on a socket death, so a failover landing mid-transaction used to kill the
process before the store's own rejection could run. The bracket records the
death, releases exactly once, destroys the dead client on release, and the
store's failure contract answers the caller with the retryable 503. The
pool-level listener covers idle clients only, and every `pool_error` log
event carries `phase` ∈ {`idle`, `checked-out`}. Bare `pool.connect()` is
banned for this service by `eslint.config.mjs`; `src/pool.ts` holds the one
sanctioned checkout.

Development (the two roots are any independently generated base64 32-byte
secrets — `openssl rand -base64 32` — and the local IdP/edge tooling may
already provision them):

```
JOBS_SERVER_ID=jobs \
JOBS_DATABASE_URL=postgresql://helix_jobs:…@db:5432/helix_jobs \
JOBS_EDGE_TO_JOBS_SECRET=… JOBS_PORTAL_TO_JOBS_SECRET=… \
[JOBS_LIMITS='{"unfinishedPerAppEnv":20}'] \
  pnpm dev:jobs
```

The listener serves `/health` and the five signed internal operation routes
(verification + durable burn). The lifecycle route serves the portal's
delivery (the app-lifecycle authority above), the submit route serves the
acceptance transaction (above), and the worker executes accepted work (the
execution seam above); the other operations' semantics arrive with
their own tickets and answer 503 `jobs_unavailable` until then — an unmatched
request answers 503 `jobs_unavailable` while the store is unusable, 404 on a
ready service.

## Development

```
pnpm --filter @azx-pbc/jobs typecheck
pnpm vitest run apps/jobs --project=node
```

The integration suites run against the real test cluster through the real
role split; each provisions its own scratch database from
`.devcontainer/db-init/01-roles.sql` and drops it afterwards.
