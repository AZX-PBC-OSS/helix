# Background jobs plane

**Status:** Implemented in `apps/jobs` (see [the feature doc](../features/background-jobs.md));
enabling it on a production install is a separate operator rollout. Implements
[ADR-0045](../adr/0045-app-triggered-durable-jobs-plane.md).
**Updated:** 2026-10-13.

The initial service is TypeScript/pg-boss behind a private HTTP API, with its
own database. Job types and references include a stable deployment-configured
server name. This allows a later Python/TaskQ service without changing the
app-facing contract or sharing runner databases. Only one server, `jobs`, ships
in this initiative. A second runtime requires a concrete workload and its own
integration evidence; this plan does not implement it speculatively.

Polling, soft fairness controls, job-local retry identity, trusted job code,
existing outbound policy and archive cancellation remain. Synthetic actors are
development/test fixtures; shared portal-editor improvements remain separate.
This document and ADR-0045's latest amendment supersede conflicting September
and October planning. Dated audits and research preserve their original evidence.

## 1. Delivery and dependency

Deliver `helix-jobs` using Node 24, TypeScript, Fastify and pg-boss. Reuse the
workspace's Zod contracts, pnpm catalog/lockfile, Vitest, logging and telemetry
packages. Keep pure `buildApp()` separate from worker/listener boot. Initially
register only `jobs:fetch`: one GET through edge policy and egress. No app code,
LLM pipeline, schedules, batches, sub-jobs, app-data writes, delegated credentials
or production administration UI are exposed. Test fixtures have no production
grant or stable public payload contract.

Start from the tested pg-boss **12.37.0** dependency in `poc/jobs-pgboss`
(`b6f6777`), locking it through the pnpm catalog. This is the tested baseline,
not a claim that it is the latest release. Upgrades require a source diff and
adapter acceptance tests. The [PoC comparison](../reviews/jobs-runner-poc-2026-10-08.md)
records both implementations, observed overlap and remaining production gaps.
The [TaskQ source review](background-jobs-taskq-refresh.md) is historical
candidate evidence, not a dependency requirement for this delivery.

The PoCs demonstrated atomic enqueue/metadata rollback, retained-key recovery,
crash behavior, cancellation and cleanup. Neither implemented the production
signed hops, lifecycle, complete capacity policy or deployment isolation. Reuse
findings and useful code after review; do not treat either branch as a ready
production service. Python packaging, mirrored schemas, native wheels, TaskQ
reservations/watchdog/prune internals and a Python telemetry exception are no
longer initial-delivery work. There is no required runner administration UI,
including in development; local inspection uses the API, logs and tests.

Extend the existing portal capability editor and request reporting for qualified
types. No production job list, individual-job controls, shared editor redesign,
uncertain-save reconciliation or approval-note recovery is added.

### Named services and the common contract

A server is a stable logical namespace, not a library name. The initial server
is `jobs`; a future Python workload might use `python:generate-report`. Prefer
these names to implementation names such as `pgboss` or `taskq`. Define a server
id as 1–63 lowercase ASCII letters/digits/hyphens, starting with a letter and
ending with a letter/digit. A local type uses the same syntax. A qualified type
is exactly `<server>:<localType>`. Grants match the complete string; no wildcard,
unqualified alias or default-server fallback exists. This is a new, unshipped
contract, so there are no legacy bare `fetch` grants to migrate.

Every job reference is `{server, jobId}`. `jobId` is opaque and local to that
server (1–128 ASCII letters/digits/underscore/hyphen); a UUID is one valid form,
not a cross-runner requirement. Persist and pass both fields, including in
snapshots, cancellation acknowledgements, callbacks and examples. The qualified
`type` must agree with `server`. Do not search other servers for a missing id.

| Public operation | Route | Success |
| --- | --- | --- |
| Submit local type on named server | `POST /_api/jobs/:server/types/:type` | 202 `{server, jobId, status}` |
| Poll | `GET /_api/jobs/:server/:jobId` | 200 complete snapshot including `server` and qualified `type` |
| Result | `GET /_api/jobs/:server/:jobId/result` | 200 raw JSON result |
| Cancel | `DELETE /_api/jobs/:server/:jobId` | 202 `{server, jobId, cancellationRequested: true}` while active |

The `:type` submission segment is local, so `POST /_api/jobs/jobs/types/fetch`
requires `jobs:fetch`. The dev gateway uses the same routes and its trusted `dev`
environment. Poll/result/cancel use the original reference, never a current type
to reselect a server. Unknown server on submit returns 400 `job_server_unknown`;
unknown server on reference operations returns the same 404 `job_not_found` as
an unknown job. A configured but unavailable server returns 503
`jobs_unavailable`. Routing never retries an operation against a different store.

Deployment configuration supplies a static map from server id to an internal
HTTPS endpoint, installed type catalogue, serving/intake state and credentials.
Local development may use the established local transport. Apps can select an
advertised type or reference, never an endpoint, database, credential or
implementation. No runtime discovery, plugin framework, automatic failover,
cross-server scheduling or shared job database is required. The catalogue is
configuration-derived, not inferred from health; an outage does not remove grants.

