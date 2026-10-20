# @azx-pbc/jobs

The `helix-jobs` runner package (ADR-0045, background-jobs-plane design §1):
Node 24, TypeScript, and the exact-pinned pg-boss 12.37.0 baseline. This
package owns the storage seam — the installed-handler policy, the private
migration/configuration command, the startup compatibility check — the service
boot: the health-first listener, the storage-readiness supervisor and the
shared health vocabulary, and the signed internal operation receiver: every
edge→jobs and portal→jobs instruction is verified and its nonce durably burned
before its operation runs. All five receiving operations are served:
lifecycle delivery (the app-generation authority's apply-before-acknowledge
receiver, `src/lifecycle.ts`), submission (the acceptance transaction,
`src/acceptance.ts`), cancellation (the durable intent plus the runner drive,
`src/cancellation.ts`) and the owner-scoped observation reads (the logical
public-read horizons' projection, `src/observation.ts`).

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

## The observation seam (`src/observation.ts`)

The owner-scoped status and result reads — the polling half of the protocol
(ADR-0005), projected against the **logical public-read horizons**:

- **Authorization runs on every read**, in the order the contract fixes:
  existence, then the signed identity (app, environment, principal kind,
  owner), then the record's public readability, then the type grant. A
  foreign or unknown reference — and a record past its public horizon —
  answers the same 404 `job_not_found` (never a disclosure that someone
  else's or an expired job exists); a lapsed grant answers 403 `forbidden`,
  fail-closed, ahead of any state revelation. Reads are read-only: polling
  never mutates execution, and a failed observation is never an execution
  failure (the retryable 503, the last known state staying visibly stale).
- **The horizons are computed from the record's `terminal_at`** — the
  instant of its ORIGINAL terminal outcome, stamped by every terminal write
  in the same statement that writes the status. A successful result stays
  readable for seven days (`resultExpiresAt`), the record for thirty
  (`recordExpiresAt`); past the result boundary the job's public status reads
  `expired` and the result read answers 410 `result_expired` — however
  delayed the physical cleanup is; past the record boundary every read
  answers 404 while the physically retained row still holds the retry key
  (criterion 14). One shared projection (`projectedPublicStatus` and its
  neighbours) is what every reader of the record's public state consumes —
  the observation routes, the cancellation seam's terminal classification
  and the acceptance transaction's retained-key comparison — so no path can
  show a stale `succeeded` past the horizon or read an expired record.
- **The snapshot is the complete latest state** (criterion 40): terminal
  outcome, cancellation intent, attempt and progress, both horizons, the
  bounded execution error — one fixed camelCase shape with explicit nulls,
  validated against the wire schema before it is sent.
- **The result is the stored canonical JSON, as exact bytes** — objects,
  scalars and JSON `null` (a result, never expiry), never re-serialized: a
  result at the 64-KiB cap nests past the engine's recursive serializer, and
  the value the job produced is the value the caller reads. An unfinished
  job answers the stateful 409 `job_not_ready`; a terminal job without a
  successful result, 409 `job_terminal` — each with the job's status and
  applicable bounded error.

## The owner-cancellation seam (`src/cancellation.ts`)

An authorized cancel request becomes durable intent first, then the runner
drive — in that order, and never the reverse:

1. **The intent write is the authorization check and the fence in one
   statement.** `cancellation_requested` is set on the record conditional on
   the signed caller's identity (app, environment, principal kind, owner), the
   record's type being inside the signed grants, and the record still being
   non-terminal — so a state that changed before the write landed cannot be
   acted on. A repeat while active writes the same value and answers the same
   acknowledgement (harmless by construction). The refusals classify the
   record as it stands: a foreign or unknown reference — and a record past
   its public record horizon — answers the same 404
   `job_not_found` (never a disclosure that someone else's or an expired job
   exists), a
   grant that does not cover the record's type answers 403 `forbidden`, and a
   terminal job answers 409 `job_terminal` with its own status and stored
   error, its outcome preserved (a successful result past its seven days
   reads `expired` — the read horizons' projection, never a stale stored
   status).
2. **Then the runner.** The record's runner row is cancelled through the
   runner's own fenced adapter call (`cancelRunnerJob`): a waiting row moves
   to `cancelled` and will never dispatch; an active row's claim is lost,
   which trips its worker's per-job abort signal on the next heartbeat. A
   drive that could not answer is logged and left to the sweeper's
   cancellation arm — the 202 confirms the durable intent, not the runner
   row's state.

The pending intent is enforced by two readers: the worker-start gate (below)
refuses any claim that arrives after it and commits the terminal `cancelled`
outcome in the gate's own transaction, and the recovery sweeper re-drives the
runner cancel and projects the outcome for everything else — so an
acknowledged cancellation reaches a terminal outcome within the
healthy-service bound (the heartbeat and sweep cadences) while required
services remain available, and stays pending, honestly, during an outage.
Whichever terminal outcome commits first wins: a completion settling after
the cancellation is fenced by the conditional writes; a cancellation arriving
after a committed completion reads `terminal` and changes nothing.

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
   identical bytes recover the original job (202 with its CURRENT public
   status — the read horizons' projection, so a replay after result expiry
   returns the original job as `expired`) even
   when validation rules have since changed or intake has closed; different
   bytes answer 409 `idempotency_conflict` with the job's state, even when
   they are invalid for new work. A record past its public record horizon is
   unreadable: the identical replay answers the unknown-job 404 without
   creating work while the row is still physically retained, and the
   changed-bytes conflict still stands. Neither answer creates work or
   consumes a slot.
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
attempt's fresh instance carries it too. Shutdown stops the loops that drive
runner operations through the instance (the recovery sweeper, the
cancellation store, the cleanup loop) before the runner itself, then the
stores.

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
  start. The same transaction judges the record's durable cancellation
  intent: a claim arriving after it commits the record's terminal `cancelled`
  outcome in the gate's own transaction (the handler never runs, and the
  intent can never turn into a run or a retry), and the begin's own projection
  is conditional on the intent — an intent committing between the gate's read
  and its write stops the attempt at the write. A refused claim does not run
  the handler; the deadline and cancellation refusals commit their own
  terminal outcomes, and the closed-generation refusal leaves the wrapper
  record untouched — the durable cancellation of closed-generation work is
  the recovery path's.
- **The attempt projection.** Begin writes `running` at the attempt number
  (`retryCount + 1`), resets the progress and clears the previous attempt's
  error; a handler reports bounded progress (`{step, of, label}`, validated at
  the seam) which persists only while its attempt is the record's current one.
  A failure whose type permits retries writes `queued` — the failed attempt's
  error and its progress stay clearly identified while waiting — and a
  terminal failure writes `failed` with the error's code. A success writes
  `succeeded` with the bounded result (a complete JSON value within 64 KiB;
  `result_invalid` / `result_too_large` are the terminal refusals).
- **The handler's abort signal.** The attempt context carries the claim's own
  `AbortSignal`: the runner aborts it when the claim is cancelled (an owner's
  or a lifecycle delivery's) or expires, and a supported handler stops its
  bounded I/O on it. An ignored signal changes nothing — the claim's
  settlement is fenced either way, so the attempt's result can never land
  after the abort.
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
  registration of one type fails loudly. Production registers the outbound
  fetch handler (below); the development fixtures are their own ticket's
  work and are never registered in production.
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

## The outbound fetch handler (`src/fetchJob.ts`)

The platform-authored work for the one installed production type
(`jobs:fetch`): one governed GET, then the complete upstream JSON value. The
handler is composed once per process with this server's jobs→edge minting key
and the two signed callback destinations, and registered for the installed
type only — no caller input selects it.

- **The dispatch, not the fetch.** The outbound call is made by the edge's
  signed jobs→edge callback (`POST /internal/jobs/v1/fetch`, the receiver the
  callback ticket owns), which resolves the CURRENT registry entry, fences
  the signed lifecycle generation, checks the origin allowlist and the
  delegated prohibition, charges the app's fetch budget, mints the egress
  instruction and streams the upstream bytes back. The handler mints the
  instruction from the job's immutable record identity (the attempt context's
  record — server, app, environment, principal kind, owner, qualified type,
  the job's public id and its admitted generation), binds the exact
  `{url}` body bytes by digest, and selects the destination by the job's
  signed environment tier — never by input, never with a fallback between
  tiers. No redirect is followed (the signed contract binds one resource),
  and the whole dispatch is bounded at the platform's 30-second outbound
  timeout alongside the attempt's own abort signal (a cancellation or a
  claim expiry) — both stop the call, and the abort propagates back through
  the edge's stream to the egress forward.
- **The interpretation is terminal, never retried.** The type has one
  execution attempt and the handler makes one dispatch: a refusal, an
  upstream failure, an unusable answer or a timeout is the job's distinct
  terminal reason, with no partial output ever returned. The callback's
  bounded error envelope maps onto the job's reasons — `outbound_forbidden`,
  `delegated_unattended` and `outbound_quota_exceeded` pass through; the
  edge's `upstream_error` (the upstream's non-2xx or a failed forward) is the
  job's `upstream_error`; everything the callback's own machinery answers
  (unauthorized, jobs_disabled, jobs_unavailable, body refusals) is the job's
  `platform_error`. A 200 body is read bounded on the STREAM — the cap stops
  the response the moment it passes the 64-KiB result allowance
  (`result_too_large`, the excess bytes never read, the stream's abort
  propagating to the egress forward) — then parsed as a complete JSON value
  (`result_invalid` when it is not; JSON `null` is a result, never absence).
