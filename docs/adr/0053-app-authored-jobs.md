# 0053. App-authored jobs: deterministic modules that yield requests, run in QuickJS compiled to WebAssembly

**Status:** Proposed _(2026-10-29; from the Franklin team, for review by the Helix owners)_

**Related:**
- ADR [0045](0045-app-triggered-durable-jobs-plane.md) and [`docs/design/background-jobs-plane.md`](../design/background-jobs-plane.md): the jobs plane this builds on. Its 2026-10-13 amendment (named job services) is the seam used here: app-authored jobs are a **second named job service**. The design's §6 says "blocking or uncooperative future job code needs its own isolation/execution decision"; this ADR is that decision. It supersedes ADR-0045's "app-authored job code" non-goal, for the shape defined here only.
- ADR [0020](0020-static-only-apps-v1.md): relaxed for this one surface.
- ADR [0013](0013-egress-trust-model.md): its lesson that whoever mints an instruction must not be able to assert authority (decision 5).
- ADRs [0015](0015-app-data-three-scope-model.md), [0041](0041-app-data-write-concurrency.md) and [0042](0042-shared-prefix-grants-and-list-verb.md): the app-data a job may touch (decision 1).
- ADRs [0016](0016-capability-manifest-approval-classifier.md) and [0018](0018-deploy-model-immutable-versions.md): the jobs capability is approved like any elevated capability, and each run pins the module version it started with (decisions 2, 9).
- ADR [0031](0031-connection-providers-delegated-auth.md): the platform popup and shim that consent reuses (decision 3). Its unattended-caller question stays open.
- ADRs [0004](0004-auth-model.md), [0017](0017-registry-listen-notify-projection.md) and [0040](0040-entra-group-visibility-directory-seam.md): why revocation is projected rather than re-checked (decision 4).
- ADRs [0011](0011-in-memory-rate-limiting.md) and [0021](0021-metering-ledger.md): shared rate counters and attribution (decision 6).
- ADRs [0012](0012-edge-portal-codeploy.md) ("egress must remain separate because it holds connection credentials") and [0028](0028-deployment-model-customer-deployed.md) (patches are customer-pulled): why the sandbox holds nothing and must contain an unpatched bug (decisions 7–8, Security).
- `docs/design/custom-backends.md` §1 (the invariant), §2 (the isolation landscape), §3 rung 1, and §8 open question 2 (whether Wasm runtimes are a real rung-1 boundary, which this ADR answers for one workload).
- Evidence: five spike reports in [`docs/reviews/2026-10-28-app-jobs-engine-spikes/`](../reviews/2026-10-28-app-jobs-engine-spikes/README.md), cited as `[quickjs-2 Q1]` and so on.

## Summary

Apps can write their own server-side jobs. A **job module** is an async generator in the app's bundle. It never performs I/O. Instead it **yields a request** ("fetch this", "call the LLM", "write this key"). The platform's **runner** performs that request through the edge, records the answer in the run's **history**, and resumes the job with it. If anything crashes, a fresh sandbox **replays** the job against its history and carries on. This is the durable-execution model of Temporal and Azure Durable Functions, with one difference: here the job code is untrusted.

Two approvals gate a run. An admin approves the app's jobs capability once, like any elevated capability, and the user who starts each run approves it in a platform-rendered popup. The run then acts with the app's authority, narrowed to what the manifest allows and the user approved. It never acts as the user.

Runs are served by a second named job service under ADR-0045, with its own database and signing keys. It is reached through the same `/_api/jobs/...` routes as `jobs:fetch`. Job code runs in **QuickJS compiled to WebAssembly**, built by Helix, with **one Wasm instance per run**, in a sandbox pool that holds no credentials and has no network. So a single engine bug on an unpatched install reaches only its own run.