The shared contract covers durable acceptance, current owner/type authorization,
scoped retry identity, snapshots, results, cancellation intent, lifecycle and
bounded retention. Native states/errors stay in each server's adapter. Limits
and execution mechanics can differ by server within the published contract.
A future language implementation must pass the same wire/signing fixtures and
behavioral failure matrix; it need not use the same queue library.

## 2. Identity, access and outbound authority

Every job has immutable `(server, appId, env, ownerKind, ownerOid, type)`
attribution; `type` is qualified and its prefix equals `server`.
Only `user` and `dev` callers can enqueue or operate on jobs. `ownerOid` is the
canonical principal captured by the existing caller resolver (ADR-0048), never
a display name, email or independently parsed token `sub`. `env` comes from the
serving surface, never the app's payload. The production edge uses `prod`; the
dev gateway serves the same four operations with `dev` and its existing dev-token
authentication. Preview does not create a third environment.

Poll, result and cancel each require current app access, the current
job-type grant, and an exact match on app, environment, principal kind and owner
id. Possessing a job reference is insufficient. A wrong owner/app/environment returns
the same 404 as an unknown id. There is no implicit app-owner or admin override.
The jobs API repeats these comparisons against its record using signed claims.
The edge validates returned fields against the response schema and requested server
before forwarding a snapshot or acknowledgement; it never trusts a mismatched
reference to redirect subsequent calls.
Do not infer the principal kind from the id's shape.

The running job acts with app authority, independently of the owner's session.
Its outbound hop is jobs → edge → egress. On every outbound request the edge
resolves the current registry entry, refuses archived/missing apps, checks the
current fetch origin grant and budget, writes the fetch ledger row, and mints
the ordinary egress instruction. Both keyless and stored-secret origins are
allowed. An origin whose credential is `kind: "provider"` is refused with 403
and a bounded `delegated_unattended` reason, before any egress call. This check
also runs when a binding changes after enqueue. Never strip a provider binding
and retry the origin keyless. Jobs receive no vendor secret or user OAuth token.

The edge shares one fetch-policy/execution core between browser and signed jobs
adapters. Each supplies explicit authority; jobs never fabricates a session or
duplicates fetch policy. The callback also checks the signed generation against
the current registry generation before dispatch.

Revoking the jobs grant blocks new jobs and all subsequent user reads/cancels;
it does not cancel already accepted work. Revoking a fetch grant or changing its
credential to a provider blocks the next outbound call. Thus "existing work
finishes" is not a promise to bypass current outbound policy. Session revocation
blocks reads through the existing gate; it does not resurrect sessions or stop
app-authority execution. Group changes follow the existing refresh semantics,
not a new synchronous directory lookup on each job poll.

## 3. Signed HTTP hops and replay

For each configured server, use separately generated secrets for edge→jobs,
jobs→edge and portal→jobs lifecycle operations. Never share these roots between
servers. Signed claims bind `server`; audiences identify both server and
direction. Each receiver checks the configured server identity and rejects a
valid instruction intended for another server. The edge callback selects a
configured verification key, then verifies the claimed server; an unverified
claim can never supply a URL, key or authority. No jobs container receives `HELIX_INSTRUCTION_SECRET`,
`HELIX_INTERNAL_SECRET`, `HELIX_EXCHANGE_SECRET`, `EDGE_AUTH_SECRET`, or a root
from which those keys can be derived. Keep distinct HKDF labels, JWT `typ` and
audience for each new direction in addition to this custody separation. Describe
the matrix in Bicep, local configuration and the role/credential tests.

Instructions have a 30-second maximum lifetime, bounded clock tolerance,
mandatory `iat`/`exp`/`jti`, a fixed algorithm, and strict schemas. They bind an
allowlisted operation, method, exact resource, SHA-256 of the HTTP body bytes,
and the operation's app/env/owner/type/generation claims. Caller-provided
headers cannot override them. The portal lifecycle key authorizes lifecycle
updates only, never job results or outbound fetch. HTTPS protects every deployed
hop; a route being called "internal" is not a network restriction. The signed
contract, its reference mint/verify implementation, and the executable signing
vectors live in `@azx-pbc/shared/jobsSigning` and `@azx-pbc/shared/jobsSigningVectors`
(ADR-0045); any future non-TypeScript server is judged against those same vectors.

Each receiver atomically burns the nonce before side effects, with retention
covering the validity window and clock tolerance. Jobs keeps its burns in its
own database. The edge gets a new, separately granted jobs-instruction burn
table in `helix`; it gets no grant on the egress burn table. The existing dev
role needs its own environment-scoped grants. Identical tokens fail on replay;
a legitimate HTTP retry uses a fresh token and the same retry key and payload. All operations have bounded timeouts, body limits and failure codes.