- **Progress is the one unit.** Nothing is reported until a valid complete
  JSON result is in hand, and the report (`{step: 1, of: 1}`) is the last
  thing before the value is returned — a poll never sees the unit completed
  without the result that completes it.
- **Telemetry.** The dispatch runs in its own client child span
  (`helix.jobs.fetch.dispatch`) beside the attempt's `helix.jobs.execute`
  root, and `helix.jobs.fetch.dispatches` counts the outcomes
  (`JOBS_FETCH_DISPATCH_OUTCOMES`); the callback's error code and the abort's
  classification ride `helix.reason`. The grading is the execute span's
  contract: designed answers (refusals, the upstream's failure, the result
  refusals, the timeout, the cancellation) stay UNSET; the callback seam
  failing or answering off-protocol grades ERROR. Never the target URL, the
  callback base, the instruction token, the input bytes or the owner oid.

## Execution fairness (`src/policy.ts`, `src/execution.ts`)

The per-process execution allowance is the platform's, never an app's: one
pg-boss worker registration per process, its options derived once from the
shared capacity defaults (`jobsWorkOptions` — `runningPerWorker` 8 total,
`runningPerAppEnv` 2 per trusted `(appId, env)` group), enforced by the one
queue all installed types share. Job inputs and manifests carry nothing that
reaches it; the send site scopes every job to its signed identity's group
(`jobsAppEnvGroupId`) and carries the type's own policy columns.

