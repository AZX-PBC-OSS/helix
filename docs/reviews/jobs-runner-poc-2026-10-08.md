# Jobs runner proof-of-concept comparison — 2026-10-08

Both pg-boss and TaskQ passed the same real-Postgres, real-process acceptance
suite behind a loopback HTTP API. For the simplified fairness requirements,
pg-boss remains the lower integration-cost choice. TaskQ's strict reservations
are a demonstrated advantage if concurrency across replicas must stay exact.
Neither experiment changes the accepted production jobs design.

## Reproduce and inspect

Both branches start independently at main `24e4b32`:

- `poc/jobs-pgboss`: pg-boss 12.37.0, commit `b6f6777`.
- `poc/jobs-taskq`: TaskQ source `6d3acf52a3b00b9c7794504418239acec9946852`.

Each branch has `apps/jobs-poc/README.md`, source, the same
`src/acceptance.test.ts`, and `results.json`. Runtime selection lives in
`src/engine.ts`. The suite uses only the common HTTP interface except for
runner-specific row counts in the transaction-rollback assertion. It creates
and removes dedicated databases and does not migrate the development database.
The TaskQ branch adds mypy/ruff/pytest to the repository gate. Its gate also
exposed a pre-existing cross-file fixture conflict: the egress adversarial suite
inserts a deliberately malformed provider (`apiOrigins: []`) while the portal's
callback-hint test lists all providers. That callback-only test now supplies an
empty provider list; its HTTP status and derived callback assertions remain.
No production behavior changed. Serial trial runs also exposed unrelated audit
row-order and fixture authorization failures, so the final gate retains normal
file parallelism and uses a fresh platform test database. The common PoC suite
still starts two independent workers for overlap tests. Read the README
before running: both implementations are intentionally local experiments.

## Observed outcomes

These are individual successful local runs on PostgreSQL 18.4/Linux ARM64,
not latency distributions or comparative load benchmarks. Timers were shortened
to make failure tests practical. Each candidate used a ten-second crash lease
or heartbeat timeout. Startup includes an empty-database migration and API
readiness, not completed worker warmup. RSS is measured on the API-only process
after the admission scenario, so it excludes the execution worker footprint.

| Scenario | pg-boss | TaskQ |
| --- | --- | --- |
| Twelve simultaneous requests with the same key | One job | One job |
| Key replay with retained-row capacity full | Original job returned | Original job returned |
| Same key, different body | 409 | 409 |
| Different owner reads the job | 404 | 404 |
| Metadata insert fails after runner enqueue | Runner insertion rolls back | Runner insertion rolls back |
| Acceptance response discarded, process restarted | Same job recovered | Same job recovered |
| JSON null result / oversized result | Null retained / oversized rejected | Null retained / oversized rejected |
| SIGKILL after outbound server receives request | One outbound call; terminal failure | One outbound call; terminal failure |
| Recovery measurement | 11.312 s | 11.280 s |
| Cancellation measurement | 0.992 s | 0.564 s |
| Two workers, configured total concurrency two | Four simultaneous requests | Two simultaneous requests |
| Two workers, configured per-app concurrency one | Two simultaneous requests | One simultaneous request |
| Queued deadline | No outbound call | No outbound call |
| Result expires before record | Result hidden and cleared | Result hidden and cleared |
| Record pruning | Key removed; reuse creates new job | Key removed; reuse creates new job |
| API-only startup / resident memory sample | 253 ms / 129 MiB | 255 ms / 68 MiB |

The recovery measurement includes restart and a one-second observation period
without another outbound call. Cancellation includes an additional 500 ms check
that completion did not overwrite the cancelled state. Small timing differences
are not a reason to choose either implementation.

## Integration findings

pg-boss's public borrowed-transaction enqueue API worked directly with the
Helix metadata insert and capacity lock. retryLimit=0 prevented crash retry in
the executed fault scenario. Cancellation required passing the native AbortSignal
to fetch. Its local concurrency controls were straightforward and their doubled
capacity during two-process overlap was observed. A strict distributed cap would
need a different strategy; the PoC deliberately accepts bounded deployment overlap.
The library enforces a minimum ten-second heartbeat timeout.

The pg-boss adapter still needs runner-schema knowledge for status projection
and early result deletion, because result and record retention share the native
row. A small cleanup loop handles queued deadlines and coordinated record/key
removal. This is not a zero-wrapper integration.

TaskQ's global and typed per-app reservations held the exact limits with two
real processes. Its native result expiry and prune/archive machinery passed once
adapted correctly. Atomic admission uses the lower-level PostgresBackend API.
A metadata foreign key gives atomic key deletion with the primary runner row.
The result model needs wrapping to represent arbitrary JSON through the typed
actor interface; the test covers null but not exact near-cap payload parity.

TaskQ introduces Python packaging, another lockfile and native wheel resolution,
Pydantic contract definitions, mypy/ruff/pytest and a telemetry SDK/bootstrap with
mirrored constants. Short recovery settings also required coordinated changes
to cancellation and watchdog settings, whose cross-field validation rejected
inconsistent configurations before startup.

One integration failure was caught only by execution: wrapping archive expiry
inside the admission transaction caused InFailedSQLTransactionError on plain
Postgres. The internal archive-expiry function probes an optional Timescale
catalog and catches its missing-table error, leaving an enclosing transaction
aborted. Running archive expiry in autocommit after the atomic primary-row/key
prune fixed the failure. The PoC pins and documents that internal seam.

## Limits and recommendation

Neither PoC is the production jobs service. Both omit signed edge instructions,
nonce storage, real edge/egress policy, lifecycle generations, portal controls,
deployment wiring and least-privilege database provisioning. The admission cap
covers retained primary rows; the complete unfinished/per-app/archive storage
policy remains to be implemented. There is no scale benchmark, exhaustive race
exploration, database-partition test, graceful-shutdown proof, complete retry-key
behavior between logical expiry and delayed physical pruning, or guarantee of
exactly-once external effects. Telemetry assertions use recording providers;
OTLP delivery to a live collector was not exercised.

Choose pg-boss if two-per-app/eight-total are fairness defaults and temporary
rolling-deployment overlap is acceptable. Choose TaskQ if exact fleet-wide slots
are worth the separate language and integration machinery. Both have now
survived the initial fault matrix; the choice is about those concrete costs
and semantics, not a speculative claim that one cannot perform the core job.