The public edge's jobs callback route always requires signature verification,
even on a platform host or when dev auth bypass is enabled. Do not trust Host,
source IP or a caller-supplied trace as proof of service identity. The newer
consent code provides signing and deployment precedents, but its payload-free,
no-burn JWT contract is not sufficient for these operations.

## 4. Retry identity and capacity protection

### Retry keys belong to jobs

An optional `Idempotency-Key` labels one intended job. Scope it to
`(server, appId, env, ownerKind, ownerOid, type, key)`, cap it at 128 UTF-8 bytes and
reject empty/whitespace-only values. It is not a credential and never replaces
current authorization. Do not log it. Without a key, each POST is new work.
The author guide creates a random key before the first POST and retains that
key and the original serialized input for retries. Deliberate new work uses a
new key. Submission deduplication does not change a type's execution-retry policy.

Keep the original JSON body limit of 64 KiB and exact-byte comparison. The
signed instruction binds the raw body digest and optional key. Jobs owns the
key, digest and job mapping in its private database; edge keeps no mapping or
reservation. Current caller/type authorization and bounded readable input come
first. Jobs then looks up a retained key before new-work validation, intake
closure or queue/storage capacity checks. Identical bytes recover the original
job even after validation rules change. Different bytes return 409
`idempotency_conflict`; equivalent JSON serialized differently still conflicts.
Jobs also rechecks the signed `allowedTypes` before an identical replay
recovers: a record whose type they no longer cover answers 403 `forbidden`,
after the conflict and record-horizon verdicts, as the read paths order it.
Ordinary edge submission throttles apply to retries too.

A key stays attached while the live job record physically exists, including active
work, terminal records and delayed cleanup. Seven-day result expiry does not
release it. Public record access still ends 30 days after terminal state. A
matching replay of a physically retained but no longer publicly readable record
returns 404 `job_not_found` without creating a job; different bytes still
conflict. This preserves the read-retention boundary without another public
status or a separate key-expiry clock. Once physical cleanup removes the record
and its mapping, the key may create new work. There is no exact-time reuse
promise, and clients must not depend on expired keys for permanent deduplication.
Cleanup never deletes an active record merely because enqueue was long ago.
Here the live job record is the primary runner job and its wrapper identity.
Pruning that record releases the key. Any transient runner archive is not a
second key store or publicly readable record; do not enable archival retention.
Any transient archive bytes still count toward retained-storage capacity until purged. Do not
add an archive-to-edge or archive-to-key retirement acknowledgement protocol.

### One durable enqueue transaction

The jobs-local adapter resolves a key, validates new work, checks intake,
lifecycle generation and capacity, and creates the runner job plus any wrapper
metadata in one database transaction. Serialize competing new-job capacity
checks and inserts; a unique scoped-key constraint protects concurrent retries.
A local admission lock and bounded indexed counts are sufficient for the initial
scale; no external reservation protocol is needed. Check retained-key identity
before new-work queue-cap logic. Use pg-boss's public `db.executeSql` borrowed
transaction adapter for enqueue, with wrapper metadata in that transaction.
Do not substitute runner-native deduplication for the scoped public contract.

Use the borrowed-connection enqueue path where needed to keep wrapper metadata
and runner insertion atomic. The adapter owns pg-boss schema knowledge. Verify
its transaction, duplicate and cleanup interleavings with real Postgres. A
rollback creates neither a job nor a lasting key claim. A lost reply after
commit leaves one durable job; the same authorized keyed POST can recover it
when the request throttle allows. A timeout/503 means acceptance is unknown,
not a promise of nonacceptance. Edge restart requires no reconciliation.

The submit response is directly 202 `{server, jobId, status}`. There is no separate
admission identifier, receipt, close operation, settlement, acknowledgement,
refund, UTC accounting day, or automatic edge resubmission. Server plus job ID identify
accepted work; request IDs correlate attempts. The internal instruction's short
expiry remains a transport-authentication bound, not an accounting lease.

### Capacity defaults

These are overload/fairness controls, not financial entitlements. Start with
platform defaults shared by all apps. No per-app capacity editor or approval
workflow is part of this delivery. Operator deployment configuration may adjust
finite positive limits after sizing; app payloads and manifests cannot.

| Control | Initial default | Authority |
| --- | --- | --- |
| Submission attempts per app/environment | 10 per 60-second fixed window | Edge, existing shared counter primitive |
| Submission attempts across the deployment | 100 per 60-second fixed window | Edge, shared aggregate counter across serving edge replicas and servers |
| Unfinished jobs per app/environment | 20 | Jobs, checked with enqueue |
| Unfinished jobs per server | 200 | Jobs, checked with enqueue |
| Retained jobs per app/environment | 1,000 | Jobs, checked with enqueue |
| Retained jobs per server | 10,000 | Jobs, checked with enqueue |
| Running jobs per app/environment / worker process | 2 / 8 | pg-boss local limits across types (§6) |

