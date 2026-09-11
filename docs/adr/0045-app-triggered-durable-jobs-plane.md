# 0045. App-triggered durable jobs: a platform-owned plane behind an HTTP contract

**Status:** Proposed _(2026-09-11)_
**Related:** ADR [0001](0001-three-runtime-split.md) (the plane split this extends); ADR [0002](0002-postgres-role-split-rls.md) (the role convention a fourth plane inherits); ADR [0006](0006-secret-custody-seam.md) and ADR [0040](0040-entra-group-visibility-directory-seam.md) (the seam pattern this is the third instance of); ADR [0013](0013-egress-trust-model.md) (the attested-instruction shape reused here); ADR [0020](0020-static-only-apps-v1.md) (the constraint that creates the gap); ADR [0021](0021-metering-ledger.md) (attribution); ADR [0031](0031-connection-providers-delegated-auth.md) (the unattended-caller question this is the first workload to force); ADR [0041](0041-app-data-write-concurrency.md) ("do not build a job claim on this primitive"); `docs/design/custom-backends.md` §3 rung 0; `docs/design/background-jobs.md` (the research behind job #1); architecture §3

## Context

A hosted app has no way to run work that outlives the browser tab.

Apps are static bundles (ADR-0020). All dynamic behaviour is a request to `/_api/*`, which is request-scoped by construction: it begins when the tab asks and ends when the tab stops listening. Any unit of work longer than a request — and in particular any work whose *cost* is already sunk when the tab closes — has nowhere to live.

ADR-0041 hit this from the concurrency side and refused to paper over it:

> **Durable claims / mutual exclusion.** CAS can express "exactly one worker starts this job," but a claim is only sound if the winner finishes. A browser tab that wins a claim and is closed mid-work leaves the record claimed forever, and the static model has no server-side sweeper to recover it — so the claim is taken correctly and still leaks, permanently. **Do not build a job claim on this primitive.**

`docs/design/custom-backends.md` §3 gives the gap an address — rung 0, "cron/scheduled triggers … no new untrusted runtime; same as today" — and §6.5 gives the discipline: resist rungs 1 and 2 until a third app forces them. This ADR builds rung 0 and nothing above it.

### The workload that forces it

The pilot app of ADR-0041 and ADR-0042 is the same one here. Its core operation is a multi-phase LLM pipeline: a research call with server-side web search producing a strict-schema JSON document, a second call that enriches that document, and a best-effort third call that compresses it. Typical wall time is **30–90 seconds**; the aggregate synthesis over many records runs for minutes, and its vendor client is configured with a 45-minute timeout. Each run costs real money at a vendor, and a run whose result is lost is re-run and re-billed later.

Around that pipeline the reference implementation has built, in application code, exactly the machinery a job runner provides: a compare-and-swap status claim, a per-record rate limit, a daily spend cap checked before each run, a per-phase audit row, and a stale-job recovery sweep.

**The load-bearing observation is that this machinery does not actually make the work durable, even today, outside Helix.** The pipeline is started from a post-response hook in the same web process that served the request. If that process restarts mid-run, the work stops and the record stays claimed; recovery is opportunistic — it runs only when some later request happens to touch that same record, and only after a 15-minute staleness threshold. The implementation's own recovery message names the cause ("most often the … server restarted during a run").

So the platform is not being asked to preserve a durability guarantee that exists elsewhere. **It is being asked to provide one that has never existed**, for a workload where the failure mode is silent, delayed, and billed twice. That is a stronger case for building the primitive than "an app wants to keep what it has", and it is the case this ADR rests on.

### Why this does not reopen the untrusted-runtime question

The tempting reading is that durable background work means running app code on a server, which is rung 1 — untrusted tenant code on a substrate we control — and expensive (isolates or Wasm plus compensating controls).

It does not, because **the job types are platform-authored**. An app does not supply code; it names a job type from an enumerated set and supplies a JSON payload, exactly as it names a capability today. Nothing tenant-written executes server-side, so the containment model of architecture decision 1 is untouched and no new isolation work is in scope.

This also satisfies the line drawn when the app-data surface was last scoped: build in-house while the primitive is expressible as a platform-authored grant the app merely names; the moment an app needs to author its own policy or its own logic, it is rung 0/1 and a different decision. A canned job type behind a platform API is on the safe side of that line by construction.

The one property this *does* change, and it should be named rather than discovered: architecture §3 says the control plane's background work "runs as scheduled jobs it owns — **no standing workers**." A jobs plane is a standing worker. The precedent for the shape exists; the precedent for it being app-triggerable does not.

## Decision

### 1. A fourth plane: `helix-jobs`, one container, platform-owned job code

`helix-jobs` joins edge (data/policy), portal (control), and egress (mechanism). One image runs two things: a **worker** that executes jobs, and an **internal API** that accepts and reports on them. It is never routable from an app subdomain; like egress, it is reachable only from inside the deployment.

Job types are platform code shipped with the image. There is no mechanism for an app to supply, upload, or reference code of its own. That is the property that keeps this at rung 0, and it is a requirement of this ADR, not a v1 simplification.

### 2. The HTTP contract is the decision; the runner behind it is an implementation detail

Everything outside `helix-jobs` depends **only** on the HTTP surface in decision 3. Nothing else in the repo imports the runner's types, reads its tables, or knows its schema. Swapping the runner — a different library, a cloud queue service, something hand-written — is a change confined to one container.

This is the third instance of a pattern the repo has already committed to twice: `SecretStore` (ADR-0006) putting a dev envelope and a production vault behind one interface, and `Directory` (ADR-0040) putting Graph, a static fixture, and an explicitly-unavailable variant behind another. The argument is stronger here than in either, because a job runner is a large, stateful dependency and any credible candidate is pre-1.0 or vendor-specific.

Two consequences follow and are binding:

- **The jobs database is private to `helix-jobs`.** No other service reads or writes it, and it is not an integration surface. A shared database used as a message bus would make the runner's internal schema a contract in everything but name.
- **The edge never enqueues by writing rows.** See decision 6.

### 3. The app-facing surface: enqueue, poll, stream, fetch, cancel

Exposed through the edge at `/_api/jobs/*`, grant-checked against the app's manifest like every other capability:

| Verb | Path | Returns |
| --- | --- | --- |
| `POST` | `/_api/jobs/<type>` | `{ jobId, status }` — accepts the payload and an optional idempotency key |
| `GET` | `/_api/jobs/<id>` | `{ status, progress, error? }` |
| `GET` | `/_api/jobs/<id>/events` | SSE: progress events, then a terminal event |
| `GET` | `/_api/jobs/<id>/result` | the result JSON; `404` unknown, `410` expired |
| `DELETE` | `/_api/jobs/<id>` | requests cooperative cancellation |

**Enqueue is deliberately not the stream.** Making the enqueue call itself the progress stream collapses two different failure modes into one: a connection that drops at t=0 leaves the caller unable to tell whether the job started, which forces an idempotency key to resolve — at which point it is the two-call shape with worse semantics. Enqueue is short, cheap and retry-safe; streaming is a separate, resumable read.

Polling is the primary path and the SSE stream is an optimization. An app that only polls must be fully functional, because the stream is the part with a scaling caveat (see consequences).

### 4. Results are returned by value. The jobs plane cannot write app-data

A job's output is stored with the job and fetched by the app, which then writes it wherever it belongs. `helix-jobs` gets **no grant on `app_data`** — not a narrowed one, none.

This is a security decision before it is an ergonomic one. Writing results into app-data would require the jobs plane to understand scopes, RLS partitioning, session-derived GUCs, and grant checks — reproducing the edge's most sensitive logic in a second service. It would also mean the platform performing a blind `putShared` on the app's behalf, which is precisely the unconditional shared write ADR-0041 made unrepresentable: the platform does not know what the app believes it is overwriting, so it cannot supply a precondition. Returning the result by value keeps the app as the writer and keeps mandatory CAS meaningful.

### 5. A job is **owned by** the triggering user and **executed with** app authority

These are two different questions and conflating them is what makes unattended work look impossible.

- **Ownership** — the `gateway_calls` row, the audit trail, and the right to read the result. This is the **triggering user**, unambiguously. Any other answer makes spend unattributable and budgets unanswerable.
- **Authority** — the credential the job acts with while running. This is **app-scoped**, because the user's session may be expired, refreshed, or revoked by the time the job runs, and there is nothing left to re-check it against.

Revocation then needs no new machinery: **the result is fetched through the edge**, which already re-checks group membership on every request. A user who loses access while their job runs simply cannot read the result. Fail-closed, no mid-flight cancellation protocol, no session resurrection.

This is the first workload to force ADR-0031's deferred question ("anything without a user session has no delegated token … needs deciding before the first scheduled workload"). This ADR answers it **only** for platform-authored job types acting with app authority. It does **not** authorize unattended access to delegated connection providers; that remains open and refuse-by-default.

### 6. The edge reaches the jobs plane with an attested instruction, never a database write

Enqueue is the edge minting a signed instruction and posting it to the jobs API — the same shape as the fetch-proxy's edge→egress hop (ADR-0013), carrying `(app, user, capability, request-id)` and the payload. The alternative — the edge inserting directly into the runner's queue table — would bind the dependency-minimal trusted path to a third-party schema across a version boundary, and is rejected outright.

The policy decisions stay in the edge, above the mechanism: grant check, quota, budget, audit. The jobs plane verifies the instruction and executes. This is `custom-backends.md` §6.1 and §6.2 applied to a new capability rather than retrofitted to one.

### 7. `helix_jobs` is a Postgres role with grants only on its own schema

Per ADR-0002's convention, the runtime role is created `NOINHERIT NOBYPASSRLS` in both the dev bootstrap and the production role bootstrap, and holds privileges on nothing outside the jobs schema. In particular it has **no grant on `app_data`, `app_secrets`, or the registry** — stated here so the role split's blast-radius argument can be checked by reading one file, the way `helix_edge`'s absent `app_secrets` grant can be.

### 8. Job #1 is a generic structured LLM pipeline

The first job type is: run an N-phase LLM pipeline, where each phase supplies a prompt, an optional JSON schema for structured output, and an optional request for provider-side web search; validate each phase's output; store the final document as the job result.

Everything domain-specific — the prompts, the schemas, the phase count, the enrichment context — is **payload**. The test this must pass, stated so it can be applied at review time: **if the job's API mentions any noun from the pilot app's problem domain, the abstraction is wrong.**

Its LLM access initially routes through the **fetch-proxy with a connection secret**, not the LLM gateway. The reasoning, the alternatives, and the governance cost of that choice are worked in `docs/design/background-jobs.md`; the short version is that it requires no gateway change and no re-tuning of an app's prompts, and it preserves this ADR's invariants — the jobs plane holds no vendor key, and its outbound call still passes through a platform choke point with SSRF controls. The cost is real and named in the consequences.

### 9. Telemetry ships with it

A new plane, a new route set, a new outbound hop, a background loop, and a new decision point that can deny a request — five of the things the standing expectation names. In the same change: `SPAN_*`/`ATTR_*`/`INSTR_*`/`ROUTE_*` constants in `packages/shared/src/telemetry.ts`; spans from the service's own helper, never an inline `tracer.startSpan`; instruments on one `instruments()` object; every dimension bounded and non-personal (`appId` and job type are dimensions, `userOid` is never one); no whole URLs. The jobs plane is an *inbound* trace continuation point like egress, not an inject-only one like the edge and portal, because its caller is the edge rather than an untrusted app user. The span and instrument tables in `docs/features/observability.md` are updated in the same change.

## Consequences

- **The platform gains a durability guarantee the reference implementation never had.** Lease-and-heartbeat with a server-side sweeper means a worker that dies releases its claim and the job is retried, rather than a record sitting claimed until someone happens to look at it. This is the single largest functional gain and it is worth measuring against the status quo rather than against an ideal.
- **Result storage is capped and expiring, which is a new way to lose money.** Results are bounded (the natural cap matches the app-data value cap — 64 KiB — and the pilot app's measured documents are 42.4 KB median / 52.8 KB max, so they fit with the same thin headroom ADR-0042 recorded) and they expire on a TTL. A job whose result nobody fetches before expiry has spent the money for nothing. Long TTLs are the cheap mitigation; an explicitly-granted write-back capability is the real one, and is deferred rather than designed here.
- **Routing job #1's LLM calls through the fetch-proxy puts the platform's most expensive workload outside the USD ledger.** `dollarsPerDay` and the model allowlist do not apply to a fetch-proxy call; only `requestsPerDay` does. This is a genuine regression in the platform's headline cost-governance story, taken deliberately to avoid making job #1 depend on unbuilt gateway features, and it is the first thing to revisit once the plane is proven. A per-job cost ceiling enforced in the jobs plane is a partial mitigation and should ship with job #1.
- **A second standing service changes the Postgres connection budget.** A durable runner needs session-scoped features — `LISTEN/NOTIFY`, advisory locks, `SKIP LOCKED` dispatch, heartbeat renewal — which do not survive transaction-mode pooling, so it holds several *direct* connections per replica. That lands on the same server as the registry projection's already-filed connection-budget item. Whether the jobs schema lives in its own database or its own server is an open question below, but the budget interacts either way.
- **Multi-replica progress streaming needs a fanout, or one replica.** An SSE client connected to replica A cannot see progress from a job running on replica B without shared fanout state. Single-replica sidesteps it; polling is unaffected, which is why decision 3 makes polling the primary path.
- **Scheduled triggers become cheap, and are still not in scope.** Once a durable runner with leader election exists, cron is a small addition — but it is a different authorization question (a scheduled job has no triggering user at all, which decision 5 deliberately does not answer) and it is deferred.
- **ADR-0031's unattended-caller question is now half-answered and half-sharpened.** Platform job types acting with app authority are settled. A job that needs a *delegated* connection — acting as a user at a third party — still has no answer, and now has a concrete caller that will want one.
- **This is the platform's first standing worker.** Architecture §3's "no standing workers" phrasing describes the control plane and should be amended to say so explicitly, rather than left to read as a platform-wide rule that this ADR silently breaks.

### Open questions

These are genuinely undecided, and the ADR is Proposed rather than Accepted because of the first one.

1. **Is a second language runtime acceptable at the container boundary?** The strongest available runner implementations are not TypeScript. Decision 2's seam is what makes this an implementation choice rather than an architectural one — nothing outside the container would import it — but it means a second toolchain, a second CI path, a second dependency-audit surface, and no shared zod schemas across the boundary. Evaluated candidates and the specific trade-offs are in `docs/design/background-jobs.md`. If the answer is no, the decision becomes "build a minimal TypeScript runner", which is a much smaller feature than any candidate and a much larger build.
2. **Own database or own server?** Private to `helix-jobs` either way (decision 2); the question is the connection budget and the blast radius.
3. **Should the per-job resource ceiling be app-settable within a platform maximum, or fixed?** For an LLM job the direct cost lever is the number of provider-side search calls, which is a budget question wearing a capability's clothes.
4. **What is the `pause_turn` policy for job #1?** Provider-side tool loops can pause and require continuation. A job has no user to ask, so the gateway or the job must auto-continue with a hard cap and surface exhaustion as a terminal error. See the design doc.

### Explicit non-goals

Each was raised, is real, and is not solved here. Recording them is what stops a later reader assuming this ADR covered them.

- **App-authored job code.** The moment an app supplies code rather than a payload, this is rung 1 and needs the isolation work `custom-backends.md` §2 prices. The §11 third-app discipline applies.
- **Workflow graphs.** Posting a DAG and having the platform execute it is the eventual ambition and is not this. v1 is single job types; chaining, if needed sooner, is one job enqueuing another, which is strictly less expressive and much cheaper to reason about.
- **Scheduled / cron triggers.** See consequences — cheap later, different authorization question, deferred.
- **Writing results into app-data.** Decision 4; revisit only with an explicit grant and a precondition story.
- **Unattended access to delegated connection providers.** ADR-0031's question stays open and refuse-by-default.
- **A batch / fan-out verb.** One job, one result. Fan-out is a real shape and a separate decision.
- **Exposing the runner's own admin UI.** Whatever the implementation ships, operator visibility belongs in the portal behind portal auth, or nowhere.