The rules an implementation must keep are the [invariants](#invariants) at the start of the Decision. The security argument is in [Security: three walls](#security-three-walls).

## Glossary

Each word below means exactly one thing in this ADR.

| Term | Meaning |
|---|---|
| **Job module** | One ES module in the app's bundle that exports an async generator, declared in the manifest. |
| **Run** | One execution of a job module, owned by the user who approved it. |
| **Child run** | A run started by another run with `h.child`. It has its own history and belongs to its parent. |
| **Request** | A description of one effect (a fetch, an LLM call, an app-data operation, a sleep) that the job yields. The job never performs it. |
| **Answer** | What the runner sends back into the job for a request: the upstream's or data store's response, after projection. |
| **Refusal** | The platform declining a request (ceiling, budget, revocation). Never delivered to the job as an answer. |
| **Module service** | The named job service (ADR-0045, 2026-10-13 amendment) that serves runs. It has two parts, the runner and the sandbox pool. Its server name is open question 1; this ADR writes `modules`. |
| **Runner** | Trusted platform code in the module service. It performs requests, keeps histories and drives runs. Never called "the engine" here. |
| **Engine** | The JavaScript interpreter that executes job code: QuickJS compiled to WebAssembly. Nothing else. |
| **Instance** | One WebAssembly instance of the engine. Each run gets its own. |
| **Prelude** | Trusted platform JavaScript loaded into an instance before the job module. It installs `h` and removes what jobs must not have. |
| **Sandbox host** | A process in the sandbox pool that holds instances and answers the runner's protocol. |
| **Sandbox pool** | The set of sandbox hosts, deployed apart from the runner, with no credentials and no network. |
| **History** | The runner's append-only record of a run's requests, answers and recorded values. The only source of truth for a run. |
| **Replay** | Re-running a job from the start in a fresh instance, feeding it answers from its history, until it yields a request with no recorded answer. |
| **Sticky** | A run whose instance stays in memory between steps, so the next step needs no replay. |
| **Wave** | The set of requests a job yields at once with `h.all`. |
| **Run grant** | The record created at consent: module hash, input digest, ceilings, owner, expiry. |
| **Run header** | The pinned facts a run started with: module hash, engine build, limit settings. |
| **Callback** | ADR-0045's signed jobs → edge hop, through which a job service asks the edge to perform an outbound operation. |
| **Data scope** | One (app, owner) pair. |

## Context

### What apps cannot do today

A Helix app is a static bundle (ADR-0020), and everything dynamic is a request to `/_api/*` that ends when the tab stops listening. ADR-0045 added durable background work, but only **platform-authored job types**. The first is `jobs:fetch`, one governed `GET` whose result is kept as JSON. Its implementation design runs only trusted job code, for at most 60 minutes, and excludes app code, sub-jobs and app-data writes. The app's **own logic** still cannot keep running after the tab closes.

For example:

- **ListGen** resolves a CSV of properties against a rate-limited account-lookup API.
  - Each property runs a small planner: the address as listed, then spelling variants, then same-parcel and nearby addresses. It stops at the first hit, under a per-property call cap.
  - A refresh is about 21,000 calls and takes hours.
  - Today it runs in users' browser tabs, coordinated through app-data leases and rate-grant slots. Nothing runs unless a tab is open, and every tab carries its own rate limiter.
- **The ADR-0041/0045 pilot app.** Its LLM pipeline is ADR-0045's deferred workload. Branching on what those phases return, such as re-researching when a result is thin, is app logic.

Governed server-side jobs written by the app are something that sets Helix apart. The logic is the app's own, but every call it causes is still approved, metered, budgeted, rate-limited and audited by the gateway, which is what Helix already does for code running in a browser.

### The shape: the job decides, the platform does

Durable-execution systems split work in two:

- **Workflow code** is deterministic and performs no I/O. It *asks* for work.
- **An executor** performs each request, records the answer in a history, and resumes the code with the answer. After a crash, it replays the code against the history to bring it back to where it was.

This is the model behind Temporal workflows and Azure Durable Functions orchestrators; AWS Step Functions and Cloudflare Workflows have the same shape. Temporal and Durable Functions both ask developers to keep the system clock and randomness out of workflow code and to use deterministic substitutes. Temporal's TypeScript SDK replaces `Date` and `Math.random` with replay-safe versions and makes `WeakRef` throw. So the constraint this ADR puts on app authors is normal in this space.

In this ADR, **the app writes the workflow code, and the module service's runner is the executor.** The tenant code is then pure computation:
- it holds no credential;
- it reaches no network;
- it cannot exceed its budget, because it never makes a call. It can only ask the runner to make one.

What is new is that the workflow code is **untrusted**. Temporal and Durable Functions run code that the operator wrote and deployed on its own workers. Their sandboxes exist for determinism, not security. Helix must treat job code as hostile.

### Why not another platform job type

ADR-0045 decision 8 tests a platform job type this way: "if the job's API mentions any noun from the pilot app's problem domain, the abstraction is wrong."

- **The I/O half of these workloads passes that test.** "Call this origin under a rate limit, checkpoint, retry on 429" names no domain. This ADR makes the platform own that half (decision 6).
- **The control-flow half cannot pass it.** ListGen's address ladder, or the pilot app's re-research rule, would have to be written as a payload. A payload expressive enough for that is a program, so the platform would end up designing, owning and securing an interpreter. Running the app's own JavaScript, with I/O taken away from it, is the honest version of the same thing.

### The constraint: untrusted code on our servers

custom-backends.md §1:

> A custom backend is just another untrusted tenant. It gets its capabilities *through* the gateway, holds no ambient cloud credentials, and the gateway stays the single choke point for identity, authz, quota, and audit.

App-written job code is untrusted tenant code running on our servers, which is rung 1 of custom-backends.md §3. It is a narrow case of rung 1:

1. **The code performs no I/O and holds no credential.** All I/O is the runner's.
2. **It serves no inbound traffic.**
3. **Every run passes two human gates:** an admin approved the app's jobs capability, and a user approves each run.

**The attacker** is a malicious or compromised app author, or a poisoned dependency in the bundle, in an app whose jobs capability an admin approved. The install is single-tenant (ADR-0028), but apps distrust each other (ADR-0019), and that boundary must hold. Customers pull patches; Helix does not push them (ADR-0028). So **the design must contain a known engine bug on an install that has not been patched.**

### How others run untrusted code, and what it teaches

- **Cloudflare Workers for Platforms** is the closest prior art for the gateway shape. A platform-owned dispatch worker runs authentication and rate limiting before any tenant code, and outbound workers inject credentials so tenants never hold secrets. custom-backends.md §1 maps this onto Helix's edge and fetch proxy. Cloudflare also says plainly that V8 isolates are not a boundary on their own. It runs them behind compensating controls such as frozen timers, moving suspicious workers into their own process, and restarts that shuffle memory (custom-backends.md §2). *Lesson:* running policy before tenant code is the right seam, and an isolate needs defence in depth behind it.
- **Shopify Functions** runs untrusted third-party app JavaScript on Shopify's servers. It compiles the code to WebAssembly with Javy, a QuickJS-based toolchain that Shopify built, and runs it under hard limits, including an instruction-count cap (11 million per call for typical carts, per Shopify's documentation at the time of writing). Each call runs to completion. *Lesson:* QuickJS in Wasm is used in production as a server-side boundary for tenant code. Shopify never pauses a run between calls, and that pausing is what this design adds.
- **Figma plugins** moved in 2019 from a JavaScript-level sandbox (the Realms shim) to "a JavaScript VM written in C and cross-compiled to WebAssembly", after a vulnerability in the earlier sandbox. quickjs-emscripten's README identifies that VM as QuickJS, and whether Figma still uses it is unverified. Figma's sandbox runs in the user's browser, not on a server. *Lesson:* another team chose this kind of boundary after a JavaScript-level sandbox failed, meaning one that hides globals inside the same engine.
- **Temporal's TypeScript SDK** originally ran workflows in `isolated-vm`. Temporal's own introduction to `isolated-vm` now carries a note that the SDK has switched away from it. *Lesson:* a sandbox for determinism is not a sandbox for security; `isolated-vm` itself is now in maintenance mode (see Alternatives).

The spikes found no production system that runs **paused** QuickJS generators for many tenants server-side [quickjs-1 §4]. That combination is new here, and the spikes are its evidence.

## Decision

### Invariants

Every part of the implementation must keep these rules. Each one names the decisions that enforce it. Cite them by number, for example "0053 I5".