Values are initial operator defaults, not public SLAs or workload-sizing claims.
Per-app unfinished/retained defaults are scoped within each server.
Keep one configuration definition per owning service and document resolved
values. The edge and the dev gateway read the two submission controls
and their window from `EDGE_JOBS_LIMITS`; the jobs service reads its own
controls from `JOBS_LIMITS`. Reject zero/negative/unbounded settings. Capacity reductions block new
work until occupancy falls; they do not evict accepted jobs or erase results.
Execution overlap follows §6; no persisted distributed-slot synchronization is required.

Authenticated submission attempts reaching the submission gate count before
forwarding, including retries, invalid input and uncertain or rejected outcomes.
There are no refunds. Fixed windows may allow adjacent-window bursts. Throttles
return 429 `rate_limited`; clients back off and reuse the same key. Unfinished
or retained-job saturation returns 429 `jobs_capacity_exceeded` for new work.
This means the job was not created by that transaction; an earlier ambiguous
request with the same key must still be resolved by retrying that key. Capacity
replays work even when new intake is closed or queues/storage are full, subject
to current authorization and the ordinary request throttle. Status/result/cancel
are not charged to the submission buckets and retain ordinary gateway controls.

Unfinished means every nonterminal job, including delayed retries and pending
cancellation. Retained means all physically stored jobs, active or terminal,
including temporary archived bodies awaiting deletion. A key hit uses no new
queue/storage slot. Completion releases unfinished capacity; only physical
cleanup releases retained storage capacity. Within each server database, enforce app and server-wide storage/unfinished
caps across types and rolling overlap. These caps are transactional; execution
concurrency is a separate soft limit. The per-app submission throttle and the
deployment aggregate are shared across all servers, so changing a type prefix
does not multiply the edge allowance. Development-tier submissions are counted
by the dev gateway's own process-local throttle, with the same configured
limits, and do not count toward the deployment aggregate: the dev gateway's
database role has no grant on the shared counter table, so a compromised dev
gateway cannot reset production abuse controls. No cross-database capacity reservation or
global execution ledger is introduced. Adding a server requires sizing the
combined storage and connection budget; it adds its own configured capacity. These finite counts, bounded payload/result
sizes, bounded attempts/progress and §7 retention limit jobs storage; the stored
ceiling must still block new work when cleanup stalls. Include runner tables,
indexes and transient archives when measuring actual disk use before release.

Avoid moving overload into audit or telemetry storage: reuse bounded rejection
logging, do not emit a persistent ledger row per rejected flood request, and
keep keys/identities out of metric dimensions. Existing platform ledger retention
is separate; these controls do not promise a fixed byte ceiling for Postgres,
WAL, backups or every other service's data.

### Reporting is operational

Use existing gateway request outcomes and bounded operational signals. A
successful submission response, including a replay, is a successful request;
it is not proof of a new unique job. A timeout remains an uncertain request
outcome. Missing request records after failure are not repaired by an accounting
protocol and never change job durability or capacity enforcement.

Do not add accepted-job billing rows, admission uniqueness fields,
`jobSubmissionState`, `JobsUsageToday`, pending-confirmation allowances or exact
accepted totals. Existing usage/audit views may show recorded jobs requests with
clear request-level labels. Capacity occupancy, refusals and cleanup health
belong to operator telemetry; no new production job monitor is required.
Outbound calls retain the existing fetch ledger, quotas, credential and policy
checks independently. This change does not relax vendor-spend controls.

## 5. Lifecycle delivery

Archiving cancels queued and running jobs in both environments. Unarchiving
permits new jobs and never resumes a cancelled generation. Promotion does not
affect jobs. There is no hard app-delete route today; any future deletion must
retain and deliver the cancellation tombstone before discarding app metadata.

Add a monotonically increasing jobs lifecycle generation to app metadata and
the edge projection. The portal writes the archive/unarchive change, generation
and lifecycle outbox intent for each configured lifecycle target in the same
transaction. Targets include serving and retiring servers that can retain work.
Track delivery/acknowledgement per `(appId, generation, server)`; a successful
delivery to one server cannot acknowledge another. One unavailable target must
not block delivery to healthy ones. No cross-database commit is required. A bounded portal sender
delivers separately signed updates to each target, retries until acknowledged and reconciles
undelivered records after restart. Jobs remembers the highest generation and
ignores older events. Archive closes the current generation; unarchive opens a
new one but also cancels every older generation, so out-of-order delivery cannot
revive work or skip a brief archive.

Enqueue records the signed generation. Jobs serializes admission and lifecycle
updates per app; it rejects closed/older generations. An unseen newer generation
waits for its control-plane update and returns a retryable 503, rather than being
opened by an edge assertion. Initial app creation emits open-generation
records too. Enabling a new server synchronizes every current app generation,
including archived apps, before that server opens intake. Workers check the durable generation before executing. A lifecycle
update records cancellation intent before invoking bounded runner bulk-cancel
passes; a recovery loop keeps applying that intent until no older active jobs
remain. One bulk-cancel call is not proof that racing claims were all stopped.

