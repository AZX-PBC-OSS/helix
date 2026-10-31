# 0053. App-authored jobs: app code that keeps working on the server, run in QuickJS compiled to WebAssembly

**Status:** Proposed _(2026-10-30; from the Franklin team, for review by the Helix owners)_

**Related:**
- ADR [0045](0045-app-triggered-durable-jobs-plane.md) and [`docs/design/background-jobs-plane.md`](../design/background-jobs-plane.md): the jobs plane. This is a **second named job service** under its 2026-10-13 amendment. The design's §6 says "blocking or uncooperative future job code needs its own isolation/execution decision"; this ADR is that decision, and supersedes ADR-0045's "app-authored job code" non-goal for this shape only.
- ADR [0020](0020-static-only-apps-v1.md): relaxed for this one surface.
- App-data a job may touch: ADRs [0015](0015-app-data-three-scope-model.md), [0041](0041-app-data-write-concurrency.md), [0042](0042-shared-prefix-grants-and-list-verb.md).
- Approval and version pinning: ADRs [0016](0016-capability-manifest-approval-classifier.md), [0018](0018-deploy-model-immutable-versions.md).
- Delegated connections stay refused for unattended callers: ADR [0031](0031-connection-providers-delegated-auth.md).
- Shared counters, daily budgets, metering ledger: ADRs [0011](0011-in-memory-rate-limiting.md), [0021](0021-metering-ledger.md).
- Why the sandbox holds nothing, and must contain an engine bug on an unpatched install: ADRs [0012](0012-edge-portal-codeploy.md), [0028](0028-deployment-model-customer-deployed.md).
- `docs/design/custom-backends.md` §1 (the invariant), §2 (isolation landscape), §3 rung 1, §8 open question 2 (whether Wasm runtimes are a real rung-1 boundary; answered here for one workload).
- Evidence: [`docs/reviews/2026-10-28-app-jobs-engine-spikes.md`](../reviews/2026-10-28-app-jobs-engine-spikes.md), cited as `[spikes §n]`.

## Summary

An app may ship server-side **job modules**: `async` functions that keep running after the tab closes. A job never performs I/O. A trusted runner performs each request it makes through the edge, under the app's grants, budgets, metering and audit; records the answers in a history; and replays the job after a crash. This is the Temporal and Azure Durable Functions model, with untrusted code.

- **Starting:** after an admin approves the app's modules once, a signed-in user submits a run (like `jobs:fetch`, no popup) and owns it. The edge keeps a **run record** and checks every request against it.
- **Authority:** the app's grants and budgets, never the user's.
- **Limits:** the operator's: deadline (24 hours by default), request count, per-origin pace.
- **Engine:** QuickJS compiled to WebAssembly, built by Helix, one instance per run, in a sandbox pool with no credentials or network.

