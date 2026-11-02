# Background jobs release acceptance

**Date:** 2026-10-21. **Scope:** the background jobs plane
([ADR-0045](../adr/0045-app-triggered-durable-jobs-plane.md),
[design](../design/background-jobs-plane.md)) as assembled on the
`feat/helix-jobs-v1` branch, judged against the 71 acceptance criteria of the
jobs specification. **Excluded:** any live Azure deployment.

This is a dated snapshot. The current behavior is in
[the feature doc](../features/background-jobs.md).

## Verdict

Accepted for merge, with the residuals below. Every criterion has executed
evidence, and none has a material gap. Four criteria are proven only
statically: two absence properties, the Azure definitions and alerts, and the
documentation. Four are partially proven, because one sub-case of each runs
only below the real-stack level. Production rollout is a separate operator
action and has not happened.

## How the evidence was gathered

- **The full gate.** `./check-and-lint.sh` passed clean: typecheck, lint, refs,
  format, docs and tests, with 343 test files, 5058 tests passed and 1 skipped.
  The skip is the live-LLM provider test, which needs a vendor key. Every
  jobs test file on the branch ran in that pass.
- **Both Bicep builds.** `az bicep build` of `infra/azure/main.bicep` and
  `az bicep build-params` of `infra/azure/main.bicepparam` both exited 0.
- **The real-stack suites.** These run the dev IdP, portal, egress, jobs
  service, edge and dev gateway as separate processes on fresh databases under
  the real roles (`apps/jobs/src/test/realStack.ts`). The suites are
  `journey`, `retryIdentity`, `lifecycleCancellation`, `namedServers`,
  `trustBoundary`, `runtimeRecovery`, `capacity`, `workerOverlap`, `retention`,
  `outboundFetch` and `deployedComposition`, each
  `apps/jobs/src/<name>.integration.test.ts`.
- **A hand-driven journey.** It ran on the ordinary local stack, booted with
  `node .claude/skills/run-helix/smoke.mjs --keep`, in headless Chromium. The
  details are below.

## Results by area

| Area | Criteria | Real-stack evidence | Status |
| --- | --- | --- | --- |
| Access and capability management | 1–8 | `journey`, `trustBoundary`, `retryIdentity`, `namedServers`, `runtimeRecovery` | proven, except the capability editor (7): component tests plus a manual save in a real browser. No automated accessibility audit exists |
| Submission and retry identity | 9–15 | `retryIdentity` (concurrent keys, lost replies, edge and jobs crashes, validation skew), `retention` (key reuse after cleanup), `trustBoundary` (one byte over the input bound) | proven |
| Capacity and uncertain submissions | 16–21 | `capacity`, `workerOverlap`, `namedServers` (throttle spans servers), `outboundFetch` | proven |
| Execution and the fetch job | 22–32 | `lifecycleCancellation`, `workerOverlap`, `outboundFetch`, the diagnostic suites | proven, except worker death (28): process death is real-stack, but a pg-boss worker dying inside a live process is tested only in `execution.integration` and `runner.integration`. The fixture contract not shipping (27) is proven statically |
| Status, results, retention | 33–38 | `retention`, `outboundFetch`, `retryIdentity` | proven |
| Progress and observation | 39–45 | `lifecycleCancellation`, `journey`, `runtimeRecovery`, `trustBoundary` | proven. The absence of an events endpoint (44) is proven statically |
| Cancellation and lifecycle | 46–52 | `lifecycleCancellation`, `namedServers`, `runtimeRecovery` (portal delivery overdue after 60 s) | proven, except the jobs-side cancellation backlog passing 60 s (52), which is covered only by `lifecycleRecovery.integration` and `health.test` |
| Operation and delivery | 53–62 | `runtimeRecovery`, `capacity`, `trustBoundary`, `deployedComposition` (upgrade with accepted work, both migration orders) | proven, except that a worker stopped inside a live process (55) is graded only in unit tests. The Azure definitions and alerts (60) are proven by compile and wiring tests only, and the guidance (61) by docs tests |
| Named servers | 63–66 | `namedServers` with two contract fixtures | proven |
| Contract and runtime boundary | 67–71 | `trustBoundary`, `deployedComposition` (role isolation on clean and upgraded stores), `runtimeRecovery` | proven |