Cancellation is asynchronous, not atomic with the archive HTTP response. During
outbox lag or registry staleness, already admitted work may run; after delivery,
old admissions cannot start new work and running work is cancelled. Already
sent external effects cannot be undone. Expose outbox age, failed deliveries and
remaining cancelled-generation work through logs, telemetry and health. These
limits must appear in the operator guide.

## 6. Runner contract and resource limits

Keep one replica (`min=max=1`) initially and allow at most two worker processes
in a rolling deployment. Use one pg-boss queue for the installed types, dispatching
to a platform allowlist, so local concurrency applies across types: eight total,
two per trusted `(appId, env)` group in each worker process. Never let each type
silently receive its own full allowance. The PoC observed both limits doubling
with two processes. Plan for up to sixteen total and four per app/environment
during overlap. These are fairness defaults, not strict fleet-wide guarantees;
lease loss can also overlap local cleanup with recovery. No new distributed
reservation system is required. Any future scaling change must size and test
its actual execution and connection envelope.

Operator configuration owns finite limits. Updates take effect through reviewed
worker/deployment configuration; app input cannot change retries, concurrency,
deadlines or retention. Check effective pg-boss queue policy during migration
and startup compatibility checks. This replaces TaskQ's persisted actor/keyed
slot synchronization and drain-to-resize protocol.

Development/test fixtures have bounded execution and retry attempts; the
production fetch type has one execution attempt (`retryLimit: 0`) and no automatic
outbound retry. Configure claim heartbeat, maintenance and abort checks so worker
loss and cancellation meet their bounds; preserve terminal/claim fencing.
GET is not a guarantee that a remote endpoint has no side effects. Worker death after
an upstream response can lose that response; report a terminal failure rather
than promising exactly-once execution or secretly reissuing the call.

The 60-minute bound is an absolute schedule-to-close deadline from acceptance,
including queue wait and all attempts. Fetch has a shorter five-minute deadline,
a 30-second outbound GET timeout, and response-stream abort when the result
exceeds 64 KiB (65,536 bytes is allowed). Validate HTTP status and JSON before storing fetch results;
non-JSON, non-success status and over-cap responses are closed, sanitized errors.
No caller-selected headers, methods, code, retry policy or connection names are
accepted by this initial fetch type.

Successful fetch results contain only the upstream JSON value, including null.
They contain no HTTP status or headers.

A jobs capability grants `{types}` only. Installed type grants are baseline
changes in the existing approval classifier; no daily budget or elevated capacity
request is exposed. Granted types must come from the installed production
catalogue, initially `jobs:fetch`, never arbitrary actor names. Fetch progress
represents one unit, completed only when the valid complete JSON result is
available; it has no invented intermediate percentage. For new work, after the
retained-key lookup in §4, reject unknown fields, wrong types and out-of-range
inputs before acceptance. Retained-key comparison precedes payload validation.

Synthetic actors are development/test fixtures. Use small deterministic fixtures
for progress, retry exhaustion, cancellation races and deadline coverage. Their inputs and outputs are test-owned, not a second public job API.
Fixtures cover abort propagation, worker death and fenced late completion. Production must
neither register these actors nor accept their names through any submission
path. Local fixture runs use the same signed service and authorization paths;
they do not require production portal controls or a production enable flag.

Record cancellation intent durably, cancel through the runner and propagate its
AbortSignal into the outbound HTTP request. Fence late completion using runner
claim/terminal semantics and conditional wrapper updates. Queued cancellation
must prevent dispatch; restart/recovery must not reissue cancelled work. Do not
copy TaskQ's forced-abandonment phases or watchdog machinery into Node.

The trusted fetch handler must honor abort and bounded I/O. The 60-second
healthy-service cancellation bound below applies to this supported handler and
recovery, not to forcibly killing arbitrary JavaScript. Test abort propagation,
queued cancellation, worker death, durable intent and completion races. Blocking
or uncooperative future job code needs its own isolation/execution decision;
this initiative does not build a general task-killing subsystem.

Cancellation acknowledgement confirms a request, not a terminal outcome.
Whichever terminal outcome commits first wins; successful completion may beat
cancellation and retain its result. Repeated requests while active are harmless;
the terminal DELETE refusal below remains unchanged.

Acknowledged owner cancellation reaches a terminal outcome within 60 seconds
while required services remain available. A competing terminal outcome may win.
During outages, durable intent remains pending and resumes after recovery;
there is no outage stop-time guarantee. Native timers must satisfy this contract.
Lifecycle delivery/cancellation backlog exposes count and oldest age, degrades
health after 60 seconds pending, and keeps recovering without an overall
completion-time SLA. These lifecycle signals do not imply accounting recovery.

## 7. Public responses, expiry and progress

