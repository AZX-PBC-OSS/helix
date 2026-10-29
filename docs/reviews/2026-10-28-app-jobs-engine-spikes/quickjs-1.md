# Spike: QuickJS compiled to WebAssembly as the engine for app-authored jobs

QuickJS-in-Wasm works for the no-I/O job design and costs very little, but only under conditions. The biggest catches are:
- QuickJS's own memory limit doesn't hold;
- the npm build is 5+ quickjs-ng releases behind, including a critical fix;
- Helix would have to build and own the QuickJS Wasm file.

No git repo was touched, all data is synthetic, and nothing is left running.

**Date:** 2026-10-28 · Spike for EK Yancy · about 2 hours · Sibling: `workerd-io.md`

**Evidence tags:**
- **[observed]**: I ran it.
- **[source]**: quoted from a primary source.
- **[research]**: from a delegated desk-research pass. Items marked "re-checked" I confirmed myself through the GitHub API, raw files or npm.
- **[assumption]**: not tested.

## Versions

| Item | Version |
|---|---|
| quickjs-emscripten | `quickjs-emscripten-core@0.32.0` plus `@jitl/quickjs-ng-wasmfile-release-sync@0.32.0` (bundles **quickjs-ng v0.12.1**) and `@jitl/quickjs-wasmfile-release-sync@0.32.0` (bundles **Bellard 2025-09-13+f1139494**). Exact pins. 0.32.0 was published 2026-02-16; the release before it was 0.31.0 on 2024-09-07. |
| Javy | 9.1.0, GitHub release binary for arm-macos. sha256 matches the published `.sha256`. |
| Wasmtime | 49.0.4 (2c2970205, 2026-10-19), aarch64-macos tarball. sha256 matches the GitHub asset digest. |
| Node / OS | v24.18.0, macOS 27, arm64 |
| Stubs | `upstream.mjs` and `gateway.mjs` copied unchanged from the sibling. Upstream: 12 requests/second plus about 3% random 429s. Gateway: bucket 10/s, burst 10, daily cap 2000. Ports 18281 and 18280, so they can't collide with the sibling. |

## Summary

**What worked** [observed], on quickjs-emscripten in Node:

| Measurement | Result |
|---|---|
| Engine start per run | **0.6 ms** median in its own Wasm instance; about 9 ms for the first one in a process |
| Sticky step (yield, then resume) | **9–14 µs** |
| Replay of 1,000 recorded steps | **16–18 ms** |
| Paused run | about **120 KiB** of QuickJS heap; about **0.4 MiB** of process RSS (0.15 MiB if runs share one Wasm instance) |
| Crash recovery | SIGKILL mid-wave, restart, replay, finished **50/50 with 0 repeated requests** |
| Non-determinism | A changed memory cap and changed job code were both caught on replay |
| Plain Node | The same job module runs unchanged under a plain Node driver |

**Weaknesses that matter for the ADR:**

1. **`setMemoryLimit` doesn't work in quickjs-emscripten 0.32.0**, in either variant.
   - The emscripten build has no `malloc_usable_size`, so QuickJS counts only 8 bytes per allocation.
   - One allocation over the limit fails, but many large ones pass. With a 32 MiB limit, a job reached **2 GiB** and process RSS grew by about 2 GB.
   - What works: give each run its own `WebAssembly.Memory` with an explicit `maximum`. At 64 MiB the job got a clean out-of-memory error at 61 MiB.
2. **Deep recursion can overflow V8's native stack before QuickJS's own check fires.**
   - This happens at a QuickJS stack limit of 512 KiB or more. The error unwinds out of Wasm and leaves the QuickJS runtime corrupt; freeing it aborts.
   - At 256 KiB or less, QuickJS catches it first.
   - The rule: a small stack limit, and throw away the whole Wasm instance after any host-level fault. That only works with one instance per run.
3. **The interrupt handler stops runaway code per run, but it blocks the host thread until the deadline.**
   - It stopped `while(true)`, a try/catch/finally loop trying to survive, regex backtracking and a `sort` loop, each at the 500 ms deadline.
   - The process and a canary run survived.
4. **Supply chain is the biggest problem.**
   - The npm package ships quickjs-ng v0.12.1. Five quickjs-ng releases since then carry memory-safety fixes, including a **critical "RCE"** fix (GHSA-m53g-qx47-3h38, fixed in v0.15.0) [research, re-checked].
   - On 2026-10-11 quickjs-ng stopped accepting private security reports and stopped issuing CVEs [source, re-checked].
   - Helix would have to build and ship its own QuickJS Wasm file.
5. **Running 4 properties at once did not speed up this rate-limited workload.**

   | Runner | In flight | Wall time |
   |---|---|---|
   | QuickJS runner | 4 | 63.6–79.1 s |
   | QuickJS runner | 1 | 42.7–59.1 s |
   | Sibling spike | 1 | 42.5 s |
   | Plain Node driver, no sandbox | 4 | 62.8 s |

   The unsandboxed driver was just as slow. The cause is the lockstep `h.all` waves plus a shared AIMD pacer, not the engine.

**Javy plus Wasmtime also works, but only in replay-per-step form** [observed].
- **Limits.** Its limits are stronger and enforced from outside the guest:
  - fuel trapped a spin loop at 11 ms (1e8 fuel) or 158 ms (2e9);
  - `max-memory-size` gives a clean out-of-memory error;
  - recursion traps;
  - each step is its own process, so a trap kills only that step.
- **Costs:**
  - Each step re-runs the job from the start against the history: 4.8 ms per process start plus about 15 µs per replayed step.
  - Node has no supported Wasmtime binding, so this means a 60 MB CLI binary or a Rust sidecar.
  - Sticky mode would need a custom Rust Javy plugin.

