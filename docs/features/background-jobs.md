# Background jobs

> **Related ADRs:** [ADR-0045](../adr/0045-app-triggered-durable-jobs-plane.md) (app-triggered durable jobs) · [ADR-0005](../adr/0005-ssrf-egress-controls.md) (SSRF + secret injection) · [ADR-0037](../adr/0037-platform-observability-otlp-boundary.md) (observability).

A hosted app can start a platform-authored job, poll its status, read its
result and cancel it. Accepted work survives restarts and runs after the user
closes the tab. The one installed production type is `jobs:fetch`: a single
governed GET whose JSON response becomes the job's result. Apps cannot upload
or name their own code.

The design is [the background jobs plane](../design/background-jobs-plane.md).
The app-author guide is [Background jobs](../../apps/docs/src/apps/jobs.md), and
the operator procedures are [Operating background jobs](../../apps/docs/src/deploy/jobs.md).
This page describes what the code does and where it lives.

| Route | Who | What |
| --- | --- | --- |
| `POST /_api/jobs/:server/types/:type` | app host (edge) | submit; `202 {server, jobId, status}` |
| `GET /_api/jobs/:server/:jobId` | app host (edge) | the latest snapshot |
| `GET /_api/jobs/:server/:jobId/result` | app host (edge) | the successful JSON result |
| `DELETE /_api/jobs/:server/:jobId` | app host (edge) | request cancellation |
| `/:slug/_api/jobs/...` | dev gateway | the same four operations in the `dev` tier |
| `/internal/jobs/v1/jobs[/:jobId[/result]]` | `helix-jobs` (internal) | the signed edge→jobs operations |
| `POST /internal/jobs/v1/lifecycle/:appId` | `helix-jobs` (internal) | the signed portal→jobs lifecycle delivery |
| `POST /internal/jobs/v1/fetch` | platform host (edge, dev gateway) | the signed jobs→edge fetch callback |

## How it works

**The edge authorizes; the jobs service owns the record.** The edge runs the
existing serving, session and origin gates, then the jobs authorization check:
only an authenticated user or a dev-token principal, with a current grant for
the qualified type. It counts the attempt against two fixed submission windows
(per app and environment, and deployment-wide), mints a signed edge→jobs
instruction over the exact request bytes, and forwards it to the server named
in the path (`apps/edge/src/gateway/jobs.ts`, `apps/edge/src/jobs/forwarder.ts`).
Attribution comes from the trusted caller and the registry projection, never
from the request.

**Acceptance is one transaction.** `apps/jobs` verifies the instruction and
burns its nonce (`instructionAuth.ts`, `burns.ts`). Then, under one admission
lock, it looks up a retained retry key, checks intake and the unfinished and
retained capacity, and commits the job record, the retry mapping and the
pg-boss enqueue together (`acceptance.ts`, `intake.ts`). A retry key is scoped
to server, app, environment, principal kind, owner and qualified type.
Identical bytes recover the original job, and different bytes answer `409`.

**Execution is fenced.** pg-boss workers run at most two jobs per app and
environment and eight per process (`runner.ts`, `execution.ts`). A start gate
refuses work whose app lifecycle generation is closed or whose cancellation is
recorded. The recovery sweeper reconciles lost workers and enforces the
absolute deadline: 60 minutes, or five for `jobs:fetch` (`recovery.ts`). The
first recorded terminal outcome wins (`cancellation.ts`).

**The fetch job does not make the call itself.** `fetchJob.ts` mints a
jobs→edge instruction bound to the job's identity and the `{url}` digest. The
edge receiver (`apps/edge/src/gateway/jobsCallback.ts`) checks the signed
lifecycle generation against the registry, then runs the same fetch-policy core
the browser path uses with unattended authority. That core applies the
allowlist, budget, secret injection through egress and SSRF controls. Origins
that use delegated user credentials are refused with no keyless fallback.

**Lifecycle changes reach every server.** Archive and unarchive bump the app's
generation and write one outbox intent per configured server in the same
transaction (`apps/portal/src/jobs/lifecycle.ts`). The portal's delivery loop
sends each intent independently (`apps/portal/src/jobs/delivery.ts`). The jobs
service applies it before it acknowledges, and stamps cancellation intent on
the closed generation's active work. New apps cannot submit until their state
has been delivered; until then a submission answers a retryable `503`.

**Retention.** Results are readable for seven days from success, and records
for 30 days from any terminal outcome. The cleanup loop removes expired content
within 48 hours and retires the record, its runner row and its retry key
together (`cleanup.ts`, `observation.ts`).

**Health.** `helix-jobs` reports `jobs_database`, `jobs_worker`,
`jobs_sweeper`, `jobs_cleanup`, `jobs_capacity`, `jobs_intake` and
`jobs_lifecycle_recovery` in its always-200 body. The portal adds
`jobs_lifecycle_delivery`, and the edge and dev gateway add
`jobs_reachability`. The spans, instruments and events are listed in
[observability.md](observability.md).

## Configuration

The deployment map (`EDGE_JOBS_CONFIG`, `PORTAL_JOBS_CONFIG`,
`PORTAL_JOBS_CATALOGUE` and the jobs service's own env) is validated by
`@azx-pbc/shared/jobsDeployment`. Each consumer receives only its own
credentials. Locally, `scripts/stack-env.mjs` mints the whole plane for a
stack, and `apps/jobs/README.md` covers running it. In Azure, `deployJobs` (off by default)
gates the plane and `infra/azure/README.md` describes the topology. With jobs
fully disabled, the catalogue advertises nothing, the routes refuse, and
ordinary hosting does not depend on jobs configuration.

`jobs:diagnostic` is a test-only type for controllable progress, failure and
retry. It is registered only when `JOBS_DIAGNOSTICS=true` (locally,
`HELIX_JOBS_DIAGNOSTICS=1` on a resolved stack). The production boot refuses
that setting, so production never registers or accepts it.

## Tests

The real-stack suites in `apps/jobs/src/*.integration.test.ts` boot the dev
IdP, portal, egress, jobs service, edge and dev gateway on fresh databases
through `apps/jobs/src/test/realStack.ts`. The reference journey is
`journey.integration.test.ts`. The failure matrix is split across
`retryIdentity`, `lifecycleCancellation`, `namedServers`, `trustBoundary`,
`runtimeRecovery`, `capacity`, `workerOverlap`, `retention`, `outboundFetch`
and `deployedComposition`. Component and unit suites sit beside each module.

## Known gaps

- Every platform identity can read all of kv-platform, including the jobs
  signing roots and DSNs. Tracked in `TODO.md`.
- During a closing rollout, an old-revision replica that restarts can briefly
  reopen intake. The service cannot detect a server id repointed to an empty
  store.
- The dev gateway throttles dev submissions in each replica's memory, and they
  do not count toward the deployment-wide window. Tracked in `TODO.md`.
- The edge's `jobs_reachability` check is not relayed to an alert. The edge
  availability test fires only when it reports `error`.
- The jobs image check (`apps/jobs/scripts/image-smoke.sh`) runs in CI's
  images job. It has not yet run against a built image on GitHub Actions.
- No Python or second production runner ships. Named-server routing is proven
  with two contract fixtures.