[Decision](#decision) is settled. What is only proposed is in [Proposals awaiting a decision](#proposals-awaiting-a-decision).

## How a job works

```js
// jobs/summarize.js: fetch an article, summarise it, and save the summary.
export default async function summarize({ articleId }, h) {
  const article = await h.fetch({ origin: "news", path: `/articles/${articleId}` });
  const summary = await h.llm({
    model: "small",
    messages: [{ role: "user", content: `Summarise: ${article.body}` }],
  });
  await h.data.put({
    scope: "shared",
    key: `summaries/${articleId}`,
    value: summary.text,
    ifNoneMatch: "*", // create only: every put needs a precondition (ADR-0041)
  });
  return { done: true };
}
```

1. **Ask.** `h.fetch(...)` records a request and returns a promise. It opens no connection.
2. **Perform.** When the job can only wait, the runner sends its pending requests through the edge, which checks each like a browser call.
3. **Record.** The runner appends the answer to the history, and the job resumes from its `await`.
4. **Replay.** After a crash, a fresh sandbox reruns the job, answering from the history in the original order with no network calls, until the job asks for something new.

So a job must be deterministic: no `Date` or `Math.random` (it uses the recorded `h.now()` and `h.random()`), and no state outside its own variables. A replay that diverges from the history fails with `nondeterminism` (d1).

Requests can run concurrently, and long work can be split into **child runs**, each with its own history:

```js
const [a, b] = await Promise.all([h.fetch(reqA), h.fetch(reqB)]);
const results = await Promise.all(items.map((item) => h.child(resolveOne, item)));
```

See the [worked example](#worked-example-a-listgen-refresh) for a full workload.

## Glossary

| Term | Meaning |
|---|---|
| **Run**, **child run** | One execution of a job module, owned by the user who started it. A child run is started by `h.child` and belongs to its parent |
| **Request**, **answer**, **refusal** | An effect the job asks for; the upstream's or data store's response; the platform declining it (never handed to the job) |
| **Step** | One hand-off: the runner delivers answers; the job runs until it waits on requests only |
| **History** | The runner's append-only record of a run's requests, answers and recorded values; the only source of truth |
| **Replay** | Rerunning a job in a fresh instance, answering from its history step by step, until it asks for something unrecorded |
| **Module service** | The named job service that serves runs (ADR-0045, 2026-10-13 amendment), called `modules` here (open question 1): a trusted **runner** plus a **sandbox pool** of **sandbox hosts**, processes holding engine **instances** (one Wasm instance per run) |
| **Prelude** | Trusted JavaScript loaded before the job; installs `h`, removes what jobs must not have |
| **Sticky** | A run whose instance stays in memory between steps, so the next step needs no replay |
| **Run record** | The edge's record of an accepted run: app, environment, owner, module hash, deadline, stopped flag |
| **Run header** | What a run is pinned to at start: module hash, engine build, limit settings |
| **Callback** | ADR-0045's signed jobs → edge hop, through which a job service asks the edge to perform an outbound operation |

## Context

### What apps cannot do today

Apps are static bundles (ADR-0020) whose `/_api/*` requests end when the tab stops listening. ADR-0045's durable jobs are **platform-authored types** only, such as `jobs:fetch` (one governed `GET`, result kept as JSON): trusted code, at most 60 minutes, no app code, sub-jobs or app-data writes. So app logic cannot outlive its tab:

- **ListGen** checks properties against a rate-limited account-lookup API with a per-property planner that stops at the first hit under a call cap. A refresh is about 21,000 lookups over hours, run in users' tabs coordinated by app-data leases and rate-grant slots: nothing runs without an open tab, and each tab has its own rate limiter.
- **The ADR-0041/0045 pilot app.** Its LLM pipeline is ADR-0045's deferred workload; branching on phase results (re-researching a thin result) is app logic.

Server jobs written by apps, yet checked, metered, budgeted, paced and audited by the gateway, would set Helix apart.

### The shape: the job decides, the platform does

Durable-execution systems split deterministic, I/O-free **workflow code**, which _asks_, from an **executor**, which performs each request, records the answer in a history, and replays the code after a crash. Temporal workflows and Azure Durable Functions orchestrators work this way; AWS Step Functions and Cloudflare Workflows share the shape. Temporal's TypeScript SDK uses plain `async`/`await`, replaces `Date` and `Math.random` with replay-safe versions and makes `WeakRef` throw, so this constraint on authors is normal.

Here the app writes the workflow code and the runner is the executor. What is new is that the code is **untrusted**: those systems run operator-deployed code, and their sandboxes exist for determinism, not security.

### Why not another platform job type

ADR-0045 decision 8: "if the job's API mentions any noun from the pilot app's problem domain, the abstraction is wrong." The **I/O half** ("call this origin at this pace, record the answer, back off on 429") passes, so the platform owns it. The **control-flow half** (ListGen's address ladder, the pilot's re-research rule) cannot: a payload expressive enough for it is a program, and the platform would end up owning an interpreter. Running the app's JavaScript with I/O removed is the honest version.

### The constraint: untrusted code on our servers

custom-backends.md §1:

> A custom backend is just another untrusted tenant. It gets its capabilities _through_ the gateway, holds no ambient cloud credentials, and the gateway stays the single choke point for identity, authz, quota, and audit.

Job code is rung 1 of custom-backends.md §3 (untrusted tenant code on our servers), narrowed: no I/O, no credential, no inbound traffic, and admin approval before any run.

**The attacker** is a malicious or compromised app author, or a poisoned dependency, in an approved app. Installs are single-tenant (ADR-0028), but apps distrust each other (ADR-0019). Customers pull patches; Helix does not push them (ADR-0028). So **the design must contain a known engine bug on an unpatched install.**

### How others run untrusted code

| System | What it does | Lesson |
|---|---|---|
| Cloudflare Workers for Platforms | Policy runs before tenant code; outbound workers inject credentials (custom-backends.md §1). V8 isolates get compensating controls (§2) | Policy before tenant code is the right seam; isolates need defence in depth |
| Shopify Functions | Untrusted app JavaScript on Shopify's servers, as Wasm built with Javy (Shopify's QuickJS-based toolchain), under hard limits including an instruction-count cap; each call runs to completion | QuickJS in Wasm is a production server-side boundary. Pausing between calls is new here |
| Figma plugins | In 2019, after a vulnerability in a JavaScript-level sandbox, moved to "a JavaScript VM written in C and cross-compiled to WebAssembly" (QuickJS, per quickjs-emscripten's README), in the browser | Chosen after a sandbox that hid globals in the same engine failed |
| Temporal TypeScript SDK | Ran workflows in `isolated-vm`; has since switched away | Determinism sandboxes are not security sandboxes; `isolated-vm` is in maintenance mode |

No production system runs **paused** QuickJS jobs for many tenants server-side [spikes §5]; the spikes are the evidence for that combination.

## Decision

### Invariants

Cite as "0053 I5".

- **I1. Job code performs no I/O.** Every effect is a request the runner performs. (d1, d6)
- **I2. Job code has no credential, network, clock or randomness.** Time and randomness come only from `h.now()` and `h.random()`, whose values are recorded. (What an engine bug reaches is I8's subject.) (d1, d6, d7)
- **I3. A run starts only for an app whose job modules an admin approved, and only on a signed-in user's submission.** That user owns it. (d2, d3)
- **I4. A run never acts as the user.** No user-scope data, delegated connection or user token. (d3)
- **I5. The edge decides from its own run record, then applies its ordinary checks.** A request is refused unless it belongs to a run the edge accepted that is not stopped or past its deadline. Nothing the module service asserts widens a run. The app's grants, budgets, fetch policy, metering and audit apply exactly as to its browser calls. (d3, d4)
- **I6. A refusal is never handed to the job as an answer.** It ends the run. (d1, d5)
- **I7. The runner's history is the only source of truth.** Sandbox state is a cache; every sandbox frame is untrusted input. (d7, d8)
- **I8. One engine bug, on an unpatched install, reaches only its own run's instance**, plus what its fixed imports expose (a clock, stderr, its own recorded values). No credential, network or authority. Reaching another run takes a second, independent bug. (d6, d7)
- **I9. Replay is checked.** Each request, each recorded value and a hash of the return value must match the history, or the run fails. (d1, d8)
- **I10. Engine upgrades drain; they never kill a live run.** An instance runs only on the engine build pinned in its run header. (d8)

### Decision 1. The contract: an async function that asks for every effect

A job module is one ES module file, produced by the app's own bundler, whose default export is an `async` function `(input, h)`. Its return value is the run's result. The module is a single bundled file; its source may import pure libraries that the app's bundler inlines. The bundled file itself has no runtime imports.

`h` is the job's only way to affect anything. Each request returns a promise of its answer:

| Request | The runner, through the edge (d4) | Governed by |
|---|---|---|
| `h.fetch(req)` | One fetch-proxy call to an origin the manifest allows. Delegated-connection origins refused, as for `jobs:fetch` | Fetch grant, `requestsPerDay`, secrets and SSRF rules (ADR-0005, ADR-0013); operator pacing (d5) |
| `h.llm(req)` | One LLM-gateway call | Model allowlist, `dollarsPerDay` |
| `h.data.get/put/list` | `shared` app-data. `put` needs a precondition (ADR-0041; 428 without). `list` is ADR-0042's prefix verb | Data grants, `writesPerDay`, CAS |
| `h.data.append` | `collection` app-data, append only (never readable, ADR-0015). No `user` scope (I4) | Data grants |
| `h.sleep(ms)` | A durable timer | None |
| `h.child(fn, input)` | A child run of `fn`; resolves to its return value | See below |

Four calls are not requests and return at once: `h.now()` and `h.random()` return recorded values; `h.progress({ step, of, label })` reports progress in ADR-0045's snapshot shape; `h.log(text)` writes run logs (d8).

- **Answers and refusals (I6).** Anything the upstream or data store says is an **answer** for the job: a 4xx or 5xx, a 429 once the runner's back-off is used up (d5), a CAS `412` (which ADR-0041 expects writers to retry). A **platform** refusal (run ceiling, app budget, fetch policy, revoked approval) ends the run with a visible outcome (d8). In a spike, a daily-cap refusal delivered as an answer silently became "processed, no match" for 44 properties [spikes §4].
- **Concurrency.** Many requests may be in flight; the runner performs them concurrently within the operator's pacing.
- **Child runs.** `fn` is an `async` function in the same module; its own history keeps any one history short (ListGen uses one child per property). A child is part of its parent, not a job: no `/_api/jobs` reference, and not counted against ADR-0045's unfinished or retained caps (20 and 1,000 per app and environment), which a ListGen refresh would otherwise exceed. Its requests count against the parent's ceilings and the app's budgets. Children in flight per run is a platform setting (d5).
- **Determinism is enforced (I2, I9).** No `Date`, `Math.random`, timers or host APIs. Replay delivers the recorded answers in the same steps, so even `Promise.race` replays correctly. A mismatched request, recorded value or return-value hash fails the run with `nondeterminism`: the code depended on something outside its inputs. The run header prevents the other cause, a module changing mid-run (d8).
- **Browser and server.** A small client-side driver runs the same module in a tab through `/_api/*`. Authors can check determinism locally by replaying a recorded history.
- **Apps depend on the contract, not the engine** (as in ADR-0045 decision 2), so the engine (d6) can change without touching an app.

### Decision 2. The manifest lists job modules; an admin approves them once

ADR-0045's `jobs` grant gains a `modules` section (illustrative syntax):

```ts
jobs: {
  types: ["jobs:fetch"],                    // ADR-0045 platform job types, unchanged
  modules: {
    refresh: { path: "jobs/refresh.js" },   // served as the qualified type `modules:refresh`
  },
}
```

- **A module has the app's own grants and budgets** (fetch origins, LLM models, `shared` and `collection` app-data), never more, never user scope or delegated connections (I4). Narrowing a module to a subset is a [proposal](#proposals-awaiting-a-decision).
- **No limits in the manifest;** they are the operator's (d5).
- **Approval.** `classifyChange` (ADR-0016) treats adding a module as **elevated**; an admin approves it once. Platform job types stay baseline grants.
- **Code changes need no new approval** if the manifest is unchanged. Every version is bounded by the app's grants and budgets, the operator's limits and the edge's per-request checks.
- **Each run pins its module.** The run record holds the module's hash in the app's live version at acceptance (d3). The module service fetches that source through the callback (d4) and keeps it, by hash, while any run uses it. Replay never depends on the live bundle, ADR-0018 rollbacks and archiving cannot strand a run, and a redeploy never changes a run in flight.
- **Revoking the app's module approval stops its runs** (d3): the admin's kill switch.

**Deliberate difference from ADR-0045:** granted types "must come from the installed production catalogue … never arbitrary actor names". Module names are the app's own; the admin's approval of the module list replaces the catalogue.

### Decision 3. Starting, owning and stopping a run

**Starting** works like `jobs:fetch`, with no consent popup: a signed-in user calls ADR-0045's `POST /_api/jobs/modules/types/<module>` with JSON input and an optional `Idempotency-Key`. ADR-0045's submission throttle, retry-key rules, 64 KiB input limit and unfinished and retained caps apply. The edge accepts only modules in the approved manifest.

**Run record.** Before forwarding, the edge writes one in `helix`: app, environment, owner (canonical oid, ADR-0048), module hash in the live version, deadline. The signed submission carries its id, and every callback names it (d4). A resend with the same `Idempotency-Key` and bytes finds the same record, so a retry never makes a second run. ADR-0045's edge keeps no job records; this departure is for module runs only, because their code is untrusted and they run for hours.

**Owner and authority.** The submitting user owns the run (its `gateway_calls` rows and audit trail, reading results, cancelling), under ADR-0045's exact-owner checks. Authority is the app's: Helix has no per-user authorization inside an app (ADR-0007), so the user is who the run is attributed to, not its principal. The run never uses, stores or forwards the user's session or refresh token, and gets no user-scope app-data or delegated connections (I4). ADR-0031's unattended-caller question stays open; the default is still to refuse.

**A run stops** at its **deadline** (operator-set, **24 hours by default**, not changeable by apps; longer than the `jobs` service's 60-minute bound, which the jobs design allows: "limits and execution mechanics can differ by server"), or when its **owner cancels** (ADR-0045's route), an **admin stops** it from the portal, an **admin revokes** the app's module approval, or the **app is archived** (ADR-0045 lifecycle delivery). Signing out or losing access does **not** stop it: as with `jobs:fetch`, it runs until it finishes, is stopped or hits its deadline (a residual risk).

**Two independent paths enforce every stop:**
1. **The edge refuses at once (authoritative).** The run record holds the deadline and a stopped mark, set by the edge for the owner's cancel and by the portal for an admin's stop (ADR-0017 projection, sub-second). Revocation and archiving appear in the registry projection the edge already checks on every callback.
2. **The module service cancels.** The owner's cancel uses ADR-0045's cancel route. Admin stop, revocation and archiving use ADR-0045's lifecycle outbox, which retries until acknowledged; it tracks delivery per (app, generation, server) today, so it gains a per-run record type. The runner also enforces the deadline, records stops durably, and checks before each dispatch and before resuming from `h.sleep`.

The module service has no platform-database access (ADR-0045), so a slow path 2 only wastes sandbox time.

### Decision 4. Every request goes through the edge

**The runner uses ADR-0045's signed jobs → edge callback,** discipline unchanged: separate secrets per server and direction, with no service holding `HELIX_INSTRUCTION_SECRET`; short-lived instructions binding server, operation, resource and body hash; nonces burned in a dedicated `helix` table granted to the edge alone; registry generation checked before dispatch; the production callback refuses `dev` instructions and the dev-gateway callback refuses `prod`; one fetch-policy core for browser and job callers.

- **Allowlisted operations widen** from outbound fetch to d1's request kinds (fetch, LLM, app-data), plus a run's pinned module source by hash (d2). Each gets the design's explicit-authority adapter, so the edge never fabricates a session. A write's CAS precondition is in the signed body, so it cannot be stripped. Because `h.llm` uses the real LLM gateway, module runs get the USD ledger and `dollarsPerDay` that ADR-0045's fetch-routed LLM job would lack.
- **The edge never takes a module run's authority from the callback (I5).** It refuses if the named run record is missing, stopped or past its deadline, or disagrees with the callback's app, environment or owner. Then it applies the `/_api/*` policy path: module in the approved manifest, request within grants and budget, fetch policy, metering, audit. `gateway_calls` gains a `jobRunId` column (additive, no backfill, like ADR-0021's request-path amendment).
- **Job code never sees the callback credential (I2).** Only the runner holds it.
- **Adversarial tests** gain module cases **in the same change**: unknown, stopped or expired run; mismatched app, environment or owner; module not in the approved manifest; archived app; request outside grants; request over budget; data write without a precondition.

### Decision 5. The operator owns the limits

Apps declare no limits. Each limit is an existing app budget or an operator setting.

- **App daily budgets apply unchanged** (`requestsPerDay`, `dollarsPerDay`, `writesPerDay`), enforced by the edge on every request (d4): block new, finish in-flight.
- **Per-run limits are operator settings,** one value per deployment, enforced by the runner before dispatch so nothing overshoots: **deadline** (24 hours by default, d3), most **requests** (children included), largest **history**, most **child runs in flight**. Defaults other than the deadline are [proposals](#proposals-awaiting-a-decision).
- **ADR-0045's capacity controls apply** (submission throttle, unfinished and retained caps), without counting child runs (d1).
- **Pacing is new.** Helix has daily budgets but nothing limiting how fast an app calls an upstream. The operator sets a **pace per origin** in calls per second (unpaced origins are limited only by the daily budget). The runner holds every module-run request to it **across runner processes**, since ADR-0045's rolling deployments briefly run two workers and a per-process limiter would double the rate. On an upstream **429** it slows down, honours `Retry-After` and retries; when retries run out, the job gets the 429 as an answer (d1).

The pacing mechanism, and whether one pace is shared by every app calling an origin, are [proposals](#proposals-awaiting-a-decision). In a spike, two apps sharing one upstream doubled each other's run time [spikes §4].

### Decision 6. The engine: QuickJS compiled to WebAssembly, one instance per run, built by Helix

**Why.** A job needs only ECMAScript over JSON, so the smallest boundary is practical. Guest objects in a QuickJS Wasm instance hold no host references, and the instance reaches the host only through fixed imports: 19 in the Helix build (abort and assert, a clock, heap resize, stdout and stderr, glue callbacks), none for files or sockets [spikes §1]. A QuickJS memory-safety bug corrupts only its instance; going further takes a **second, independent** bug in V8's WebAssembly implementation or an import (I8). **One instance per run, never shared**, or one bug would expose every run's heap.

**Loading and stepping.** A fresh instance gets the prelude, then the job's **source**: never bytecode, which quickjs-ng treats as equivalent to untrusted native code [spikes §5]. No module loader is installed, so job code cannot import anything at run time, including platform code. A step resolves the delivered answers and drains QuickJS's pending-job queue; the requests still outstanding are its output. The engine never waits on anything outside itself.

**Ambient API (I2):** ECMAScript built-ins only. No `Date`; `Math.random` throws; no timers, `console`, `WebAssembly`, `Atomics`, `WeakRef` or `FinalizationRegistry`. `h` is frozen; the prelude deletes its own globals before the job loads. The spike found no non-determinism at a fixed configuration [spikes §1], and the configuration-dependent sources (memory cap, stack limit, engine build) are pinned in the run header (d8). Each engine upgrade checks reachable globals against an allowlist; any change blocks it.

**Per-run limits inside the engine.** Mechanisms decided; values are [proposals](#proposals-awaiting-a-decision). In the spike, runaway and memory-bomb jobs stopped only their own run, and a canary in another instance survived every probe [spikes §1].

| Limit | Mechanism | A tripped limit takes down |
|---|---|---|
| Memory | QuickJS heap limit, plus a hard per-instance `WebAssembly.Memory` maximum (the guarantee) | The run. **Any out-of-memory error ends the instance**, dropped without another call, because an out-of-memory runtime can trap later [spikes §1] |
| Stack | QuickJS stack limit, below where V8's own stack overflows first [spikes §1] | The run. Any host-level fault discards the instance |
| CPU per step | QuickJS interrupt deadline; uncatchable by job code; also stops regex backtracking | The run. Other runs on its thread wait out the deadline (d7) |

**Helix builds the engine.** The npm `quickjs-emscripten` builds bundle quickjs-ng v0.12.1, five or more releases behind; upstream's regression test for the critical GHSA-m53g-qx47-3h38 crashes both; and their memory limit fails (a 32 MiB limit let a job reach 2 GiB) [spikes §1]. Helix CI builds from a pinned, sha256-checked quickjs-ng release amalgam (v0.17.0 at writing), or a pinned master commit for an unreleased memory-safety fix; quickjs-emscripten's C glue at a pinned commit plus a Helix patch of about 40 lines; and `emcc` from the digest-pinned `emscripten/emsdk` image. No quickjs-libc, so no `std` or `os` modules. The build is reproducible, passes the GHSA-m53g test, and its memory limit holds [spikes §1]. Each bump passes a release suite (smoke job, memory bombs, CPU-interrupt and stack probes, out-of-memory probe, globals allowlist, Wasm import list, upstream security regression tests) and records the upstream tag or commit, amalgam sha256, emsdk digest and `.wasm` sha256.

**Standing cost.** Since 2026-10-11, quickjs-ng accepts no private security reports and issues no CVEs, and fixes reach master weeks before a release [spikes §5]. No scanner will flag exposure, so the module service's owner reviews quickjs-ng master at least weekly, rebuilds from a pinned commit when a memory-safety fix lands, and ships rebuilds as flagged security releases named in the release notes and deployment catalogue (ADR-0036). Effort: about half a day per routine release; one to three days when the C API or emsdk breaks, which happened once in the five releases from 0.12.1 to 0.17.0 [spikes §1].

**Node's patch level becomes part of the boundary,** because V8 runs the Wasm.

**The spikes measured an earlier contract** (async generators that `yield` requests). Isolation, limit and build findings do not depend on it; step, replay and memory figures do, and must be re-measured on the `async`-function contract before intake opens.

### Decision 7. The module service: a runner, and a sandbox pool that holds nothing

**A second named job service under ADR-0045**, with what that amendment gives every server: a private database with runtime and migration roles (no access to `helix` or the `jobs` database), three directional secrets, a lifecycle-outbox target, deployment-optional intake. Unlike `jobs`, it has **two images**:

- **The runner** holds the database credentials and callback signing key. It drives runs, keeps histories and performs requests through the callback.
- **The sandbox pool** runs job code and holds nothing worth stealing: no managed identity (no `IDENTITY_ENDPOINT`), no Key Vault, database or mounted secrets, and **no outbound network**, enforced at the network layer (inbound only from the runner; cloud metadata and identity endpoints blocked, custom-backends.md §4). It is declared in Bicep on its own ACA workload profile, whose nodes host nothing else. Sandbox hosts run with cgroup CPU and memory limits, a read-only root filesystem, all capabilities dropped, `no-new-privileges` and a non-root user. Optional hardening: ACA dynamic sessions (Hyper-V) per run, or a sandbox host per app.

**Inside a sandbox host,** a main-thread router fronts N `worker_threads` sized to the cgroup's cores.
- **Placement.** An instance lives on one thread (V8 cannot move a `WebAssembly.Memory` between threads), so moving a run means replaying it. New and replayed runs go to the least-loaded thread.
- **Eviction.** Idle instances are evicted under a per-thread cap, which must cover the active working set, and replay on their next step.
- **Thread death.** Its runs replay on other threads; in the spike, 250 runs recovered in 83–195 ms, no step lost or duplicated [spikes §2].
- **Spinning runs** stall only their own thread's runs, and only until the deadline.

**Protocol (I7):** newline-delimited JSON over the pool's private network, multiplexed by request id. Every frame from a sandbox host is untrusted: size-capped, parsed, matched to an outstanding request id and validated like a request.

| Operation | The runner sends | The sandbox host returns |
|---|---|---|
| `open` | source, input, limits | the first step's requests |
| `step` | the step's answers | new requests, or the result, plus any `h.now()`/`h.random()` values |
| `replay` | the whole history | the requests of the first step with no recorded answers |
| `close` | — | — |

The runner appends sandbox-produced `h.now()` and `h.random()` values to the history and sends them back on replay. A supervisor reaps sandbox hosts if the runner dies, and their runs replay elsewhere. The process split costs about 25 µs per step and a few milliseconds per 1,000-step replay [spikes §2], negligible next to upstream-paced steps.

### Decision 8. Durability, history, results, logs and telemetry

**Each step,** the runner (dispatching through pg-boss in its own database, as `jobs` does, and holding the run's claim and heartbeat) delivers arrived answers, takes the requests the job now waits on, checks its stop list and the run's limits, dispatches each request through the callback at the origin's pace, and appends the step (answers delivered, requests returned) to the history.

- **The history is truth; a sticky instance is a cache (I7).** After a crash, restart, eviction or move, a fresh instance replays against the history with no network calls, in milliseconds for thousands of steps [spikes §2]. Appends are batched, because a ListGen refresh starts thousands of child runs; a crash loses at most the current batch's answered-but-unflushed entries, bounded by the children-in-flight cap.
- **Requests are at-least-once;** only answers not yet in the history can repeat. `h.fetch` carries an idempotency key built from the run and the request's position, for upstreams that de-duplicate; `h.data.put` is replay-safe through its precondition. In a crash test killing runner and sandbox mid-run, the run resolved all 50 properties (301 calls) with no duplicate answered request [spikes §4].
- **The run header pins** module hash, engine build and limit settings. A resume refuses if any differs, rather than relying on replay to notice.
- **Engine upgrades drain (I10).** The pool keeps every engine build with live runs; new runs start on the newest, so a security upgrade never strands, re-bills or kills a run. An emergency upgrade that cannot wait is an explicit operator action that ends affected runs with `engine_retired`.
- **Results.** One per run: the return value, capped at 64 KiB as for every job type. A child's return value goes to its parent. Larger output goes to `shared` app-data via `h.data.put`.
- **Data writes** go through the edge with CAS, so the module service, like `jobs`, has no `app_data` grant. ADR-0045 decision 4's objection (the platform cannot supply a precondition) does not apply: the app's code supplies it.
- **The history is handled like a job result,** since it holds third-party content: only in the module service's database, readable only by the run's owner (ADR-0045's exact-owner rule, no admin override), for seven days after the run ends, then deleted within ADR-0045's cleanup bounds.
- **Logs.** `h.log` output is stored with the run, capped in size and volume, visible only to the owner, and **never written to the platform log store**, because it is untrusted text.
- **Delivery gate.** Before intake opens, the service must pass ADR-0045's common wire and signing fixtures and behavioural failure matrix, as the jobs design requires of any new job service.
- **Telemetry.** ADR-0045's rules apply. New spans: run lifecycle, replay, request dispatch, pacing, callback checks. Bounded dimensions: `appId`, module-hash prefix, request kind, stop reason, engine build; never the owner's oid. `docs/features/observability.md` is updated in the same change.

**Outcomes.** Runs use ADR-0045's poll, cancel and result routes, statuses and retention, adding these `error.code` values:

| Outcome | Status | `error.code` |
|---|---|---|
| Cancelled by the owner, stopped by an admin, or ended by archiving | `cancelled` | `cancelled` |
| Module approval revoked | `cancelled` | `approval_revoked` |
| Deadline reached | `failed` | `timeout` |
| Refused by a per-run limit | `failed` | `refused_ceiling` |
| Refused by the app's fetch budget | `failed` | `outbound_quota_exceeded`, as for `jobs:fetch` |
| Refused by the app's LLM or data budget | `failed` | `refused_budget` |
| Refused by fetch policy | `failed` | `outbound_forbidden` or `delegated_unattended`, as for `jobs:fetch` |
| Engine limit tripped (memory, stack, CPU) | `failed` | `engine_limit` |
| Replay did not match the history | `failed` | `nondeterminism` |
| Emergency engine retirement | `failed` | `engine_retired` |
| The job threw | `failed` | `job_error` |
| Platform interruption with no recovery left | `crashed` | `platform_error` |

## Security: three walls

1. **Policy: an approved job can only ask, and every ask is checked.** Nothing runs without module approval; the edge checks each request against its run record, grants, budgets and fetch policy, then meters and attributes it; per-run limits and pacing bound it further (d2–d5). _An attacker inside this wall_ gets what the app's grants and budgets allow, attributed under `jobRunId`: what its browser code could already do with a tab open.
2. **Engine: job code holds and reaches nothing, and one bug stays in one run.** No credential, network, clock or randomness; its own Wasm instance with 19 fixed imports (I1, I2, d6). _An attacker with a QuickJS memory-safety bug_ controls only their own run's instance, which they already controlled. The sandbox host needs a second bug, in V8's Wasm implementation or a host import.
3. **Platform: the pool has nothing to steal, and the runner cannot be made to lend authority.** Sandbox hosts have no identity, secrets, database or network (d7); the runner treats every frame as untrusted (I7), and the edge does not take its word for which run a request belongs to (I5). _An attacker with two chained bugs_ reaches one sandbox host and can read and disturb its runs, but cannot call anything or reach another app's grants.

Installs are patched only when a customer pulls a release (ADR-0028), so walls 2 and 3 must contain a **known, unpatched** engine bug (I8); hence the Helix-owned build and weekly upstream watch (d6).

| Attacker, shallowest first | What they get | What stops them going further |
|---|---|---|
| A misbehaving approved job | Any request within the app's grants and budgets | Module approval (d2); edge checks per request (d4); per-run limits and pacing (d5); metering and audit by `jobRunId` |
| App JavaScript starting runs the user did not intend | Runs owned by that user, with the app's authority | As for `jobs:fetch`: ADR-0045's throttle and caps, app budgets, attribution to the user, the user's cancel (d3) |
| A runaway, memory-bomb or deep-recursion job | Its own run fails; its thread's other runs wait out one deadline | Per-instance memory maximum, stack limit, uncatchable deadline; out-of-memory ends the instance (d6) |
| A QuickJS memory-safety bug (e.g. an unpatched quickjs-ng advisory) | Its own run's instance, plus the host clock, stderr and its own recorded values | One instance per run; 19 fixed imports; Helix-built engine tracking upstream master (d6) |
| A QuickJS bug plus a V8 Wasm or host-import bug | One sandbox host: co-resident runs' inputs, answers and state, and the ability to **forge answers across** them, undetectable by per-run replay. No credential or network | Pool separate from the runner, holding nothing (d7). Optional: a sandbox host per app, or Javy plus Wasmtime per step (Alternatives) |
| Escape to the node (a kernel bug) | The pool's nodes | Dedicated workload profile hosting nothing else; optional Hyper-V per run (d7) |
| A compromised sandbox host lying in its frames | Wrong answers or values for its runs | Frames capped, matched by id, validated; the runner's history is authoritative (d7, I7) |
| A compromised runner (module service) | In runs the edge accepted and has not stopped: spend within their apps' grants and budgets, and forge their answers. Cannot invent a run, reach another app, or reach the `jobs` service's store | The edge's run record (d3, I5); per-app budgets cap spend; every request attributed (d4); per-server secrets and databases (ADR-0045) |
| The owner loses access mid-run | Requests until the run finishes, is stopped or hits its deadline (24 hours by default) | The run record's deadline; owner or admin stop, enforced at the edge at once (d3) |
| Hostile log content | Text shown to the run's owner | Stored per run, capped, never in the platform log store (d8) |

**Accepted residual risks:** the double-escape, compromised-runner and owner-loses-access rows above (a sandbox host per app narrows the first to one app); approval covers the module list, not each code version, so authors can change job code without re-approval, within the app's grants and the operator's limits; an app can start a run for a signed-in user without a click, as with `jobs:fetch` today; quickjs-ng issues no CVEs, so detection depends on the weekly upstream watch (open question 2).

## Alternatives considered

### Other shapes

- **Async generators that `yield` requests.** The first form, measured by the spikes; `gen.next(answer)` keeps the protocol tiny. Same security, since isolation comes from the engine and runner, not the syntax. Replaced because developers write `await`, as Temporal's TypeScript SDK does.
- **A consent popup per run** (module, input, limits; approval creates the run record). Too heavy. The run record stays, created on submit (d3), but the user is not asked; admin approval, budgets, operator limits and edge checks bound the run.
- **Admin re-approval of job code by hash on every change.** Rejected for v1: a review step per redeploy, when grants, budgets, operator limits and per-request checks already bound any version.
- **Per-module limits in the manifest** (ceilings, rates, concurrency). Rejected for v1 in favour of operator settings (d5); addable if one deployment-wide value proves too blunt.
- **A platform "fetch campaign" job type, plan as payload (rung 0).** Good for the I/O half, which d5 keeps; rejected for control flow, because the plan language would grow into an interpreter.
- **The tab plans, the platform executes request batches.** Branching on an answer still needs an open tab; a subset of this design.
- **App modules inside the `jobs` service.** Rejected: its worker holds that server's database credentials and signing secrets beside the code it runs, and assumes trusted, cooperative handlers and a 60-minute deadline (`background-jobs-plane.md` §6). A separate service keeps stores, keys and failure domains apart, at the cost of a second deployment.
- **Jobs that do their own I/O (`await env.FETCH.fetch()`).** Needs network-level containment of a live engine and a per-run credential channel. Spiked on workerd [spikes §3]; a possible later stage needing its own ADR.
- **Running with the user's session, token or delegated authority.** Rejected; ADR-0031 stays open.
- **The status quo, browser tabs.** Kept as d1's in-tab path; fails whenever the tab does.

### Other engines

Requirements: runs the module unchanged from source; no ambient I/O, clock or randomness; enforces limits; isolation unit no wider than one app's runs; pinned build; contains one bug on an unpatched install.

**workerd** (Cloudflare's open-source Workers runtime) was spiked three times [spikes §3]. For it: Cloudflare, one of the largest builders of agent infrastructure, builds on Workers, so Helix's module format, tooling and V8 patch stream would align with that ecosystem; authors get browser V8 semantics; and jobs doing their own I/O get easier (shown in the I/O spike through a deny-by-default outbound worker). Against it:
- **No limits when self-hosted:** its enforcer is a no-op ("single-tenant policy: no limits") [spikes §3]. Limits fall to an external watchdog and cgroups, and a kill takes down every run in the process, which must then replay [spikes §3].
- **The isolation unit is a process.** Runs in one isolate share a trust domain (in the spike, one run polluted intrinsics and captured another's requests) [spikes §3]. Safe isolation needs a container per (app, owner), created at runtime per new owner, awkward under ADR-0028's "no per-app infrastructure at runtime" [spikes §3].
- **A large ambient surface, closed by hand:** a prelude must neutralise each non-deterministic global on the global object and its whole prototype chain, gated by a per-upgrade audit of 83 own and 79 inherited globals [spikes §3]. With `network = (allow = [])` alone, workerd still made a DNS lookup on any hostname the job chose [spikes §3].
- **Platform modules were reachable:** a job could import the shim and drive another run with forged answers. Mitigations were drafted, not verified [spikes §3].

QuickJS in Wasm closes that surface by construction. The price: a Helix-owned build and upstream watch (d6), and a different engine from the author's browser.

| Requirement | QuickJS in Wasm (chosen) | workerd | Javy plus Wasmtime |
|---|---|---|---|
| Isolation unit | One Wasm instance per run | One container per (app, owner) | One OS process per step |
| Limits | Inside the engine, per run | External watchdog and cgroups; a kill takes the whole process | Deterministic fuel and a memory cap, per step |
| Ambient surface | Only what the prelude installs; 19 imports | A prelude plus a per-upgrade globals audit | Javy's fixed surface |
| One bug, unpatched | Stays in its run's instance | Reaches its container's runs | Stays in its step's process |
| Patch stream | Helix-owned build; no upstream CVEs | Cloudflare's, including V8's | Bytecode Alliance's; 57 Wasmtime advisories in 2026 at the time of the spike [spikes §5] |
| Paused runs between steps | Yes (sticky) | Yes (sticky) | No: every step replays, so cost grows with the square of history length |

- **Javy plus Wasmtime:** the strongest per-step boundary, **kept as the named fallback** for threat models needing a process per step. Costs a second runtime artifact (a 60 MB CLI or a Rust sidecar) and a replay every step [spikes §1].
- **Native QuickJS** (addon or own process): faster, but one memory bug runs native code in the host, giving up the Wasm wall.
- **npm `quickjs-emscripten` builds as shipped:** behind on security fixes; memory limit fails (d6).
- **`isolated-vm`:** rejected; in maintenance mode, and its README warns leaked handles are "usually trivial" to turn into "a springboard back into the nodejs isolate".
- **Node's `vm` module:** not a security boundary, per Node's documentation.
- **Hosted engines** (Cloudflare Workers for Platforms or Workflows, Deno Subhosting): rejected under ADR-0028; code and data would leave the customer's cloud.

## Consequences

Most consequences are stated in the decisions: the new service (d7), the wider callback (d4), the edge's run record and per-run outbox records (d3), operator pacing (d5), the engine build, weekly watch, Node's patch level and the spike re-run (d6). Beyond those:

- **ADR-0020 is relaxed for one surface.** Bundles stay static; the gateway stays the only dynamic surface.
- **Engine bugs become reachable server-side for the first time;** the walls contain one without a patch.
- **The pool costs money while idle:** its dedicated workload profile bills for nodes regardless of runs. Minimum node count and size are deployment settings the install's sizing guide should cover.
- **For authors:** all I/O through `h`; no `Date`, `Math.random` or runtime imports (pure libraries are bundled in); violations fail explicitly; local checks by replaying recorded histories; one module for tab and server; no self-pacing in module runs; a different engine from the browser (small semantic differences, harder debugging).
- **`apps/docs/src/apps/jobs.md`'s** "jobs run platform-provided code only" is updated in the implementing change.

## Explicit non-goals

- **Jobs that perform their own I/O.** Every effect goes through the runner.
- **Acting as the user.** No user-scope app-data, delegated connections or user tokens.
- **Scheduled or standing runs.** Every run starts from a signed-in user's submission (open question 3).
- **Bytecode, runtime imports or a module loader.** Job modules are single bundled source files.
- **Replacing ADR-0045's platform job types.** `jobs:fetch` and its successors remain right when no app logic is involved.
- **Changing the `jobs` service.** Its limits, deadlines and stop semantics are untouched.

## Proposals awaiting a decision

Filled in by the drafting team. None is decided; each needs a Helix owners' decision before implementation.

| Proposal | Proposed value or mechanism | Why |
|---|---|---|
| Per-run request limit (d5) | 50,000 requests, children included | A ListGen refresh is about 21,000 lookups plus a few thousand public-data and app-data calls |
| Per-run history limit (d5) | 256 MiB | A history keeps whole answers without trimming. Re-measure after the spike re-run |
| Child runs in flight per run (d5) | 8, counting only a run's own children: a ListGen refresh has up to 8 groups in flight, each with up to 8 properties | The spikes' value [spikes §4]. Whether to count the whole tree instead is part of this proposal |
| How pacing holds across runner processes (d5) | Shared counters in the module service's own Postgres database, as ADR-0011's resolution did for inbound limits | ADR-0045 already gives the service a database; no Redis |
| Whether one origin's pace is shared by every app calling it (d5) | Yes: one shared pace per origin, optional per-app split | Two apps on one upstream doubled each other's run time [spikes §4] |
| Back-off on upstream 429 (d5) | Halve the pace, honour `Retry-After`, retry up to 5 times, then hand the 429 to the job | The usual additive-increase, multiplicative-decrease shape |
| Engine memory limit (d6) | 48 MiB QuickJS heap limit inside a 64 MiB `WebAssembly.Memory` maximum | The Helix build held a 32 MiB limit at 31 MiB [spikes §1] |
| Engine stack limit (d6) | 256 KiB or less | At 512 KiB or more, V8's own stack overflowed first [spikes §1] |
| CPU deadline per step (d6) | 100–250 ms | Enough for real work between requests; short enough that a spinning run stalls its thread briefly |
| Protocol frame cap (d7) | 8 MiB | The spikes' value. Must exceed the largest answer the edge can return |
| Narrowing a module to a subset of the app's grants (d2) | Optional per-module `uses` list: fetch origins and data prefixes | Lets an admin approve a module that touches less than the whole app |

## Open questions

1. **Server name and catalogue.** This ADR writes `modules`, with each manifest module as a local type. ADR-0045's catalogue is "configuration-derived", so it would advertise the service, while types come from each app's approved manifest (d2).
2. **Who watches upstream?** Who reviews quickjs-ng master weekly, and what triggers a release from a pinned commit rather than a tag?
3. **Scheduled triggers** as standing approvals ("run nightly until revoked"): decide here, or in their own ADR?
4. **Can ACA express the pool?** Dedicated workload profile, no egress, blocked identity endpoint, cgroup limits we control. If not, ACA dynamic sessions may be the v1 path.
5. **Module source size.** What is the largest job module the service accepts?
6. **Pacing for browser callers?** The same operator setting could pace the fetch proxy for every caller, not only module runs.
7. **quickjs-ng or Bellard QuickJS?** ng releases faster and runs test262 in CI; Bellard's is in OSS-Fuzz and was slightly faster in the spike [spikes §5].
8. **The out-of-memory trap.** In the glue or the engine, and does quickjs-ng master's `8e14a39` fix it? The terminal-instance rule contains it either way [spikes §1].
9. **Is the Javy plus Wasmtime fallback needed** for any customer's threat model?

## Worked example: a ListGen refresh

Illustrative, like d2's manifest syntax. ListGen keeps its properties in `shared` app-data, about 50 per group record (`aln/<group>`). A refresh confirms each against a rate-limited account-lookup API: at most **15 lookup calls** per property, stopping at the first match. The planner works in tiers, cheapest first:

| Tier | Candidates tried | Public data it needs |
|---|---|---|
| 0 | The address as listed | None |
| 1 | Spelling repairs, from the official address point | One address-point lookup |
| 2 | Other addresses on the same parcel, and on parcels with the same owner nearby | One parcel lookup |
| 3 | Addresses from affordable-housing records near the property | None: the records are bundled with the module |
| 4 | Addresses at other address points within 150 m | One address-point lookup |

**Pass 1** runs tiers 0–1 for every property; **pass 2** runs tiers 2–4 for properties still unresolved. Each group's results go to one `results/<group>` record, written only by the job. People's review decisions live in separate records the job never touches.

### The job module

`planQueries`, `matchPremise`, `checkEligibility`, `pointQuery` and `parcelQuery` are the pure planner and matcher functions ListGen already uses in the browser. The app's bundler inlines them, with `lodash-es`'s `chunk`, into this one file.

```js
// jobs/refresh.js (both imports are pure: no I/O, no Date, no Math.random)
import { chunk } from "lodash-es";
import {
  planQueries,
  matchPremise,
  checkEligibility,
  pointQuery,
  parcelQuery,
} from "../lib/planner.js";

const MAX_CALLS_PER_PROPERTY = 15; // lookup calls per property, across both passes
const GROUPS_AT_ONCE = 8;
const TIERS_BY_PASS = { 1: [0, 1], 2: [2, 3, 4] };

export default async function refresh({ refreshId, groups }, h) {
  for (const pass of [1, 2]) {
    await runPass(pass, refreshId, groups, h);
  }
  return { refreshId, groups: groups.length };
}

// Resolve every group for one pass, a few groups at a time, each group as a child run.
async function runPass(pass, refreshId, groups, h) {
  let finished = 0;
  for (const batch of chunk(groups, GROUPS_AT_ONCE)) {
    await Promise.all(batch.map((group) => h.child(resolveGroup, { refreshId, group, pass })));
    finished += batch.length;
    h.progress({ step: finished, of: groups.length, label: `Pass ${pass} of 2` });
  }
}

// One group: read its properties and this refresh's earlier results,
// resolve the properties this pass covers, then write the group's results record.
async function resolveGroup({ refreshId, group, pass }, h) {
  const aln = await h.data.get({ scope: "shared", key: `aln/${group}` });
  const prev = await h.data.get({ scope: "shared", key: `results/${group}` });
  const earlier = earlierResults(prev, refreshId);

  const todo = aln.value.properties.filter((property) => needsWork(property, pass, earlier));
  if (todo.length === 0) return 0;

  const results = await Promise.all(
    todo.map((property) =>
      h.child(resolveProperty, { property, pass, callsSoFar: callsUsed(earlier, property.id) }),
    ),
  );

  const properties = { ...earlier }; // keep earlier results, then add this pass's
  todo.forEach((property, i) => {
    properties[property.id] = results[i];
  });
  await writeResults(group, prev, { refreshId, properties }, h);
  return todo.length;
}

// One property: try this pass's tiers, cheapest first, and stop at the first match.
async function resolveProperty({ property, pass, callsSoFar }, h) {
  const tried = [];
  let calls = callsSoFar;

  for (const tier of TIERS_BY_PASS[pass]) {
    const context = await fetchPublicData(property, tier, h);
    for (const query of planQueries(property, tier, context, tried)) {
      if (calls >= MAX_CALLS_PER_PROPERTY) {
        return { resolution: "stopped_at_cap", calls, tried };
      }
      calls += 1;
      tried.push(query);

      const answer = await h.fetch({ origin: "lookup", path: "/premises/search", query });
      if (answer.status !== 200) {
        return { resolution: "lookup_failed", status: answer.status, calls, tried };
      }
      const premise = matchPremise(property, tier, answer.body);
      if (premise) {
        const eligibility = checkEligibility(premise);
        return { resolution: "candidate", premise, tier, query, calls, eligibility };
      }
    }
  }

  const resolution = pass === 1 ? "unresolved" : "not_found";
  return { resolution, calls, tried };
}

// The public data a tier's planner needs. Tiers 0 and 3 need none.
// If the lookup fails, the planner plans without it.
async function fetchPublicData(property, tier, h) {
  const request = publicDataRequest(property, tier);
  if (request === null) return null;

  const answer = await h.fetch(request);
  return answer.status === 200 ? answer.body : null;
}

function publicDataRequest(property, tier) {
  switch (tier) {
    case 1:
      return { origin: "addresses", path: "/points", query: pointQuery(property, 0) };
    case 2:
      return { origin: "parcels", path: "/parcels", query: parcelQuery(property) };
    case 4:
      return { origin: "addresses", path: "/points", query: pointQuery(property, 150) };
    default:
      return null;
  }
}

// Results from an earlier attempt at this same refresh, keyed by property id.
function earlierResults(prev, refreshId) {
  if (prev && prev.value.refreshId === refreshId) {
    return prev.value.properties;
  }
  return {};
}

// Pass 1 skips properties this refresh already settled, so a re-run resumes.
// Pass 2 takes only the properties pass 1 left unresolved.
function needsWork(property, pass, earlier) {
  const result = earlier[property.id];
  if (pass === 1) {
    return result === undefined;
  }
  return result !== undefined && result.resolution === "unresolved";
}

function callsUsed(earlier, propertyId) {
  const result = earlier[propertyId];
  return result === undefined ? 0 : result.calls;
}

// Write with a CAS precondition (ADR-0041): replace the record we read, or create it.
async function writeResults(group, prev, value, h) {
  const request = { scope: "shared", key: `results/${group}`, value };
  if (prev) {
    request.ifMatch = prev.version;
  } else {
    request.ifNoneMatch = "*";
  }
  const write = await h.data.put(request);
  if (write.status === 412) {
    throw new Error(`results/${group} changed during the refresh`);
  }
}
```

- **Nothing here waits on a timer, retries, counts a rate or saves a checkpoint.** The runner does all that; the same code also runs in the browser with the client-side driver.
- **A lookup error is an answer, not a refusal.** An upstream 5xx, or a 429 outlasting the runner's back-off, arrives as `answer.status` and becomes `lookup_failed`. A limit or budget refusal never reaches this code; it ends the run (I6).

### The manifest entry, and the operator's settings

```ts
jobs: {
  modules: {
    refresh: { path: "jobs/refresh.js" },
  },
}
```

An admin approves this once; a redeploy that only changes `jobs/refresh.js` needs no new approval (d2). ListGen's admin passes the lookup API owner's allowed pace to the Helix operator, who sets it for the `lookup` origin (d5). The app's code never mentions it.

### Starting a refresh

```js
// In the ListGen app, behind the "Start refresh" button.
async function startRefresh(refreshId, groups) {
  // One key per intended run. Resend with the same key and body only to retry a lost reply (ADR-0045).
  const submissionKey = crypto.randomUUID();
  const response = await fetch("/_api/jobs/modules/types/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": submissionKey },
    body: JSON.stringify({ refreshId, groups }), // about 100 group keys, about 5,000 properties
  });
  // { server, jobId, status }: poll, cancel and read the result with ADR-0045's routes.
  return response.json();
}
```

### What happens during the run

1. **Pass 1:** eight groups at a time, each property a child run, so no history grows long and none counts against ADR-0045's job caps (d1).
2. **Each lookup goes through the edge,** which checks the `lookup` grant and daily budget and meters the call. Egress injects the API key, which the job never sees. The runner holds the operator's pace and slows on a 429 (d5).
3. **The user closes the tab.** Nothing changes. Progress (`Pass 1 of 2`, 40 of 100 groups) is there when anyone reopens ListGen.
4. **A runner process crashes.** A fresh sandbox replays each open run from its history in milliseconds, with no lookups, and continues from the first unanswered request (d8).
5. **The daily fetch budget runs out.** The edge refuses the next lookup; the run ends `failed` with `outbound_quota_exceeded`, and ListGen shows "paused on budget". Written group records stand; tomorrow, a new run of the same refresh (a new submission, with a new key) skips every property this refresh already settled.
6. **The run finishes,** returning `{ refreshId, groups: 100 }`. The real output is the `results/` records, which ListGen's map and review queue read as today.

**Keep searching** (ListGen's button that runs the rest of one property's queries for a reviewer) needs no server run: the tab runs `resolveProperty` with the client-side driver (d1).

### What moves out of the app

| ListGen runs this in the browser today | With app-authored jobs |
|---|---|
| Batch leases in app-data, with heartbeat tokens and lease expiry judged by each tab's own clock | The runner's claim on the run |
| Rate-grant slot records, and a token bucket in each tab at a share of the total pace | The operator's pace for the origin |
| Back-off durations written to slot records so other tabs slow down too | The runner's back-off on 429 and `Retry-After` |
| Checkpoint writes in a fixed order, with a cursor per batch | The history, and replay |
| A dedicated Web Worker, so hidden-tab timer throttling does not stall the work | Nothing: the run needs no tab |
| A stall warning for when no tab holds a lease | Nothing: the run does not stall when tabs close |
| A self-imposed daily call cap, summed from per-batch counts | The per-run request limit, and the app's daily budget |

ListGen keeps its domain: planner, matcher, eligibility rules, record layout, and people's review decisions.

## Appendix: evidence

From the [engine spikes](../reviews/2026-10-28-app-jobs-engine-spikes.md), on synthetic data, mostly on a developer laptop (macOS, arm64, Docker Desktop); ACA and production hardware may differ. **Step, replay and memory figures were measured on the earlier async-generator contract** and are re-measured for the `async`-function contract before intake opens (d6).

| Claim | Figure | Spikes section |
|---|---|---|
| Starting an instance with prelude and job loaded | about 0.5–0.6 ms | §1 |
| One step, in-thread | 11–12 µs (async generator) | §1 |
| Replaying 1,000 steps | 11–12 ms in-thread; 18–19 ms across the process split | §1, §2 |
| Memory per paused run | about 0.4–0.5 MiB, plus about 24 MiB per thread | §1, §2 |
| Throughput | about 29k steps/s on one pool thread; about 100k steps/s on four threads with 1,000 paused runs | §2 |
| Process-split cost | about 25 µs per step at p50 | §2 |
| Thread-death recovery | 250 runs in 83–195 ms, with no step lost or duplicated | §2 |
| Eviction cliff | about 30× slower when the resident cap is below the working set | §2 |
| Helix build | about 20 s, byte-identical across runs, a 571 KB `.wasm` with 19 imports, passes the GHSA-m53g test | §1 |
| Memory limit | a 32 MiB limit stops bombs at 31 MiB with the Helix build; a job reached 2 GiB with the npm build | §1 |
| Runaway containment | a canary in another instance survived every probe | §1 |
| Crash test | after the runner and sandbox were both killed mid-run, the run resolved all 50 properties (301 calls) with no duplicate answered request | §4 |
| Shared upstream | two apps on one upstream doubled each other's run time | §4 |
| workerd limits | none enforced when self-hosted | §3 |
| workerd isolation | runs sharing an isolate could pollute intrinsics and capture each other's requests | §3 |
| workerd DNS | `allow = []` alone still performed host DNS lookups | §3 |
| workerd containers | about 22 MiB per container; after a SIGKILL, 20 runs recovered by replay in 14 ms | §3 |