**Recommendation:** QuickJS-in-Wasm is a credible engine for this design, on these conditions:
- one Wasm instance per run, with a hard `WebAssembly.Memory` maximum;
- a QuickJS stack limit of 256 KiB or less, plus a per-step interrupt deadline;
- steps run off the main thread;
- a Helix-owned QuickJS Wasm build that tracks upstream fixes.

Keep the container cgroup as the backstop. Javy plus Wasmtime is the fallback if the threat model needs a process per step and deterministic fuel.

## What was built

| File | What it does |
|---|---|
| `engine-qjs.mjs` | The sandbox: own Wasm instance per run, own QuickJS runtime and context, `Date` not installed, plus a trusted prelude |
| `runner.mjs` | The trusted runner, standing in for helix-jobs: validates yields, runs sticky and replay modes, keeps the history, performs requests |
| `jobs/listgen.js` | The job: tiers T0–T4, 15-call cap per property, 4 properties in flight. Uses `h.random()` to shuffle the property order, so replay is only correct if recorded values are reused. |
| `probes/*.js` | Hostile jobs |
| `node-driver.mjs` | Plain Node driver (the browser-tab stand-in) |
| `javy/` | Javy builds plus `javy/driver-tail.js`, the replay-per-step driver |
| `upstream.mjs`, `gateway.mjs`, `props.mjs` | Copied from the sibling |

**Engine details:**
- **Prelude.** It builds a frozen `h`, captures `JSON` and `Promise.prototype.then`, makes `Math.random` throw, and deletes its own globals.
- **Channel.** The only channel is strings: answer JSON in, `{done,value}` JSON out, parsed by the host's own `JSON.parse`. The one exception is a single synchronous host import, `__helix_rec(kind)`, which returns a number for `h.now()` and `h.random()`.

**Runner details:**
- **Validation.** Each yield must be `fetch` or `all` with at most 8 items. Every URL must be on `https://lookup.example.test`.
- **Requests** go proxy-style over the gateway's Unix socket, as workerd's `globalOutbound` did in the sibling. The runner applies:
  - a token-bucket pacer at the AIMD rate (start 8, +0.25 on success, halve on a 429 at most once per burst, range 0.5–20);
  - up to 8 retries;
  - a per-run call cap of 1000;
  - the `select` JSON pointer.
- **History** is `run/<runId>.history.jsonl`, appended with `fdatasync` per entry. Entry types:
  - `header`: module sha256 and input;
  - `rec`: `now`/`random` values in call order;
  - `item`: one answered request inside an unfinished wave;
  - `yield`: a completed step (request and answer);
  - `done` or `failed`.
- **Replay** starts automatically whenever a history file exists:
  - recorded values and answers are fed back;
  - a different value kind, a different request, unused records or an early return raise a `NondeterminismError`;
  - once the history runs out, the run continues live and reuses any partial `item` answers.

**Design choices the brief asked about:**
- **Async generator**, as specified. It works in both QuickJS variants; the runner drains microtasks after each `next()`. If the job awaits anything that isn't a platform yield, the runner reports an error instead of hanging. A sync generator also works and is about 4.5 µs per step cheaper; the runner accepts both.
- **Concurrency through `h.all` waves over per-property child generators inside the job.** The runner sees one generator, and the history stays one entry per wave. The cost is lockstep: each wave waits for its slowest request (see Q11).

## Part 1: Research

### 1. QuickJS vs quickjs-ng

