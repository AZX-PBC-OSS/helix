# @azx-pbc/jobs

The `helix-jobs` runner package (ADR-0045, background-jobs-plane design §1):
Node 24, TypeScript, and the exact-pinned pg-boss 12.37.0 baseline. This
package currently owns the storage seam — the installed-handler policy, the
private migration/configuration command, and the startup compatibility check.
Service boot, the HTTP API and worker registration land in their own tickets
and compose from here.

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
(failing on drift fixed at queue creation), grants the runtime role DML on
the runner's tables — provisioning sets no default privileges, so grants
arrive by migration — and verifies the effective state by re-reading it.
Later jobs-owned migrations (wrapper tables, their grants) extend this
command the same way: a step under the migration identity, after the schema
they depend on exists.

## Startup compatibility check (`src/compat.ts`)

`checkJobsStorageCompatibility(pool)` answers, read-only, whether the
runtime may rely on its store: schema installed at the pinned dependency's
version, the queue carrying the platform's effective policy, and the runtime
identity holding its DML. The verdict union (`compatible`, `unreachable`,
`schema_missing`, `schema_version`, `queue_missing`, `queue_policy`,
`runtime_privileges`) is what service boot and health reporting consume; the
expected schema version is read from the installed pg-boss package, so a
catalog bump moves the expectation with the dependency.

## Development

```
pnpm --filter @azx-pbc/jobs typecheck
pnpm vitest run apps/jobs --project=node
```

The integration suite runs against the real test cluster through the real
role split; it provisions its own scratch database from
`.devcontainer/db-init/01-roles.sql` and drops it afterwards.