- **I1. Job code performs no I/O.** Every effect is a request that the runner performs. (d1, d7)
- **I2. The language surface gives job code no credential, network, clock or randomness.** Time and randomness come only from `h.now()` and `h.random()`, whose values are recorded in the history. (What a job reaches *through an engine bug* is I9's subject.) (d1, d7, d8)
- **I3. A run starts only with two approvals:** an admin approved the app's jobs capability, and a user consented to this run with this input. A run grant can be narrowed after consent, never widened. (d2, d3)
- **I4. A run never acts as the user.** It gets no user-scoped data, no delegated connection and no user token. (d4)
- **I5. The edge decides a module run's authority from its own projection of the run grant.** Nothing the module service asserts in a callback can widen what a run may do. (d5)
- **I6. A refusal is never delivered to the job as an answer.** (d1)
- **I7. The runner's history is the only source of truth.** A sandbox's state is a cache, and every frame from a sandbox is untrusted input. (d8, d9)
- **I8. Replay is checked.** On replay, each request, each recorded value and a hash of each return value must match the history, or the run fails. (d1, d9)
- **I9. One engine bug, on an unpatched install, reaches only its own run's instance**, plus what that instance's fixed imports expose (a clock, stderr and its own recorded values). It gains no credential, network or authority. Reaching another run takes a second, independent bug. (d7, d8)
- **I10. Engine upgrades drain; they never kill a live run.** An instance only ever runs on the engine build pinned in its run header: the pool keeps old builds until their runs finish, and a resume on a different build is refused. (d9)

### Decision 1. The contract: a job module that yields requests

An app may ship job modules in its bundle. Each is a single ES module, bundled by the app's own build with no imports, that exports an async generator:

```js
// jobs/resolve.js
export default async function* resolve(input, h) {
  const results = yield h.all(input.items.map(item => h.child(resolveOne, item)));
  yield h.data.put({ scope: "shared", key: `results/${input.batch}`, value: results, ifMatch: input.version });
  return { resolved: results.filter(r => r.hit).length };
}

async function* resolveOne(item, h) {
  for (const query of plan(item)) {                       // the app's own logic
    const res = yield h.fetch({ origin: "lookup", path: "/search", query, select: "/premises" });
    if (match(item, res.body)) return { hit: true, premise: res.body[0] };
  }
  return { hit: false };
}
```

`h.fetch(...)` does not perform a call. It builds a **request**, and `yield` hands that request to the runner. The request kinds in v1:

| Request | The runner performs, through the edge (decision 5) | Governed by |
|---|---|---|
| `h.fetch(req)` | One fetch-proxy call, to an origin the manifest already approved. Origins whose credential is a provider binding are refused, as for `jobs:fetch` | Fetch grant, secrets and SSRF rules (ADR-0005, ADR-0013) |
| `h.llm(req)` | One LLM-gateway call | Model allowlist, `dollarsPerDay` |
| `h.data.get/put/list` | `shared` app-data. A `put` must carry a precondition (ADR-0041; 428 without one). `list` is ADR-0042's prefix-grant verb | Data grants, CAS |
| `h.data.append` | `collection` app-data, append only, because that scope is never readable (ADR-0015). There is no `user` scope (I4) | Data grants |
| `h.sleep(ms)` | A durable timer | None |
| `h.progress({step, of, label})`, `h.log(str)` | Progress in ADR-0045's snapshot shape, and logs for this run (decision 9) | Size caps |

**Refusals are not answers (I6).** When the runner or the edge refuses a request because of a ceiling, a cap, a budget or a revocation, the run ends with a visible outcome (decision 9). It does not continue with an error value that it might treat as data. In a spike, a daily-cap refusal delivered as an ordinary answer silently became "processed, no match" for 44 properties [quickjs-1 Q8]. Outcomes from the upstream or the data store are answers, not refusals. That covers an upstream 4xx or 5xx, an upstream 429 after the runner's back-off is used up, and a CAS `412`, which ADR-0041 expects writers to handle by retrying.

**Composition.**
- `h.all([...])` yields several requests or child runs at once, as one **wave**. The runner performs them concurrently, within the rate limits, and resumes the job when every one has answered.
- `h.child(fn, input)` starts a child run with its own history, so no single history grows long. ListGen uses one child per property. A child's return value is its answer to the parent; it is not separately readable by the app. **A child run is part of its parent, not a job.** It has no `/_api/jobs` reference and does not count against ADR-0045's unfinished or retained job caps (20 and 1,000 per app and environment), which a 21,000-child ListGen refresh would otherwise exceed. Instead, its requests count against the parent's request ceiling, and its history against the parent's `historyMiB`. The runner caps children in flight per run (default 8, within an operator maximum).

**Projection.** A request may name a projection (`select`). The runner applies it **before** recording the answer, which keeps the history small and keeps fields the job does not need out of storage. For ListGen, only the matched premise is kept.

**Determinism is enforced, not requested (I2, I8).** The engine exposes no `Date`, no `Math.random`, no timers and no host APIs. `h.now()` and `h.random()` exist, and their values are recorded. On replay, the runner compares each request, each recorded value and a hash of each return value against the history. A mismatch fails the run with a non-determinism error. That happens when the code depended on something outside its inputs. The other cause, a module that changed mid-run, is prevented by the run header (decision 9).

**The same module runs in a browser.** A small client-side driver performs the requests through `/_api/*`, as a tab does today. One job module therefore serves both an in-tab run and a durable server run. An author can also test determinism locally, by replaying a recorded history.

**Apps depend on the contract, not the engine.** As in ADR-0045 decision 2, the generator-and-requests shape is what apps build against. The engine (decision 7) can change inside the module service without touching an app.

### Decision 2. The manifest declares job modules; an admin approves the capability

ADR-0045's `jobs` grant gains a `modules` section. The shape below is illustrative, not final syntax:

```ts
jobs: {
  types: ["jobs:fetch"],                      // ADR-0045 platform job types, unchanged
  modules: {
    resolve: {                                // served as the qualified type `modules:resolve`
      path: "jobs/resolve.js",
      uses: { fetch: ["lookup"], data: { shared: ["results/"] } },  // a subset of the app's own grants
      ceilings: { requests: 50000, wallClock: "12h", historyMiB: 64, llmDollars: 0 },
      rates: { lookup: "10/s" },              // feeds the platform limiter (decision 6)
      concurrency: { perApp: 4, perUser: 1, childrenInFlight: 8 },
    },
  },
}
```

Each module declares:
- its path in the bundle;
- which of the app's own capabilities its requests may use: a **subset**, never more than the app has;
- per-run ceilings: request count, wall-clock time, history size, and dollars for LLM requests;
- a request rate for each origin;
- maximum concurrent runs, per app and per user, and children in flight per run.

Platform job types stay **baseline** grants under ADR-0045. `classifyChange` (ADR-0016) treats adding or widening a module as **elevated**.

**Two of ADR-0045's rules are deliberately different for the module service:**
- **Grants do not come from an installed catalogue.** The jobs design says granted types "must come from the installed production catalogue … never arbitrary actor names". Module names are the app's own. What takes the catalogue's place is the admin's approval of the app's module declarations, and the rule that a module's requests are confined to a subset of grants the app already holds.
- **Limits are still the operator's.** The jobs design says "app input cannot change retries, concurrency, deadlines or retention". The manifest's ceilings, rates and concurrency are *requests*: the module service clamps each to an operator-configured maximum, exactly as consent clamps ceilings (decision 3).

**The capability is approved; each code version is not.** An admin approves the module declarations, with their subsets and limits, as an elevated capability under ADR-0016. A redeploy that changes job code but not the manifest needs no new approval, as for any other app code. What bounds every version of the code is the same: the approved subset and limits, the user's consent to each run, and the edge's checks on every request.

**Each run pins its module version.** At consent, the run grant records the hash of the module file in the app's live version. The module service fetches that exact source through the callback (decision 5) and keeps it, keyed by hash, as long as any run uses it. So replay never depends on which bundle version is live, ADR-0018 rollbacks and archiving cannot strand a run, and a redeploy never changes a run already in flight.

**Revoking the app's module grant stops its runs** (decision 4). It is the admin's kill switch.

### Decision 3. A user approves every run, in a platform-rendered popup

App JavaScript is untrusted (ADR-0019, ADR-0020), so it must never render consent. Consent reuses ADR-0031 amendment 1's connect popup, then joins ADR-0045's ordinary submit route:

1. The app calls `window.helix.jobs.request({ module, input, ceilings })`. The helper ships in the opt-in platform shim, like `window.helix.connect`: `capabilities.shim` gains `jobs` (ADR-0031, 2026-09-25 amendment, item 5).
2. The platform opens its own popup on the control-plane site. It shows the app; the module and its version; the input's size and digest; the ceilings and the expiry; and "runs with this app's access; you own the run and its cost".
3. On approval, the portal records a **run grant**: module hash, input digest, ceilings, `owner` (the user's canonical oid, ADR-0048), environment and `expiresAt`. Requested ceilings are clamped to the manifest's, and the grant carries the narrower of the two. The edge projects grants with the ADR-0017 pattern.
4. The popup returns the grant id to the app. The app submits with `POST /_api/jobs/modules/types/resolve`, carrying the grant id and the input.
5. The edge accepts the submission only if its projected grant exists and matches the app, environment and owner of the caller and the digest of the submitted input. It then submits the run to the module service over ADR-0045's edge → service hop.

**A grant starts at most one run, and the grant id is that run's retry key.** ADR-0045 recovers a lost submit reply by resending the same keyed request. Here, resending the same grant with the same bytes returns the original run instead of starting a second one, and different bytes are refused, as with any retry key. A grant can therefore never be spent twice, and a lost reply is still recoverable.

Because the input digest binds the grant, the app cannot swap the input after approval. Ceilings can be narrowed later, never raised (I3). The owner can stop a run at any time with ADR-0045's cancel route.

### Decision 4. Authority and revocation

This keeps ADR-0045 decision 5's split:

- **Ownership** belongs to the approving user. That means the `gateway_calls` rows, the audit trail, and the right to read results and stop the run. ADR-0045's exact-owner checks on poll, result and cancel apply unchanged.
- **Authority** is the app's, narrowed to the module's subset (decision 2) and the run grant's ceilings. Helix has no per-user authorization inside an app to intersect with (ADR-0007). The user is the gate, and the party the run is attributed to, but not the principal.
- **A run never acts as the user (I4).** It gets no user-scoped app-data and no delegated connections. The user's session or refresh token is never used, stored or forwarded. ADR-0031's unattended-caller question stays open, and the default is still to refuse.

**Module runs stop on more events than platform jobs do.** A `jobs:fetch` job lasts at most five minutes. Under ADR-0045, revoking the jobs grant or the owner's session blocks reads but does not cancel work already accepted. A module run can last hours and runs app-written code, so this ADR adds stops. There is **deliberately no background re-check of the owner's access**: the edge never calls Graph and holds only a session snapshot (ADR-0040; up to 60 minutes stale under ADR-0004), and a re-check would need a directory capability that ADR-0040 withholds. Instead, a run stops when any of these happens:
- its grant's `expiresAt` passes. The expiry is capped by a deployment-wide maximum, default 24 hours, and serves as the run's schedule-to-close deadline. That is longer than the `jobs` service's 60-minute bound, which the jobs design allows ("limits and execution mechanics can differ by server");
- the owner or an admin stops it;
- an admin revokes the app's module grant;
- the owner's sessions are revoked. ADR-0004's operator revoke also revokes that user's live run grants;
- the app is archived, as for every job (ADR-0045 lifecycle delivery).

**How a stop is enforced.** The portal records the stop, and two independent paths carry it:
1. **The edge refuses at once.** The stop is projected to the edge with the ADR-0017 pattern (sub-second). The edge checks that projection on every callback for the run (decision 5). This check is authoritative: from then on, the run cannot cause another effect.
2. **The module service cancels.** An owner's stop uses ADR-0045's ordinary cancel route, which only the owner may call. Stops that start in the portal (an admin's stop, grant revocation, session revocation, expiry) go over ADR-0045's lifecycle outbox, which retries until acknowledged. That outbox today tracks delivery per (app, generation, server), so it gains a record type keyed per run. Archiving keeps its existing generation records. The runner records each stop durably, then checks before dispatching each request and before resuming a run from `h.sleep`.

The module service has no platform-database access (ADR-0045), so it learns of stops only through the second path. A delay on that path wastes sandbox time, but it cannot cause an effect.

### Decision 5. The runner performs every request through ADR-0045's callback; the edge stays the single choke point

**The runner reaches the edge through ADR-0045's signed jobs → edge callback,** with that hop's whole discipline unchanged:
- each server has its own separately generated secrets for each direction, and no service holds `HELIX_INSTRUCTION_SECRET`;
- instructions are short-lived and bind the server, the operation, the resource and the body hash;
- the edge burns nonces in a dedicated table in `helix`, granted to it alone;
- the edge checks the app's registry generation before dispatch;
- the production callback refuses `dev` instructions, and the dev-gateway callback refuses `prod`;
- the edge uses one fetch-policy core for browser and job callers, so jobs never duplicate fetch policy.

This ADR widens the callback's allowlisted operations from outbound fetch to the request kinds in decision 1 (fetch, LLM and app-data), plus fetching a run's pinned module source by hash (decision 2). Each new operation gets the design's explicit-authority adapter, as fetch has, so the edge never fabricates a session. A data write's CAS precondition is part of the signed body, so it cannot be stripped in transit. One side effect is an improvement: `h.llm` goes through the real LLM gateway, so module runs get the USD ledger and `dollarsPerDay` that ADR-0045 noted its fetch-routed LLM job would lack.

**For a module run, the edge never takes authority from the callback (I5).** The callback names the run. The edge looks up that run's grant in **its own projection** (decision 3). It refuses the callback if any of these is true:
- the run is unknown, stopped or expired;
- the callback's claimed app, environment or owner disagrees with the grant;
- the request falls outside the module's subset;
- the request would exceed the grant's ceilings.

Then it applies the same policy path as `/_api/*`: grant check, quota, budget, metering, audit, and the hop to egress. This is ADR-0013's lesson applied to the new hop: whoever mints an instruction must not be able to assert authority. A compromised module service can act only within runs that really exist and were approved.

**Job code never sees the callback credential (I2).** Only the runner holds it, and nothing in the sandbox protocol carries it.

The callback's adversarial tests are extended **in the same change** with module-run cases:
- unknown, stopped and expired runs;
- mismatched app, environment or owner;
- requests outside the subset;
- requests over the ceilings;
- data operations without a precondition.

### Decision 6. Rate limits, budgets and back-off belong to the platform

Because the runner dispatches every request:

- **Per-run ceilings are enforced exactly, before dispatch.** Nothing is counted after the fact, so nothing overshoots. The edge re-checks them (decision 5).
- **Each (app, origin) gets a token bucket.** It is set to the manifest's declared rate and shared by all of that app's runs. It backs off with AIMD on 429 and honours `Retry-After`.
- **Each origin also gets a global bucket,** so that several apps calling one upstream cannot together exceed it. In a spike, two apps sharing an upstream doubled each other's run time [workerd-io Q9].
- **Buckets are shared across runner processes.** Per-process buckets would multiply the effective rate, and ADR-0045's rolling deployments briefly run two workers. The buckets are Postgres-backed counters in the module service's own database, following ADR-0011's resolution.
- **The edge's existing outbound spend policy and per-app daily budgets still apply** (ADR-0021). A run grant can only narrow them.
- **`gateway_calls` gains a `jobRunId` column.** The change is additive and needs no backfill, like ADR-0021's request-path amendment.

ADR-0045's capacity controls (unfinished and retained job caps, edge submission throttles) apply to module runs as to any job. Apps stop implementing rate limiting themselves, which removes that whole class of bugs from app code.

### Decision 7. The engine: QuickJS compiled to WebAssembly, one instance per run, built by Helix

**Why this engine.** A job does no I/O, so its engine needs no Web APIs and no bindings: only ECMAScript over JSON. That makes the smallest available boundary practical. In a QuickJS Wasm instance, guest objects hold no references to host objects. The instance reaches the host only through a short, fixed list of imports: 19 in the Helix build, covering abort and assert, a clock, heap resize, stdout and stderr, and the glue's callbacks, with no file or socket imports [quickjs-2 Q1]. A QuickJS memory-safety bug therefore corrupts only that instance's own memory. Reaching anything else takes a **second, independent** bug, in V8's WebAssembly implementation or in one of those imports (I9).

**One instance per run, never shared.** A shared instance would expose every run's heap to a single QuickJS bug, and turn one run's fault into everyone's.

**Loading.** The sandbox host creates a fresh instance, loads the prelude, then loads the job module's **source**. It never accepts bytecode, because quickjs-ng treats untrusted bytecode as equivalent to untrusted native code [quickjs-1 §2]. No module loader is installed, so job code cannot import anything, including platform code.

**Ambient API (I2).** The job gets ECMAScript built-ins only:
- `Date` is not installed, and `Math.random` throws.
- There are no timers, `console`, `WebAssembly`, `Atomics`, `WeakRef` or `FinalizationRegistry`.
- `h` is frozen, and the prelude deletes its own globals before the job loads.

The spike found no source of non-determinism at a fixed configuration [quickjs-1 Q9]. The configuration-dependent sources (memory cap, stack limit, engine build) are pinned in the run header (decision 9). On every engine upgrade, the list of reachable globals is checked against an allowlist, and any change blocks the upgrade.

**Limits are enforced inside the engine, per run:**

| Limit | Mechanism | What a tripped limit takes down |
|---|---|---|
| Memory | The QuickJS heap limit (for example 48 MiB), plus a hard `WebAssembly.Memory` maximum per instance (default 64 MiB), which is the guarantee | The run. **Any out-of-memory error ends the instance.** It is dropped without another call into it, because a runtime that has run out of memory can trap on later calls [quickjs-2 Q1] |
| Stack | A QuickJS stack limit of 256 KiB or less. At 512 KiB or more, V8's own stack overflows first [quickjs-1 Q6] | The run. Any host-level fault discards the instance |
| CPU per step | A QuickJS interrupt deadline of 100–250 ms. Job code cannot catch it, and it also stops regex backtracking | The run. Other runs on the same thread wait out the deadline (decision 8) |
| CPU and wall time per run | The runner adds up step time against the run's ceilings. A run that keeps hitting the deadline fails against its CPU budget | The run |

In the spike, a runaway or memory-bomb job stopped only its own run, and a canary run in another instance survived every probe [quickjs-1 Q5, Q6].

**Helix builds the engine.** The npm `quickjs-emscripten` builds are unsuitable [quickjs-1 Q6; quickjs-2 Q1]:
- they bundle quickjs-ng v0.12.1, five or more releases behind, and upstream's regression test for the critical GHSA-m53g-qx47-3h38 crashes both of them;
- their memory limit does not hold: a 32 MiB limit let a job reach 2 GiB.

Helix CI therefore builds quickjs-ng to Wasm from these inputs:
- a pinned, sha256-checked quickjs-ng release amalgam (v0.17.0 at the time of writing), or a pinned master commit when an unreleased memory-safety fix is needed;
- quickjs-emscripten's C glue at a pinned commit, plus a Helix patch of about 40 lines;
- `emcc` from the `emscripten/emsdk` image, pinned by digest;
- no quickjs-libc, so there are no `std` or `os` modules.

The build is reproducible, passes the GHSA-m53g regression test, and its memory limit holds [quickjs-2 Q1]. Every engine bump must pass a release suite:
- the smoke job;
- the memory bombs;
- the CPU-interrupt and stack probes;
- the out-of-memory probe;
- the globals allowlist;
- the Wasm import list;
- upstream's security regression tests.

Each release records the upstream tag or commit, the amalgam sha256, the emsdk digest and the `.wasm` sha256.

**The standing cost, stated plainly.** Since 2026-10-11, quickjs-ng accepts no private security reports and issues no CVEs. Its fixes land on master weeks before a release [quickjs-1 §2]. So a scanner will never tell a customer they are exposed, and:
- the module service's owner reviews quickjs-ng's master commits at least weekly;
- when a memory-safety fix lands, the owner rebuilds from a pinned commit;
- engine rebuilds ship as flagged security releases, named in the release notes and the deployment catalogue (ADR-0036).

The estimated effort is about half a day per routine upstream release. It is one to three days when the C API or emsdk breaks, which happened once in the five releases from 0.12.1 to 0.17.0 [quickjs-2 Q1].

**Node's patch level becomes part of the boundary,** because V8 runs the Wasm.

### Decision 8. The module service: a runner, and a sandbox pool that holds nothing

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

The pool is declared in Bicep on its own ACA workload profile, so its nodes host nothing else. Each sandbox host runs with:
- cgroup CPU and memory limits;
- a read-only root filesystem;
- all capabilities dropped, and `no-new-privileges`;
- a non-root user.

A deployment can optionally harden further with ACA dynamic sessions (Hyper-V) per run, or with a sandbox host per app.

**Inside a sandbox host.** A router runs on the main thread, with N `worker_threads` sized to the cgroup's cores.
- **Placement.** A run's instance lives on exactly one thread, because V8 cannot move a `WebAssembly.Memory` between threads. Moving a run therefore means replaying it. New and replayed runs go to the least-loaded thread.
- **Eviction.** Idle instances are evicted under a per-thread cap and replayed on their next step. The cap must cover the active working set.
- **Thread death.** If a thread dies, its runs replay on other threads. In the spike, 250 runs recovered in 83–195 ms with no step lost or duplicated [quickjs-2 Q2].
- **Spinning runs.** A spinning run stalls only the runs on its own thread, and only until the deadline.

**The protocol (I7).** The runner talks to sandbox hosts over the pool's private network, using newline-delimited JSON multiplexed by request id. Frames are capped at 8 MiB.

| Operation | The runner sends | The sandbox host returns |
|---|---|---|
| `open` | source, input, limits | — |
| `step` | an answer | the next request, or the result, plus any `h.now()`/`h.random()` values |
| `replay` | the whole history | the first request with no recorded answer |
| `close` | — | — |

- **Every frame from a sandbox host is untrusted input.** It is size-capped, parsed, matched to an outstanding request id, and validated like a yielded request.
- **Recorded values** from `h.now()` and `h.random()` are produced in the sandbox. The runner appends them to the history and sends them back on replay.
- **A supervisor reaps sandbox hosts** if the runner dies, and their runs replay elsewhere.

Splitting the runner and the sandbox into separate processes costs about 25 µs per step, and a few milliseconds per 1,000-step replay [quickjs-2 Q3]. That is negligible next to steps paced by an upstream rate limit.

### Decision 9. Durability, history, results, logs and telemetry

**A step.** The runner dispatches through pg-boss in its own database, as the `jobs` service does, and holds the run's claim and heartbeat. For each step it:
1. resumes the job with the last answer;
2. takes the next request the job yields;
3. checks its stop list and the ceilings, then dispatches the request through the callback;
4. appends `{request, answer}` to the history.

**The history is the source of truth, and a sticky instance is only a cache (I7).** After a crash, a restart, an eviction or a move, a fresh instance replays the job against its history until it yields a request with no recorded answer. Replay makes no network calls, and costs milliseconds for thousands of steps [quickjs-2 Q2]. History appends are batched per wave, because a ListGen refresh is about 21,000 child runs. A crash therefore loses at most the answered-but-unflushed entries of the current wave, and the cap on children in flight bounds that number.

**Requests are at-least-once.** Only answers not yet in the history can repeat.
- `h.fetch` carries an idempotency key (`run/step/item`), so an upstream that supports one can de-duplicate.
- `h.data.put` is safe under replay because of its precondition.

In a crash test that killed both the runner and the sandbox mid-run, the run recovered and resolved all 50 of its properties (301 calls) with no duplicate answered request [workerd-noio Q6].

**The run header pins** the module hash, the engine build and the limit settings. A resume refuses to proceed when any of them differs, rather than relying on replay to notice.

**Engine upgrades drain; they do not kill (I10).** The pool keeps each engine build that still has live runs, and new runs start on the newest build. A security upgrade therefore never strands, re-bills or kills an in-flight run. An emergency upgrade that cannot wait is an explicit operator action. It ends the affected runs with a visible `engine_retired` outcome.

**Outcomes on the job surface.** A run is polled, cancelled and has its result read through ADR-0045's routes, with ADR-0045's statuses and retention. Module runs add these `error.code` values:

| Outcome | Status | `error.code` |
|---|---|---|
| Stopped by the owner or an admin, by session revocation, or by archiving | `cancelled` | `cancelled` |
| The app's module grant revoked | `cancelled` | `approval_revoked` |
| Grant expired before the run finished | `failed` | `timeout` |
| A request refused by the run's own ceilings | `failed` | `refused_ceiling` |
| A request refused by the app's fetch budget | `failed` | `outbound_quota_exceeded`, as for `jobs:fetch` |
| A request refused by the app's LLM or data budget | `failed` | `refused_budget` |
| A request refused by fetch policy | `failed` | `outbound_forbidden` or `delegated_unattended`, as for `jobs:fetch` |
| An engine limit tripped (memory, stack, CPU) | `failed` | `engine_limit` |
| Replay did not match the history | `failed` | `nondeterminism` |
| Ended by an emergency engine retirement | `failed` | `engine_retired` |
| The job threw | `failed` | `job_error` |
| Lost to a platform interruption with no recovery left | `crashed` | `platform_error` |

**Results.** A run has one result: the job's return value, capped at 64 KiB as for every job type. A child run's return value goes to its parent, not to the app. A job whose output is larger writes it to `shared` app-data with `h.data.put`, as in the example in decision 1.

**Data writes** go through the edge with CAS, so the module service, like `jobs`, has no `app_data` grant. ADR-0045 decision 4 objected that the platform cannot supply a precondition. That objection does not apply here, because the app's code supplies it.

**The history is a retained store of third-party content, and is governed as one.**
- It lives only in the module service's database.
- It is readable only by the run's owner, under ADR-0045's exact-owner rule (there is no admin override), and it has a deletion verb.
- It follows the result's clock: it stays readable for seven days after the run ends, and is then deleted within ADR-0045's cleanup bounds.
- `select` keeps stored answers to what the job needs (decision 1).

**Logs.** `h.log` output is stored with the run, capped in size and volume, and visible only to the run's owner. It is **never written to the platform log store**, because it is untrusted text.

**Delivery gate.** As the jobs design requires of any new job service, the module service must pass ADR-0045's common wire and signing fixtures and its behavioural failure matrix before it opens intake.

**Telemetry.** ADR-0045's telemetry rules apply. New spans cover consent, run lifecycle, replay, request dispatch and callback checks. Dimensions are bounded: `appId`, a prefix of the module hash, the request kind, the stop reason and the engine build. The owner's oid is never a dimension. `docs/features/observability.md` is updated in the same change.

## Security: three walls

The design puts three independent walls between a hostile job and anything worth having. Each wall is described below by what it removes, and by what an attacker who gets past it still holds.

**Wall 1: policy. Nothing runs without two approvals, and an approved job can only ask.**
- An admin approved the app's jobs capability and its limits (d2), and a user approved this exact run, input and ceilings (d3).
- Even then, the job performs nothing itself. Every request goes from the runner to the edge, and is checked against the module's subset, the run's ceilings and the app's budgets, then recorded in the ledger (d5, d6).
- The edge decides from its own projection of the grant, so neither the job nor the module service can assert more authority (I5).

*An attacker who stays inside this wall* gets exactly the run grant, metered and attributed under `jobRunId`.

**Wall 2: the engine. Job code holds nothing and reaches nothing, and one bug stays in one run.**
- The code has no credential, no network, no clock and no randomness (I1, I2).
- It runs in its own Wasm instance, with 19 fixed imports (d7).

*An attacker with a QuickJS memory-safety bug* controls only their own run's instance, which they already controlled. Reaching the sandbox host takes a second, independent bug, in V8's Wasm implementation or in a host import.

**Wall 3: the platform. The pool has nothing to steal, and the runner cannot be made to lend authority.**
- A sandbox host has no identity, no secrets, no database and no network (d8).
- The runner does hold credentials, but it treats every sandbox frame as untrusted (I7), and the edge does not take the runner's word for anything (I5).

*An attacker with two chained bugs* reaches one sandbox host. They can read and disturb the runs on it, but they cannot call anything, and cannot reach another app's grants.

**Why the walls must hold without a patch.** Helix installs are patched only when a customer pulls a release (ADR-0028). Walls 2 and 3 are therefore designed to contain a **known, unpatched** engine bug (I9). This is also why Helix owns the engine build and watches upstream weekly (d7).

| Attacker, from shallowest to deepest | What they get | What stops them going further |
|---|---|---|
| A misbehaving approved job | Any request within its run grant | Capability approval (d2); consent (d3); ceilings and limiters before dispatch, re-checked at the edge (d5, d6); metering and audit by `jobRunId` |
| App JavaScript misrepresenting a run to the user | Nothing | The platform renders the popup and binds the grant to the input digest (d3) |
| A runaway, memory-bomb or deep-recursion job | Its own run fails; other runs on its thread wait out one deadline | A memory maximum, stack limit and uncatchable deadline per instance; out-of-memory ends the instance (d7) |
| A QuickJS memory-safety bug, such as an unpatched quickjs-ng advisory | Its own run's instance, plus the host clock, stderr and its own recorded values | One instance per run; 19 fixed imports; a Helix-built engine tracking upstream master (d7) |
| A QuickJS bug plus a V8 Wasm or host-import bug | One sandbox host: co-resident runs' inputs, answers and state, and the ability to **forge answers across** those runs, which per-run replay cannot detect. No credential, no network | The pool is separate from the runner and holds nothing (d8). Optional: a sandbox host per app, or Javy plus Wasmtime per step (Alternatives) |
| Escape to the node (a kernel bug) | The pool's nodes | A dedicated workload profile that hosts nothing else; optional Hyper-V per run (d8) |
| A compromised sandbox host lying in its frames | Wrong answers or values for the runs it hosts | Frames are capped, matched to their id and validated; the runner's history is authoritative (d8, I7) |
| A compromised runner (module service) | Within runs that exist and were approved: it can spend up to their ceilings and forge the answers their jobs see. It reaches no other app or run, and gets no wider grant. It cannot reach the `jobs` service's store | The edge checks its own projected grant (d5, I5); per-run ceilings and per-app budgets cap spend; every request is attributed (d6); ADR-0045 gives each server its own secrets and database |
| The owner loses access mid-run | Requests until the grant expires (24 hours by default), unless the run is stopped sooner | The expiry cap; a stop by the owner or an admin; session revocation stops runs (d4) |
| Hostile log content | Text shown to the run's owner | Stored per run, capped, never in the platform log store (d9) |

**Known residual risks.** These are accepted. They are named here so that nobody mistakes them for gaps:
- A double escape can forge answers between runs on the same sandbox host. A sandbox host per app narrows this to one app's runs.
- A compromised runner can spend within approved runs, but cannot widen them.
- Approval covers the capability, not each version of the code. An app author can change job code without re-approval, within the approved subset and limits; the user's per-run consent and the edge's checks still apply.
- A run can continue for up to its expiry cap after its owner loses access (open question 4).
- quickjs-ng issues no CVEs, so how quickly Helix learns of exposure depends on the weekly upstream watch (open question 2).

## Alternatives considered

### Other shapes

- **A platform "fetch campaign" job type, with the plan as payload (rung 0).** It handles the I/O half well, and decision 6 keeps that part. It was rejected for the control-flow half, because the plan language would grow into an interpreter.
- **The tab plans, the platform executes.** The planner stays in the browser, and only request batches become durable platform work. Any branching on an answer still needs an open tab. This is a subset of this design, not an alternative to it.
- **An admin re-approves job code by hash on every change.** The deploy path would hash each module and file an approval request whenever the code changed, showing a diff. Rejected for v1: it adds a review step to every redeploy, while the capability's subset and limits, the user's consent to each run and the edge's per-request checks already bound what any version of the code can do.
- **Run app modules inside the existing `jobs` service.** Rejected:
  - its worker process holds that server's database credentials and signing secrets, alongside the code it runs;
  - its design assumes trusted, cooperative handlers and a 60-minute deadline (`background-jobs-plane.md` §6).

  A separate named service keeps the two stores, keys and failure domains apart, at the cost of a second deployment.
- **Jobs that do their own I/O (`await env.FETCH.fetch()`).** This needs network-level containment of a live engine, and a credential channel for each run. It was spiked on workerd [workerd-io], and is recorded as a possible later stage. That stage would need its own ADR, and probably a second engine.
- **Running with the user's session, token or delegated authority.** Rejected for now; ADR-0031 stays open.
- **The status quo: browser tabs.** It is kept as the in-tab path of decision 1. It fails whenever the tab does.

### Other engines

Every candidate was held to the same requirements:
- it runs the module unchanged, from source;
- it has no ambient I/O, clock or randomness;
- it enforces limits;
- its isolation unit is no wider than one data scope;
- its build is pinned;
- it contains one bug on an unpatched install.

**workerd, Cloudflare's open-source Workers runtime, was looked at seriously, and was spiked three times** [workerd-io, workerd-noio, workerd-noio-2]. The case for it is real:
- Cloudflare is one of the largest companies building agent infrastructure, and it builds it on Workers. Choosing workerd would align Helix's module format, tooling and V8 patch stream with that ecosystem.
- Authors get the same V8 semantics as in their browser.
- It leaves an easier path to jobs that do their own I/O. The I/O spike showed that working through a deny-by-default outbound worker.

It was not chosen, because for this design the spikes found the following:
- **Self-hosted workerd enforces no limits.** Its limit enforcer is a no-op ("single-tenant policy: no limits") [workerd-io Q5]. Every limit falls to an external watchdog and cgroups, and a kill takes down every run in the process, which then has to replay [workerd-noio Q4].
- **The isolation unit is a process, not an instance.** Runs in one isolate form one trust domain: in the spike, one run polluted intrinsics and captured another's requests [workerd-noio Q10]. Safe isolation needs a container per (app, owner), created at runtime for each new owner. That sits awkwardly with ADR-0028's posture of "no per-app infrastructure at runtime" [workerd-noio-2 Q3].
- **The ambient surface is large and must be closed by hand.** A prelude must neutralise each non-deterministic global, on the global object and on every prototype in its chain. A per-upgrade audit of 83 own and 79 inherited globals gates that [workerd-noio-2 Q2, Q2(c)]. With `network = (allow = [])` alone, workerd still made a DNS lookup on any hostname the job chose [workerd-noio Q5].
- **Platform modules were reachable from job code.** A job could import the shim and drive another run's generator with forged answers. Mitigations were drafted but not verified [workerd-noio Q10; workerd-noio-2 §Could not verify].

QuickJS in Wasm closes the same surface by construction. An instance has only what the prelude installs and 19 fixed imports, and its limits are inside the engine. The price is that Helix owns a build and an upstream watch (d7), and that authors run on a different engine from their browser.

| Requirement | QuickJS in Wasm (chosen) | workerd | Javy plus Wasmtime |
|---|---|---|---|
| Isolation unit | One Wasm instance per run | One container per (app, owner) | One OS process per step |
| Limits | Inside the engine, per run | An external watchdog and cgroups; a kill takes the whole process | Deterministic fuel and a memory cap, per step |
| Ambient surface | Only what the prelude installs; 19 imports | A prelude plus a per-upgrade globals audit | Javy's fixed surface |
| One bug, unpatched | Stays in its run's instance | Reaches its container's runs | Stays in its step's process |
| Patch stream | A Helix-owned build; no upstream CVEs | Cloudflare's, including V8's | The Bytecode Alliance's; 57 Wasmtime advisories in 2026 at the time of the spike [quickjs-1 §3] |
| Paused runs between steps | Yes (sticky) | Yes (sticky) | No: every step replays, so cost grows with the square of the history length |

- **Javy plus Wasmtime** is the strongest per-step boundary, and is **kept as the named fallback** for a deployment whose threat model needs a process per step. It costs a second runtime artifact (a 60 MB CLI or a Rust sidecar), and a replay on every step [quickjs-1 Q1, Q3].
- **Native QuickJS**, as an addon or its own process, is faster. But a single QuickJS memory bug would then run native code in the host, which gives up the Wasm wall that justifies the engine.
- **The npm `quickjs-emscripten` builds as shipped** are behind on security fixes, and their memory limit does not hold (d7).
- **`isolated-vm` inside Node.** Rejected: it is in maintenance mode, and its README warns that leaked handles are "usually trivial" to turn into "a springboard back into the nodejs isolate".
- **Node's `vm` module** is not a security boundary, and Node's documentation says so.
- **Hosted engines** (Cloudflare Workers for Platforms or Workflows, Deno Subhosting). Rejected under ADR-0028, because code and data would leave the customer's cloud.

## Consequences

**For the platform:**
- **ADR-0020 is relaxed for one surface.** App-written code runs server-side, as jobs that do no I/O. Bundles stay static, and the gateway stays the only dynamic surface.
- **Engine bugs become reachable server-side for the first time.** The walls are built to contain one without a patch (Security).
- **ADR-0045 gains a second named job service** with two images, the runner and the sandbox pool. The `jobs` service is unchanged.
- **The jobs → edge callback grows** from outbound fetch to fetch, LLM and app-data operations, with per-run grant checks for module runs (d5).
- **ADR-0045's lifecycle outbox gains per-run stop records** (d4), and the callback gains a module-source operation (d2).
- **Module runs stop on more events than platform jobs** (session revocation, module-grant revocation). The jobs docs must say so (d4).
- **Rate limiting moves into the platform** (d6).
- **The pool costs money while idle.** A dedicated workload profile bills for its nodes whether or not any runs exist. The minimum node count and size are deployment settings, and the install's sizing guide should cover them.

**For app authors:**
- **Determinism is a constraint.** Violations fail explicitly, and a module can be checked locally by replaying recorded histories.
- **One job module serves a tab and the server** (d1).
- **Job code runs on a different engine from the browser.** The semantic differences are small, but debugging is harder.
- **`apps/docs/src/apps/jobs.md` changes.** Its statement that "jobs run platform-provided code only" is updated in the change that implements this ADR.

**For operations:**
- **Helix owns an engine build** and its release suite (d7).
- **Someone watches quickjs-ng's master weekly,** and engine rebuilds ship as flagged security releases.
- **Node's patch level is part of the boundary,** because V8 runs the Wasm.

## Explicit non-goals

- **Jobs that perform their own I/O.** Every effect goes through the runner.
- **Acting as the user.** There are no user-scoped app-data, delegated connections or user tokens.
- **Scheduled or standing runs.** Every run starts from a user's consent (open question 3).
- **Bytecode, imports or a module loader.** Job modules are single bundled source files.
- **Replacing ADR-0045's platform job types.** `jobs:fetch` and its successors remain the right tool when no app logic is involved.
- **Changing the `jobs` service.** Its limits, deadlines and stop semantics are untouched.

## Open questions

1. **The server name, and how modules appear in the catalogue.** This ADR writes `modules`, with each manifest module as a local type. ADR-0045's catalogue is "configuration-derived", so it would advertise the service itself, while the types come from each app's approved manifest (decision 2).
2. **Who watches upstream?** Who on the Helix team reviews quickjs-ng's master each week, and what triggers a release from a pinned commit rather than a tag?
3. **Scheduled triggers,** as standing grants ("run nightly, approved by X, until revoked"). Should they be decided here, or in their own ADR?
4. **The loss-of-access bound.** Is the default expiry cap of 24 hours acceptable, or should a deployment set it lower?
5. **Consent on the dev gateway.** The dev gateway authenticates with dev tokens. Does the developer consent in the same control-plane popup, or does the `dev` environment use a simpler local grant?
6. **Can ACA express the pool?** It needs a dedicated workload profile, a pool with no egress, a blocked identity endpoint and cgroup limits we control. If it can't, ACA dynamic sessions may be the v1 path.
7. **History and source limits.** What are the maximum history, answer and module-source sizes? Should `select` be mandatory above some threshold?
8. **`h.any`.** Should there be a variant of `h.all` that resumes on whichever answer arrives first, and records the order? In a spike, lockstep waves under a rate limit ran no faster than sequential calls [quickjs-1 Q11].
9. **quickjs-ng or Bellard QuickJS?** ng releases faster and runs test262 in CI. Bellard's is in OSS-Fuzz, and was slightly faster in the spike [quickjs-1 §1].
10. **The out-of-memory trap.** Is it in the glue or in the engine, and does quickjs-ng master's `8e14a39` fix it? The terminal-instance rule contains it either way [quickjs-2 Q1].
11. **Is the Javy plus Wasmtime fallback needed** for any customer's threat model?

## Appendix: evidence

All figures come from the spike reports in [`docs/reviews/2026-10-28-app-jobs-engine-spikes/`](../reviews/2026-10-28-app-jobs-engine-spikes/README.md). They were measured on synthetic data, mostly on a developer laptop (macOS, arm64, Docker Desktop), so ACA and production hardware may differ.

| Claim | Figure | Source |
|---|---|---|
| Starting an instance with prelude and job loaded | about 0.5–0.6 ms | quickjs-2 Q1 |
| One step, in-thread | 11–12 µs (async generator) | quickjs-2 Q1 |
| Replaying 1,000 steps | 11–12 ms in-thread; 18–19 ms across the process split | quickjs-2 Q1, Q3 |
| Memory per paused run | about 0.4–0.5 MiB, plus about 24 MiB per thread | quickjs-2 Q1, Q2 |
| Throughput | about 29k steps/s on one pool thread; about 100k steps/s on four threads with 1,000 paused runs | quickjs-2 Q2 |
| Process-split cost | about 25 µs per step at p50 | quickjs-2 Q3 |
| Thread-death recovery | 250 runs in 83–195 ms, with no step lost or duplicated | quickjs-2 Q2 |
| Eviction cliff | about 30× slower when the resident cap is below the working set | quickjs-2 Q2 |
| Helix build | about 20 s, byte-identical across runs, a 571 KB `.wasm` with 19 imports, passes the GHSA-m53g test | quickjs-2 Q1 |
| Memory limit | a 32 MiB limit stops bombs at 31 MiB with the Helix build; a job reached 2 GiB with the npm build | quickjs-2 Q1 |
| Runaway containment | a canary in another instance survived every probe | quickjs-1 Q5, Q6 |
| Crash test | after the runner and sandbox were both killed mid-run, the run resolved all 50 properties (301 calls) with no duplicate answered request | workerd-noio Q6 |
| Shared upstream | two apps on one upstream doubled each other's run time | workerd-io Q9 |
| workerd limits | none enforced when self-hosted | workerd-io Q5 |
| workerd isolation | runs sharing an isolate could pollute intrinsics and capture each other's requests | workerd-noio Q10 |
| workerd DNS | `allow = []` alone still performed host DNS lookups | workerd-noio Q5 |
| workerd containers | about 22 MiB per container; after a SIGKILL, 20 runs recovered by replay in 14 ms | workerd-noio-2 Q3 |
