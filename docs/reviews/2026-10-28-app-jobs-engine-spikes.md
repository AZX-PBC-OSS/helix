# App-authored jobs engine spikes — 2026-10-28

Five time-boxed spikes tested two engines for running app-written job code that
does no I/O: QuickJS compiled to WebAssembly, and self-hosted workerd. Both ran
the same job, which yields requests that a trusted runner performs, records and
replays. Both engines can run that design. They differ in where limits are
enforced and in how far one bug reaches. [ADR-0053](../adr/0053-app-authored-jobs.md)
chooses QuickJS in Wasm and cites this document as `[spikes §n]`.

## Setup

- **Job.** A ListGen-shaped resolver over 50 synthetic properties: per property, a
  ladder of lookups that stops at the first hit. One answered call is one step.
  A full run made 301 answered calls.
- **Stubs.** The upstream allowed 12 requests per second and returned about 3%
  random 429s. The gateway stub had a 10/s token bucket and a daily cap of 2,000.
  All data was synthetic.
- **Machine.** macOS arm64, Node v24.18.0, Docker Desktop for container runs.
  Nothing was measured on Linux, in ACA or under cgroup CPU quotas.
- **Versions.**
  - quickjs-emscripten 0.32.0 from npm, which bundles quickjs-ng v0.12.1 and Bellard 2025-09-13.
  - A Helix-style build of quickjs-ng v0.17.0.
  - Javy 9.1.0 and Wasmtime 49.0.4.
  - workerd `1.20261014.1`, with esbuild 0.25.10.

## Reproduce and inspect

The spikes ran in a local throwaway workspace and are not preserved on a branch.
Re-running one means rebuilding it from the setup above.

The QuickJS Wasm build is one shell script around the pinned
`emscripten/emsdk` image. It joins the module service's implementation, not this
record. Every figure below was measured unless it is marked as research or an
assumption.

## Observed outcomes

These are single-machine runs with small sample counts, not load benchmarks.

| Scenario | QuickJS in Wasm | workerd |
| --- | --- | --- |
| Start a run | 0.5–0.6 ms in its own instance | 10–17 ms for a cold process |
| One step with the run kept in memory | 11–12 µs | about 0.08 ms |
| Replay 1,000 recorded steps | 11–12 ms in-thread; 18–19 ms across a process boundary | 2.5 ms, cold process |
| Memory per paused run | about 0.4–0.5 MiB RSS | 13–27 KB idle; up to about 340 KB RSS mid-wave (20 runs, an upper bound) |
| `while(true){}` in a step | Interrupted at the deadline, and job code cannot catch it. A canary run survived | Never stopped by the engine; the process blocked for 24 s. Only SIGKILL stops it, and that kills every run in the process |
| Memory bomb | npm build: a 32 MiB limit let a job reach 2 GiB. Helix build: stopped at 31 MiB. A Wasm memory maximum gives a clean out-of-memory error | No engine limit. cgroup memory kills the container; `--max-old-space-size` aborts the process and ignores ArrayBuffers |
| SIGKILL mid-run, then replay | All 50 properties resolved, 0 answered requests repeated | All 50 properties resolved, 0 duplicates |
| Changed code or config mid-run | Caught on replay | Caught on replay |
| Two runs in one isolation unit | One Wasm instance per run; nothing shared | Runs sharing an isolate stole each other's requests (§3) |
| End to end, 50 properties | 42.7–79.1 s, bound by the rate limit | 36.8–42.5 s, bound by the rate limit |

## 1. QuickJS in Wasm: the engine

- **Limits work per run, with conditions.**
  - The interrupt handler stopped `while(true)`, a loop wrapped in
    try/catch/finally, catastrophic regex backtracking and a `sort` callback loop,
    each within 3 ms of the 500 ms deadline. Only that run failed.
  - The step runs synchronously, so every other run on the same thread waits
    until the deadline.
  - At a QuickJS stack limit of 512 KiB or more, V8's own stack overflowed first
    and left the runtime corrupt. At 256 KiB or less, QuickJS caught it.
- **The npm build's memory limit does not hold.** The emscripten build lacks
  `malloc_usable_size`, so QuickJS counted 8 bytes per allocation. A hard
  `WebAssembly.Memory` maximum per instance is the guarantee.
- **What a job can reach.**
  - Present: ECMAScript built-ins only.
  - Absent: `Date`, timers, `fetch`, `process`, `require`, `std`, `os`, `console`,
    `WebAssembly`, `Atomics`, `WeakRef` and `FinalizationRegistry`.
  - No module loader is installed, so every dynamic `import()` of a platform or
    system module failed.
  - `Math.random` was replaced with a throwing stub.
  - The Helix build has 19 Wasm imports, none of them file or socket calls.