Retain four public operations: submit, status, result and cancel. The
2026-10-07 ADR-0045 amendment removes the events endpoint. Successful enqueue, including an authorized
keyed replay, returns 202 `{server, jobId, status}`. For new work after the
retained-key lookup in §4, generic and type-specific payload errors return 400
`payload_invalid`; they do not create a job. Updated per consistency check —
§4 owns the validation/replay ordering, including different-byte conflicts. Submission throttles still count the request. Worker-time validation failures caused by version
skew are terminal failures, separately observable. Validate a known qualified type
explicitly; only the selected server's registered handlers may execute.

Submit, status, result and cancellation resolve within 30 seconds or return
sanitized 503. Service failure never masquerades as 404, an empty result or an
acknowledged cancellation. A timed-out submit or cancellation may have committed;
recover by keyed submission or status/repeated cancellation respectively.

Keep the seven public statuses: `queued`, `running`, `succeeded`, `failed`,
`crashed`, `cancelled`, `expired`. Map native waiting states to queued. The adapter distinguishes ordinary failure
from lost execution after worker/lease failure, projecting the latter as crashed
when no attempt remains. Public status names do not require native enum names. Only a successful result whose
TTL has elapsed becomes expired. A successful JSON `null` result is not expiry.
Store an explicit success/result-expiry timestamp in platform job metadata;
do not infer it from the runner's nullable result column or wait for its sweep.

Result reads return 409 while unfinished or terminal without a successful
result, including a bounded status/error body; 410 `result_expired` after seven
days from success; and 404 after record expiry or on an ownership mismatch.
Terminal DELETE returns 409 with status. Error messages are fixed, sanitized
platform messages, never raw validation input/error dumps or upstream exception
text. Add jobs-specific shared error schemas instead of changing unrelated
portal error mappings simply to obtain HTTP 410.

Existing serving, caller/session and development-token/origin gates retain their
statuses, headers and bodies. Their responses may be the nested
`{error: {code, message}}` API envelope (including `refresh_required`) or an
existing non-JSON serving/access denial. The shared edge framework error handler
also keeps its existing envelope. The flat `{code, message}` jobs schema covers
jobs-operation errors after those gates and the signed internal protocol; it
does not normalize gate errors. Updated per consistency check — see §2's existing
caller boundary, `apps/edge/src/auth/gate.ts`, `apps/edge/src/devGateway/resolver.ts`
and `apps/edge/src/errors.ts`. Author examples check status/content type before
decoding, retain the original job reference during sign-in/refresh, and resume
observation after authentication recovery. Follow the existing gateway
`Cache-Control: no-store` convention for all jobs responses.

Public error reasons distinguish invalid input, timeout, cancellation, retry
exhaustion, outbound policy refusal, outbound
quota refusal, unattended delegated-credential refusal, upstream failure,
invalid result, oversized result, and platform failure. Callers must not need
to match message text to distinguish those categories.

Retain public records for 30 days after terminal state and enforce that horizon
on reads independently of sweep timing. Configure pg-boss primary-row retention to preserve all terminal states for
30 days. A jobs-local cleanup loop removes successful output at seven days and
prunes the primary row plus wrapper/key identity atomically at thirty days.
Native maintenance must not prune rows earlier or leave orphaned retry mappings.
The PoC used accelerated retention and runner SQL for early output deletion;
keep that schema knowledge inside the pinned adapter and test upgrade compatibility.
No separate archive of job bodies is required. The observable physical-deletion
bound is 48 hours after each logical expiry boundary. If an outage prevents
cleanup, keep it visibly overdue and finish within 48 hours after restoration.
Existing backup retention is unchanged. Configure cleanup and alert on missed
cycles. Include
job payloads, attempts, progress and platform metadata in the retention review;
do not claim that deleting a result erases the rest of the job. Keep no separate
long-lived archive of platform job bodies.
Retry mappings are removed with the physical job record. There is no
unacknowledged-receipt retention exception. Public logical expiry does not
release a key ahead of cleanup; §4 specifies the bounded replay response during
that gap. Retained-job capacity also remains occupied until physical removal.

Status polling is the only progress transport. Each request uses current edge
caller authorization and the signed jobs snapshot API. Zod in `@azx-pbc/shared` is the wire-contract authority and is reused by the
initial TypeScript service. Shared conformance fixtures and signing vectors
become a gate for any future non-TypeScript implementation. Return one complete camelCase snapshot with explicit nulls,
including attempt, progress, cancellation intent and result/record expiry times.
No events endpoint, SSE framing, browser connection leases, heartbeat timers,
stream quotas or progress fanout are required. No Redis dependency is introduced.

Snapshots describe current state, not a replayable event log. Intermediate
updates may be skipped. Progress uses `{step, of, label}` with a positive bounded
`of`, `0 <= step <= of` and platform labels of at most 128 UTF-8 bytes. Before
execution progress is null. Across retries, identify the last attempt while
waiting, then reset progress when the next attempt begins. Test fixtures exercise
this behavior; the initial production fetch type has one attempt. Keep progress as a bounded latest snapshot in the jobs adapter/wrapper; no
append-only event history or public `progressSeq` is required.