One gap was closed during this review. Design §9 lists "the sender crashes"
and "updates arrive out of order" among the real-service cases, but both had
only integration-level evidence. `lifecycleCancellation`'s delayed-delivery
case now does both through the real stack. It SIGKILLs the portal while two
lifecycle intents are pending and checks that the restarted portal still
holds and delivers them. It then presents a late archive older than the
applied unarchive, freshly signed with the portal key. The jobs service
acknowledges its current watermark and closes nothing, and a job running
under the open generation succeeds. The new check fails when the late
delivery carries a newer generation instead.

## The hand-driven journey

1. Two fixture users signed in to the portal SPA through the dev IdP. The owner
   created and deployed an internal app with the CLI. In the SPA's
   Capabilities tab, the owner ticked the fetch job type and saved; the grant
   applied at once. The owner's fetch origin request went to approval. The
   owner could not approve it (403), and a second admin did.
2. In the served app, the owner submitted two fetch jobs and got `202
   queued`. A keyed replay returned the same job id. The browser process was
   then killed. The origin received both GETs after the browser was gone, with
   no credential or cookie headers.
3. The owner returned in a fresh browser profile and signed in again. The app,
   opened with the job reference in its URL, read `succeeded` with progress
   1/1. The result was the origin's exact JSON, including a `null` member.
   Cancelling a finished job answered 409 with its status.
4. A job held in flight was cancelled after another leave-and-return. Both the
   cancel and its repeat answered `202 cancellationRequested`. The job read
   `cancelled` 12.4 s after the acknowledgement, and egress logged that the
   outbound call was aborted.
5. A different user of the same app got the same 404 for the owner's job as
   for an unknown id, on both read and cancel.
6. Every jobs reply carried `Cache-Control: no-store`. No service logged an
   error. The only log mention of the target was egress's origin field, with
   no path, retry key or body. The jobs service's seven health checks read
   `ok` afterwards.

The journey found one wording defect. A repeated cancel logged "the competing
outcome won its race" when the first request had already cancelled the runner
row. The log message and `docs/design/logging.md` now cover both causes.

## Residuals

These were accepted, and each is documented where an operator will find it:

- **Vault-wide reads.** Every platform identity can read all of kv-platform,
  including the jobs roots and DSNs. Tracked in `TODO.md`; described in the
  operator page's known limitations.
- **Closing rollouts.** During a closing rollout, an old-revision replica that
  restarts can briefly reopen intake. The service also cannot detect a server
  id repointed to an empty store. Both are documented in the operator page,
  with the rule never to repoint a server that still has references.
- **The dev-gateway throttle.** It counts in each replica's memory, up to three
  replicas, and dev traffic does not reach the deployment-wide window. This
  was a product decision. The deferred `SECURITY DEFINER` option is in
  `TODO.md`.
- **Edge reachability.** The edge's `jobs_reachability` check is not relayed.
  A degraded reading across several servers would not alert; only `error`
  trips the edge availability test (`infra/azure/README.md`).
- **Fault-injection-only sub-cases.** The jobs-side 60 s cancellation-backlog
  degradation, a pg-boss worker dying inside a live process, and stopped-worker
  health grading run only in integration and unit tests.
- **DNS rebinding.** It is covered only by egress's unit test with a mocked
  resolver.
- **The jobs image.** It has never been built or checked here, because there is
  no docker in the dev container. The CI images job builds it, checks it with
  `apps/jobs/scripts/image-smoke.sh`, and then pushes a cache rebuild rather
  than the checked artifact. Neither that job nor the new CI test-shard steps
  has run on GitHub Actions yet.
- **CI shard balance.** The test shards are unbalanced, at about 1415 s
  against 512 s. This costs wall time only.
- **Early returns without roles.** Some older edge and portal suites return
  early when their database roles are missing. CI provisions the roles before
  the suite, and `apps/jobs/src/ciGate.test.ts` pins that step.
- **Local database drift.** A long-lived local `helix` database may still grant
  CONNECT to PUBLIC if it predates the current roles script.
  `.devcontainer/db-init/01-roles.sql` revokes it, and fresh databases are
  correct.

## What a live rollout still has to show

- That the jobs image builds, passes its check, and is the image pushed.
- The first green CI run with the jobs steps.
- `deployJobs=true` applied to an existing install with the documented order:
  roles, both migrate jobs, then images.
- The health relay running and each jobs alert firing on a forced
  degradation.
- A pilot app's grant, submit, poll, result and cancel against the deployed
  edge, with Entra sign-in.