- **No source of non-determinism** was found at a fixed configuration. A changed
  memory cap and changed job code were both caught on replay.
- **A Helix-owned build works.**
  - quickjs-ng v0.17.0 built in 18–19 s, to a 571,346-byte `.wasm`, byte-identical
    across two builds.
  - It loads into the stock `quickjs-emscripten-core` through a six-line variant
    object.
  - It needs a Helix patch of about 40 lines, which reports `malloc_usable_size`
    and adapts to C API changes.
  - With the patch, the memory limit holds, and upstream's regression test for
    GHSA-m53g-qx47-3h38 passes. Both npm builds crash on that test.
  - Engine speed matched the npm build. RSS per paused run was about 25% higher.
- **A new hazard: out-of-memory.** After a runtime ran out of memory while still
  holding it, later calls into it could trap with an out-of-bounds access.
  Treating any out-of-memory error as the end of the instance contains this.
- **Maintenance.** The estimate is half a day per routine upstream release, and
  one to three days when the C API or emsdk breaks. One break
  (`JS_NewArrayBuffer`) occurred in the five releases from 0.12.1 to 0.17.0. This
  is an estimate from that one jump, not a tracked history.
- **Javy plus Wasmtime also works, but only by replaying every step.**
  - Fuel trapped a spin in 11 ms (1e8 fuel).
  - `max-memory-size` gave a clean out-of-memory error, and each step's process
    died alone.
  - Each step costs about 4.8 ms of process start plus about 15 µs per replayed
    step.
  - It needs a 60 MB CLI or a Rust sidecar, because Node has no supported
    Wasmtime binding.

## 2. QuickJS in Wasm: the host

- **A `worker_threads` pool with thread affinity works.**
  - A run's instance must stay on one thread, because V8 cannot move a
    `WebAssembly.Memory` between threads.
  - With 1,000 runs, one thread did about 29k steps/s, and 2, 4 and 8 threads did
    56k, 101k and 177k. That is linear, so the router was not the bottleneck.
  - Memory was about 0.4 MiB per resident run plus about 24 MiB per thread.
- **Thread death is recoverable.** Killing a thread with `terminate()`, an uncaught
  throw or `process.exit` replayed its 250 runs on other threads in 83–195 ms,
  with no step lost or duplicated.
  - Plain least-loaded placement sent about 70% of replays to the respawned, empty
    thread.
  - Weighting a queued replay as 50 resident steps spread them evenly.
- **Eviction.** Evicting an idle instance and replaying it later cost 4–19 ms.
  When the resident cap was smaller than the working set, throughput fell about
  30×, so the cap must hold the active working set.
- **A separate sandbox process costs little.** Over a Unix socket, a step cost
  38–41 µs at p50 against 13–14 µs in-process. A 1,000-step replay cost 18–19 ms
  when sent as one message, against 36–41 ms driven step by step.
- **An orphaned host process outlived its runner,** so production needs a
  supervisor that reaps sandbox processes.

## 3. workerd

- **Self-hosted workerd enforces no limits.**
  - Its limit enforcer is a no-op, with the source comment "Single-tenant policy:
    no limits". That comment was read on `main`; the pinned version behaved the
    same way.
  - CPU, wall-clock and memory limits all have to come from outside: a watchdog,
    cgroups or `RLIMIT_CPU`.
  - A kill takes down the whole process. Its sticky runs recovered by replay:
    19 runs of 100 steps took about 16 ms.
- **Runs that share an isolate are one trust domain.**
  - One run patched intrinsics to capture another run's requests, and sent them
    out through its own permitted fetch.
  - It also used `import("./shim.mjs")` to drive another run's generator with
    forged answers. Nothing detected it.
  - Separate isolates stopped both attacks.
  - The fixes for the import hijack (a single bundled module, a closure-held run
    map, checking the genuine `ExecutionContext`, frozen intrinsics) were drafted
    but **not tested**.
- **One isolate per process is the safe unit, and one container per (app, owner)
  works.**
  - Three locked-down containers held 20 paused runs each, at about 22–23 MiB
    each. One container used about 1.8× that, unexplained.
  - Killing one container left the others serving. Its runs recovered into a
    fresh container in 14 ms.
  - From inside a container, the spike could not see or reach another container's
    processes, network or socket.
- **Egress needs a deny worker.** With `network = (allow = [])` alone, workerd
  still ran a host DNS lookup on any hostname the job chose. That was inferred
  from error text, with no packet capture. A 403 deny worker as `globalOutbound`
  stopped it.