- **One live registration per process.** pg-boss spawns a full worker set per
  `work()` call, so a second registration on one instance would silently
  multiply the per-process total — the thing design §6 forbids ("never let
  each type silently receive its own full allowance"). `JobsExecution`
  refuses a second live registration on an instance it has already registered
  (`releaseOn` is the sanctioned release), whichever component attempts it.
- **The measured envelope.** `src/fairness.integration.test.ts` runs the real
  chain — real acceptance transaction, real supervised runners, real role
  split — with holding handlers, measures the delivered concurrency from the
  handlers themselves, and publishes one `[jobs fairness]` record per leg.
  Observed on this repository's dev cluster (Postgres 18, one suite run):
  one worker peaks at 8 total with every app/environment group at 2 at the
  same time (an app's `prod` and `dev` groups each at their own 2); two
  overlapping worker processes — the rolling-deployment shape — peak at 16
  total and 4 per group, never more, with the database's own connection count
  at saturation read and published alongside (25 connections in that run —
  the figure a deployment's overlap budget must size, design §4/§8). The same
  legs pin the distinction from transactional capacity: five jobs accepted
  for one group (far inside the 20-per-app unfinished cap) run two at a time
  while the rest wait queued — the binding constraint is the execution
  allowance, not storage.

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
- **Durable cancellation intent is part of the same reconciliation.** A
  record whose `cancellation_requested` is pending on a runner row still
  waiting or active re-drives the runner cancel (the dependency's own fence
  makes the re-drive safe against a racing completion) and, when the drive
  confirms the row cancelled, projects the intent's terminal `cancelled`
  outcome. A drive that could not answer — or that found the row already
  terminal — projects nothing this pass: the next pass reads the row's own
  state truthfully. This is the recovery of a lost runner drive (a crash
  between the intent write and the cancel) and the outage-resume path: the
  intent stays pending and the passes keep applying it until no active work
  remains.
- **Archive-cancellation recovery rides the same arms.** A delivered archive
  (or a newer generation) reaches the records as durable intent stamped by
  the lifecycle apply's own transaction — the per-record flag the arms above
  already carry to terminal outcomes. The pass opens with that state's
  lifecycle half: a healing stamp re-records intent on still-active
  closed-generation work that carries none (a store whose closed generations
  predate the stamping), then measures the backlog — the outstanding count
  and oldest pending age of still-active closed-generation work, in both
  environments. That measurement is the `jobs_lifecycle_recovery` health
  check's evidence, kept separately visible from the portal's delivery lag:
  a backlog converging inside the healthy-service bound reads `ok` with its
  count in the metrics; pending work older than 60 seconds degrades
  (criterion 52), and recovery keeps applying until none remains active —
  with no promised overall completion time.
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

## The cleanup loop (`src/cleanup.ts`)

The retention contract's physical half (`src/observation.ts` owns the logical
horizons; design §7 owns the bounds): expired content stops being READ at its
horizon and stops being STORED within 48 hours after it — including after a
service restoration. One supervised pass, on a one-minute cadence:

- **The result arm.** Every stored result whose seven-day lifetime has ended
  is removed from the live record, and the row's stored status converges to
  `expired` in the same statement (the store's own CHECK constraints require
  it — a success always carries its result). The record itself, its retry
  key and every other column stay: the record stays publicly readable as
  `expired` until its record horizon.
- **The record arm.** Every terminal record past its thirty-day horizon —
  the same lifetime for every terminal outcome — is retired TOGETHER with the
  runner row it was accepted under, in one transaction: the runner ids come
  from the record deletion's own `RETURNING`, and their deletion rides the
  runner adapter's borrowed-connection delete (`runner.deleter`, the pinned
  dependency's own `deleteJob` on the caller's client), so a rollback — for
  example a runner row that cannot be removed — leaves the record, its retry
  key and its runner row all in place. Nothing is ever half-retired. Because
  the runner ids are the retired records' OWN ids, a key reused by a
  replacement job — which cannot exist until the deletion that releases the
  scoped-key constraint commits — can never be caught by a pass's runner
  deletes, and two replicas' passes racing the same rows each delete exactly
  what their own statement returned.
- **Active work is never pruned by age.** Both arms select on the record's
  terminal instant; a non-terminal record has none, whatever its age — the
  absolute deadline's enforcement is the recovery sweeper's and the start
  gate's, and a terminal status is absorbing.
- **The bounds.** Each arm touches at most 500 rows per pass; a pass that
  removed a full batch is followed immediately by the next (a backlog left
  by an outage converges in minutes of drained passes instead of standing on
  the cadence). A FAILED pass retries on the storage supervisor's capped
  backoff, not the steady cadence — the recovery after a repair is measured
  in seconds. Native pg-boss maintenance cannot race this contract: the
  queue policy disables its deletion sweep on both arms, and the startup
  compatibility check refuses a store whose queue policy drifts.
- **The measurement.** A pass opens by measuring the server-wide retained
  and unfinished occupancy and the overdue content — what has already stood
  past its 48-hour removal deadline. That measurement is the evidence two
  health checks grade (both lookup-only, like every other check): the
  `jobs_cleanup` check (a stopped or never-passed loop → `error`; a stale
  pass → `degraded`; overdue content → `degraded` until a pass opens on it
  cleared — "operators see overdue cleanup until it completes") and the
  `jobs_capacity` check (retained saturation at the server-wide cap →
  `degraded`, the state where new work is refused and only cleanup frees
  it). Unfinished-capacity refusal alone deliberately degrades nothing — an
  ordinary busy answer is not an unhealthy worker.
- **Supervision and telemetry.** The recovery sweeper's discipline verbatim:
  `start()` never throws, a failed pass is counted, logged and never ends
  the cadence, `stop()` releases the pool and the timer on every exit path.
  One root consumer span per pass (`helix.jobs.cleanup`, outcome
  `JOBS_CLEANUP_OUTCOMES`, the pass's removed counts as its batch-bounded
  attributes) and the `helix.jobs.cleanups` counter — a run of `failed` with
  no `ok` is a store that stopped answering its cleanup.

## The app-lifecycle authority (`src/lifecycle.ts`)

The portal is the generation authority (ADR-0007); this service owns the
jobs-side state its delivery lands in — one row per known app in the
`jobs.app_lifecycle` table: the highest lifecycle generation durably applied
and whether that generation is archived. The lifecycle route applies a
delivered `{generation, archived}` in one transaction — ensure the row, lock
it, merge, write, stamp, commit — and acknowledges **after** the commit with
the highest applied generation, never the delivered one: a redelivery or an
out-of-order older change acknowledges the highest and changes nothing, so
older deliveries can never reopen a closed generation (each new generation's
watermark already closes every generation below it — an immediate
archive/unarchive delivered in either order keeps every pre-archive
generation ineligible).

The stamp is how a delivered archive becomes per-record cancellation intent:
every still-active job record of the app that the applied state closes — in
both environments — is stamped `cancellation_requested` (with the instant it
became pending) in the same transaction, before the acknowledgement. The
admission/start gate's row lock makes that race-free: an acceptance that
committed before the apply is visible to the stamp, and one after it reads
the closed generation and is refused. The recovery sweeper's arms carry each
stamped record to its terminal `cancelled` outcome; the acknowledgement
confirms durable intent, never that cancellation has finished running.

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
result — the durable owner-cancellation intent column
(`cancellation_requested`) and the terminal-outcome instant column
(`terminal_at`, the input both public-read horizons derive from), with the
state-machine checks that keep a result
only where the
public record projects it and a terminal status always dated — and the
occupancy index the capacity counts
use), grants the runtime role DML
on all of it — provisioning sets no default privileges, so grants arrive by
migration — and verifies the effective state by re-reading it. The
job-record store's added columns converge in place for an existing store,
and a pre-existing terminal row is dated at the migration instant (the
conservative direction: it can only extend readability, never shorten it).
Later
jobs-owned migrations extend this command the same way: a step under the
migration identity, after the schema they depend on exists.

