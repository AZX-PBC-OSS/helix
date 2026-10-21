---
title: Operating background jobs
description: "Run, recover, retire and size the background-jobs plane: server states, the procedures that keep job references valid, the health checks and alerts, and the measured capacity figures."
---

# Operating background jobs

The background-jobs plane is one job server named `jobs`: the `helix-jobs`
service (pg-boss on Node) and its private `helix_jobs` database. This page is
for the operator who runs it. It covers the states a server can be in, the
procedures that move it between them without losing a job reference, how to
read its health, and what has been measured about its capacity.

The deployment definitions ship the plane on by default (`deployJobs=true`).
Turning it on in a production install is your rollout decision; nothing on
this page assumes it has happened.

There is no administration UI for jobs, in production or locally. You diagnose
the plane from health bodies, structured logs and the jobs API. The
[Azure README](https://github.com/AZX-PBC-OSS/helix/blob/main/infra/azure/README.md#background-jobs-deployjobs-adr-0045)
is the reference for what the template provisions. This page is the procedure
layer on top of it.

## Server states

| State | How you get there | New submissions | Existing jobs | App lifecycle changes |
| --- | --- | --- | --- | --- |
| Serving | `jobsServerState=serving`, `jobsIntakeOpen=true` (the defaults) | Accepted | Run, read, cancel, recover by retry key, clean up | Delivered to the server |
| Intake closed | `jobsIntakeOpen=false` | `503 jobs_disabled` | Same as serving | Delivered |
| Retiring | `jobsServerState=retiring` (closes intake whatever `jobsIntakeOpen` says) | `503 jobs_disabled`, and `jobs:fetch` is no longer offered for new grants. Saved grants stay | Same as serving | Delivered |
| Temporarily unavailable | an outage, a stopped replica, a broken store | `503 jobs_unavailable` (retryable, and acceptance is uncertain) | Reads answer `503`; nothing is lost | Queued in the portal's outbox until the server answers |
| Disabled | `deployJobs=false` | `503 jobs_disabled` | Not served. The database and its records stay | Not recorded |

Four rules follow from this table:

- **A temporary shutdown is not retirement.** Keep the configuration, the
  store and the portal's pending lifecycle intents. Recovery uses the same
  store.
- **Disable only a drained server.** `deployJobs=false` stops serving every
  reference the store still holds. Retire first and wait for the drain.
- **Never point the `jobs` server at an empty or different database while its
  references remain.** A retained retry key replayed against an empty store
  would run its work a second time. The template declares the `helix_jobs`
  database unconditionally so an apply can never delete it. The service
  refuses a store bound to another server id (`jobs_intake` reports `error`),
  but it cannot detect an empty replacement.
- **Closing intake never refuses work that was already being enqueued.** The
  closure is written to the store under the admission lock, so it waits for
  in-flight admissions on every replica to commit, and no replica admits new
  work after it lands.

Proof: `apps/jobs/src/intake.integration.test.ts` (closure serialized with
in-flight admissions, reads and cancellation while closed, reopening on the
same store), `apps/jobs/src/namedServers.integration.test.ts` (retirement keeps
old reads and retries while blocking new work) and
`apps/jobs/src/runtimeRecovery.integration.test.ts` (a temporary stop, an
absent store and an incompatible schema, each recovered with accepted work
kept).

## Procedures

Each state change below is a Bicep parameter changed with a full template
apply. The parameters are described in the
[configuration reference](/deploy/configuration#feature-gates).

### Enable jobs on an existing installation

Follow the
[jobs upgrade procedure](https://github.com/AZX-PBC-OSS/helix/blob/main/infra/azure/README.md#the-jobs-upgrade-procedure-existing-install)
in the Azure README. It has five steps, and their order is the barrier that
keeps an existing install safe:

1. Re-run the role script, so the jobs identities and database exist.
2. Apply the template with `deployJobs=true` and the bootstrap passwords and
   signing roots.
3. Run both migrate jobs. They own different databases, so either order
   works, but both must finish before the images that need them roll.
4. Roll the images. The jobs service's startup check refuses a schema it does
   not match and reports it in `/health`; it never migrates.
5. **Wait for lifecycle synchronization.** Until the portal has delivered an
   app's current lifecycle state to the server, that app's submissions get a
   retryable `503 jobs_unavailable`. Enablement is finished when the portal's
   `jobs_lifecycle_delivery` check shows `synchronizedTargets` equal to
   `targets` and has no detail.

The `helix-jobs` image is not published by CI yet. Push it manually for each
release before step 2, because the apply creates the jobs app and its
migrate job from it. See
[Deploying updates](/deploy/updates#what-ci-publishes).

Proof: `apps/jobs/src/enablementSync.integration.test.ts` (the real portal
sender synchronizes every app, archived apps included, before intake opens),
`apps/jobs/src/deployedComposition.integration.test.ts` (an existing install
upgraded with accepted work and per-service credentials kept, with the two
migrations run in both orders), and
`apps/jobs/src/azureMigrationWiring.test.ts` (the two migrate jobs share
nothing).

### Routine upgrades

A routine update follows [Deploying updates](/deploy/updates): run both
migrate jobs, then roll the apps. The jobs health relay is a scheduled job
that runs the same image. A full apply keeps the two in step; a routine
image roll does not, so update the relay with the jobs app. It validates
health bodies against the contract in its own image.

```bash
az containerapp job update -g <rg> -n <namePrefix>-jobs-health-relay \
  --image "ghcr.io/<owner>/helix-jobs:$TAG"
```

During a rollout the old and new jobs revisions overlap. Both processes
execute work from the same store, so for that window the execution envelope
is twice the per-process one (see [Capacity and sizing](#capacity-and-sizing)).
Accepted jobs keep their state across the roll.

### Temporary shutdown and recovery

An outage needs no procedure to be safe, only one to confirm recovery. While
the jobs service or its store is down:

- Submissions get `503 jobs_unavailable`. A client cannot tell whether its
  request was accepted, so it retries with the same retry key; the key
  recovers the original job once the server answers.
- Status, result and cancellation requests get `503`, never a fabricated
  `404` or an empty result.
- Accepted work stays in the store. The portal keeps lifecycle changes in its
  outbox and keeps delivering them.
- Deadlines do not stop. A job's 60-minute absolute deadline (5 minutes for
  `jobs:fetch`) runs through the outage, and work past its deadline is not
  executed on recovery.

When the service comes back, it rechecks the store on a capped backoff
without a restart. The recovery sweeper then settles interrupted attempts: a
type that permits retries runs again, and a single-attempt `jobs:fetch` job
whose worker died is recorded `crashed`. It is not rerun. Cleanup catches up
on anything that became due during the outage.

There is no template parameter for a temporary stop, and none is needed. To
pause new work, [close intake](#close-intake-without-retiring). If the jobs
replica or its store has to stop, for example for Postgres maintenance, the
behaviour above applies and there is nothing to undo afterwards. Keep the
template parameters unchanged: a shutdown is not a state change.

Recovery is complete when:

- every `jobs_*` check on the jobs service reads `ok`;
- the portal's `jobs_lifecycle_delivery` check reads `ok` with
  `outstanding` back to 0;
- `-alert-jobs-unobserved` and any other jobs alert have resolved.

Proof: `apps/jobs/src/runtimeRecovery.integration.test.ts` (a temporary stop,
then a store absent and incompatible at startup, recovered without a restart;
the store dying under a running service, then recovering),
`apps/jobs/src/recovery.integration.test.ts` (the sweeper's projections) and
`apps/jobs/src/retryIdentity.integration.test.ts` (a lost reply recovered by
the same key).

### Close intake without retiring

Set `jobsIntakeOpen=false` and apply. The jobs service receives
`JOBS_ACCEPTING=false`. New submissions get `503 jobs_disabled`; everything
else keeps working, including retained-key recovery of earlier submissions.
`jobs:fetch` stays offered for new grants. Use this to drain an active
installation, or to pause new work while you investigate.

Confirm the closure from the jobs service's `jobs_intake` check. Once the
closed posture is applied it reads `ok`, with the drain counts in its metrics.
It reads `degraded` while the posture is not yet applied, and while the
cleanup evidence behind the drain counts is stale.

**Known caveat during the closing rollout.** If a replica of the old revision
restarts while the closing revision is rolling out, it applies its own
configuration, which is still open. Until the old revision is deactivated,
that replica can admit new submissions; replicas of the new revision still
refuse them. Anything admitted in that window is ordinary accepted work and
drains like the rest. Before you rely on the closure, confirm that only the
new revision is active:

```bash
az containerapp revision list -g <rg> -n <namePrefix>-jobs \
  --query "[?properties.active].{rev:name,image:properties.template.containers[0].image}" -o table
```

To reopen, set `jobsIntakeOpen=true` and apply. The same store reopens with
every job and retry key it held.

### Retire the server

Retirement closes new work and waits for the store to empty. Its references
keep working until then.

1. Set `jobsServerState=retiring` and apply. Intake closes, and `jobs:fetch`
   leaves new-grant discovery in the portal. Saved grants are not rewritten,
   so an app that holds one can still read, cancel and recover its existing
   jobs.
2. Confirm the closure as in [Close intake](#close-intake-without-retiring).
3. Watch the drain in the `jobs_intake` check: its `unfinishedServer` and
   `retainedServer` metrics, and the detail `intake is closed and drained`
   when both are zero. Unfinished jobs finish within their deadlines. Retained
   jobs leave only through cleanup, up to 30 days after each job's terminal
   outcome plus the 48-hour removal window, so plan for a drain of about a
   month.
4. When the check reports the server drained, the server is retired. Disable
   the plane next if you no longer want it.

Throughout, keep the configuration, the routes, the credentials and the
store. Do not remove grants or edit records to speed the drain up.

### Disable the plane

Set `deployJobs=false` and apply, after retirement has drained the server or
on an install that has never held a job. The apply removes the jobs container
app, its migrate job and health relay, and every jobs setting from the edge,
dev gateway and portal. Ordinary hosting then has no jobs dependency: the
jobs routes answer `503 jobs_disabled`, and the portal writes no lifecycle
intents and reports no `jobs_lifecycle_delivery` check.

The `helix_jobs` database and any records in it stay.

### Re-enable the plane

Re-enabling reuses the retained store. Never create a fresh database for it.

1. Set `deployJobs=true` (with `jobsServerState=serving` and
   `jobsIntakeOpen=true`) and apply. The apply needs the jobs DSNs and the
   three signing roots: from the vault lines in `main.bicepparam` if those
   secrets are still in kv-platform, otherwise from the bootstrap variables,
   as in step 2 of the upgrade procedure.
2. Run the jobs migrate job against the image you are deploying, then roll
   the jobs app.
3. Wait for lifecycle synchronization, exactly as in step 5 of the upgrade
   procedure. The portal resends the current state of every app before that
   app's submissions are admitted.

Retained keys then recover their original jobs, and records keep their
original retention clocks. Nothing cleans the store while the plane is
disabled, so the first cleanup passes after re-enabling remove whatever
became due. If any of it is past its 48-hour removal deadline, `jobs_cleanup`
reads `degraded` until it is gone. Expired results and records read as
expired throughout; cleanup timing never extends readability.

### Tune capacity limits

The template sets neither limit variable, so a deployed plane runs the
platform defaults. To change one after sizing, add it as a plain environment
entry on the container app in `main.bicep`. Neither value is a secret.

| Variable | Set on | Controls | Default |
| --- | --- | --- | --- |
| `EDGE_JOBS_LIMITS` | the edge and the dev gateway (set both) | `submissionAttemptsPerAppEnv`, `submissionAttemptsDeployment`, `submissionWindowSeconds` | 10 and 100 attempts per 60 s window |
| `JOBS_LIMITS` | the jobs app | `unfinishedPerAppEnv`, `unfinishedPerServer`, `retainedPerAppEnv`, `retainedPerServer`, `runningPerAppEnv`, `runningPerWorker` | 20, 200, 1,000, 10,000, 2, 8 |

```bicep
// in the jobs app's envVars in infra/azure/main.bicep
{ name: 'JOBS_LIMITS', value: '{"retainedPerServer":5000}' }
```

Each value is a positive whole number. An unknown key or a bad value stops
the service at boot with the variable named, so a typo never leaves a default
silently in force. `EDGE_JOBS_LIMITS` also refuses the jobs service's keys,
so one document cannot appear to tune a service that never reads it.

What a change does:

- **Lowering a cap evicts nothing.** Accepted jobs and stored results stay.
  New work is refused `429 jobs_capacity_exceeded` until occupancy falls below
  the new cap.
- **A change takes effect per process.** During the rollout the old process
  admits under its old limits until it stops.
- **The edge counts across replicas; the dev gateway does not.** The edge
  keeps both submission windows in the shared database. The dev gateway
  counts development submissions in each replica's memory, and it can scale
  to 3 replicas, so the development tier can admit up to three times the
  configured rate. Development traffic never counts toward the production
  window.

Proof: `apps/jobs/src/capacity.integration.test.ts` (caps hold under
concurrency, lowering evicts nothing, the throttle charges every attempt),
`apps/jobs/src/workerOverlap.integration.test.ts` (mixed limits during an
overlap), and `apps/jobs/src/config.test.ts` and
`packages/shared/src/jobsDeployment.adversarial.test.ts` (malformed overrides
refused).

## Reading health

Each service reports its jobs state as checks inside its `/health` body,
which answers HTTP 200 in every state. Read the body, never the status code.

| Check | Reported by | Reads `degraded` or `error` when |
| --- | --- | --- |
| `jobs_database` | jobs | the store is unreachable, or its schema, queue policy or runtime grants do not match this image |
| `jobs_worker` | jobs | the runner has not started or has no registered worker |
| `jobs_sweeper` | jobs | the recovery sweeper has not run, has no successful pass, or is stale |
| `jobs_lifecycle_recovery` | jobs | archive cancellation of still-active jobs has been pending over 60 s |
| `jobs_cleanup` | jobs | the cleanup loop stopped or is stale, or content is past its 48-hour removal deadline |
| `jobs_capacity` | jobs | retained jobs reached the server-wide cap, or the measurement is stale |
| `jobs_intake` | jobs | the configured intake posture is not yet applied, or the store belongs to another server |
| `jobs_lifecycle_delivery` | portal | lifecycle changes have waited over 60 s for delivery, or the sender stopped |
| `jobs_reachability` | edge, dev gateway | one or more configured jobs servers do not answer `/health` as the jobs service |

Missing or stale evidence never reads `ok`. Ordinary throttling (`429
rate_limited`) and unfinished-capacity refusals degrade nothing: a busy server
is not an unhealthy one.

### Delivery backlog and cancellation backlog

Archiving an app cancels its unfinished jobs in two stages, and each stage
has its own check:

1. **Delivery.** The archive is written to the portal's outbox in the same
   transaction as the app change. The portal's sender delivers it to the jobs
   server. `jobs_lifecycle_delivery` on the portal grades this stage: its
   `outstanding` and `oldestSeconds` metrics count intents not yet
   acknowledged, and its detail names each lagging server. A backlog here
   means the jobs server has not heard about the change. Look at
   reachability and the portal's `jobs.delivery.*` events.
2. **Cancellation.** Once delivered, the jobs server marks every still-active
   job of the older generation for cancellation in the same transaction, and
   the recovery sweeper carries each one to `cancelled`.
   `jobs_lifecycle_recovery` on the jobs service grades this stage with its
   own `outstanding` and `oldestSeconds`. A backlog here means the change
   arrived but jobs are still running. Look at the runner and the
   `jobs.recovery.*` events.

Either backlog degrades its check after 60 s. Delivery and cancellation keep
going until they settle; there is no promised completion time. Until a new or
unarchived app's state is delivered, its submissions get `503
jobs_unavailable` rather than being admitted on an unknown state.

Proof: `apps/jobs/src/portalDelivery.integration.test.ts`,
`apps/jobs/src/lifecycleRecovery.integration.test.ts` and
`apps/jobs/src/lifecycleCancellation.integration.test.ts`.

### Expiry and cleanup

Retention is enforced in two halves. Reads expire on time whatever cleanup
is doing; storage is released by cleanup.

- A successful result is readable for 7 days. After that the result reads
  `410 result_expired` and the job's status reads `expired`.
- A job record is readable for 30 days after its terminal outcome, whatever
  the outcome, and then reads `404`.
- Cleanup removes expired results and expired records within 48 hours of
  each horizon. A record and its runner row are removed together, with the
  retry key, in one transaction. Completion alone removes nothing.
- Retained-job capacity is freed only by that removal. If cleanup stops, the
  store eventually fills to `retainedPerServer`, new work is refused `429
  jobs_capacity_exceeded`, and `jobs_capacity` reads `degraded`. Existing
  jobs stay readable.
- If an outage holds cleanup past its deadline, `jobs_cleanup` reads
  `degraded` until a pass completes on a clear store. A pass that removes a
  full batch of 500 is followed immediately by the next, so a backlog drains
  in minutes once the store answers.
- On boot, the first cleanup pass can fail with "the runner has not started"
  when it has records to remove. It retries a second later. One failed pass
  at startup is not an incident; a run of `jobs.cleanup.pass_failed` with no
  `jobs.cleanup.pass` is.

Proof: `apps/jobs/src/retention.integration.test.ts` and
`apps/jobs/src/cleanup.integration.test.ts`.

### Alerts

With `deployAlerts` and `deployJobs` on, a relay job reads the jobs and
portal health bodies every 5 minutes from inside the environment, and five
log rules alert on them: `-alert-jobs-execution`, `-alert-jobs-capacity`,
`-alert-jobs-cleanup`, `-alert-jobs-lifecycle` and `-alert-jobs-unobserved`.
The
[alert table](https://github.com/AZX-PBC-OSS/helix/blob/main/infra/azure/README.md#background-jobs-health-bodies-from-inside-modules-alerts-jobs-bicep)
in the Azure README gives each rule's condition, severity and first
diagnostic step. Treat `-alert-jobs-unobserved` first: while it fires for a
target, the other four rules have no reading for that target and cannot
fire.

### Reading a body or the logs yourself

The jobs app and, by default, the portal have internal ingress. Read a health
body from inside the replica. The images carry no curl, so probe with node
over a pseudo-TTY, as in the Azure README's isolation checks:

```bash
script -q /dev/null az containerapp exec -g <rg> -n <namePrefix>-jobs --command \
  "node -e \"fetch('http://127.0.0.1:3003/health').then(r=>r.text()).then(console.log)\"" < /dev/null

script -q /dev/null az containerapp exec -g <rg> -n <namePrefix>-portal --command \
  "node -e \"fetch('http://127.0.0.1:3001/health').then(r=>r.text()).then(console.log)\"" < /dev/null
```

Every service logs structured JSON with an `event` field. To read the jobs
service's own events in the Log Analytics workspace:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "<namePrefix>-jobs"
| extend p = parse_json(Log_s)
| where tostring(p.event) startswith "jobs."
| project TimeGenerated, event = tostring(p.event), level = toint(p.level), msg = tostring(p.msg)
| order by TimeGenerated desc
```

The events worth knowing by area:

| Area | Events |
| --- | --- |
| Store and boot | `jobs.storage.ready`, `jobs.storage.unavailable`, `jobs.runner.started`, `jobs.runner.start_failed`, `jobs.worker.registered` |
| Intake | `jobs.intake.applied`, `jobs.intake.apply_failed`, `jobs.intake.refused` (the store belongs to another server) |
| Capacity | `jobs.admission.capacity_refused` (one bounded line per refusal, with the cap, the limit and the occupancy) |
| Execution | `jobs.execution.failed`, `jobs.execution.deadline_exceeded`, `jobs.execution.platform_error`, `jobs.execution.settle_uncertain` |
| Recovery | `jobs.recovery.pass`, `jobs.recovery.pass_failed`, `jobs.recovery.reconciled`, `jobs.recovery.terminated`, `jobs.recovery.lifecycle_stamped`, `jobs.recovery.row_missing` (a corrupt store) |
| Cleanup | `jobs.cleanup.pass`, `jobs.cleanup.pass_failed`, `jobs.cleanup.backlog`, `jobs.cleanup.overdue` |
| Lifecycle delivery (portal) | `jobs.delivery.pass`, `jobs.delivery.synchronized`, `jobs.delivery.unreachable`, `jobs.delivery.refused`, `jobs.delivery.pass_failed` |

No log line carries a job input, a result body, a retry key, a full URL, a
credential or a user identity.

For one job, use the jobs API as its owner: `GET
/_api/jobs/jobs/<jobId>` returns its status, attempt, progress and error
reason. The portal's usage and audit views record jobs submission requests,
including replays and uncertain endings; they are a request log, not a count
of jobs. There is no operator job list.

## Capacity and sizing

The capacity defaults are fairness and resource-protection controls, not
service levels. The figures below separate what the platform enforces from
what was observed in a test run.

### What is enforced

- Submission attempts: 10 per app and environment, and 100 across the
  deployment, per 60-second fixed window. Every authenticated attempt counts,
  including retries, invalid input and refusals. There are no refunds.
- Unfinished jobs: 20 per app and environment, 200 per server, checked in the
  same transaction as the enqueue.
- Retained jobs: 1,000 per app and environment, 10,000 per server, checked
  the same way. Every physically stored job counts, active or terminal.
- Running jobs: 2 per app and environment and 8 in total per worker process.
  These are per-process limits, not fleet-wide reservations.
- Input and result: at most 65,536 bytes each.

### What was measured

All measurements ran in this repository's dev container (Postgres 18,
`max_connections` 300) on developer hardware, not on Azure. They are
observations of particular runs, not guarantees; the guarantees are the
limits above. Re-run the named suite to measure your own environment.

| Measurement | Observed | Source |
| --- | --- | --- |
| Running jobs, one process | peaks at 8, with each of four app/environment groups at 2 | `workerOverlap.integration.test.ts`, `fairness.integration.test.ts` |
| Running jobs, two overlapping processes | peaks at 16, and 4 per group, never more | same suites |
| Jobs-role connections, one process | 15 at the execution peak | `workerOverlap.integration.test.ts` |
| Jobs-role connections, two processes | 24 at the execution peak | `workerOverlap.integration.test.ts` |
| Graceful stop of one of two processes mid-run | its 8 running jobs reran on the other process, all 20 succeeded | `workerOverlap.integration.test.ts` |
| Storage per small job, queued (about 40-byte input) | about 1.4 KiB: 1.0 KiB record, 0.4 KiB runner row | `storageSizing.integration.test.ts` |
| Storage per small job, succeeded (about 40-byte result) | about 1.9 KiB | `storageSizing.integration.test.ts` |
| Storage per job at both bounds, queued | about 70 KiB, nearly all the input in the runner row's TOAST | `storageSizing.integration.test.ts` |
| Storage per job at both bounds, succeeded | about 140 KiB: the input once in the runner row, the result once in the record | `storageSizing.integration.test.ts` |
| Completion | removes no row; the record and the runner row both stay until cleanup | `storageSizing.integration.test.ts`, `workerOverlap.integration.test.ts` |
| Cleanup, then `VACUUM` | both rows of every job removed; table and TOAST files shrink back, index files keep their size | `storageSizing.integration.test.ts` |
| Refilling after cleanup | the same number of small jobs fit in the freed table pages; only the indexes grew | `storageSizing.integration.test.ts` |

The storage figures come from two runs on the same day, which agreed to
within 0.1 KiB per small job and 2 KiB per bound job. Postgres allocates in
8 KiB pages, so a figure for 100 small jobs is rounded to the page. The bound
profile used incompressible input and result bodies of exactly 65,536 bytes
each, so it is the worst case per job; compressible JSON stores smaller. The
suite runs the real migrated store, the real admission transaction, worker
and cleanup loop, with a test-owned handler in place of the outbound fetch.
It does not go through the signed HTTP hops, which add only short-lived
instruction-replay rows to this store. Those rows are pruned after their
replay window and are not measured. The pinned pg-boss keeps no separate
archive table: a finished job's runner row stays where it was until cleanup
deletes it with its record.

The suites are under `apps/jobs/src/`. Run one with:

```bash
pnpm exec vitest run apps/jobs/src/storageSizing.integration.test.ts --project=node --disable-console-intercept
```

Each prints its figures as one JSON line per leg, prefixed `[jobs sizing]`,
`[jobs overlap]` or `[jobs fairness]`.

### Sizing a deployment

**Storage.** The retained-job caps bound how many jobs the store holds, so
they bound its size. Multiplying the measured per-job figures by the default
caps gives these projections. They are arithmetic on the observations above,
not measurements of a full store:

| Retained jobs | Small jobs (about 1.9 KiB each) | Jobs at both bounds (about 140 KiB each) |
| --- | --- | --- |
| 1,000 (one app and environment at its cap) | about 2 MiB | about 137 MiB |
| 10,000 (the server at its cap) | about 19 MiB | about 1.3 GiB |

The per-job figures include indexes. Add room for dead row versions between
autovacuum runs, for index files, which do not shrink after cleanup, and for
WAL and backups, which these figures exclude. Lowering `retainedPerServer` is the way to bound the store
more tightly. If cleanup stops, the store grows to the cap and then refuses
new work instead of growing further.

**Connections.** The jobs service's pools are bounded in code: 19 connections
across its stores and 10 for the pg-boss runner, so 29 per process at most,
and 58 while two revisions overlap. The run above used 15 and 24. Size the
Postgres server's `max_connections` against the configured ceilings of every
service, not against an observed peak. The jobs migrate job holds its own
connections only while it runs.

**Execution.** One replica runs at most 8 jobs at a time, and two at most 16
during a rollout. Raising `runningPerWorker` raises that concurrency but not
the pool ceilings above. No run has measured the plane above the defaults, so
measure connections and latency again after raising it.

## Known limitations

- **Vault-wide reads.** The edge, portal, egress and dev-gateway identities
  hold Key Vault Secrets User on all of kv-platform, so they can read the jobs
  roots and DSNs stored there. The template delivers each service only its
  own jobs settings; the vault grant does not enforce that split. This is
  tracked in
  [TODO.md](https://github.com/AZX-PBC-OSS/helix/blob/main/TODO.md).
- **The jobs image is published by hand.** CI builds the edge, portal, egress
  and certbot images only.
- **A closing rollout can briefly reopen intake** on an old-revision replica
  that restarts. See [Close intake](#close-intake-without-retiring).
- **The jobs service shares the apps environment's network.** It inherits the
  apps subnet's outbound allowances. Application fetches still go only
  through the edge and egress.