- **Determinism needs a prelude, and an audit on every upgrade.**
  - Web-platform globals such as timers, `MessageChannel` and `fetch` live on the
    global object's prototype, so shadowing them on `globalThis` left the real
    functions callable.
  - The second prelude neutralised them along the whole prototype chain, plus
    `Intl` default dates and `crypto.subtle.generateKey`. All 15 benign
    non-determinism probes then replayed clean.
  - An audit listed 83 own globals and 79 inherited ones. It classified 130 as
    deterministic and 28 as neutralised, and left 2 residual sources that are
    closed outside the prelude.
- **A variant where the job does its own I/O also worked.** Pointing
  `globalOutbound` at a gateway sent every `fetch()`, raw `connect()` and
  WebSocket through it, including requests to localhost and 169.254.169.254, and
  the gateway attributed each call by the socket it arrived on. This is the
  design ADR-0053 leaves for a later stage.
- **The compatibility date is a security setting.** At a 2026 compatibility date,
  workerd exposed `process` and a virtual `node:fs` without `nodejs_compat`.

## 4. The job contract, whatever the engine

- **A refusal must not look like an answer.** A gateway daily-cap refusal,
  delivered to the job as an ordinary 429, became "processed, miss with error" for
  44 properties, and the run still reported success.
- **`h.all` waves did not help under a rate limit.** Four properties in flight ran
  no faster than one, and an unsandboxed driver was just as slow. Lockstep waves
  plus 429s arriving together caused more back-offs. Concurrency pays only when
  upstream latency, not its rate, is the constraint.
- **Shared upstreams need a global bucket.** Two apps sharing one upstream each
  took about twice as long, because they split its limit.
- **Replay is exact.** After a SIGKILL mid-wave, replay used the recorded values,
  reused the one answered request from the unfinished wave, and continued live.
  The runner's call log matched the gateway's exactly. Only a request sent but not
  yet recorded can repeat: at most one per in-flight slot.
- **The same job module runs unchanged under a plain Node driver,** so one module
  can serve both a tab and the server.

## 5. Security record and prior art (research)

- **quickjs-ng advisories** include GHSA-m53g-qx47-3h38, a critical "RCE via
  `js_array_toReversed()`" fixed in v0.15.0 (2026-05-28), and GHSA-r6vf-p8wr-4vg9,
  a high-severity use-after-free (2026-06-04). NVD lists about 29 CVEs for
  "quickjs"; these were not re-checked one by one.
- **Disclosure policy.** Since 2026-10-11, quickjs-ng accepts no private security
  reports and issues no CVEs. It treats untrusted bytecode as equivalent to
  untrusted native code, so jobs must be loaded from source.
- **quickjs-ng or Bellard.** ng releases more often and runs test262 in CI.
  Bellard's QuickJS is covered by OSS-Fuzz and was slightly faster here, at 7.3 µs
  against 8.9 µs per step on the npm builds.
- **Wasmtime** had 81 published advisories, 57 of them in 2026. Most need crafted
  Wasm and are not reachable from JavaScript inside a fixed Javy module.
- **V8 Wasm escapes do happen,** for example CVE-2024-2887. Node's patch level is
  part of the boundary.
- **Production users.**
  - Shopify Functions runs untrusted app JavaScript through Javy (QuickJS) on
    Wasmtime, with hard instruction and memory limits, and each call runs to
    completion. Its limits were not re-fetched.
  - Figma moved its plugin sandbox to QuickJS compiled to Wasm after an escape
    from its earlier sandbox. Whether it still uses it was not verified.
  - No production system was found running **paused** QuickJS generators for many
    tenants server-side.

## 6. Limits

- **Not measured.**
  - Nothing ran on Linux, in ACA, under cgroup CPU quotas or at production scale.
  - V8 address-space use was tested only up to 1,000 Wasm memories.
  - TCP or TLS between ACA apps was not tested; the process split used a Unix
    socket.
  - Pool threads and the process split were never combined. Their joint step
    cost of about 55–60 µs is an estimate.
- **Not verified.**
  - No ASan build confirmed the GHSA-m53g fix, and no exploit was attempted.
  - test262 and upstream's full suite were not run against the Helix build.
  - The cause of the out-of-memory trap was not found, nor whether upstream's
    `8e14a39` fixes it.
  - It was not checked whether the build is reproducible on x86_64.
- **QuickJS host gaps.**
  - A native crash inside a pool thread was not tested; SIGSEGV would kill the
    whole process.
  - A job that runs just under the deadline on every step, and so stalls its
    thread repeatedly, was not tested.
  - The pool tests ran on the npm engine, not the Helix build.
- **workerd gaps.**
  - The import-hijack fixes were not tested.
  - Async interleaving across awaits within one isolate was not tested.
  - SES `lockdown()` was installed but never run.
  - Whether DNS queries actually leave the host is inferred from error text only.
- **Statistics.** End-to-end wall times had only 2–5 samples per setting, with
  large variance.