## Startup compatibility check (`src/compat.ts`)

`checkJobsStorageCompatibility(pool)` answers, read-only, whether the
runtime may rely on its store: schema installed at the pinned dependency's
version, the queue carrying the platform's effective policy, the instruction
burn store, the app-lifecycle store and the job-record store present with its
execution columns, the cancellation-intent column, the pending-cancellation
instant column, and the terminal-instant column, and the
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
  `jobs_worker` check grades the runner's, the `jobs_sweeper` and
  `jobs_lifecycle_recovery` checks grade the recovery sweeper's (the loop's
  freshness and its archive-cancellation backlog measurement — names in
  `@azx-pbc/shared`, `JOBS_HEALTH_CHECK_NAMES`), and **unknown readiness
  never appears healthy** — before any probe has answered, the state is
  `error`; a listener without its worker is `error`, not ok; a sweeper that
  never completed a pass, or whose last successful pass is older than three
  sweep cadences, is `error`/`degraded`, never ok.
- **Invalid configuration is an explicit startup error.** `loadJobsConfig`
  (`src/config.ts`) refuses a missing or malformed `JOBS_SERVER_ID`,
  `JOBS_DATABASE_URL`, any of the server's three signing roots
  (`JOBS_EDGE_TO_JOBS_SECRET` and `JOBS_PORTAL_TO_JOBS_SECRET` for the two
  receiving directions, `JOBS_JOBS_TO_EDGE_SECRET` for the fetch callbacks it
  mints), or either callback destination (`JOBS_EDGE_PROD_URL` /
  `JOBS_EDGE_DEV_URL`) before anything listens; the roots derive to their
  direction keys at boot, so a malformed one stops the process, not the first
  instruction.
