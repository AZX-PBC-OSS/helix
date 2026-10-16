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

The one pg-boss instance the service composes — the enqueue half today,
execution registration later. Its start is supervised and health-first: the
instance's own start is a read-only schema check (`migrate: false`) that
refuses a missing or behind schema, so the runner retries with capped backoff
until the store verifies, logging each failed attempt; until it converges the
enqueue refuses (retryable unavailability), which is honest — nothing can be
durably enqueued into a store that has not come up. Shutdown stops the runner
first, then the stores — the acceptance store's pool among them.

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
check and the occupancy index the capacity counts use), grants the runtime
role DML
on all of it — provisioning sets no default privileges, so grants arrive by
migration — and verifies the effective state by re-reading it. Later
jobs-owned migrations extend this command the same way: a step under the
migration identity, after the schema they depend on exists.

## Startup compatibility check (`src/compat.ts`)

`checkJobsStorageCompatibility(pool)` answers, read-only, whether the
runtime may rely on its store: schema installed at the pinned dependency's
version, the queue carrying the platform's effective policy, the instruction
burn store, the app-lifecycle store and the job-record store present, and the
runtime identity holding its DML. The verdict union (`compatible`,
`unreachable`, `schema_missing`, `schema_version`, `queue_missing`,
`queue_policy`, `burn_missing`, `lifecycle_missing`, `record_missing`,
`runtime_privileges`) is what the
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

- **`/health` always answers 200.** The body carries the degradation:
  the `jobs_database` check (names in `@azx-pbc/shared`, `JOBS_HEALTH_CHECK_NAMES`)
  grades the supervisor's snapshot, and **unknown readiness never appears
  healthy** — before any probe has answered, the state is `error`.
- **Invalid configuration is an explicit startup error.** `loadJobsConfig`
  (`src/config.ts`) refuses a missing or malformed `JOBS_SERVER_ID`,
  `JOBS_DATABASE_URL` or either receiver signing root
  (`JOBS_EDGE_TO_JOBS_SECRET`, `JOBS_PORTAL_TO_JOBS_SECRET`) before anything
  listens; the roots derive to their direction keys at boot, so a malformed
  one stops the process, not the first instruction.
- **Shutdown releases what startup acquired.** The `onClose` hook stops the
  runner (its retry timer and instance) first, then every store's pool — the
  acceptance store, the lifecycle store, the burn store's sweep timer, the
  storage supervisor's probe timer — and flushes telemetry; the
  graceful-shutdown install bounds the drain.
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
delivery (the app-lifecycle authority above) and the submit route serves the
acceptance transaction (above); the other operations' semantics arrive with
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