A failed status request returns the bounded sanitized error within the existing
30-second request deadline. It does not cancel, fail or resubmit the job. Clients
keep any last known state visibly stale and retry observation. Every subsequent
poll applies current authorization and credential checks; no stream revocation
window is needed. Ordinary request limits still apply. Client guidance uses
bounded polling with backoff on failures and stops on terminal outcomes, known
access loss or leaving the view. No fixed end-to-end freshness SLA is promised;
report measured update delays rather than equating a polling interval with one.

## 8. Databases, deployment and health

Use one private database per job server on the existing Postgres server.
Initially only `jobs` exists, using the jobs database and `helix_jobs` role.
Future servers get distinct runtime/migration roles and cannot connect to each
other's databases; they do not share pg-boss or TaskQ tables. Revoke database
CONNECT from PUBLIC on both platform and jobs databases, then grant the
documented runtime/migration roles explicitly. A role-specific REVOKE cannot
override PUBLIC membership. Also restrict schema creation/default privileges;
`helix_jobs` is NOINHERIT/NOBYPASSRLS and not a database/schema owner. No platform
runtime role can connect to jobs; jobs cannot connect to `helix`. The migration
identity is separate and never installed in a runtime image. Apply the ACL
changes to existing installs and test databases, not only empty-volume bootstrap.

The edge's existing rate counters, new nonce-burn table and portal lifecycle
outbox are platform-owned
Prisma migrations. Jobs owns its wrapper tables and pg-boss migrations in its own
database, via a separately executed jobs migration/config job. Roles, grants,
both migration jobs and rollback/forward-compatibility checks ship in Bicep.
No auto-migrate flag runs under `helix_jobs` at startup. Rollback of an image
must be checked against the forward-only schema before deployment.

Each server is deployment-optional. `JobsDeploymentConfig` owns the static
server map; each entry has its endpoint, installed types, three independent
secret references and serving/intake state. Database credentials belong only
to that server and its migration job. Edge and portal never receive them.
`JOBS_SERVER_ID` identifies the server at its own startup. Replace the singleton
`JOBS_URL` assumption with this map; keep callback destinations by environment.
Intake is controlled per server, never by an app request.

With no configured or retained servers, omit the jobs catalogue and refuse jobs
routes. Ordinary hosting then needs no jobs secrets, outbox backlog or jobs
health dependency. Enabling a server synchronizes app generations before intake.
Retirement closes new intake against in-flight enqueue transactions and drains
active work/lifecycle delivery. It removes types from new-grant discovery but
retains original routing, credentials, authorized keyed recovery,
reads/cancellation, lifecycle delivery and cleanup until its retained records
are gone. Only then can the target be removed and the runtime fully disabled.
An outage or intentional temporary shutdown is unavailability, not retirement
completion: keep the map/store and pending lifecycle intent for recovery.
An already granted retiring type may still recover its retained keys;
it cannot create new work. Do not silently rewrite grants or migrate references.
Never repoint or reuse a server id for an empty store while references or retry
identities remain. Replacing a library under one name must preserve its store/
identity contract or drain it; otherwise use a new namespace. A future hard
app-delete must preserve cancellation tombstones for every affected server.
Re-enable against the retained store, never an empty replacement
that could rerun retained keys. There is no accounting reconciliation barrier.

Place jobs in the existing apps Container Apps environment with internal app
ingress and no Key Vault data-plane credential. Reuse avoids an additional
environment/subnet at the cost of a broader network allowance: jobs inherits the
apps subnet's outbound allowances, rather than a jobs-only destination allowlist.
It still makes application fetches exclusively through edge→egress and holds
no connection secrets. Network enforcement is the existing apps environment's
posture; do not claim a separate jobs network sandbox. Image builds fetch
dependencies outside that runtime network. Production and dev-gateway URLs
must preserve environment attribution; jobs does not choose a tier from its
own deployment mode. Local `pnpm dev:jobs` uses the same contract and a dev
database, with ports reserved in the workspace stack tooling.
The production callback refuses `dev` instructions and the dev-gateway callback
refuses `prod`; a job's signed tier selects the configured callback destination.
Never fall back to the other destination when one is unavailable.

Start the health API before worker initialization. Bounded DB connection/schema
checks retry with capped backoff while `/health` reports error/degraded and job
routes return 503. A worker task that exits unexpectedly is supervised; never
leave an apparently healthy API with no worker. Parse-invalid config and missing
keys are boot errors. Project supervised worker/maintenance state into the shared
always-200 three-state contract, including DB, worker, sweeper, capacity/cleanup and
lifecycle-recovery checks. Unknown/stale checks cannot report ok.

Configure ACA probes explicitly against the service's always-200 `/health`,
with worker supervision for dead execution and body-aware alerting for
degradation. Do not substitute a runner-native readiness endpoint. The edge independently reports
jobs reachability health without allowing a slow health request
to hold a gateway handler. Measure the actual pool configuration and account for
two replicas, API connections, lifecycle recovery and migrations; neither an old TaskQ pool estimate nor the PoC's API-only RSS establishes a
production sizing guarantee. Add each configured server to that budget.

