# 0053. App-authored jobs: app code that keeps working on the server, run in QuickJS compiled to WebAssembly

**Status:** Proposed _(2026-10-30; from the Franklin team, for review by the Helix owners)_

**Related:**
- ADR [0045](0045-app-triggered-durable-jobs-plane.md) and [`docs/design/background-jobs-plane.md`](../design/background-jobs-plane.md): the jobs plane this builds on. App-authored jobs are a **second named job service** under its 2026-10-13 amendment. The design's §6 says "blocking or uncooperative future job code needs its own isolation/execution decision"; this ADR is that decision. It supersedes ADR-0045's "app-authored job code" non-goal, for the shape defined here only.
- ADR [0020](0020-static-only-apps-v1.md): relaxed for this one surface.
- ADRs [0015](0015-app-data-three-scope-model.md), [0041](0041-app-data-write-concurrency.md) and [0042](0042-shared-prefix-grants-and-list-verb.md): the app-data a job may touch.
- ADRs [0016](0016-capability-manifest-approval-classifier.md) and [0018](0018-deploy-model-immutable-versions.md): job modules are approved like any elevated capability, and each run pins the code it started with.
- ADR [0031](0031-connection-providers-delegated-auth.md): delegated connections stay refused for unattended callers.
- ADRs [0011](0011-in-memory-rate-limiting.md) and [0021](0021-metering-ledger.md): shared counters, daily budgets and the metering ledger.
- ADRs [0012](0012-edge-portal-codeploy.md) and [0028](0028-deployment-model-customer-deployed.md): why the sandbox holds nothing, and why it must contain an engine bug on an install that has not been patched.
- `docs/design/custom-backends.md` §1 (the invariant), §2 (the isolation landscape), §3 rung 1, and §8 open question 2 (whether Wasm runtimes are a real rung-1 boundary, which this ADR answers for one workload).
- Evidence: [`docs/reviews/2026-10-28-app-jobs-engine-spikes.md`](../reviews/2026-10-28-app-jobs-engine-spikes.md), cited as `[spikes §n]`.

## Summary

Apps can write their own server-side jobs: ordinary `async` functions in the app's bundle that keep running after the tab closes.

A job never performs I/O itself. When it calls `await h.fetch(...)`, it is **asking** Helix to make the call. Helix makes it through the edge, with the same grants, budgets, metering and audit as a call from the browser. Helix records the answer in the run's **history**, and hands it back to the job. If anything crashes, Helix starts the job again in a fresh sandbox and **replays** the recorded answers until the job catches up. This is how Temporal and Azure Durable Functions work. The difference is that here the job code is untrusted.

- **Starting a run** works like `jobs:fetch` today, with no popup. An admin approves the app's job modules once, as an elevated capability. After that, a signed-in user of the app starts a run through ADR-0045's submit route, and owns it. The edge keeps a **run record** for each run it accepts, and checks every request the run makes against it.
- **A run has the app's authority, never the user's.** It uses the app's own grants and budgets. It never sees user-scope data or delegated connections.
- **The operator owns the limits:** how long a run may live (24 hours by default), how many requests it may make, and how fast each outbound origin may be called.
- **Job code runs in QuickJS compiled to WebAssembly**, built by Helix, with one Wasm instance per run, in a sandbox pool that has no credentials and no network. A single engine bug on an unpatched install reaches only its own run.