- **Shutdown releases what startup acquired.** The `onClose` hook stops the
  recovery sweeper first (its runner-row reads ride the runner's instance),
  then the cancellation store (its runner drive rides the same instance),
  then the runner (its retry timer, its instance and the worker on it), then
  every store's pool — the execution store, the acceptance store, the
  observation store, the
  lifecycle store, the burn store's sweep timer, the storage supervisor's
  probe timer — and flushes telemetry; the graceful-shutdown install bounds
  the drain. The failed-partial-initialization exit releases the same set.
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

The ordinary local stack resolves the jobs plane for you: an offset stack's
`node scripts/stack-env.mjs --env` mints this whole env set (plus the edge's
`EDGE_JOBS_CONFIG`, the portal's `PORTAL_JOBS_CONFIG`/`PORTAL_JOBS_CATALOGUE`,
and the stack's private `helix_jobs_<suffix>` database — `scripts/ensure-db.mjs`
provisions and migrates it through the migration identity), so
`env $(node scripts/stack-env.mjs --env --offset 1000) pnpm dev:jobs` joins the
run-helix composition with every credential already agreed. A resolved stack
also sets `HELIX_STACK_ENV`, under which the services skip their
`.env.local` files — the stack env is authoritative, and a second stack
obeying the developer's files would boot cross-wired into their credentials.
On the shared dev stack (offset 0) the developer's own settings are
authoritative — this manual form, typically via `apps/jobs/.env.local`; without
them the rest of the stack runs fully disabled. A `JOBS_DATABASE_URL` override
on an offset stack must name a database on the SAME Postgres server as
`DATABASE_URL` — the prep provisions through that connection — and it must not
name a jobs-store database (`helix_jobs`, `helix_jobs_<suffix>`), which both
the resolver and the prep refuse. The three roots are any independently
generated base64 32-byte secrets — `openssl rand -base64 32`; the callback
destinations are the edge's bases for the two tiers (the edge process for
`prod` instructions, the dev-gateway process for `dev` — each on a
platform-class host, never an app host):

```
JOBS_SERVER_ID=jobs \
JOBS_DATABASE_URL=postgresql://helix_jobs:…@db:5432/helix_jobs \
JOBS_EDGE_TO_JOBS_SECRET=… JOBS_PORTAL_TO_JOBS_SECRET=… JOBS_JOBS_TO_EDGE_SECRET=… \
JOBS_EDGE_PROD_URL=https://… JOBS_EDGE_DEV_URL=https://… \
[JOBS_LIMITS='{"unfinishedPerAppEnv":20}'] \
  pnpm dev:jobs
```

The listener serves `/health` and the five signed internal operation routes
(verification + durable burn). The lifecycle route serves the portal's
delivery (the app-lifecycle authority above), the submit route serves the
acceptance transaction (above), the cancel route serves the owner-cancellation
seam (above), the snapshot and result routes serve the owner-scoped
observation reads (above), and the worker executes accepted work — the
execution seam above, with the outbound fetch handler dispatching its
governed GET through the edge's signed callback; an unmatched
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
