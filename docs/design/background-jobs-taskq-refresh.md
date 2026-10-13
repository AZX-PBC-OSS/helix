# TaskQ integration evidence — 2026-10-06

**Historical candidate evidence:** the 2026-10-13 ADR-0045 amendment selects
TypeScript/pg-boss initially, with named services permitting a later Python
implementation. Requirements below describe the earlier TaskQ candidate and do
not require Python tooling or TaskQ integration now. The current
[jobs-plane design](background-jobs-plane.md) and
[executed PoC comparison](../reviews/jobs-runner-poc-2026-10-08.md) supersede
implementation conclusions where they differ. No new source audit is claimed.

This is a source review for the then-current [jobs-plane design](background-jobs-plane.md),
which now records the replacement dependency and integration contract. It replaces the
September initiative's dependency claims where they differ. It is not a full
security review of TaskQ or a report of executed integration tests.

## Current integration note — 2026-10-07

The table below preserves the October 6 source review. Its acceptance-receipt,
admission-retention and public cursor consequences are superseded by the current
design. The borrowed-connection seam now supports jobs-local capacity/dedup and
wrapper/job atomicity, not accounting receipts. Check retained keys before
new-work queue/storage caps; native hot-row key lifetime can supply identity until primary-record pruning,
without an independent expiry clock. Verify wrapper deletion with that pruning;
transient archives have zero retention, no retry identity or public access, and
still count toward storage capacity until purged. No cursor crosses the public
polling contract. Verify these revised adapter guarantees in implementation;
this note does not claim new upstream source inspection or executed tests.

## Revision and release

The reviewed tree is
[`6d3acf52a3b00b9c7794504418239acec9946852`](https://github.com/AZX-PBC-OSS/TaskQ/tree/6d3acf52a3b00b9c7794504418239acec9946852),
the `origin/main` returned by a fresh fetch on 2026-10-06. Its last commit updates
the exception/retry API documentation. The prior pin was
`ef2e57be26e21c9856640fe69de48c7e8b4120c6`.

Both the [PyPI metadata](https://pypi.org/pypi/taskq-py/json) and
[GitHub latest release](https://github.com/AZX-PBC-OSS/TaskQ/releases/latest)
still identify `0.2.2`; GitHub records publication on 2026-07-22. The source
project also reports `0.2.2`, so that version string cannot identify the reviewed
code. Use the exact source requirement in the design, then lock transitives
when the Python package is implemented. Do not automatically track moving main.

## Findings that change the integration

Paths below are relative to the immutable tree linked above. They were read
directly; references to tests describe upstream coverage, not tests run here.

| Area | Evidence | Consequence for Helix |
| --- | --- | --- |
| Cancellation and recovery | `src/taskq/backend/_sweeps.py`, cancellation-first branch of `_SWEEP_1_SQL`; fix `af7dd218` | A cancelled running job no longer re-pends merely because retries remain. Still test the assembled Helix lifecycle/cancel races. |
| Forced cancellation | `src/taskq/worker/cancel.py`, phase 2 and post-transaction abandonment | Active cancellation uses grace/cleanup and `task.cancel()`, then abandonment. The reclaim sweep's extra grace is a different mechanism. Project abandonment with cancellation intent to public cancelled; do not map every abandonment identically. |
| Terminal write fencing | Migration `01.00.18_02_pre_claim_epoch.sql`, `src/taskq/backend/_terminal.py`; fix `59a47582` | Preserve runner claim fencing. Never implement platform terminal updates by an unconditional write to TaskQ's job row. |
| Transactional enqueue | `src/taskq/backend/postgres.py`, `enqueue_with_conn`; `backend/_enqueue.py` | The jobs-local adapter can put its acceptance receipt and runner enqueue in one borrowed-connection transaction. The high-level `JobsClient.enqueue` does not take that connection; using it blindly would split the transaction. |
| Queue-full replay | `src/taskq/client/_jobs.py`, `JobsClient.enqueue` documentation | Native `max_pending` checks precede native idempotency insertion. Recover platform receipts before attempting a new enqueue, so a full queue cannot block recovery of an accepted job. |
| Idempotency horizon | Same method's idempotency contract | There is no time-based idempotency TTL. Native keys dedupe until their hot job row is pruned; wrapper/admission retention must enforce Helix's contract. |
| Hard per-app concurrency | `docs/guides/rate-limiting.md`, `KeyedReservationRef` and lazy registration | Use a typed ref over the trusted app/env envelope plus a shared global reservation. Keyed saturation is enforced after claim and may cause claim/deny/snooze churn. It is not a queue-per-app requirement. |
| Reservation changes | Same guide, `sync_slots` and queue-cap sections | Stored slot state is not magically replaced by an actor decorator edit. Drain and synchronize a deliberate count change; verify overlap behavior. |
| Actor configuration | `src/taskq/client/_jobs.py`, effective `max_pending`; `src/taskq/worker/startup.py` | Stored values remain relevant. The current client caches operator-owned `max_pending` with bounded staleness; old statements that every change requires worker restart are too broad. |
| Retention | `src/taskq/settings.py`, `prune_retention_*` and `archive_retention_period` | The global retention field is explicitly inert. Succeeded/cancelled default to 30 days, failed/abandoned/crashed to 90 days; prune moves records to an archive with a 365-day default. Explicitly configure every status and archive expiry. |
| Result expiry | `src/taskq/constants.py`, `MAX_RESULT_BYTES`; `backend/_sweeps.py`, result-expiry sweep | The 64 KiB cap remains. Keep explicit wrapper result-expiry metadata rather than interpreting nullable runner result fields as a public expired state. |
| Health | `src/taskq/worker/health.py`, `compute_health`, `HealthReport`, `default_worker_health_socket_path` | Reuse the engine, project it into always-200 health, and supervise initialization/worker lifetime. The default Unix socket is now per PID; the old claim that every worker defaults to one shared socket is obsolete. Explicit paths must still be isolated in tests. |
| Progress | `src/taskq/progress/`, migration `01.00.20_03_pre_progress_seq_bigint.sql` | Snapshot/coalescing remains the integration shape. Do not promise event-log replay. Treat the native cursor as a bigint/string across JSON boundaries, not an indefinitely safe JavaScript number. |
| Packaging | `pyproject.toml`, `.python-version` | Upstream uses Python 3.13 and now requires `tors>=0.15.0` in core, alongside other native wheels. Verify target-platform wheels/builds in CI; “pure Python dependency” is not a valid assumption. |
| Admin UI | `pyproject.toml`, `src/taskq/web/` | The optional dependency boundary remains. Source files still ship in the wheel; prove missing imports/mount refusal in the final production image rather than asserting the files are absent. |

The diff is large and includes worker, storage, settings, migrations, telemetry,
admin, and testing changes. No claim is made that all changed code was audited.
Before shipping, run the design's real-Postgres acceptance matrix and check the
resolved transitive dependencies and production image, including native wheels.
Revalidate copied Python API signatures when writing the adapter; do not copy
line-number references from the old exploration as current interfaces.

## Verification boundary

This refresh fetched Git history and read source, settings and primary package
metadata. It did not install TaskQ, build its image, execute its tests or start
a worker. Helix's repository gate validates this documentation change only;
it cannot establish behavior of a jobs service that has not been implemented.