Decisions are separated from proposals. Everything under [Decision](#decision) is settled. Values and mechanisms that are still only proposed are listed in [Proposals awaiting a decision](#proposals-awaiting-a-decision).

## How a job works

This section is for a developer meeting the idea for the first time. The Decision section states the same thing precisely.

```js
// jobs/summarize.js: a job module in the app's bundle
export default async function summarize(input, h) {
  const page = await h.fetch({ origin: "news", path: `/articles/${input.id}` });
  const reply = await h.llm({ model: "small", messages: [{ role: "user", content: `Summarise: ${page.body}` }] });
  await h.data.put({ scope: "shared", key: `summaries/${input.id}`, value: reply.text, ifNoneMatch: "*" });
  return { done: true };
}
```

It reads like browser code, with one difference: every effect goes through `h`.

1. **The job asks.** `h.fetch(...)` does not open a connection. It records a request, and returns a promise.
2. **Helix does the work.** When the job has nothing left to do except wait, the sandbox hands Helix the requests it is waiting on. Helix's **runner** sends each one through the edge. The edge checks the app's grants and budgets, as it does for a browser call, and performs it.
3. **The answer is recorded, and the job continues.** The runner appends the answer to the run's history. The sandbox resolves the matching promise, and the job carries on from its `await`.
4. **After a crash, the job replays.** A fresh sandbox runs the job from the start. Each request that already has an answer in the history is resolved straight from the history, with no network call, in the order it was first answered. When the job asks for something with no recorded answer, it is live again.

Replay only works if the job does the same thing every time it is given the same answers. So a job:
- **must not read the clock or randomness directly.** `Date` and `Math.random` are not available. Use `h.now()` and `h.random()`, whose values are recorded.
- **must not keep state anywhere but its own variables.** There is no file system, no global cache and no network.

Helix checks this on every replay. A job that asks for something different from what the history says fails with `nondeterminism`, instead of silently going wrong.

Several requests can be in flight at once:

```js
const [a, b] = await Promise.all([h.fetch(reqA), h.fetch(reqB)]);
```

A long job can split its work into **child runs**, each with its own history:

```js
const results = await Promise.all(items.map(item => h.child(resolveOne, item)));
```

A full workload is in the [worked example](#worked-example-a-listgen-refresh).

## Glossary

Each word below means exactly one thing in this ADR.

| Term | Meaning |
|---|---|
| **Job module** | One ES module in the app's bundle whose default export is an `async` function `(input, h)`. Declared in the manifest. |
| **Run** | One execution of a job module. Owned by the signed-in user who started it. |
| **Child run** | A run started by another run with `h.child`. It has its own history, and belongs to its parent. |
| **Request** | A description of one effect (a fetch, an LLM call, an app-data operation, a sleep) that the job asks for. The job never performs it. |
| **Answer** | What the runner hands back to the job for a request: the upstream's or the data store's response. |
| **Refusal** | The platform declining a request (a ceiling, a budget, a revocation). Never handed to the job as an answer. |
| **Step** | One hand-off. The runner delivers one or more answers, and the job runs until it is waiting on requests only. |
| **History** | The runner's append-only record of a run's steps: each request, each answer, and each recorded value. The only source of truth for a run. |
| **Replay** | Running a job again from the start in a fresh instance, delivering answers from its history step by step, until it asks for something with no recorded answer. |
| **Module service** | The named job service (ADR-0045, 2026-10-13 amendment) that serves runs. It has two parts, the runner and the sandbox pool. This ADR calls the server `modules` (open question 1). |
| **Runner** | Trusted platform code in the module service. It performs requests, keeps histories and drives runs. |
| **Engine** | The JavaScript interpreter that executes job code: QuickJS compiled to WebAssembly. Nothing else. |
| **Instance** | One WebAssembly instance of the engine. Each run gets its own. |
| **Prelude** | Trusted platform JavaScript loaded into an instance before the job module. It installs `h` and removes what jobs must not have. |
| **Sandbox host** | A process in the sandbox pool that holds instances and answers the runner's protocol. |
| **Sandbox pool** | The set of sandbox hosts, deployed apart from the runner, with no credentials and no network. |
| **Sticky** | A run whose instance stays in memory between steps, so the next step needs no replay. |
| **Run record** | The edge's own record of a run it accepted: app, environment, owner, module hash, deadline and whether it has been stopped. Created automatically on submit. |
| **Run header** | The facts a run is pinned to when it starts: module hash, engine build, limit settings. |
| **Callback** | ADR-0045's signed jobs → edge hop, through which a job service asks the edge to perform an outbound operation. |

## Context

### What apps cannot do today

A Helix app is a static bundle (ADR-0020), and everything dynamic is a request to `/_api/*` that ends when the tab stops listening. ADR-0045 added durable background work, but only **platform-authored job types**. The first is `jobs:fetch`, one governed `GET` whose result is kept as JSON. Its implementation design runs only trusted job code, for at most 60 minutes, and excludes app code, sub-jobs and app-data writes. The app's **own logic** still cannot keep running after the tab closes.

For example:

- **ListGen** resolves a list of properties against a rate-limited account-lookup API.
  - Each property runs a small planner: the address as listed, then spelling variants, then same-parcel and nearby addresses. It stops at the first hit, under a per-property call cap.
  - A refresh is about 21,000 lookup calls and takes hours.
  - Today it runs in users' browser tabs, coordinated through app-data leases and rate-grant slots. Nothing runs unless a tab is open, and every tab carries its own rate limiter.
- **The ADR-0041/0045 pilot app.** Its LLM pipeline is ADR-0045's deferred workload. Branching on what those phases return, such as re-researching when a result is thin, is app logic.

Governed server-side jobs written by the app would set Helix apart. The logic is the app's own, but every call it causes is still checked, metered, budgeted, paced and audited by the gateway, which is what Helix already does for code running in a browser.

### The shape: the job decides, the platform does

Durable-execution systems split work in two:

- **Workflow code** is deterministic and performs no I/O. It *asks* for work.
- **An executor** performs each request, records the answer in a history, and resumes the code with the answer. After a crash, it replays the code against the history to bring it back to where it was.

This is the model behind Temporal workflows and Azure Durable Functions orchestrators. AWS Step Functions and Cloudflare Workflows have the same shape. Temporal's TypeScript SDK uses plain `async`/`await` for it, replaces `Date` and `Math.random` with replay-safe versions, and makes `WeakRef` throw. So the constraint this ADR puts on app authors is normal in this space.

In this ADR, **the app writes the workflow code, and the module service's runner is the executor.** The job code is then pure computation:
- it holds no credential;
- it reaches no network;
- it cannot exceed a budget by itself, because it never makes a call. It can only ask the runner to make one.

What is new is that the workflow code is **untrusted**. Temporal and Durable Functions run code that the operator wrote and deployed on its own workers. Their sandboxes exist for determinism, not security. Helix must treat job code as hostile.

### Why not another platform job type

ADR-0045 decision 8 tests a platform job type this way: "if the job's API mentions any noun from the pilot app's problem domain, the abstraction is wrong."

- **The I/O half of these workloads passes that test.** "Call this origin at this pace, record the answer, back off on 429" names no domain. This ADR makes the platform own that half.
- **The control-flow half cannot pass it.** ListGen's address ladder, or the pilot app's re-research rule, would have to be written as a payload. A payload expressive enough for that is a program, so the platform would end up designing, owning and securing an interpreter. Running the app's own JavaScript, with I/O taken away from it, is the honest version of the same thing.

### The constraint: untrusted code on our servers

custom-backends.md §1:

> A custom backend is just another untrusted tenant. It gets its capabilities *through* the gateway, holds no ambient cloud credentials, and the gateway stays the single choke point for identity, authz, quota, and audit.

App-written job code is untrusted tenant code running on our servers, which is rung 1 of custom-backends.md §3. It is a narrow case of rung 1:

1. **The code performs no I/O and holds no credential.** All I/O is the runner's.
2. **It serves no inbound traffic.**
3. **An admin approved the app's job modules** before any run can start.

**The attacker** is a malicious or compromised app author, or a poisoned dependency in the bundle, in an app whose job modules an admin approved. The install is single-tenant (ADR-0028), but apps distrust each other (ADR-0019), and that boundary must hold. Customers pull patches; Helix does not push them (ADR-0028). So **the design must contain a known engine bug on an install that has not been patched.**

### How others run untrusted code, and what it teaches

- **Cloudflare Workers for Platforms** is the closest prior art for the gateway shape. A platform-owned dispatch worker runs authentication and rate limiting before any tenant code, and outbound workers inject credentials so tenants never hold secrets. custom-backends.md §1 maps this onto Helix's edge and fetch proxy. Cloudflare also says plainly that V8 isolates are not a boundary on their own, and runs them behind compensating controls (custom-backends.md §2). *Lesson:* running policy before tenant code is the right seam, and an isolate needs defence in depth behind it.
- **Shopify Functions** runs untrusted third-party app JavaScript on Shopify's servers. It compiles the code to WebAssembly with Javy, a QuickJS-based toolchain that Shopify built, and runs it under hard limits, including an instruction-count cap. Each call runs to completion. *Lesson:* QuickJS in Wasm is used in production as a server-side boundary for tenant code. Shopify never pauses a run between calls, and that pausing is what this design adds.
- **Figma plugins** moved in 2019 from a JavaScript-level sandbox to "a JavaScript VM written in C and cross-compiled to WebAssembly", after a vulnerability in the earlier sandbox. quickjs-emscripten's README identifies that VM as QuickJS. Figma's sandbox runs in the user's browser, not on a server. *Lesson:* another team chose this kind of boundary after a sandbox that hid globals inside the same engine failed.
- **Temporal's TypeScript SDK** originally ran workflows in `isolated-vm`, and has since switched away from it. *Lesson:* a sandbox for determinism is not a sandbox for security; `isolated-vm` itself is now in maintenance mode (see Alternatives).

The spikes found no production system that runs **paused** QuickJS jobs for many tenants server-side [spikes §5]. That combination is new here, and the spikes are its evidence.

## Decision

### Invariants

Every part of the implementation must keep these rules. Cite them by number, for example "0053 I5".

- **I1. Job code performs no I/O.** Every effect is a request that the runner performs. (d1, d6)
- **I2. Job code has no credential, network, clock or randomness.** Time and randomness come only from `h.now()` and `h.random()`, whose values are recorded. (What a job reaches *through an engine bug* is I8's subject.) (d1, d6, d7)
- **I3. A run starts only for an app whose job modules an admin approved, and only on a signed-in user's submission.** That user owns the run. (d2, d3)
- **I4. A run never acts as the user.** It gets no user-scope data, no delegated connection and no user token. (d3)
- **I5. The edge decides from its own run record, and applies its ordinary checks.** A request is refused unless it belongs to a run the edge accepted, and that run is not stopped or past its deadline. Nothing the module service asserts can widen what a run may do. Then the app's grants, budgets, fetch policy, metering and audit apply exactly as to the app's browser calls. (d3, d4)
- **I6. A refusal is never handed to the job as an answer.** It ends the run. (d1, d5)
- **I7. The runner's history is the only source of truth.** A sandbox's state is a cache, and every frame from a sandbox is untrusted input. (d7, d8)
- **I8. One engine bug, on an unpatched install, reaches only its own run's instance**, plus what that instance's fixed imports expose (a clock, stderr and its own recorded values). It gains no credential, network or authority. Reaching another run takes a second, independent bug. (d6, d7)
- **I9. Replay is checked.** On replay, each request, each recorded value and a hash of the return value must match the history, or the run fails. (d1, d8)
- **I10. Engine upgrades drain; they never kill a live run.** An instance only ever runs on the engine build pinned in its run header. (d8)

### Decision 1. The contract: an async function that asks for every effect

An app may ship job modules in its bundle. Each is a single ES module, bundled by the app's own build with no imports, whose default export is an `async` function `(input, h)`. Its return value is the run's result.

`h` is the job's only way to affect anything. Each call below records a request and returns a promise of its answer:

| Request | What the runner does, through the edge (decision 4) | Governed by |
|---|---|---|
| `h.fetch(req)` | One fetch-proxy call, to an origin the app's manifest already allows. Origins bound to a delegated connection are refused, as for `jobs:fetch` | The app's fetch grant, `requestsPerDay`, secrets and SSRF rules (ADR-0005, ADR-0013); operator pacing (decision 5) |
| `h.llm(req)` | One LLM-gateway call | The app's model allowlist and `dollarsPerDay` |
| `h.data.get/put/list` | `shared` app-data. A `put` must carry a precondition (ADR-0041; 428 without one). `list` is ADR-0042's prefix verb | The app's data grants, `writesPerDay`, CAS |
| `h.data.append` | `collection` app-data, append only, because that scope is never readable (ADR-0015). There is no `user` scope (I4) | The app's data grants |
| `h.sleep(ms)` | A durable timer | None |
| `h.child(fn, input)` | Starts a child run of `fn` with its own history. The promise resolves to the child's return value | See below |

Three calls are not requests and return at once: `h.now()` and `h.random()` return recorded values, and `h.progress({ step, of, label })` and `h.log(text)` report progress in ADR-0045's snapshot shape, and logs for the run (decision 8).

**Answers and refusals (I6).** Whatever the upstream or the data store says is an **answer**, and the job decides what to do with it. That includes an upstream 4xx or 5xx, an upstream 429 after the runner's back-off is used up (decision 5), and a CAS `412`, which ADR-0041 expects writers to handle by retrying. When **the platform** declines a request instead (a run ceiling, an app budget, fetch policy, a revoked approval), the run ends with a visible outcome (decision 8). The job never sees an error it might mistake for data. In a spike, a daily-cap refusal delivered as an ordinary answer silently became "processed, no match" for 44 properties [spikes §4].

**Concurrency.** A job may have many requests in flight, with `Promise.all` or by starting several before awaiting any. The runner performs them concurrently, within the operator's pacing.

**Child runs.** `h.child(fn, input)` runs `fn`, an `async` function in the same module, as a child run with its own history, so that no single history grows long. ListGen uses one child per property. **A child run is part of its parent, not a job.** It has no `/_api/jobs` reference, and does not count against ADR-0045's unfinished or retained job caps (20 and 1,000 per app and environment), which a ListGen refresh, with a child per property, would otherwise exceed. Its requests count against the parent's ceilings, and the app's budgets, like any other request. The number of children a run may have in flight is a platform setting (decision 5).

**Determinism is enforced, not requested (I2, I9).** The engine exposes no `Date`, no `Math.random`, no timers and no host APIs. The runner records which answers it delivered in each step, and replay delivers the same answers in the same steps. Given the same input and the same steps, a deterministic job asks for the same requests in the same order, so promise combinators such as `Promise.race` replay correctly. On replay, the runner compares each request, each recorded value and a hash of the return value against the history. A mismatch fails the run with `nondeterminism`. That happens when the code depended on something outside its inputs. The other cause, a module that changed mid-run, is prevented by the run header (decision 8).

**The same module runs in a browser.** A small client-side driver performs the requests through `/_api/*`, as a tab does today. One job module therefore serves both an in-tab run and a durable server run. An author can also check determinism locally, by replaying a recorded history.

**Apps depend on the contract, not the engine.** As in ADR-0045 decision 2, the `async`-function-and-requests shape is what apps build against. The engine (decision 6) can change inside the module service without touching an app.

### Decision 2. The manifest lists job modules; an admin approves them once

ADR-0045's `jobs` grant gains a `modules` section. The shape below is illustrative, not final syntax:

```ts
jobs: {
  types: ["jobs:fetch"],                 // ADR-0045 platform job types, unchanged
  modules: {
    refresh: { path: "jobs/refresh.js" },   // served as the qualified type `modules:refresh`
  },
}
```

- **A module uses the app's own grants.** Its requests may reach the app's fetch origins, LLM models and `shared` and `collection` app-data, under the app's own budgets. Never more than the app has, and never user scope or delegated connections (I4). Narrowing a module to a subset of the app's grants is a [proposal](#proposals-awaiting-a-decision), not part of this decision.
- **Limits are not in the manifest.** Ceilings, pacing and concurrency belong to the operator (decision 5).
- **Approval.** `classifyChange` (ADR-0016) treats adding a module as **elevated**. An admin approves it once, like any elevated capability. Platform job types stay baseline grants under ADR-0045.
- **Code changes need no new approval.** A redeploy that changes job code but not the manifest is like any other app code change. What bounds every version of the code is the same: the app's grants and budgets, the operator's limits, and the edge's checks on every request.
- **Each run pins its module version.** The run record holds the hash of the module file in the app's live version when the run was accepted (decision 3). The module service fetches that exact source through the callback (decision 4). It keeps the source, keyed by hash, as long as any run uses it. So replay never depends on which bundle version is live, ADR-0018 rollbacks and archiving cannot strand a run, and a redeploy never changes a run already in flight.
- **Revoking the app's module approval stops its runs** (decision 3). It is the admin's kill switch.

**One of ADR-0045's rules is deliberately different for the module service.** The jobs design says granted types "must come from the installed production catalogue … never arbitrary actor names". Module names are the app's own. The admin's approval of the app's module list takes the catalogue's place.

### Decision 3. Starting, owning and stopping a run

**Starting a run works like `jobs:fetch`.** There is no consent popup. A signed-in user of the app submits with ADR-0045's ordinary route, `POST /_api/jobs/modules/types/<module>`, with the input as the JSON body and an optional `Idempotency-Key`. ADR-0045's submission throttle, retry-key rules, 64 KiB input limit and unfinished and retained caps all apply unchanged. The edge accepts only if the app's approved manifest lists the module.

**The edge keeps a run record.** Before it forwards an accepted submission, the edge writes a run record in `helix`: app, environment, owner (the user's canonical oid, ADR-0048), the module's hash in the app's live version, and the deadline. The signed submission to the module service carries the record's id, and every callback for the run names it (decision 4). A resent submission with the same `Idempotency-Key` and the same bytes finds the same record, so a lost reply is still recoverable and a retry never creates a second run. This is a deliberate departure from ADR-0045, where the edge keeps no job records. It applies to module runs only, because their code is untrusted and they can run for hours.

**Ownership** belongs to the submitting user. That means the `gateway_calls` rows, the audit trail, and the right to read results and cancel. ADR-0045's exact-owner checks on poll, result and cancel apply unchanged.

**Authority** is the app's. Helix has no per-user authorization inside an app to intersect with (ADR-0007). The user is the party the run is attributed to, not its principal.

**A run never acts as the user (I4).** It gets no user-scope app-data and no delegated connections. The user's session or refresh token is never used, stored or forwarded. ADR-0031's unattended-caller question stays open, and the default is still to refuse.

**A run stops when any of these happens:**
- it reaches its **deadline**. Every module run has one, set by the operator, **24 hours by default**. Apps cannot change it. That is longer than the `jobs` service's 60-minute bound, which the jobs design allows ("limits and execution mechanics can differ by server");
- **its owner cancels it**, with ADR-0045's cancel route;
- **an admin stops it**, from the portal;
- **an admin revokes the app's module approval**;
- **the app is archived**, as for every job (ADR-0045 lifecycle delivery).

A run does **not** stop when its owner signs out, or loses access to the app. It continues until it finishes, is stopped or reaches its deadline. This is the same as `jobs:fetch`, and is listed under residual risks.

**How a stop is enforced.** Two independent paths carry every stop:
1. **The edge refuses at once.** The run record holds the deadline, and is marked when the run is stopped: by the edge itself for the owner's cancel, and by the portal for an admin's stop, projected to the edge with the ADR-0017 pattern (sub-second). Revocation and archiving show in the app's registry projection, which the edge already checks on every callback. This path is authoritative: from then on, the run cannot cause another effect.
2. **The module service cancels.** The owner's cancel uses ADR-0045's ordinary cancel route. An admin's stop, revocation and archiving go over ADR-0045's lifecycle outbox, which retries until acknowledged. That outbox today tracks delivery per (app, generation, server), so it gains a record type keyed per run. The runner also enforces the deadline itself. It records each stop durably, and checks before it dispatches each request and before it resumes a run from `h.sleep`.

The module service has no platform-database access (ADR-0045), so a delay on the second path only wastes sandbox time. It cannot cause an effect.

### Decision 4. Every request goes through the edge

**The runner reaches the edge through ADR-0045's signed jobs → edge callback,** with that hop's whole discipline unchanged:
- each server has its own separately generated secrets for each direction, and no service holds `HELIX_INSTRUCTION_SECRET`;
- instructions are short-lived and bind the server, the operation, the resource and the body hash;
- the edge burns nonces in a dedicated table in `helix`, granted to it alone;
- the edge checks the app's registry generation before dispatch;
- the production callback refuses `dev` instructions, and the dev-gateway callback refuses `prod`;
- the edge uses one fetch-policy core for browser and job callers, so jobs never duplicate fetch policy.

This ADR widens the callback's allowlisted operations from outbound fetch to the request kinds in decision 1 (fetch, LLM and app-data), plus fetching a run's pinned module source by hash (decision 2). Each new operation gets the design's explicit-authority adapter, as fetch has, so the edge never fabricates a session. A data write's CAS precondition is part of the signed body, so it cannot be stripped in transit. One side effect is an improvement: `h.llm` goes through the real LLM gateway, so module runs get the USD ledger and `dollarsPerDay` that ADR-0045 noted its fetch-routed LLM job would lack.

**For a module run, the edge never takes authority from the callback (I5).** The callback names the run record. The edge looks it up, and refuses the callback if:
- there is no such record, or the run is stopped or past its deadline;
- the callback's claimed app, environment or owner disagrees with the record.

**Then the edge applies the same policy path as `/_api/*`:** the module is in the app's approved manifest, the request is inside the app's grants, the app's budget allows it, fetch policy allows it, and the call is metered and audited. `gateway_calls` gains a `jobRunId` column, so every call is attributed to its run. The change is additive and needs no backfill, like ADR-0021's request-path amendment.

**Job code never sees the callback credential (I2).** Only the runner holds it, and nothing in the sandbox protocol carries it.

The callback's adversarial tests are extended **in the same change** with module cases: an unknown, stopped or expired run; a mismatched app, environment or owner; a module not in the approved manifest; an archived app; a request outside the app's grants; a request over budget; and a data write without a precondition.

### Decision 5. The operator owns the limits

Apps declare no limits. Every limit on a module run is either an existing app budget or an operator setting.

**The app's existing daily budgets apply unchanged:** `requestsPerDay` for fetch, `dollarsPerDay` for the LLM, and `writesPerDay` for app-data. The edge enforces them on every request (decision 4), block-new and finish-in-flight as today.

**Per-run limits are operator settings,** one value per deployment, which apps cannot change:
- the **deadline** (24 hours by default; decision 3);
- the most **requests** one run may make, children included;
- the largest **history** one run may keep;
- the most **child runs in flight** per run.

The runner enforces them before dispatch, so nothing overshoots. The defaults other than the deadline are [proposals](#proposals-awaiting-a-decision).

**Pacing is new, and it is the operator's.** Helix today has daily budgets but no pacing: nothing limits how fast an app calls an upstream. Module runs get it:
- **The operator sets a pace for an origin**, as calls per second. An origin with no pace set is unpaced, and only the daily budget limits it.
- **The runner paces every module-run request** to that origin, and the pace holds across runner processes. ADR-0045's rolling deployments briefly run two workers, so a per-process limiter would double the rate.
- **On an upstream 429, the runner slows down** and honours `Retry-After`, then retries. When its retries are used up, the 429 is handed to the job as an answer (decision 1).

The mechanism, and whether one pace is shared by every app calling an origin, are [proposals](#proposals-awaiting-a-decision). In a spike, two apps sharing one upstream doubled each other's run time [spikes §4].

**ADR-0045's capacity controls apply** to module runs as to any job: the submission throttle, and the unfinished and retained caps. Child runs are part of their parent, and are not counted there (decision 1).

### Decision 6. The engine: QuickJS compiled to WebAssembly, one instance per run, built by Helix

**Why this engine.** A job does no I/O, so its engine needs no Web APIs and no bindings: only ECMAScript over JSON. That makes the smallest available boundary practical. In a QuickJS Wasm instance, guest objects hold no references to host objects. The instance reaches the host only through a short, fixed list of imports: 19 in the Helix build, covering abort and assert, a clock, heap resize, stdout and stderr, and the glue's callbacks, with no file or socket imports [spikes §1]. A QuickJS memory-safety bug therefore corrupts only that instance's own memory. Reaching anything else takes a **second, independent** bug, in V8's WebAssembly implementation or in one of those imports (I8).

**One instance per run, never shared.** A shared instance would expose every run's heap to a single QuickJS bug, and turn one run's fault into everyone's.

**Loading.** The sandbox host creates a fresh instance, loads the prelude, then loads the job module's **source**. It never accepts bytecode, because quickjs-ng treats untrusted bytecode as equivalent to untrusted native code [spikes §5]. No module loader is installed, so job code cannot import anything, including platform code.

**Running a step.** The sandbox delivers the step's answers by resolving the matching promises, then runs QuickJS's pending-job queue until it is empty. Whatever requests are then outstanding are the step's output. The engine never waits on anything outside itself.

**Ambient API (I2).** The job gets ECMAScript built-ins only:
- `Date` is not installed, and `Math.random` throws.
- There are no timers, `console`, `WebAssembly`, `Atomics`, `WeakRef` or `FinalizationRegistry`.
- `h` is frozen, and the prelude deletes its own globals before the job loads.

The spike found no source of non-determinism at a fixed configuration [spikes §1]. The configuration-dependent sources (memory cap, stack limit, engine build) are pinned in the run header (decision 8). On every engine upgrade, the list of reachable globals is checked against an allowlist, and any change blocks the upgrade.

**Limits are enforced inside the engine, per run.** The mechanisms are decided. The values are [proposals](#proposals-awaiting-a-decision) from the spikes.

| Limit | Mechanism | What a tripped limit takes down |
|---|---|---|
| Memory | The QuickJS heap limit, plus a hard `WebAssembly.Memory` maximum per instance, which is the guarantee | The run. **Any out-of-memory error ends the instance.** It is dropped without another call into it, because a runtime that has run out of memory can trap on later calls [spikes §1] |
| Stack | A QuickJS stack limit, kept below the point where V8's own stack overflows first [spikes §1] | The run. Any host-level fault discards the instance |
| CPU per step | A QuickJS interrupt deadline. Job code cannot catch it, and it also stops regex backtracking | The run. Other runs on the same thread wait out the deadline (decision 7) |

In the spike, a runaway or memory-bomb job stopped only its own run, and a canary run in another instance survived every probe [spikes §1].

**Helix builds the engine.** The npm `quickjs-emscripten` builds are unsuitable [spikes §1]:
- they bundle quickjs-ng v0.12.1, five or more releases behind, and upstream's regression test for the critical GHSA-m53g-qx47-3h38 crashes both of them;
- their memory limit does not hold: a 32 MiB limit let a job reach 2 GiB.

Helix CI therefore builds quickjs-ng to Wasm from these inputs:
- a pinned, sha256-checked quickjs-ng release amalgam (v0.17.0 at the time of writing), or a pinned master commit when an unreleased memory-safety fix is needed;
- quickjs-emscripten's C glue at a pinned commit, plus a Helix patch of about 40 lines;
- `emcc` from the `emscripten/emsdk` image, pinned by digest;
- no quickjs-libc, so there are no `std` or `os` modules.

The build is reproducible, passes the GHSA-m53g regression test, and its memory limit holds [spikes §1]. Every engine bump must pass a release suite: the smoke job, the memory bombs, the CPU-interrupt and stack probes, the out-of-memory probe, the globals allowlist, the Wasm import list, and upstream's security regression tests. Each release records the upstream tag or commit, the amalgam sha256, the emsdk digest and the `.wasm` sha256.

**The standing cost, stated plainly.** Since 2026-10-11, quickjs-ng accepts no private security reports and issues no CVEs. Its fixes land on master weeks before a release [spikes §5]. So a scanner will never tell a customer they are exposed, and:
- the module service's owner reviews quickjs-ng's master commits at least weekly;
- when a memory-safety fix lands, the owner rebuilds from a pinned commit;
- engine rebuilds ship as flagged security releases, named in the release notes and the deployment catalogue (ADR-0036).

The estimated effort is about half a day per routine upstream release. It is one to three days when the C API or emsdk breaks, which happened once in the five releases from 0.12.1 to 0.17.0 [spikes §1].

**Node's patch level becomes part of the boundary,** because V8 runs the Wasm.

**The spikes measured an earlier form of the contract,** in which jobs were async generators that `yield`ed requests. The isolation, limit and build findings do not depend on that form. The step, replay and memory figures do, and must be re-measured with the `async`-function contract before the module service opens intake (Consequences).

### Decision 7. The module service: a runner, and a sandbox pool that holds nothing

**The module service is a second named job service under ADR-0045**, with everything that amendment gives a server:
- its own private database and runtime and migration roles, with no access to `helix` or to the `jobs` database;
- its own three directional secrets;
- its own lifecycle-outbox target;
- deployment-optional intake.

Unlike `jobs`, it has **two images**:

- **The runner** holds the service's database credentials and callback signing key. It drives runs, keeps histories and performs requests through the callback.
- **The sandbox pool** runs job code and holds nothing worth stealing:
  - no managed identity, so there is no `IDENTITY_ENDPOINT` to mint tokens from;
  - no Key Vault access, no database access and no mounted secrets;
  - **no outbound network**, enforced at the network layer. The pool accepts inbound connections only from the runner, and opens none. The cloud metadata and identity endpoints are blocked at that layer as well (custom-backends.md §4).

The pool is declared in Bicep on its own ACA workload profile, so its nodes host nothing else. Each sandbox host runs with cgroup CPU and memory limits, a read-only root filesystem, all capabilities dropped, `no-new-privileges`, and a non-root user. A deployment can optionally harden further with ACA dynamic sessions (Hyper-V) per run, or with a sandbox host per app.

**Inside a sandbox host.** A router runs on the main thread, with N `worker_threads` sized to the cgroup's cores.
- **Placement.** A run's instance lives on exactly one thread, because V8 cannot move a `WebAssembly.Memory` between threads. Moving a run therefore means replaying it. New and replayed runs go to the least-loaded thread.
- **Eviction.** Idle instances are evicted under a per-thread cap and replayed on their next step. The cap must cover the active working set.
- **Thread death.** If a thread dies, its runs replay on other threads. In the spike, 250 runs recovered in 83–195 ms with no step lost or duplicated [spikes §2].
- **Spinning runs.** A spinning run stalls only the runs on its own thread, and only until the deadline.

**The protocol (I7).** The runner talks to sandbox hosts over the pool's private network, using newline-delimited JSON multiplexed by request id, with a cap on frame size.

| Operation | The runner sends | The sandbox host returns |
|---|---|---|
| `open` | source, input, limits | the first step's requests |
| `step` | the step's answers | the new requests, or the result, plus any `h.now()`/`h.random()` values |
| `replay` | the whole history | the requests of the first step with no recorded answers |
| `close` | — | — |

- **Every frame from a sandbox host is untrusted input.** It is size-capped, parsed, matched to an outstanding request id, and validated like a request.
- **Recorded values** from `h.now()` and `h.random()` are produced in the sandbox. The runner appends them to the history and sends them back on replay.
- **A supervisor reaps sandbox hosts** if the runner dies, and their runs replay elsewhere.

Splitting the runner and the sandbox into separate processes costs about 25 µs per step, and a few milliseconds per 1,000-step replay [spikes §2]. That is negligible next to steps paced by an upstream.

### Decision 8. Durability, history, results, logs and telemetry

**A step, from the runner's side.** The runner dispatches through pg-boss in its own database, as the `jobs` service does, and holds the run's claim and heartbeat. For each step it:
1. delivers the answers that have arrived to the job;
2. takes the requests the job is now waiting on;
3. checks its stop list and the run's limits, then dispatches each request through the callback, at the origin's pace;
4. appends the step (which answers were delivered, and which requests came back) to the history.

**The history is the source of truth, and a sticky instance is only a cache (I7).** After a crash, a restart, an eviction or a move, a fresh instance replays the job against its history. Replay makes no network calls, and costs milliseconds for thousands of steps [spikes §2]. History appends are batched, because a ListGen refresh starts thousands of child runs. A crash therefore loses at most the answered-but-unflushed entries of the current batch, and the cap on children in flight bounds that number.

**Requests are at-least-once.** Only answers not yet in the history can repeat.
- `h.fetch` carries an idempotency key built from the run and the request's position, so an upstream that supports one can de-duplicate.
- `h.data.put` is safe under replay because of its precondition.

In a crash test that killed both the runner and the sandbox mid-run, the run recovered and resolved all 50 of its properties (301 calls) with no duplicate answered request [spikes §4].

**The run header pins** the module hash, the engine build and the limit settings. A resume refuses to proceed when any of them differs, rather than relying on replay to notice.

**Engine upgrades drain; they do not kill (I10).** The pool keeps each engine build that still has live runs, and new runs start on the newest build. A security upgrade therefore never strands, re-bills or kills an in-flight run. An emergency upgrade that cannot wait is an explicit operator action. It ends the affected runs with a visible `engine_retired` outcome.

**Outcomes on the job surface.** A run is polled, cancelled and has its result read through ADR-0045's routes, with ADR-0045's statuses and retention. Module runs add these `error.code` values:

| Outcome | Status | `error.code` |
|---|---|---|
| Cancelled by the owner, stopped by an admin, or ended by archiving | `cancelled` | `cancelled` |
| The app's module approval revoked | `cancelled` | `approval_revoked` |
| Reached its deadline | `failed` | `timeout` |
| A request refused by a per-run limit | `failed` | `refused_ceiling` |
| A request refused by the app's fetch budget | `failed` | `outbound_quota_exceeded`, as for `jobs:fetch` |
| A request refused by the app's LLM or data budget | `failed` | `refused_budget` |
| A request refused by fetch policy | `failed` | `outbound_forbidden` or `delegated_unattended`, as for `jobs:fetch` |
| An engine limit tripped (memory, stack, CPU) | `failed` | `engine_limit` |
| Replay did not match the history | `failed` | `nondeterminism` |
| Ended by an emergency engine retirement | `failed` | `engine_retired` |
| The job threw | `failed` | `job_error` |
| Lost to a platform interruption with no recovery left | `crashed` | `platform_error` |

**Results.** A run has one result: the job's return value, capped at 64 KiB as for every job type. A child run's return value goes to its parent, not to the app. A job whose output is larger writes it to `shared` app-data with `h.data.put`.

**Data writes** go through the edge with CAS, so the module service, like `jobs`, has no `app_data` grant. ADR-0045 decision 4 objected that the platform cannot supply a precondition. That objection does not apply here, because the app's code supplies it.

**The history is handled like a job result.** It holds third-party content (upstream responses, LLM replies), so:
- it lives only in the module service's database;
- it is readable only by the run's owner, under ADR-0045's exact-owner rule, with no admin override;
- it follows the result's retention: readable for seven days after the run ends, then deleted within ADR-0045's cleanup bounds.

**Logs.** `h.log` output is stored with the run, capped in size and volume, and visible only to the run's owner. It is **never written to the platform log store**, because it is untrusted text.

**Delivery gate.** As the jobs design requires of any new job service, the module service must pass ADR-0045's common wire and signing fixtures and its behavioural failure matrix before it opens intake.

**Telemetry.** ADR-0045's telemetry rules apply. New spans cover run lifecycle, replay, request dispatch, pacing and callback checks. Dimensions are bounded: `appId`, a prefix of the module hash, the request kind, the stop reason and the engine build. The owner's oid is never a dimension. `docs/features/observability.md` is updated in the same change.

## Security: three walls

The design puts three independent walls between a hostile job and anything worth having. Each is described by what it removes, and by what an attacker who gets past it still holds.

**Wall 1: policy. An approved job can only ask, and every ask is checked.**
- Nothing runs unless an admin approved the app's job modules (d2).
- Even then, the job performs nothing itself. Every request goes from the runner to the edge, which checks it against its own run record, then the app's grants, budgets and fetch policy, then meters it and attributes it to the run (d3, d4). The operator's per-run limits and pacing bound it further (d5).

*An attacker who stays inside this wall* gets what the app's own grants and budgets allow, attributed under `jobRunId`. That is what the same app's browser code could already do while a tab was open.

**Wall 2: the engine. Job code holds nothing and reaches nothing, and one bug stays in one run.**
- The code has no credential, no network, no clock and no randomness (I1, I2).
- It runs in its own Wasm instance, with 19 fixed imports (d6).

*An attacker with a QuickJS memory-safety bug* controls only their own run's instance, which they already controlled. Reaching the sandbox host takes a second, independent bug, in V8's Wasm implementation or in a host import.

**Wall 3: the platform. The pool has nothing to steal, and the runner cannot be made to lend authority.**
- A sandbox host has no identity, no secrets, no database and no network (d7).
- The runner does hold credentials, but it treats every sandbox frame as untrusted (I7), and the edge does not take the runner's word for which run a request belongs to (I5).

*An attacker with two chained bugs* reaches one sandbox host. They can read and disturb the runs on it, but they cannot call anything, and cannot reach another app's grants.

**Why the walls must hold without a patch.** Helix installs are patched only when a customer pulls a release (ADR-0028). Walls 2 and 3 are therefore designed to contain a **known, unpatched** engine bug (I8). This is also why Helix owns the engine build and watches upstream weekly (d6).

| Attacker, from shallowest to deepest | What they get | What stops them going further |
|---|---|---|
| A misbehaving approved job | Any request within the app's grants and budgets | Module approval (d2); the edge's checks on every request (d4); per-run limits and pacing (d5); metering and audit by `jobRunId` |
| App JavaScript starting runs the user did not intend | Runs owned by that user, with the app's authority | The same bound as any `jobs:fetch` submission: ADR-0045's throttle and caps, the app's budgets, attribution to the user, and the user's cancel (d3) |
| A runaway, memory-bomb or deep-recursion job | Its own run fails; other runs on its thread wait out one deadline | A memory maximum, stack limit and uncatchable deadline per instance; out-of-memory ends the instance (d6) |
| A QuickJS memory-safety bug, such as an unpatched quickjs-ng advisory | Its own run's instance, plus the host clock, stderr and its own recorded values | One instance per run; 19 fixed imports; a Helix-built engine tracking upstream master (d6) |
| A QuickJS bug plus a V8 Wasm or host-import bug | One sandbox host: co-resident runs' inputs, answers and state, and the ability to **forge answers across** those runs, which per-run replay cannot detect. No credential, no network | The pool is separate from the runner and holds nothing (d7). Optional: a sandbox host per app, or Javy plus Wasmtime per step (Alternatives) |
| Escape to the node (a kernel bug) | The pool's nodes | A dedicated workload profile that hosts nothing else; optional Hyper-V per run (d7) |
| A compromised sandbox host lying in its frames | Wrong answers or values for the runs it hosts | Frames are capped, matched to their id and validated; the runner's history is authoritative (d7, I7) |
| A compromised runner (module service) | Within runs the edge accepted and has not stopped: it can spend within their apps' grants and budgets and forge the answers their jobs see. It cannot invent a run, reach another app, or reach the `jobs` service's store | The edge's run record (d3, I5); per-app budgets cap spend; every request is attributed (d4); ADR-0045 gives each server its own secrets and database |
| The owner loses access mid-run | Requests until the run finishes, is stopped or reaches its deadline (24 hours by default) | The deadline in the run record; a stop by the owner or an admin, enforced at the edge at once (d3) |
| Hostile log content | Text shown to the run's owner | Stored per run, capped, never in the platform log store (d8) |

**Known residual risks.** These are accepted. They are named here so that nobody mistakes them for gaps:
- A double escape can forge answers between runs on the same sandbox host. A sandbox host per app narrows this to one app's runs.
- A compromised module service can spend within runs the edge accepted, but cannot invent or widen them.
- Approval covers the module list, not each version of the code. An app author can change job code without re-approval, within the app's grants and the operator's limits.
- An app can start a run for a signed-in user without that user clicking anything, as it can submit a `jobs:fetch` job today.
- A run can continue for up to its deadline after its owner loses access.
- quickjs-ng issues no CVEs, so how quickly Helix learns of exposure depends on the weekly upstream watch (open question 2).

## Alternatives considered

### Other shapes

- **Jobs as async generators that `yield` requests.** This was the first form, and the one the spikes measured. The runner advances the job one request at a time with `gen.next(answer)`, which keeps the sandbox protocol very small. It gives exactly the same security as `async` functions, because isolation comes from the engine and the runner, not from the syntax. It was replaced because `await` is what developers already write, and what Temporal's TypeScript SDK uses.
- **A consent popup for every run.** A platform-rendered popup would show the module, its input and its limits, and the user's approval would create the run's record. Rejected as too heavy. The run record stays, created automatically on submit (d3), but the user is not asked: starting a module run now works like submitting `jobs:fetch`, and the admin's approval, the app's budgets, the operator's limits and the edge's checks bound what a run can do.
- **An admin re-approves job code by hash on every change.** Rejected for v1: it adds a review step to every redeploy, while the app's grants and budgets, the operator's limits and the edge's per-request checks already bound what any version of the code can do.
- **Limits declared per module in the manifest** (ceilings, rates, concurrency). Rejected for v1 in favour of operator settings (d5). It can be added later if one deployment-wide value proves too blunt.
- **A platform "fetch campaign" job type, with the plan as payload (rung 0).** It handles the I/O half well, and decision 5 keeps that part. It was rejected for the control-flow half, because the plan language would grow into an interpreter.
- **The tab plans, the platform executes.** The planner stays in the browser, and only request batches become durable platform work. Any branching on an answer still needs an open tab. This is a subset of this design, not an alternative to it.
- **Run app modules inside the existing `jobs` service.** Rejected: its worker process holds that server's database credentials and signing secrets, alongside the code it runs, and its design assumes trusted, cooperative handlers and a 60-minute deadline (`background-jobs-plane.md` §6). A separate named service keeps the two stores, keys and failure domains apart, at the cost of a second deployment.
- **Jobs that do their own I/O (`await env.FETCH.fetch()`).** This needs network-level containment of a live engine, and a credential channel for each run. It was spiked on workerd [spikes §3], and is recorded as a possible later stage that would need its own ADR.
- **Running with the user's session, token or delegated authority.** Rejected; ADR-0031 stays open.
- **The status quo: browser tabs.** It is kept as the in-tab path of decision 1. It fails whenever the tab does.

### Other engines

Every candidate was held to the same requirements:
- it runs the module unchanged, from source;
- it has no ambient I/O, clock or randomness;
- it enforces limits;
- its isolation unit is no wider than one app's runs;
- its build is pinned;
- it contains one bug on an unpatched install.

**workerd, Cloudflare's open-source Workers runtime, was looked at seriously, and was spiked three times** [spikes §3]. The case for it is real:
- Cloudflare is one of the largest companies building agent infrastructure, and it builds it on Workers. Choosing workerd would align Helix's module format, tooling and V8 patch stream with that ecosystem.
- Authors get the same V8 semantics as in their browser.
- It leaves an easier path to jobs that do their own I/O. The I/O spike showed that working through a deny-by-default outbound worker.

It was not chosen, because for this design the spikes found the following:
- **Self-hosted workerd enforces no limits.** Its limit enforcer is a no-op ("single-tenant policy: no limits") [spikes §3]. Every limit falls to an external watchdog and cgroups, and a kill takes down every run in the process, which then has to replay [spikes §3].
- **The isolation unit is a process, not an instance.** Runs in one isolate form one trust domain: in the spike, one run polluted intrinsics and captured another's requests [spikes §3]. Safe isolation needs a container per (app, owner), created at runtime for each new owner. That sits awkwardly with ADR-0028's posture of "no per-app infrastructure at runtime" [spikes §3].
- **The ambient surface is large and must be closed by hand.** A prelude must neutralise each non-deterministic global, on the global object and on every prototype in its chain. A per-upgrade audit of 83 own and 79 inherited globals gates that [spikes §3]. With `network = (allow = [])` alone, workerd still made a DNS lookup on any hostname the job chose [spikes §3].
- **Platform modules were reachable from job code.** A job could import the shim and drive another run with forged answers. Mitigations were drafted but not verified [spikes §3].

QuickJS in Wasm closes the same surface by construction. An instance has only what the prelude installs and 19 fixed imports, and its limits are inside the engine. The price is that Helix owns a build and an upstream watch (d6), and that authors run on a different engine from their browser.

| Requirement | QuickJS in Wasm (chosen) | workerd | Javy plus Wasmtime |
|---|---|---|---|
| Isolation unit | One Wasm instance per run | One container per (app, owner) | One OS process per step |
| Limits | Inside the engine, per run | An external watchdog and cgroups; a kill takes the whole process | Deterministic fuel and a memory cap, per step |
| Ambient surface | Only what the prelude installs; 19 imports | A prelude plus a per-upgrade globals audit | Javy's fixed surface |
| One bug, unpatched | Stays in its run's instance | Reaches its container's runs | Stays in its step's process |
| Patch stream | A Helix-owned build; no upstream CVEs | Cloudflare's, including V8's | The Bytecode Alliance's; 57 Wasmtime advisories in 2026 at the time of the spike [spikes §5] |
| Paused runs between steps | Yes (sticky) | Yes (sticky) | No: every step replays, so cost grows with the square of the history length |

- **Javy plus Wasmtime** is the strongest per-step boundary, and is **kept as the named fallback** for a deployment whose threat model needs a process per step. It costs a second runtime artifact (a 60 MB CLI or a Rust sidecar), and a replay on every step [spikes §1].
- **Native QuickJS**, as an addon or its own process, is faster. But a single QuickJS memory bug would then run native code in the host, which gives up the Wasm wall that justifies the engine.
- **The npm `quickjs-emscripten` builds as shipped** are behind on security fixes, and their memory limit does not hold (d6).
- **`isolated-vm` inside Node.** Rejected: it is in maintenance mode, and its README warns that leaked handles are "usually trivial" to turn into "a springboard back into the nodejs isolate".
- **Node's `vm` module** is not a security boundary, and Node's documentation says so.
- **Hosted engines** (Cloudflare Workers for Platforms or Workflows, Deno Subhosting). Rejected under ADR-0028, because code and data would leave the customer's cloud.

## Consequences

**For the platform:**
- **ADR-0020 is relaxed for one surface.** App-written code runs server-side, as jobs that do no I/O. Bundles stay static, and the gateway stays the only dynamic surface.
- **Engine bugs become reachable server-side for the first time.** The walls are built to contain one without a patch (Security).
- **ADR-0045 gains a second named job service** with two images, the runner and the sandbox pool. The `jobs` service is unchanged.
- **The jobs → edge callback grows** from outbound fetch to fetch, LLM and app-data operations, plus module source by hash (d2, d4).
- **The edge keeps a run record per module run** (d3). ADR-0045's edge keeps no job records, so this is a departure, for module runs only.
- **ADR-0045's lifecycle outbox gains per-run stop records** (d3).
- **Helix gains outbound pacing,** for module runs, set by the operator (d5). Browser callers are unchanged.
- **The engine spikes are re-run with the `async`-function contract** before the module service opens intake (d6).
- **The pool costs money while idle.** A dedicated workload profile bills for its nodes whether or not any runs exist. The minimum node count and size are deployment settings, and the install's sizing guide should cover them.

**For app authors:**
- **A job is an `async` function that does all I/O through `h`.** No `Date`, no `Math.random`, no imports. Violations fail explicitly, and a module can be checked locally by replaying recorded histories.
- **One job module serves a tab and the server** (d1).
- **Apps stop pacing their own outbound calls** in module runs. The operator sets the pace (d5).
- **Job code runs on a different engine from the browser.** The semantic differences are small, but debugging is harder.
- **`apps/docs/src/apps/jobs.md` changes.** Its statement that "jobs run platform-provided code only" is updated in the change that implements this ADR.

**For operations:**
- **Operators own the module limits:** the deadline, per-run limits and per-origin pacing (d5).
- **Helix owns an engine build** and its release suite (d6).
- **Someone watches quickjs-ng's master weekly,** and engine rebuilds ship as flagged security releases.
- **Node's patch level is part of the boundary,** because V8 runs the Wasm.

## Explicit non-goals

- **Jobs that perform their own I/O.** Every effect goes through the runner.
- **Acting as the user.** There are no user-scope app-data, delegated connections or user tokens.
- **Scheduled or standing runs.** Every run starts from a signed-in user's submission (open question 3).
- **Bytecode, imports or a module loader.** Job modules are single bundled source files.
- **Replacing ADR-0045's platform job types.** `jobs:fetch` and its successors remain the right tool when no app logic is involved.
- **Changing the `jobs` service.** Its limits, deadlines and stop semantics are untouched.

## Proposals awaiting a decision

These are values and mechanisms the drafting team filled in. None is decided. Each needs a decision from the Helix owners before implementation.

| Proposal | Proposed value or mechanism | Why it is proposed |
|---|---|---|
| Per-run request limit (d5) | 50,000 requests, children included | A ListGen refresh is about 21,000 lookups plus a few thousand public-data and app-data calls |
| Per-run history limit (d5) | 256 MiB | Without trimming, a history keeps whole answers. Re-measure once the spike is re-run |
| Child runs in flight per run (d5) | 8 | The value the spikes ran with [spikes §4] |
| How pacing holds across runner processes (d5) | Shared counters in the module service's own Postgres database, as ADR-0011's resolution did for inbound limits | ADR-0045 already gives the service a database; no Redis |
| Whether one origin's pace is shared by every app calling it (d5) | Yes: one pace per origin, shared, with an optional per-app split | Two apps on one upstream doubled each other's run time [spikes §4] |
| Back-off on upstream 429 (d5) | Halve the pace, honour `Retry-After`, retry up to 5 times, then hand the 429 to the job | The usual additive-increase, multiplicative-decrease shape |
| Engine memory limit (d6) | A 48 MiB QuickJS heap limit, inside a 64 MiB `WebAssembly.Memory` maximum | The Helix build held a 32 MiB limit at 31 MiB [spikes §1] |
| Engine stack limit (d6) | 256 KiB or less | At 512 KiB or more, V8's own stack overflowed first [spikes §1] |
| CPU deadline per step (d6) | 100–250 ms | Long enough for real work between requests; short enough that a spinning run stalls its thread briefly |
| Protocol frame cap (d7) | 8 MiB | The value the spikes ran with. It must exceed the largest answer the edge can return |
| Narrowing a module to a subset of the app's grants (d2) | An optional `uses` list per module: fetch origins and data prefixes | Lets an admin approve a module that touches less than the whole app |

## Open questions

1. **The server name, and how modules appear in the catalogue.** This ADR writes `modules`, with each manifest module as a local type. ADR-0045's catalogue is "configuration-derived", so it would advertise the service itself, while the types come from each app's approved manifest (d2).
2. **Who watches upstream?** Who on the Helix team reviews quickjs-ng's master each week, and what triggers a release from a pinned commit rather than a tag?
3. **Scheduled triggers,** as standing approvals ("run nightly until revoked"). Should they be decided here, or in their own ADR?
4. **Can ACA express the pool?** It needs a dedicated workload profile, a pool with no egress, a blocked identity endpoint and cgroup limits we control. If it can't, ACA dynamic sessions may be the v1 path.
5. **Module source size.** What is the largest job module the service accepts?
6. **Should pacing also cover browser callers?** This ADR adds it for module runs only. The same operator setting could pace the fetch proxy for every caller.
7. **quickjs-ng or Bellard QuickJS?** ng releases faster and runs test262 in CI. Bellard's is in OSS-Fuzz, and was slightly faster in the spike [spikes §5].
8. **The out-of-memory trap.** Is it in the glue or in the engine, and does quickjs-ng master's `8e14a39` fix it? The terminal-instance rule contains it either way [spikes §1].
9. **Is the Javy plus Wasmtime fallback needed** for any customer's threat model?

## Worked example: a ListGen refresh

This section shows one real workload end to end. It is illustrative, like the manifest syntax in decision 2.

**The workload.** ListGen keeps a list of properties in `shared` app-data, about 50 properties to a group record (`aln/<group>`). A refresh confirms each property against a rate-limited account-lookup API. Each property gets at most **15 lookup calls**, and stops at its first match. The address planner works in tiers, cheapest first:

| Tier | Candidates tried | Public data it needs |
|---|---|---|
| 0 | The address as listed | None |
| 1 | Spelling repairs, from the official address point | One address-point lookup |
| 2 | Other addresses on the same parcel, and on parcels with the same owner nearby | One parcel lookup |
| 3 | Addresses from affordable-housing records near the property | None: the records are bundled with the module |
| 4 | Addresses at other address points within 150 m | One address-point lookup |

A refresh makes two **passes**. Pass 1 runs tiers 0–1 for every property. Pass 2 runs tiers 2–4, only for properties still unresolved after pass 1. Results go to one `results/<group>` record per group, and the job is the only writer of those records. People's review decisions live in separate records that the job never touches.

### The job module

The app's build bundles this file with the planner and matcher it already uses in the browser. `planQueries`, `matchPremise`, `checkEligibility`, `pointQuery` and `parcelQuery` are those pure functions. None of them performs I/O.

```js
// jobs/refresh.js
const CAP = 15;          // lookup calls per property, per refresh
const GROUPS_AT_ONCE = 8;

export default async function refresh({ refreshId, groups }, h) {
  for (const pass of [1, 2]) {
    let done = 0;
    for (const chunk of chunks(groups, GROUPS_AT_ONCE)) {
      await Promise.all(chunk.map(group => h.child(resolveGroup, { refreshId, group, pass })));
      done += chunk.length;
      h.progress({ step: done, of: groups.length, label: `Pass ${pass} of 2` });
    }
  }
  return { refreshId, groups: groups.length };
}

// One group: read its properties and earlier results, resolve what is left, write one record.
async function resolveGroup({ refreshId, group, pass }, h) {
  const aln = await h.data.get({ scope: "shared", key: `aln/${group}` });
  const prev = await h.data.get({ scope: "shared", key: `results/${group}` });
  const before = prev?.value.refreshId === refreshId ? prev.value.properties : {};

  // Pass 1 skips properties this refresh already settled, so a re-run after a stop resumes.
  const todo = aln.value.properties.filter(p =>
    pass === 1 ? !before[p.id] : before[p.id]?.resolution === "unresolved");
  if (todo.length === 0) return 0;

  const found = await Promise.all(todo.map(p =>
    h.child(resolveProperty, { property: p, pass, used: before[p.id]?.calls ?? 0 })));

  const properties = { ...before };
  todo.forEach((p, i) => { properties[p.id] = found[i]; });
  const write = await h.data.put({
    scope: "shared", key: `results/${group}`,
    value: { refreshId, properties },
    ...(prev ? { ifMatch: prev.version } : { ifNoneMatch: "*" }),      // CAS (ADR-0041)
  });
  if (write.status === 412) throw new Error(`results/${group} changed during the refresh`);
  return todo.length;
}

// One property: walk this pass's tiers, cheapest first, and stop at the first match.
async function resolveProperty({ property, pass, used }, h) {
  let calls = used;
  const tried = [];
  for (const tier of pass === 1 ? [0, 1] : [2, 3, 4]) {
    const context = await publicData(property, tier, h);
    for (const query of planQueries(property, tier, context, tried)) {
      if (calls === CAP) return { resolution: "stopped_at_cap", calls, tried };
      calls += 1;
      tried.push(query);
      const res = await h.fetch({ origin: "lookup", path: "/premises/search", query });
      if (res.status !== 200) return { resolution: "lookup_failed", status: res.status, calls, tried };
      const premise = matchPremise(property, tier, res.body);
      if (premise) {
        return { resolution: "candidate", premise, tier, query, calls,
                 eligibility: checkEligibility(premise) };
      }
    }
  }
  return { resolution: pass === 1 ? "unresolved" : "not_found", calls, tried };
}

// The public lookups a tier needs. Tiers 0 and 3 need none.
async function publicData(property, tier, h) {
  if (tier === 1) return h.fetch({ origin: "addresses", query: pointQuery(property, 0) });
  if (tier === 2) return h.fetch({ origin: "parcels", query: parcelQuery(property) });
  if (tier === 4) return h.fetch({ origin: "addresses", query: pointQuery(property, 150) });
  return null;
}

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
```

Three things to notice:
- **Nothing in the file waits on a timer, retries, counts a rate or saves a checkpoint.** Each `await` on `h` hands one request to the runner, which does all of that.
- **The file is ordinary `async` code.** The same functions run in the browser with the client-side driver.
- **A lookup error is an answer, not a refusal.** An upstream 5xx, or a 429 that outlasts the runner's back-off, comes back as `res.status` and becomes `lookup_failed` for that property. A refusal by a limit or a budget never reaches this code. It ends the run instead (I6).

### The manifest entry, and the operator's settings

```ts
jobs: {
  modules: {
    refresh: { path: "jobs/refresh.js" },
  },
}
```

An admin approves this once. After that, a redeploy that only changes `jobs/refresh.js` needs no new approval (d2).

The lookup API's owner allows a certain pace. ListGen's admin passes that on to the Helix operator, who sets the pace for the `lookup` origin (d5). The app's code never mentions it.

### Starting a refresh

```js
// In the ListGen app, behind the "Start refresh" button.
const res = await fetch("/_api/jobs/modules/types/refresh", {
  method: "POST",
  headers: { "content-type": "application/json", "idempotency-key": refreshId },
  body: JSON.stringify({ refreshId, groups }),             // ~100 group keys, ~5,000 properties
});
const job = await res.json();                              // { server, jobId, status }; poll, cancel and read with ADR-0045's routes
```

### What happens during the run

1. **Pass 1 starts.** The job resolves eight groups at a time. Each group's properties run as child runs, so no single history grows long, and none of them counts against ADR-0045's job caps (d1).
2. **Every lookup goes through the edge.** The edge checks the app's grant for the `lookup` origin and its daily budget, and meters the call. Egress injects the lookup's API key, which the job never sees. The runner keeps the whole run at the operator's pace for `lookup`, and slows down on a 429 (d5). The job code sees none of this.
3. **The user closes the tab.** Nothing changes. Progress (`Pass 1 of 2`, 40 of 100 groups) is there when anyone opens ListGen again.
4. **A runner process crashes.** A fresh sandbox replays each open run from its history in milliseconds, makes no lookups while it does, and carries on from the first request with no recorded answer (d8).
5. **The app's daily fetch budget runs out.** The edge refuses the next lookup. The run ends `failed` with `outbound_quota_exceeded`, and ListGen shows "paused on budget". The group records already written stand. Tomorrow, a new run of the same refresh skips every property this refresh already settled.
6. **The run finishes.** The parent returns `{ refreshId, groups: 100 }`. The real output is the `results/` records. ListGen's map and review queue read them as they do today.

**Keep searching**, ListGen's button that runs the rest of one property's queries on a reviewer's request, needs no server run. The app runs `resolveProperty` in the tab with the client-side driver (d1), on the same code.

### What moves out of the app

Today ListGen runs refreshes in users' tabs. Its design carries this machinery, all of which the module service replaces:

| ListGen runs this in the browser today | With app-authored jobs |
|---|---|
| Batch leases in app-data, with heartbeat tokens and lease expiry judged by each tab's own clock | The runner's claim on the run |
| Rate-grant slot records, and a token bucket in each tab at a share of the total pace | The operator's pace for the origin |
| Back-off durations written to slot records so other tabs slow down too | The runner's back-off on 429 and `Retry-After` |
| Checkpoint writes in a fixed order, with a cursor per batch | The history, and replay |
| A dedicated Web Worker, so hidden-tab timer throttling does not stall the work | Nothing: the run needs no tab |
| A stall warning for when no tab holds a lease | Nothing: the run does not stall when tabs close |
| A self-imposed daily call cap, summed from per-batch counts | The per-run request limit, and the app's daily budget |

What stays ListGen's is its domain: the planner, the matcher, the eligibility rules, the record layout, and people's review decisions.

## Appendix: evidence

All figures come from the [engine spikes](../reviews/2026-10-28-app-jobs-engine-spikes.md). They were measured on synthetic data, mostly on a developer laptop (macOS, arm64, Docker Desktop), so ACA and production hardware may differ. **The step, replay and memory figures were measured on the earlier async-generator contract,** and are re-measured for the `async`-function contract before intake opens (d6).

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