**Bellard QuickJS** ([bellard.org/quickjs](https://bellard.org/quickjs/), [GitHub mirror](https://github.com/bellard/quickjs))
- **Releases.** Single maintainer, dated releases every 5–9 months. The latest is 2026-06-04 (re-checked against the [Changelog](https://bellard.org/quickjs/Changelog)).
- **Activity.** The mirror is now active, with outside contributors [research].
- **Features.** Claims nearly 100% of test262 for ES2025 and lists async generators as supported [source].
- **Fuzzing.** Covered by OSS-Fuzz ([projects/quickjs](https://github.com/google/oss-fuzz/tree/master/projects/quickjs)) and has a Fuzzilli target ([Targets/QJS](https://github.com/googleprojectzero/fuzzilli/tree/main/Targets/QJS)) [research].
- **Advisories.** None published on GitHub.

**quickjs-ng** ([github.com/quickjs-ng/quickjs](https://github.com/quickjs-ng/quickjs))
- **Maintainers.** Mainly saghul and bnoordhuis.
- **Releases.** Every 1–2 months. Latest: v0.17.0 (2026-09-18), v0.16.2 (2026-08-20), v0.16.1 (2026-08-04) (re-checked).
- **Testing.** test262 runs in CI ([diff page](https://quickjs-ng.github.io/quickjs/diff)).
- **Fuzzing.** Not in OSS-Fuzz; it has an in-repo fuzzer only [research].
- **Conformance numbers.** Neither project publishes a pass percentage I could verify.

**Generators** [observed]: both engines run sync and async generators. `jobs/listgen.js` behaved identically on both (31 steps, 109 requests in the smoke test).

**What the wrappers build on:**
- **quickjs-emscripten** offers both engines. Its default meta-package installs the Bellard builds; quickjs-ng is available as `@jitl/quickjs-ng-*`. Effectively one maintainer, and commits from 2026-07-23 are unreleased [research].
- **Javy** builds on rquickjs, which vendors quickjs-ng ([rquickjs](https://github.com/DelSkayn/rquickjs)) [research]. Which revision the 9.1.0 binary contains is **unverified**. Javy has had breaking major releases v6 through v9 in about 10 months.

### 2. Security record

**CVEs** [research; individual entries not re-checked]. NVD lists about 29 for "quickjs" ([NVD search](https://nvd.nist.gov/vuln/search?query=quickjs)). The bug classes:
- use-after-free (for example CVE-2023-48184, CVE-2025-62490…62496, CVE-2026-3979);
- out-of-bounds read and write (CVE-2026-0821/0822/1144/1145, CVE-2025-12745);
- type confusion;
- integer overflow in the regex engine and BigInt;
- heap overflows in the **bytecode reader** (CVE-2025-46687/46688, CVE-2026-88378).

**quickjs-ng GitHub advisories** ([advisories](https://github.com/quickjs-ng/quickjs/security/advisories)), re-checked through the API:

| ID | Date | Severity | Issue |
|---|---|---|---|
| GHSA-m53g-qx47-3h38 | 2026-05-28 | **critical** | "quickjs RCE via js_array_toReversed()" |
| GHSA-r6vf-p8wr-4vg9 | 2026-06-04 | high | Use-after-free in `set_array_length` |
| 2026-07-31 batch | 2026-07-31 | 4 high, 2 medium, 2 low | Regex out-of-memory heap overflow; TypedArray sort and Proxy integer overflows; `ArrayBuffer.transfer` use-after-free; heap address leak in `JSON.stringify`; Promise and Error out-of-memory use-after-free |

None of these fixes are in quickjs-emscripten 0.32.0 [research].

**Disclosure policy** ([SECURITY.md](https://github.com/quickjs-ng/quickjs/blob/master/SECURITY.md), re-checked): *"We no longer accept private security reports nor issue CVEs."* It also says untrusted **bytecode** is "equivalent to executing untrusted native code" and out of scope. So apps should only ever submit source, never precompiled bytecode.

**How fast fixes ship** [research]:
- quickjs-ng goes from report to fix commit in 0–2 days ([ng#1296](https://github.com/quickjs-ng/quickjs/issues/1296), [ng#1368](https://github.com/quickjs-ng/quickjs/issues/1368)). The release follows weeks later.
- Bellard has also fixed some issues the same day ([bellard#399](https://github.com/bellard/quickjs/issues/399)).
- **The real lag is downstream:** quickjs-emscripten is 5+ quickjs-ng releases behind, and rquickjs and Javy also trail.
- quickjs-emscripten, Javy and rquickjs have no published advisories. That is not evidence they are secure; quickjs-emscripten's README says it "has not been audited".

**Fuzzing:** OSS-Fuzz covers Bellard's QuickJS only. Javy's OSS-Fuzz project is only a JSON comparison fuzzer, built with sanitizers off [research].

### 3. Wasm runtime options: what the boundary actually is

**(i) quickjs-emscripten inside Node.** The attacker controls JavaScript, not Wasm; the QuickJS `.wasm` file is fixed and trusted. So most V8 and Cranelift compiler bugs, which need crafted Wasm, are out of reach. The realistic attack chain:

1. A QuickJS memory-safety bug gives read/write inside that instance's own memory.
2. The attacker abuses whatever **imports** the instance has.
3. Going further needs a **V8 Wasm bug** or a bug in a host import.

I listed the import surface [observed, `node imports.mjs`]: 20 functions plus the memory. They cover:
- abort and assert;
- clock, date and timezone;
- an emscripten timer back into the same instance;
- heap resize;
- environment variables (emscripten's fake set, not the real process environment);
- writing to the host's stdout and stderr;
- quickjs-emscripten's callbacks: calling host functions registered on that instance, the interrupt check, the module loader, and freeing host references.

There is no file or network access.

**With one instance per run, a QuickJS compromise can reach only:**
- that run's own state;
- the host clock (a non-determinism source);
- the host's stderr;
- its own `__helix_rec`;
- memory up to the instance maximum.

**With a shared instance**, it can reach every other run's heap in that instance. So: one instance per run.

**Patching V8.** Node trusts the Wasm and JavaScript it runs ([Node SECURITY.md](https://github.com/nodejs/node/blob/main/SECURITY.md)), and V8 fixes arrive only through Node upgrades. V8 Wasm escapes do happen; for example CVE-2024-2887, a Pwn2Own Wasm type confusion ([NVD](https://nvd.nist.gov/vuln/detail/CVE-2024-2887)) [research].

For contrast, Node says `node:vm` "is not a security mechanism" ([docs](https://nodejs.org/api/vm.html)). QuickJS-in-Wasm is much stronger than `vm`, because the guest's objects live in Wasm memory with no references to host objects.

**(ii) Javy plus Wasmtime.**
- **Process and support.** The Bytecode Alliance has a dedicated security process ([docs.wasmtime.dev/security](https://docs.wasmtime.dev/security.html)). Wasmtime ships monthly; every 12th release is long-term support for 24 months ([release policy](https://docs.wasmtime.dev/stability-release.html)) [research].
- **Advisory record.** 81 advisories in total, **57 of them in 2026** (re-checked through the API). Critical ones include:
  - GHSA-jhxm-h53p-jm7w: aarch64 compiler bug allowing a sandbox escape, 2026-04;
  - GHSA-xx5w-cvp6-jv83: in the non-default Winch compiler;
  - GHSA-32h6-97mm-8q3c: component-model async, 2026-10-02;
  - GHSA-mghf-wjfp-p5xm and GHSA-897f-g5gm-fmxm, both 2026-10-19 and both fixed in the 49.0.4 I pinned.

  Most need crafted Wasm, so they are not reachable from JavaScript inside a fixed Javy module. The exception is a fuel-accounting bypass, GHSA-m63x-6p34-q65x, which matters if fuel is the CPU limit [research].
- **Limits.** Fuel is deterministic. Epoch interruption is 2–3 times cheaper but not deterministic. Memory limits come from `StoreLimits` or `-W max-memory-size` [research].
- **Start-up and snapshots.** About 5 µs to instantiate with copy-on-write heap images and pre-instantiation, a published figure for SpiderMonkey.wasm ([Wasmtime 1.0 performance](https://bytecodealliance.org/articles/wasmtime-10-performance)). Wizer is now built into Wasmtime [research].
- **Fit for this design.** Javy modules read stdin and write stdout, then exit. Its exported functions take "no arguments and no return values", and "generators are not supported" ([exports doc](https://github.com/bytecodealliance/javy/blob/main/docs/docs-using-exports.md); confirmed by `javy build -C help` [observed]). Keeping a generator paused across host calls needs a custom Rust plugin.
- **Node binding.** None: the npm `wasmtime` package is a 0.0.2 placeholder [research].

**(iii) Others** [research]:
- **Wasmer 7.5:** WASI/WASIX filesystem bypasses, plus missing bounds checks on atomics.
- **WAMR 2.4.5:** a critical WASI heap overflow, CVE-2026-54914.
- **wasmi v2:** an interpreter with built-in fuel, audited twice, but it had a critical out-of-bounds write (CVE-2024-28123) and a use-after-free (CVE-2025-66627).
- **WasmEdge:** thin disclosure history.

None beats Wasmtime here.

**Comparison** (observed numbers are from this spike):

| | Boundary | CPU limit | Memory limit | Start-up | Snapshot |
|---|---|---|---|---|---|
| quickjs-emscripten in Node | Wasm memory sandbox in the runner's own process and thread. Escaping needs a V8 Wasm bug or a host-import bug. V8 is patched only by upgrading Node. | QuickJS interrupt handler: cooperative, per run, blocks the thread until the deadline | **Only a `WebAssembly.Memory` maximum works**; `setMemoryLimit` is broken | 0.6 ms per run (own instance); 0.3 ms in a shared instance | None (issue #152 open). Not needed, since replaying 1,000 steps takes 18 ms. |
| Javy plus Wasmtime CLI | Wasmtime sandbox **plus an OS process per step**. Strongest security process; many 2026 advisories, mostly needing crafted Wasm. | Fuel (deterministic) or timeout; traps kill only that step | `-W max-memory-size`, clean out-of-memory error | 4.8 ms per step process (precompiled), 10.9 ms otherwise | Wizer, built in |
| Wasmtime embedded (Rust or C sidecar) | Same, without the process unless you add one | Fuel or epoch | `StoreLimits` | Microseconds [research] | Wizer |
| Wasmer, WAMR, wasmi | Weaker or less-studied records | Metering, instruction count or fuel [unverified] | Config | n/a | n/a |

### 4. Production users [research]

- **Shopify Functions.** Untrusted third-party app code, run on Shopify's servers for many tenants.
  - Javy (QuickJS) on Wasmtime, with Wizer and dynamic linking ([Shopify Engineering](https://shopify.engineering/javascript-in-webassembly-for-shopify-functions)).
  - It relies on hard limits ([Functions API](https://shopify.dev/docs/api/functions)): 256 kB module, 10,000 kB memory, **11M instructions**, 128 kB input, 20 kB output.
  - Each call runs to completion, with no paused state. *I did not re-fetch these limits.*
- **Figma plugins.** Client-side, so the risk is per user, not a shared server. Figma moved to "a JavaScript VM written in C and cross-compiled to WebAssembly" after an escape from its earlier sandbox ([Figma](https://www.figma.com/blog/an-update-on-plugin-security/)); quickjs-emscripten's README says this was QuickJS. Whether Figma still uses it is **unverified**.
- **Extism JS PDK:** quickjs-ng via rquickjs plus Wizer ([js-pdk](https://github.com/extism/js-pdk)).
- **Counterexamples:**
  - Fastly and Spin use SpiderMonkey, not QuickJS.
  - AWS LLRT runs QuickJS natively, not in Wasm, and is not a sandbox.

I found no production user running **paused** QuickJS generators for multi-tenant server-side jobs. Shopify is the closest, and it runs to completion.

### 5. Operational fit for Helix

**Option A: quickjs-emscripten in Node.**
- **What it is.** A Node dependency in the `helix-jobs` image, about 2.3 MB of `node_modules` for the three packages [observed].
- **Same language.** No second toolchain (ADR-0045 open question 1).
- **But Helix must own the Wasm build.** The npm build is 5+ security releases behind, so shipping it as is means every install starts out with known memory-safety bugs. The plan would be:
  - build quickjs-ng (or Bellard) to Wasm in Helix CI with emscripten, from a pinned upstream commit, reusing or forking quickjs-emscripten's C glue;
  - fix `malloc_usable_size` while there;
  - watch the quickjs-ng issue tracker, because there is no CVE feed;
  - re-release Helix when a fix lands.

  That is a real, ongoing cost [assumption on effort].
- **V8 patches** come with the Node base image, which Helix already tracks.

**Option B: Javy plus Wasmtime.**
- **Binaries.** Ship the `wasmtime` CLI: 60 MB on macOS arm64 [observed], about 68 MB on Linux x86_64 [research]. A 3.3 MB `wasmtime-min` exists; I didn't test it.
- **Build step.** Javy (35 MB) compiles each app's job at build time. Alternatively, ship Javy's shared 1.3 MB plugin and build tiny modules (7.7 KB for ListGen) [observed].
- **Hosting.** With no Node binding, Wasmtime runs either as a child process per step (what I measured) or as a Rust sidecar, which reopens the second-language question.

**Unpatched installs.** Customers pull patches, so some installs will run old builds. What a known QuickJS bug gives an attacker:

| | One Wasm instance per run | Shared instance | Wasmtime CLI |
|---|---|---|---|
| A known QuickJS bug reaches | That run's own state, plus clock read, stderr writes and its own host functions | Every other run's heap in that instance | That step's process: stdin, stdout, clock; no directories |
| To reach the `helix-jobs` process | Also needs a V8 Wasm bug or a host-import bug | Same | Also needs a Wasmtime bug |

In every case, keep the sibling's container sandbox (cgroup, read-only root, no network except the gateway socket, all capabilities dropped) as the backstop. By design the runner holds no upstream credential: the gateway injects the per-run token.

## Part 2: Spike answers

### Q1. Instantiate time [observed] (`node bench.mjs instantiate`)

| quickjs-emscripten | ng | Bellard |
|---|---|---|
| Compile the `.wasm`, once per process | 1.05 ms (V8 compiles the rest lazily) | 1.19 ms |
| New Wasm instance only, median / p95 | 0.16 / 0.97 ms | 0.17 / 0.72 ms |
| **Own instance + runtime + context + prelude + job module, median / p95** | **0.64 / 1.25 ms** | **0.57 / 1.20 ms** |
| New runtime in a shared instance | 0.30 ms | 0.29 ms |
| First run in a fresh process | 8.9 ms | 9.4 ms |

- **Snapshots:** quickjs-emscripten has none. At 0.6 ms, one isn't needed.
- **Javy/Wasmtime**, one full step process (spawn, Wizer-preinitialised QuickJS, first step):

  | Module | Median per step |
  |---|---|
  | Precompiled `.cwasm` | 4.8 ms |
  | `.wasm`, compiled each time | 10.9 ms |

  Peak memory for one step process was 7.7 MB.
- **workerd sibling:** 9.6 ms median cold start for a process.

### Q2. Sticky per-step overhead [observed] (`node bench.mjs step`)

Each step: the job yields, the host parses the request, stringifies the answer, and resumes the job, including one `h.now()` call. 20,000 steps:

| | Async generator | Sync generator |
|---|---|---|
| quickjs-ng 0.12.1 | 13.6 µs | 8.9 µs |
| Bellard 2025-09-13 | 11.3 µs | 7.3 µs |

For scale, the 50-property job has 79–85 steps, so the engine costs about 1 ms of a 40–80 s run.

### Q3. Replay time against history length [observed] (`node bench.mjs replay`, `node javy-bench.mjs replay`)

Each run uses a fresh engine, reads the history file, and re-executes every step with the network set to throw (median of 5):

| History steps | ng | Bellard | Javy/Wasmtime (one process) |
|---|---|---|---|
| 10 | 5.4 ms | 1.1 ms | 5.5 ms |
| 100 | 4.7 ms | 3.2 ms | 6.2 ms |
| 1,000 | **18.2 ms** | **15.5 ms** | **18.4 ms** |

- After the fixed cost, growth is linear at about 13–15 µs per step.
- Replaying the real 50-property history (about 127 steps, 661 entries, 128.5 KiB) took 18–36 ms.
- **Javy's replay-per-step mode grows with the square of the step count over a run.** The 128-step ListGen used about 1.0 s of engine time in total, with the last step at 10.6 ms. Fine at this size; a 1,000-step job would be roughly 10+ s [extrapolated].

### Q4. Memory per paused run [observed] (`node --expose-gc bench.mjs memory …`)

ListGen was paused after 10 waves. One paused run's QuickJS heap was **121 KiB** (ng) or 112 KiB (Bellard).

| Paused runs | Mode | Process RSS increase | Per run (marginal) |
|---|---|---|---|
| 1 | Own instance (ng) | 28.8 MiB (mostly one-time V8 code) | n/a |
| 100 | Own instance (ng) | 75.5 MiB | about 0.47 MiB |
| 100 | Shared instance (ng) | 60.8 MiB | about 0.33 MiB |
| 100 | Own / shared (Bellard) | 66.8 / 55.2 MiB | |
| 1,000 | Own instance (ng) | 405 MiB | **0.38 MiB** |
| 1,000 | Shared instance (ng) | 176 MiB | 0.15 MiB |

- Each own instance reserves 16 MiB of Wasm memory but touches far less.
- On Linux, V8 also reserves large guard regions per Wasm memory, which is address space only [assumption]. I didn't test past 1,000 instances.
- **Javy has no paused runs.** Between steps the state is the history, about 1 KB per step; each step process peaks at 7.7 MB.
- **workerd sibling:** about 30 MB per idle process.

### Q5. Runaway code [observed] (`node probes.mjs ng|bellard`)

The limit is a per-step deadline enforced by the QuickJS interrupt handler, set to 500 ms in the probes. Results were the same on both variants:

| Probe | Result |
|---|---|
| `while(true){}` in step 2 | "interrupted" at **502 ms** |
| The same loop inside try/catch/finally, three times | Interrupted at 502 ms. **Not catchable**: the job never reached its next yield. |
| Catastrophic regex backtracking `/(a+)+$/` | Interrupted at 501 ms, inside the regex engine |
| `sort` loop (a built-in calling back into JavaScript) | Interrupted at 503 ms |

- **Scope.** Only that run dies. A canary run in another Wasm instance kept working, and the process survived.
- **But steps run synchronously on the runner's thread.** For those 500 ms, every other run on that thread is stalled. Production needs a short step deadline (100–250 ms), a per-run CPU budget added up by the runner, or steps in `worker_threads` [not built].
- **Javy/Wasmtime** (`node javy-bench.mjs limits`):
  - fuel of 1e8 traps with "all fuel consumed" in **11 ms**, and 2e9 in 158 ms;
  - a 500 ms timeout traps at about 690 ms of process time;
  - only that step's process dies.

  Fuel is deterministic, but in replay-per-step mode a step's fuel also pays for re-running the whole history, so the budget must grow with history length.
- **workerd sibling:** no limit at all; the whole process blocked for 24 s.

### Q6. Memory bomb [observed] (`probes.mjs`, `memlimit-check*.mjs`)

**`setMemoryLimit` doesn't hold.** With a 32 MiB QuickJS limit and the default 2 GiB Wasm maximum, on both variants:

| Bomb | Result |
|---|---|
| String doubling | "string too long" in 1 ms (QuickJS's own string-length cap) |
| 8 MiB ArrayBuffers | Out of memory only when Wasm memory **reached 2,048 MiB**; process RSS **+1,987 MiB** |
| 1 MiB chunks (ArrayBuffer, Uint8Array, string, number arrays) | 1,935–2,042 chunks (about 2 GiB) before out of memory |
| Small objects | Out of memory at about 1.05M objects, 143–172 MiB |
| Catch the out-of-memory error and continue | Caught at 2,042 MiB, then the job yielded and finished normally |

**Cause.** The behaviour is observed; the mechanism is inferred from the dump text:
- `dumpMemoryUsage()` prints "malloc_usable_size unavailable".
- One 40 MiB allocation fails, 31 MiB succeeds, and 40 × 1 MiB succeed.
- QuickJS then reports 42,009,826 bytes used against a limit of 33,554,432.

**What works: a hard maximum on each instance's Wasm memory**, passed in as `wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 64 MiB })`:

| Bomb with a 64 MiB maximum | Result |
|---|---|
| ArrayBuffers | Out of memory at **61 MiB**, after 7 ms |
| Small objects | Out of memory at 63 MiB. On ng the error came back as `null`, because it struck while building the exception. Still contained. |

- **Scope is per run.** The canary survived every bomb.
- Without the Wasm maximum, one run can push the whole process past 2 GB. In a container sized for many runs, that gets everything killed.
- **Javy/Wasmtime:** a 16 or 64 MiB `max-memory-size` gives "out of memory" inside JavaScript after 5–9 ms, a clean failure of that step.
- **workerd sibling:** no per-isolate cap, and `--max-old-space-size` doesn't cover ArrayBuffers.

**Recursion and stack** (`stack-check.mjs`, default Node stack):

| QuickJS stack limit | Result |
|---|---|
| Disabled, 512 KiB or 1 MiB | **V8's** "Maximum call stack size exceeded" unwinds out of Wasm. The QuickJS runtime is left inconsistent: freeing it aborts with an assertion failure. |
| 256, 64 or 16 KiB | Caught inside the VM as a catchable error. The runtime stays usable. |
| 1 MiB with `node --stack-size=4000` | QuickJS catches it first; the margin depends on how deep the host stack already is. |

The engine now defaults to 256 KiB, and marks an instance as unusable after any host-level error.

**Javy:** deep recursion trapped with "call stack exhausted", and only that step's process died.

### Q7. Escape surface [observed] (`probes/escape.js`, `javy/escape.js`)

**Globals (quickjs-ng):**
- **Errors:** `AggregateError`, `Error`, `EvalError`, `InternalError`, `RangeError`, `ReferenceError`, `SyntaxError`, `TypeError`, `URIError`
- **Buffers and typed arrays:** `ArrayBuffer`, `SharedArrayBuffer`, `DataView`, `BigInt64Array`, `BigUint64Array`, `Float16Array`, `Float32Array`, `Float64Array`, `Int8Array`, `Int16Array`, `Int32Array`, `Uint8Array`, `Uint8ClampedArray`, `Uint16Array`, `Uint32Array`
- **Core objects:** `Array`, `Boolean`, `Function`, `Iterator`, `JSON`, `Map`, `Math`, `Number`, `Object`, `Promise`, `Proxy`, `Reflect`, `RegExp`, `Set`, `String`, `Symbol`, `WeakMap`, `WeakSet`
- **Values:** `Infinity`, `NaN`, `undefined`, `globalThis`
- **Functions:** `decodeURI`, `decodeURIComponent`, `encodeURI`, `encodeURIComponent`, `escape`, `unescape`, `eval`, `isFinite`, `isNaN`, `parseFloat`, `parseInt`, `queueMicrotask`

Bellard has the same set, minus `queueMicrotask` and plus `BigInt`.

**What a job cannot reach:**
- **Absent:** `Date`, `performance`, `setTimeout`, `setInterval`, `fetch`, `XMLHttpRequest`, `WebSocket`, `process`, `require`, `module`, `std`, `os`, `print`, `console`, `scriptArgs`, `WebAssembly`, `Atomics`, `WeakRef`, `FinalizationRegistry`, `navigator`.
- **Platform internals** are deleted before the job loads. `h` is frozen and has only `fetch`, `all`, `now` and `random`.
- **`Math.random()`** throws "Math.random is disabled in jobs; use h.random()".
- **Dynamic `import()`** of `std`, `os`, `qjs:std`, `qjs:os`, `node:fs`, `fs` and `https://…` all fail with "could not load module", because no module loader is installed. Importing `./job.js` returns the job's own module, which is harmless.
- **`Function("return this")()`** returns the sandbox's own global. The constructor-chain trick finds no `process`.

**`eval` and `new Function` work**, but they compile inside the same sandbox, so they add nothing. They can be switched off if wanted.

**No network and no filesystem:** the context has no such APIs, the Wasm imports have no file or socket calls, and the only way out is the runner, which allowlists the destination.

**Javy, by contrast,** exposes **real** `Date` and `Math.random` (through the WASI clock and random calls), plus `console`, `TextEncoder`, `TextDecoder` and `Javy.IO`. My driver removes or overrides them. Javy's imports are WASI environment, clock, file-descriptor read/write/seek/close and exit, with no directories opened and no sockets.

### Q8. Crash recovery [observed] (`node crash.mjs <id> <ms>`)

**Kill at a wave boundary (20 s):**

```
at crash: {"completedSteps":21,"recs":50,"answeredItems":84,"upstreamCallsSoFar":92,"lastEntry":"yield"}
after restart: {"processed":50,"jobCalls":301,"replayedSteps":21,"replayedRecs":50,"reusedItems":0,"liveSteps":55,
  "firstLiveStepAfterRestart":"21/0","repeatedAlreadyAnsweredRequests":0,"upstreamCallsTotal":323}
gateway log: upstream calls for this runId = 323
```

**Kill mid-wave (14.27 s):**

```
at crash: {"completedSteps":11,"recs":50,"answeredItems":45,"upstreamCallsSoFar":50,"lastEntry":"item"}
after restart: {"processed":50,"jobCalls":301,"replayedSteps":11,"replayedRecs":50,"reusedItems":1,"liveSteps":66,
  "firstLiveStepAfterRestart":"11/1","repeatedAlreadyAnsweredRequests":0,"upstreamCallsTotal":325}
gateway log: upstream calls for this runId = 325
```

- Replay used the recorded shuffle values and every recorded step with no network.
- It reused the one already-answered request from the unfinished wave and resumed live at step 11, item 1.
- The runner's call log and the gateway log agree exactly.
- A request can only be repeated if it was sent but not yet recorded when the process died: at most one per in-flight slot. The sibling spike redid the whole in-flight property.

**Caveat found along the way:** my first mid-wave attempt hit the gateway's 2,000-per-day cap, used up by earlier runs. The job counted 44 refused lookups as "misses with error" and still reported 50 processed. I discarded that result (`results/crash-midwave-INVALID-daily-cap.txt`). **The job contract should make a platform refusal terminal, or at least visible**, not just a 429 answer.

### Q9. Non-determinism detection [observed] (`node nondet.mjs`)

| Scenario | Result |
|---|---|
| `h.random()` and `h.now()` used correctly; full replay | ok: 5 steps and 6 values replayed, identical result |
| Correct use; crash after 1 step; replay then continue live | ok: 1 replayed, 4 live |
| Job picks a URL from how many MiB fit before running out of memory; same 64 MiB cap | ok: deterministic at a fixed configuration |
| **Same job, but the operator changed the cap from 64 to 48 MiB before restart** | **Caught**: step 0's request differs from history |
| WeakRef / FinalizationRegistry garbage-collection probe | Not present in this sandbox, so deterministic |
| **Job code changed between crash and restart** | Module-hash warning, then **caught** at step 5: 1 recorded value was never used |
| ListGen using `Date.now()` | Fails at once: "Date is not defined" |
| ListGen using `Math.random()` | Fails at once: "Math.random is disabled in jobs" |

**Sources of non-determinism left in the sandbox:** none at a fixed configuration and engine build. The ones that exist depend on configuration:
- the memory cap, which a job can observe by catching out-of-memory;
- the stack limit, observable by catching a stack overflow;
- the engine version, through built-in behaviour.

The interrupt is not a source, because it cannot be caught.

**Policy to adopt:**
- Pin the engine build, memory cap and stack limit in the run header.
- Refuse to resume when the module hash differs, instead of just warning.
- Note that detection is lenient: a changed program that issues the same requests replays silently, as happened for steps 0–4 above.

### Q10. The same module under plain Node [observed] (`node node-driver.mjs 50`)

The driver imports `jobs/listgen.js` as is. It supplies an `h` whose `fetch` and `all` return plain descriptions and whose `now` and `random` are `Date.now` and `Math.random`, and it sends the requests itself:

```
{"driver":"plain node, no sandbox","wallMs":62821,"steps":79,"calls":321,"backoffs":20,"processed":50,
 "hits":{"T0":6,"T1":12,"T2":4,"T4":24,"T3":1},"misses":3,"jobCalls":301,"waves":79}
```

The job file is byte-identical to the sandboxed one; nothing in it depends on QuickJS. In a browser tab, the tab's own `fetch` to the fetch-proxy would play the driver's role [assumption: not run in a browser].

### Q11. End-to-end [observed] (`runner.mjs`, `e2e-series.sh`)

All runs: 50 properties, ng, through the gateway; upstream at 12 requests/second with about 3% random 429s; gateway bucket 10/s.

| Run | In flight | Wall time | Calls sent | Back-offs | Steps | Job calls | Result |
|---|---|---|---|---|---|---|---|
| e2e1 (halve on every 429) | 4 | 63.9 s | 321 | 20 | 79 | 301 | 50/50 |
| e2e2 (halve once per burst) | 4 | 63.6 s | 323 | 22 | 84 | 301 | 50/50 |
| ser-c4-a / b / c | 4 | 79.1 / 73.0 / 64.6 s | 326 / 325 / 323 | 25 / 24 / 22 | 76–85 | 301 | 50/50 |
| ser-c1-a / b | 1 | **42.7** / 59.1 s | 316 / 320 | 15 / 19 | 301 | 301 | 50/50 |
| Plain Node driver, no sandbox | 4 | 62.8 s | 321 | 20 | 79 | 301 | 50/50 |
| workerd sibling (sequential) | 1 | 42.5 s | 301 (as counted by the job) | 14 | n/a | 301 | 50/50 |

- **The engine is not the bottleneck:** about 1 ms of engine time per run, and the unsandboxed driver is just as slow.
- **The limit is the rate pacer.** Running 4 at once didn't help because the upstream's rate limit, not its latency, is the constraint. Lockstep waves plus 429s that arrive together gave more back-offs (20–25 against 15–19). Variance is large, with only 2–5 samples per setting.
- **For the ADR:** concurrency only pays when upstream latency dominates. If it's wanted, the protocol needs an "any" yield (resume on the first answer to arrive, with the arrival order recorded) instead of `h.all` waves [not built].

## Surprises

1. **`setMemoryLimit` doesn't limit memory** in quickjs-emscripten 0.32.0, in either variant. One run reached 2 GiB. Only a Wasm memory maximum per instance caps it.
2. **V8's stack overflows before QuickJS's own stack check** at 512 KiB or more, and that corrupts the runtime. The safe pattern is a small QuickJS stack plus discarding the instance on any host-level fault. A shared instance would turn one run's fault into everyone's.
3. **The npm release is 5+ quickjs-ng releases behind**, including a critical fix, and **quickjs-ng no longer issues CVEs**. A CVE scanner won't tell customers they're exposed.
4. **The interrupt is uncatchable**, and it also stops regex backtracking and `sort` callbacks, which is better than I expected. But it still blocks the thread for the full deadline.
5. **Javy exposes a real clock and random source** through WASI. Its `-C deterministic` option only affects build-time setup, and Javy cannot export a resumable generator.
6. **A precompiled Wasmtime module must be compiled with the same fuel setting it runs with**, or it fails to load. In replay-per-step mode, fuel must also pay for the whole history replay.
7. **Running 4 at once was slower than 1** under the same rate limit. Halving once per burst didn't fix it.
8. **A daily-cap refusal silently became "processed, miss with error".** The job contract needs a terminal "platform refused" outcome.
9. **The Wasmtime 49.0.4 I pinned was itself a security release** (a critical aarch64 fix), and Wasmtime has had 57 advisories in 2026.

## Recommendation for the "QuickJS engine" ADR's engine section

**Engine: QuickJS in Wasm, run inside Node in `helix-jobs`,** using quickjs-emscripten's C glue but **a Wasm file Helix builds itself** from a pinned quickjs-ng (or Bellard) commit.

**Why:**
- Sticky mode is natural: a paused generator stays in memory at about 0.4 MiB per run.
- It's the same language and toolchain as the rest of Helix.
- Start-up (0.6 ms) and replay (18 ms per 1,000 steps) are cheap enough that crash recovery costs almost nothing.

**Which engine:** lean towards quickjs-ng, for its faster releases, test262 CI and same-day fixes. Bellard has OSS-Fuzz and was slightly faster here (7.3 against 8.9 µs per step). The choice isn't load-bearing; owning the build is.

**What an install must ship:**
1. **The `helix-jobs` image:**
   - Node, whose patch level is part of the security boundary;
   - a pinned `quickjs-emscripten-core`;
   - one Helix-built `quickjs.wasm`, recorded with its upstream commit and sha256, with `malloc_usable_size` fixed so `setMemoryLimit` also works, and with no `std` or `os` modules.
2. **The trusted prelude and runner**, with no module loader. Apps submit source only, never bytecode.
3. **The sibling's container sandbox as the backstop:**
   - cgroup memory and CPU limits;
   - read-only root;
   - no network except the gateway socket;
   - all capabilities dropped;
   - a non-root user.

**Limits it can enforce:**

| Limit | Mechanism | Scope | Evidence |
|---|---|---|---|
| Memory per run | A Wasm memory maximum per instance (for example 64 MiB, Shopify-like). **Not** `setMemoryLimit` alone. | Per run | Q6 |
| Stack | QuickJS stack limit of 256 KiB or less; any host-level error marks the instance unusable and it is discarded | Per run | Q6 |
| CPU per step | Interrupt deadline of 100–250 ms; uncatchable | Per run, but blocks its thread for the deadline | Q5 |
| CPU per run | The runner adds up step time, plus a wall-clock budget | Per run | design |
| Isolation between runs | **One Wasm instance per run, never shared** | Per run | Q4, Q6, imports |
| Determinism | No `Date`; `Math.random` throws; `h.now()`/`h.random()` recorded; engine build, caps and module hash pinned in the run header; resume refused on mismatch | Per run | Q9 |
| Calls and spend | Runner: per-run cap, AIMD, token bucket. Gateway: allowlist, global bucket, daily cap. Refusals reach the job as a terminal outcome. | Per run / per app | Q11, Q8 caveat |
| Whole-process backstop | cgroup memory and CPU limits, plus a watchdog | Whole container | sibling |

**Also needed:**
- Run steps in `worker_threads`, with a pool sized to the CPU cores [not built]. A spinning step stalls its thread for up to the deadline.
- Make the history the durable record, stored in ADR-0045's Postgres jobs schema rather than a file.
- Allow at most one live runner per run, using a lease as in ADR-0045.

**Fallback, and when to choose it:** Javy plus Wasmtime, with one OS process per step and deterministic fuel. Choose it if the threat model requires that a QuickJS bug *plus* a V8 Wasm bug still can't reach the runner process. The costs:
- a second runtime artifact: the 60 MB CLI, or a Rust sidecar;
- replay-per-step mode, whose cost grows with the square of the step count, or a custom Rust plugin for sticky mode;
- fuel budgets that must grow with history length.

**Compared with workerd** (the sibling ADR), QuickJS-in-Wasm wins on:
- built-in per-run CPU and memory limits (self-hosted workerd has none);
- no clock at all (workerd's clock isn't frozen);
- replay and determinism;
- density: about 0.4 MiB against about 30 MB per unit.

It loses on:
- supply-chain maturity: a single-maintainer wrapper, a quickjs-ng project with no CVE feed, and Helix having to own the Wasm build;
- raw JavaScript speed, which doesn't matter for a no-I/O planner.

## Could not verify

- **Javy internals:** which rquickjs and quickjs-ng revision the Javy 9.1.0 binary contains.
- **Exploitability:** whether GHSA-m53g-qx47-3h38, or any other listed bug, can be exploited from JavaScript in the quickjs-emscripten 0.32.0 build. I didn't attempt a proof of concept. "RCE" inside Wasm means control within that one instance.
- **Research items not re-checked by me:**
  - the individual NVD CVE entries, and the dates for the CVE-2025-6249x batch;
  - Shopify's limits and Figma's current engine.
- **Scale:** V8's address-space use with thousands of Wasm memories on Linux. I only tested up to 1,000 instances, on macOS.
- **Building quickjs-ng to Wasm** myself, and the effort to maintain that build. No emscripten toolchain was installed.
- **Not built or tried:**
  - running steps in `worker_threads`;
  - Wasmtime embedded in Rust (no Rust toolchain available);
  - `wasmtime-min` and its pooling allocator;
  - a real browser tab (only the plain Node driver was run).
- **Linux and container measurements:** everything here ran on macOS arm64. The sibling's container setup was not re-run.
- **Statistical confidence on end-to-end wall time:** only 2–5 samples per setting, with large variance.
- **`fdatasync` cost** was not isolated. It runs once per history entry (about 660 per run) and was not noticeable next to the pacing.
- **The `malloc_usable_size` explanation** comes from the QuickJS dump text plus the observed behaviour. I didn't read it in the C source.