## 9. Telemetry, tests and delivery gate

The TypeScript service reuses `packages/telemetry` for boot-only SDK setup,
shared signal constants and service helpers. No Python SDK/import exception or
mirrored telemetry constants are needed in this delivery. Jobs extracts trace
context only after authenticating an internal caller. The jobs→edge callback
starts a new edge root; execution links to the accepted submission. Keep the
existing inject-only rule on edge and portal.

Use `JOBS_LOG_LEVEL ?? LOG_LEVEL ?? info`, structured events and existing URL
redaction. Do not log payloads, results, retry keys or credentials. Inventory
only bounded Helix signals; no unreviewed runner auto-instrumentation. Server
names and qualified types are bounded deployment-catalogue dimensions, never
raw unknown request values; request/job/user identifiers are not dimensions.
With no endpoint or `OTEL_SDK_DISABLED=1`, register no SDK/exporter/provider.

The change must instrument and inventory submission outcomes, replay/conflict,
throttle/capacity refusals, unfinished/retained occupancy, cleanup lag, lifecycle
delivery and cancellation backlog, worker recovery, timeouts, expiry and forbidden
delegated calls. Use service helpers and bounded reasons; retain ADR-0037's existing TypeScript SDK boundary. Portal
lifecycle uses spans/logs and health; adding portal metrics needs its own ADR
decision. There is no jobs accounting reconciliation signal or health check. Operational
counts are not a unique-job billing ledger.

The implementation is complete only after these cases run against real services:

- Two owners and two environments reuse one key without sharing jobs or results;
  every read/cancel verb refuses mismatches. Current grant/session revocation
  denies subsequent observations.
- Provider-backed origins fail before egress, including a secret→provider edit
  during queue wait. A forged or replayed token, wrong direction/key/body/path,
  app-host request or dev bypass never authorizes an internal operation.
- Concurrent same-key submits produce one job. Lost replies and edge/jobs
  restarts recover that job; a lost request-log write cannot invalidate it.
  Retained-key lookup works when queue/storage is full or intake is closed,
  while ordinary request throttles may return 429. Throttled/invalid/failed
  attempts get no refunds. Test window reset and bounded retry backoff.
- Concurrent new submissions cannot exceed app/server-wide unfinished or retained
  caps within each server, across types and overlapping replicas. Completion and cleanup release
  the appropriate capacity. Paused cleanup eventually blocks new work without
  evicting retained jobs; rejection floods cannot grow unbounded audit rows.
- Archive races enqueue/claim; the sender crashes; updates arrive out of order;
  archive is followed immediately by unarchive. Old work stays cancelled and
  new-generation work remains possible after synchronization.
- Two workers exercise local execution limits, documented overlap and lease recovery.
  Cancellation survives a worker crash. Failed or abandoned status requests
  do not cancel jobs; subsequent authorized polls recover current snapshots.
- Result expiry distinguishes JSON null from expired data; keyed replay after
  result expiry does not execute again. A retained but logically expired record
  returns 404 on an identical replay and does not enqueue. Physical cleanup
  releases the key; a later new job is safe from racing old cleanup. All
  status-specific retention and archive cleanup honor the contract.
- Public/dev routes preserve existing auth/refresh, origin and non-JSON gate
  failures alongside the jobs error schema. Response fixtures cover explicit
  nulls, opaque ids, state-dependent errors and the no-store privacy boundary.
- Actual roles fail cross-database connections and prohibited table/DDL operations
  after both clean provisioning and upgrade. Runtime credentials cannot migrate.
  Partial initialization and shutdown release acquired resources while preserving
  durable work; verify bounded storage recovery and telemetry-disabled operation.
  DB absent at boot, unmigrated schema, stale sweeper, worker exit and recovery
  report honest health. Production exposes no runner administration UI; no cron,
  batch or sub-job entry point is registered by the platform. Synthetic actors
  are absent from production registration and cannot be submitted there.

Extend the existing TypeScript checks for the jobs package; retain the six-step
`typecheck lint refs format docs test` gate. No Python invocation, mypy/ruff/pytest,
uv lockfile or native-wheel build is required. CI and local `./check-and-lint.sh`
cover the same checks. Verify the production image, Bicep, real startup and the
jobs end-to-end smoke before claiming the plane ships.

Add routing tests using two lightweight contract fixtures, without deploying a
second production runner: identical local ids/keys remain isolated by server;
qualified grants cannot cross servers; wrong-server signatures and callbacks
fail; outages never trigger fallback; lifecycle delivery is tracked independently;
retirement preserves old reads/retries/cleanup while blocking new work. Initial
production acceptance still runs against the one real pg-boss service. The
[2026-10-21 acceptance review](../reviews/2026-10-21-background-jobs-acceptance.md)
records which of these cases ran against real services, and which did not.
