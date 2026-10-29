# Spike 2: QuickJS-in-Wasm for ADR-0052, covering the Helix-owned build, the thread pool and the process split

**Date:** 2026-10-28 · Follow-up to `quickjs-1.md` · about 2 hours · Spike for EK Yancy

**Evidence tags:**
- **[observed]**: I ran it. Raw output is in `results/`.
- **[source]**: read from a primary source: upstream code, the GitHub API or an advisory.
- **[assumption]**: not tested.

**Housekeeping.** No git repo was modified and nothing was committed. All data is synthetic. Nothing is left running. Two emsdk Docker images remain in the local image cache.

## Versions

| Item | Version / pin |
|---|---|
| quickjs-ng | **v0.17.0**, the latest release (checked with the GitHub API on 2026-10-28; master is 26 commits ahead). Tag commit `6d46d07d04041b40f4f49eaa7fdebe44c314c699`. Release amalgam `quickjs-amalgam.zip` sha256 `a0955463c74809173a253ff87365095e6972e8b171cfb6aa8a1e781adf35cfeb`, which equals the GitHub asset digest. |
| quickjs-emscripten (C glue, templates, FFI) | Tag v0.32.0, commit `df4efb9ef2cb25c417ecb57986da462d11b244ed`. The JS FFI `dist/ffi.mjs` comes from `@jitl/quickjs-ng-wasmfile-release-sync@0.32.0`, with its tarball sha512 checked against the lockfile. |
| Host library | `quickjs-emscripten-core@0.32.0`, unchanged |
| emscripten | `emscripten/emsdk:5.0.1@sha256:c89732ef63a56de5a96395c5a8c1c7904f7420131a045406e6fedc4cbe1cc198` (emcc 5.0.1, `8c5f4315`), the version quickjs-emscripten 0.32.0 uses. I also tried `emscripten/emsdk:6.0.13@sha256:fb7864e398acfda863dfcea78b8bc8adad359fa60c6a0bbeb845931de64aa68a`. |
| Baseline engines | npm `@jitl/quickjs-ng-wasmfile-release-sync@0.32.0` (quickjs-ng v0.12.1) and `@jitl/quickjs-wasmfile-release-sync@0.32.0` (Bellard 2025-09-13) |
| Node / OS / hardware | Node v24.18.0, macOS 27 arm64, Apple M4 Max (16 cores). Docker 29.6.2 (aarch64 Linux VM). |
| Load | Load average was 4–7 during the benchmarks. This is recorded in each `results/*` file. |

## Summary

1. **A Helix-owned build of quickjs-ng v0.17.0 works with the stock `quickjs-emscripten-core@0.32.0`, and it fixes `setMemoryLimit`** [observed].
   - **Build:** one script, `build/build.sh`, takes 18–19 s. The output is a 571,346-byte `.wasm`, sha256 `b5c143b479d43a4f92caea3cbe583fb6c0e4bf30d2ead9d4dbed422aadae1111`. Two builds gave byte-identical output.
   - **Glue changes:** 3 small edits to quickjs-emscripten's `interface.c`. One was **forced by an upstream API break** (`JS_NewArrayBuffer`). The other two were by choice: the `malloc_usable_size` fix, and dropping quickjs-libc.
   - **Memory limit now holds:** with a 32 MiB QuickJS limit, the bombs that reached **2,042 MiB** on the npm build now stop at **30–31 MiB**, and Wasm memory stays at 40 MiB.
   - **The GHSA-m53g fix is present and exercised:** upstream's regression test for it, `tests/test_array_to_gc.js` from commit `64e64eb`, passes on the Helix build. The same test **crashes the npm quickjs-ng 0.12.1 build** with a GC assertion, and **also crashes the npm Bellard build** with an out-of-bounds memory access.
   - **Engine performance:** the same as or slightly better than the npm build: about 11–12 µs per async step, 0.5–0.6 ms per instance, and 11–12 ms to replay 1,000 steps. A paused run costs about **25% more memory** (process RSS): about 0.50 MiB against 0.40 MiB.
2. **A new hazard was found** [observed]. After a job runs out of memory **while still holding that memory**, later host calls into that runtime can trap with "memory access out of bounds", and freeing it then aborts.
   - It happens on both builds, through different paths:
     - npm 0.12.1, when the Wasm memory maximum is hit;
     - Helix 0.17.0, when the QuickJS limit is hit.
   - The rule therefore extends: **any out-of-memory error fails the run, and the Wasm instance is dropped without calling back into it.**
   - Upstream master has an unreleased fix, "Fix use-after-free when JS_NewContext runs out of memory" (`8e14a39`). I don't know whether it is related.
3. **The worker_threads pool works** [observed].
   - **Isolation:** a spinning job stalls only the runs on its own thread, for the full deadline. Other threads stay at p99 below 0.4 ms.
   - **Recovery:** a thread killed by `terminate()`, an uncaught throw or `process.exit` had its 250 runs replayed elsewhere, with 0 steps lost or duplicated and results identical to a run with no fault. The in-flight steps finished in 83–195 ms.
   - **Costs:** the pool adds about 20 µs per step at p50. Evict-and-replay costs 4–19 ms. When the eviction cap is smaller than the working set, throughput falls about 30×.
4. **Splitting the runner and the sandbox into separate processes costs about +25 µs per step at p50** [observed]: 38–41 µs against 13–14 µs, and 60–80 µs against about 25 µs at p99.
   - Shipping a 1,000-step history to the host in one message replays it in 18–19 ms (14 ms in-process). Driving the replay step by step from the runner costs 36–41 ms.
   - A single host process saturates at about 45–60k steps/s; 4 host processes reached 137–172k.
   - **Protocol consequence:** the host has to produce `h.now()` and `h.random()` and return them to the runner.

**Overall:** the three gaps reviewers raised can be closed. Owning the build is cheap mechanically. The real cost is review and watching upstream, because there is no CVE feed and fixes land on master weeks before a release. ADR-0052 decision 7 text is proposed at the end.

---

## Q1. A Helix-owned QuickJS Wasm build

### What was built

| File | What it does |
|---|---|
| `build/build.sh` | The recipe. It clones quickjs-emscripten at the pinned commit and checks its HEAD. It downloads the quickjs-ng release amalgam and checks its sha256. It applies quickjs-emscripten's own `0001-bellard-module-detection.patch` (which applied with only an offset) and the Helix patch. It takes `ffi.mjs` from the pinned npm package and checks the tarball's sha512. It derives the export list from the `cwrap` names in `ffi.mjs`. It compiles with `emcc` inside the pinned emsdk image, using the exact flags of `variant-quickjs-ng-wasmfile-release-sync` (`-Oz -flto --closure 1 -s FILESYSTEM=0 -s IMPORTED_MEMORY=1 …`, Node ESM target). Finally it writes `index.mjs`, a quickjs-emscripten-core variant, and `BUILDINFO.json`. Env switches: `HELIX_NO_LIBC`, `HELIX_MALLOC_USABLE_SIZE`, `EMSDK_IMAGE`, `MIN_NODE_VERSION`. |
| `build/patches/0001-helix-interface-malloc-usable-size-no-libc.patch` | 3 edits to `c/interface.c`, 38 changed lines (see below) |
| `dist-helix/` | The output: `emscripten-module.{wasm,mjs}`, `ffi.mjs`, `index.mjs`, `BUILDINFO.json` |
| `dist-helix-repro/` | A second build, for the reproducibility check |
| `dist-helix-nofix/` | The same build without the `malloc_usable_size` fix, as a control |
| `dist-helix-emsdk6/` | The same build with emsdk 6.0.13 |
| `q1/engine2.mjs` | The prior spike's engine plus the variants `helix`, `helix-nofix` and `helix-emsdk6`. The variant is a 6-line `{type:"sync", importFFI, importModuleLoader}` object. |
| `q1/*.mjs` | Checks: `smoke`, `memlimit-check`, `memlimit-check2`, `oom-after`, `probes`, `stack-check`, `imports`, `ghsa-m53g-regress`, `perf`, `mem` |

**The Helix patch to `interface.c`:**
1. **`malloc_usable_size` fix (`HELIX_MALLOC_USABLE_SIZE`).** `QTS_NewRuntime` calls `JS_NewRuntime2()` with malloc functions whose `js_malloc_usable_size` is emscripten dlmalloc's real `malloc_usable_size`. The fix lives in the glue, so upstream's source needs no patch.
   - **Root cause** [source]: `js__malloc_usable_size()` in quickjs-ng's `cutils.h` has branches for `__APPLE__`, `_WIN32`, `__linux__`, `__GLIBC__` and `__wasi__`, and **returns 0 for anything else, including `EMSCRIPTEN`**. QuickJS then counts only its 8-byte overhead for each allocation. That confirms the prior spike's inference.
   - In v0.17.0 the new arena allocator accounts exactly for small blocks (512 B or less). Only large blocks go through `js_malloc_usable_size`.
2. **`JS_NewArrayBuffer` API break (forced).** v0.17.0 added resizable ArrayBuffers: the function gained a `max_len` argument, and its free callback became a realloc callback, where size 0 means free. Without the change the build fails:
   ```
   interface.c:559:85: error: too few arguments to function call, expected 7, have 6
   ```
   The fix is 10 lines, gated on `QJS_VERSION_MINOR >= 17`.
3. **No quickjs-libc (`HELIX_NO_LIBC`).** The build drops `-DQJS_BUILD_LIBC` (the `std` and `os` modules), and stubs the one debug-only caller, `js_std_dump_error`. The Wasm imports fall from 21 to 19.

### Build record [observed]

Command: `build/build.sh`. Output in `results/q1-build.txt`; `BUILDINFO.json`:

```
quickjsNg  v0.17.0 6d46d07d…  amalgamSha256 a0955463…cfeb
emsdkImage emscripten/emsdk:5.0.1@sha256:c89732ef…  emcc 5.0.1 (8c5f4315…)
flags      HELIX_NO_LIBC=1 HELIX_MALLOC_USABLE_SIZE=1
wasmSha256 b5c143b479d43a4f92caea3cbe583fb6c0e4bf30d2ead9d4dbed422aadae1111   wasmBytes 571346
mjsSha256  1a08264f5881c9a7b2cb75fc310d800918bc597a978c62abcfcd5554d69057e2
emccSeconds 14   totalSeconds 18      (wall: 18.5 s; second run 18.9 s)
```

| | Helix build | npm 0.12.1 build |
|---|---|---|
| `.wasm` size | 571,346 B (264,847 B gzip -9) | 528,551 B (247,167 B) |
| Wasm imports | 19 (18 functions plus memory) | 21 |
| Reproducible | **Yes.** `dist-helix-repro` is byte-identical (same wasm and mjs sha256). | n/a |

Build times are with a warm Docker image and no emscripten system-library cache. The first image pull took 61 s.

### Does it work from `quickjs-emscripten-core@0.32.0`? [observed]

`node q1/smoke.mjs ng helix helix-nofix bellard` ran the 10-property ListGen job to the same result on all four engines: 7 steps, 22 requests, `{"processed":10,"hits":{"T0":4,"T1":6}…}`.

On the Helix build, `Uint8Array.fromBase64` exists, as it does in v0.17.0; in 0.12.1 it is `undefined`. The stock core library needed no change.

### `setMemoryLimit` now holds [observed]

**Bomb sweep** (`node q1/memlimit-check.mjs`, from the prior spike's `memlimit-check.mjs`): a 32 MiB QuickJS limit, the default 2 GiB Wasm maximum, and 1 MiB chunks until out of memory.

| Bomb | npm 0.12.1 | Helix, without the fix | **Helix** |
|---|---|---|---|
| ArrayBuffer 1 MiB | 2,042 chunks, linear memory 2,048 MiB | 2,042, 2,048 MiB | **31, 40 MiB, 6.6 ms** |
| Uint8Array 1 MiB | 2,042 | 2,042 | **31** |
| string 1 MiB | 2,042 | 2,042 (4.5 s) | **31** |
| Array of numbers, 1 MiB each | 1,935 | 1,935 | **30** |
| Small objects | 1.05M objects, 172 MiB | out of memory at 40 MiB (the arena counts these exactly) | out of memory at 40 MiB |

The result is the same whether the limit is set with `setMemoryLimit` or with `newRuntime({memoryLimitBytes})`.

**The prior spike's diagnostic** (`node q1/memlimit-check2.mjs`):

```
ng          one40MiB: ERR out of memory  one31MiB: 32505856  forty1MiB: 40                    "malloc_usable_size unavailable" memory used 42009826
helix-nofix one40MiB: ERR out of memory  one31MiB: 32505856  forty1MiB: 40                    memory used 42012268
helix       one40MiB: ERR out of memory  one31MiB: 32505856  forty1MiB: 'ERR out of memory'  memory used 32574220 (limit 33554432)
```

**The prior spike's probes, re-run** (`node q1/probes.mjs helix` against `ng`, with a 32 MiB QuickJS limit and no Wasm maximum):

| Probe | npm 0.12.1 | **Helix** |
|---|---|---|
| 8 MiB ArrayBuffers | out of memory at **2,048 MiB** linear; RSS +1,996 MiB; 379 ms | out of memory at **29.3 MiB**; 2 ms |
| Catch the out-of-memory error, then continue | caught at n=2,042; RSS +1,907 MiB | caught at **n=31**; 40 MiB |
| Small objects | out of memory at 143.6 MiB | `step: null` at 40 MiB. The error was lost while building it, as in the prior spike. |
| No QuickJS limit, 64 MiB Wasm maximum | (prior spike: out of memory at 61–63 MiB) | out of memory at 61.3 / 63.4 MiB |
| Spin, try/catch spin, regex, `sort` | interrupted at 502 ms | interrupted at 502–504 ms; the canary survived every probe |
| Deep recursion with a 256 KiB stack / stack check disabled | caught in the VM / host fault | the same (`q1/stack-check.mjs`): the 256, 64 and 16 KiB limits are caught in the VM; 0 or 1 MiB gives a host `RangeError`, and `JS_FreeRuntime` then fails an assertion |

**Escape surface on v0.17.0** (`probes/escape.js`). No new I/O, clock or random globals:
- **Absent:** `Date`, `performance`, timers, `console`, `WebAssembly`, `Atomics`, `WeakRef`, `FinalizationRegistry`, `std` and `os`.
- **New compared with 0.12.1:** `DisposableStack`, `AsyncDisposableStack`, `SuppressedError` and `BigInt`.
- **Unchanged:** dynamic `import()` of `std`, `qjs:std`, `node:fs` and `https://…` still fails, because no module loader is installed.

### A new finding: the runtime is unusable after an out-of-memory error while the memory is still held [observed]

`node q1/oom-after.mjs <variant> <limit32|wasmmax64> <bomb>`. The bomb keeps its allocations alive in a top-level `let`. Afterwards the probe evaluates more code, calls `computeMemoryUsage` and frees the runtime:

| Build and limit | Eval afterwards | `computeMemoryUsage` | Free |
|---|---|---|---|
| npm 0.12.1, 64 MiB Wasm maximum | `ERR ""` | **TRAP: memory access out of bounds** | **Abort: `ctx->header.ref_count == 0`** |
| npm 0.12.1, 32 MiB QuickJS limit (not enforced) | ok | ok | ok |
| Helix 0.17.0, 64 MiB Wasm maximum | ok | ok | ok |
| Helix 0.17.0, 32 MiB QuickJS limit (with or without the fix) | `ERR null` | **TRAP: memory access out of bounds** | **TRAP: memory access out of bounds** |

When the bomb's memory is released first (the bomb runs inside a function scope), every case recovers cleanly (`results/q1-oom-after-scoped.txt`).

- **What is known:** code that keeps running near an out-of-memory condition can make the runtime trap.
- **What is not known:** whether the out-of-bounds access comes from quickjs-emscripten's glue (`QTS_*` functions not checking a failed allocation) or from the engine. I did not run that down.
- **Why it matters:**
  - The engine's existing "host fault, so poison the instance" rule catches the trap, so the damage stays inside the run's own instance.
  - But a wild memory access inside the instance is a memory-safety bug, not just an error. The safe policy is to treat any out-of-memory error, including the error coming back as `null`, as **terminal for the instance**, and never make another call into it.

### The GHSA-m53g-qx47-3h38 fix is present [source + observed]

- **Advisory** [source, GitHub API]: "quickjs RCE via js_array_toReversed() dense-array copy constructor", severity critical, vulnerable below 0.14.1, patched in **0.15.0**.
  - The bug is in `js_array_with`, `toReversed`, `toSpliced` and `toSorted`: each publishes `p->u.array.count = len` before the new slots are initialised. A getter that triggers GC then walks uninitialised `JSValue`s.
  - The advisory's own `poc.js` and exploit are not public; it publishes only an ASan trace and the root cause.
- **Fix commit** [source]: `64e64ebb1dd61505c256285a699c65c42941c5ed`, 2026-04-20, "Port js_allocate_fast_array helper for non-mutating array methods".
  - It is ported from Bellard's `feefdb17` and `4c722cea`.
  - It adds `js_allocate_fast_array()`, which fills every slot with `JS_UNDEFINED`, and uses it in all four methods.
  - It also adds the regression test `tests/test_array_to_gc.js`.
  - It is in `v0.14.0...v0.15.0`, after `d35af9d`, the commit the advisory names as vulnerable.
- **Is it in the built source?** The v0.17.0 amalgam contains `js_allocate_fast_array` 5 times, and `js_array_toReversed` calls it. The npm 0.12.1 amalgam contains it 0 times.
- **Upstream's regression test, run** (`node q1/ghsa-m53g-regress.mjs ng,helix,bellard`). The adaptation:
  - quickjs-emscripten has no `gc()`, so the getter forces GC by allocating 20,000 self-referencing objects instead of calling `std.gc()`;
  - each test case is repeated 50 times;
  - the inputs and assertions are upstream's.

  This is a regression test, not exploit development. The same result came in 3 of 3 runs:
  ```
  ng       HOST FAULT RuntimeError: Aborted(Assertion failed: p->ref_count > 0, at: …quickjs-amalgam.c,17043,gc_decref_child)
  helix    pass, getter calls=200   dispose ok
  bellard  HOST FAULT RuntimeError: memory access out of bounds   (dispose: Assertion failed: p->ref_count == 0)
  ```
  The npm builds keep `assert()` enabled, so the 0.12.1 build stopped at an assertion before using the bad memory. The Bellard build did not.

### emscripten upgrade check [observed]

I built the same thing with `emsdk:6.0.13`:
- **The first attempt failed:** `emcc: error: MIN_NODE_VERSION older than 180300 is not supported`. quickjs-emscripten pins 160000.
- With `MIN_NODE_VERSION=220000` it built in 19 s: wasm 583,278 B, sha256 `8b2619d1d87f3ced3cc770e100620aa14d79316dc0b07d5830813a49378a3403`, 19 imports.
- It passed the smoke test, the memory-limit check and the GHSA test, at the same speed (11.7 µs async step).

### Performance against npm 0.12.1 [observed]

`node q1/perf.mjs ng,helix,ng,helix` and `node --expose-gc q1/mem.mjs`. Each engine has its own instance and a 64 MiB Wasm maximum.

| Metric | npm 0.12.1 (2 runs) | Helix 0.17.0 (2 runs) |
|---|---|---|
| Own instance + prelude + ListGen, p50 / p95 | 0.59 / 1.49 ms · 0.54 / 1.30 ms | 0.60 / 1.15 ms · 0.48 / 1.08 ms |
| Async step | 13.8 · 13.5 µs | **11.8 · 11.0 µs** |
| Sync step | 9.1 · 9.0 µs | 8.0 · 8.1 µs |
| Fresh instance + replay of 1,000 steps, p50 | 14.3 · 13.6 ms | 11.4 · 12.4 ms |
| RSS per paused ListGen run, 1,000 runs | 0.398 · 0.399 MiB | **0.513 · 0.497 MiB** (without the fix: 0.513) |
| QuickJS heap per paused run | 121 KiB | 125 KiB |

The extra RSS comes from v0.17.0 itself, not from the fix: the build without the fix shows the same figure. My guess is that the new per-size-class arena pages cause it [assumption].

### Effort to maintain this per upstream release

**Observed for the jump from 0.12.1 to 0.17.0 (five releases):**

| What | Result |
|---|---|
| quickjs-emscripten's patch to the amalgam | applied with only an offset |
| `interface.c` against `quickjs.h` | uses 98 `JS_*` functions; **1 signature break** (`JS_NewArrayBuffer`), a 10-line fix. 41 `JS_EXTERN` lines changed in the header overall. |
| FFI (`ffi.mjs`) and export list | unchanged; reused as is |
| Ambient globals | 4 new ones to review (`DisposableStack`, `AsyncDisposableStack`, `SuppressedError`, `BigInt`) |
| Behaviour | the out-of-memory failure mode moved (see above); RSS per run rose 25% |
| emsdk 5 → 6 | 1 flag change |

**Per release, the routine part:**
1. Bump the tag and amalgam sha256 in `build.sh` (about 20 s to build).
2. Run the `q1/` checks (about 2 minutes): smoke, memory limit, probes, stack, imports, GHSA regressions, out-of-memory behaviour, perf.
3. Diff `quickjs.h` for the functions `interface.c` uses.
4. Diff the global list against the ambient-API allowlist.

**Estimate** [assumption]:
- about 0.5 engineer-day for a routine release, including reviewing the changelog for security fixes;
- 1–3 days when the C API breaks, emsdk needs a major bump, or quickjs-emscripten's glue has to be forked further. For example, if Helix needs a new `QTS_*` function, it must regenerate `ffi.mjs` with quickjs-emscripten's `generate.ts` toolchain, which I did not set up.

**The part that isn't mechanical** [source]:
- quickjs-ng releases about monthly, and **master is already 26 commits past v0.17.0**. Those include "Fix use-after-free when JS_NewContext runs out of memory" (`8e14a39`, 2026-10-01) and "Fix infinite loop on allocation failure in unicode_script()" (`081d50c`).
- Since 2026-10-11 there are no advisories or CVEs.
- So someone must read master's commits and decide when to build from a pinned master commit instead of waiting for a tag.
- quickjs-emscripten itself has unreleased commits from 2026-07-23 (an asyncify-only disposal fix, which doesn't affect the sync variant).

---

## Q2. A worker_threads pool with thread affinity

Code is in `pool/`; raw output is in `results/q2-*.txt`. It uses the npm quickjs-ng 0.12.1 engine with a 64 MiB Wasm maximum and a 256 KiB stack; the pool's behaviour doesn't depend on the build. Load average was 5.3–6.5, with no emscripten container running.

### Design

| File | What it does |
|---|---|
| `pool.mjs` | **The router, on the main thread.** It owns every run's history: requests, answers and recorded `now`/`random` values. History is appended only when a step's reply arrives, so a thread's state is a cache.<br>**Affinity:** `run.slot` is (thread, generation). Steps go to that thread with no history while it is alive. Otherwise the run is placed on the least-loaded live thread, and the history is attached for replay.<br>**Eviction:** an LRU cap on resident runs per thread (never evicting a busy run), an idle-TTL sweeper, and an explicit `evict()`.<br>**Thread death:** on a worker `exit`, its runs are marked non-resident, the thread is respawned with a new generation, and every in-flight step is re-dispatched as a replay. Late replies from a thread already given up on are dropped by `reqId`.<br>**`replayWeight`:** a queued replay counts as k units of load when placing work. |
| `worker.mjs` | **A sandbox thread:** `runId` → a `JobInstance` in its own Wasm instance, with messages handled one at a time. Opening a run means a new instance, then `start`, then a replay that checks every request and recorded value; any mismatch raises a non-determinism error. Any step error drops the instance. It also has fault injection (throw or `process.exit`). |
| `bench.mjs` | Subcommands: `latency`, `throughput K R`, `isolation ms`, `evict`, `churn`, `idle`, `recovery terminate\|throw\|exit`, `transfer` |
| `replay-breakdown.mjs` | Replay cost on a single thread, with no pool |

### Results [observed]

**What postMessage can carry** (`node pool/bench.mjs transfer`):

| Object | Result |
|---|---|
| `WebAssembly.Module` | clones |
| Non-shared `WebAssembly.Memory` | `DataCloneError` |
| `WebAssembly.Instance` | `DataCloneError` |
| `JobInstance` | `DataCloneError` |

So a paused run cannot move between threads; moving it means replaying it.

**Step latency** (`node pool/bench.mjs latency`): one run, 20,000 steps, µs.

| Generator | Direct on one thread, p50 / p99 | Through the pool, p50 / p99 | Inside the worker, p50 / p99 |
|---|---|---|---|
| async | 13.6 / 32.1 | **34.3 / 68.4** | 18.1 / 34.2 |
| sync | 9.0 / 13.5 | **33.4 / 268** | 14.4 / 66.6 |

**Throughput over 4 threads**: every run has one step outstanding at all times, round-robin.

| Paused runs | Steps/s (3 runs) | Latency p50 / p99 | RSS, all resident |
|---|---|---|---|
| 100 | 115k, 108k, 70k | 0.6–0.75 / 1.5–8.5 ms | 177–181 MiB |
| 1,000 | 102k, 99k, 72k | 8.2–9.2 / 13–31 ms (queueing) | 513–521 MiB |

- **Memory:** about 0.375 MiB per resident run, plus about 24 MiB per thread [derived].
- **Thread scaling** at 1,000 runs, for 1, 2, 4 and 8 threads: 29k, 56k, 101k and 177k steps/s. That is linear, so the router is not the bottleneck up to 8 threads.

**Isolation** (`node pool/bench.mjs isolation 200|500`): 8 looping runs on each of 4 threads, plus `probes/spin.js` on thread 0.

| Deadline | Spinner | Other runs on thread 0 | Runs on threads 1–3 during the spin |
|---|---|---|---|
| 200 ms | interrupted at 201 ms | **each stalled 201.4 ms** | p50 0.16 ms, p99 0.27–0.39 ms; about 9,600 steps per thread |
| 500 ms (×2) | interrupted at 501–502 ms | **each stalled 501–502 ms** | p50 0.16 ms, p99 0.24–0.29 ms |

Thread 0 survives and goes back to serving normally.

**Evict-and-replay:**

| History steps | Resident step, p50 | First step after eviction, p50 / max | Same work on one thread, no pool |
|---|---|---|---|
| 10 | 0.047 ms | **4.0 / 6.8 ms** | about 1.2 ms |
| 100 | 0.043 ms | **5.4 / 8.3 ms** | about 2.5 ms |
| 1,000 | 0.035 ms | **19.0 / 23.1 ms** | about 16.9 ms |

- **Idle TTL** (200 ms): 40 resident runs went to 0. The next step replayed in 1.4 ms.
- **Churn, worst case**: 1,000 runs with a cap of 100 per thread, so the LRU always evicts the next run due to step:
  - with no cap: **107–112k steps/s**;
  - with the cap: **3.5–4.0k steps/s**, and every step is a replay.
- RSS didn't fall promptly after evictions.

**Recovery** (`node pool/bench.mjs recovery …`):
- **Setup:** 1,000 runs (250 per thread) of a 40-step job, each stepped 20 times. Then a wave puts every run's next step in flight, thread 0 is faulted, and every run is driven to completion and compared with a run that had no fault.

| Fault | Runs lost | In-flight steps replayed | Last affected step finished after | Mismatches against the control run | Steps lost or duplicated |
|---|---|---|---|---|---|
| `terminate()` (×2) | 250 resident | 227 | 195 / 187 ms | **0** | **0** |
| uncaught throw | 250 | 150 | 146 ms | 0 | 0 |
| `process.exit(3)` | 250 | 150 | 151 ms | 0 | 0 |
| `terminate()`, replay weight 50 | 250 | 227 | **114 ms** | 0 | 0 |
| throw, replay weight 50 | 250 | 150 | **83 ms** | 0 | 0 |

- With plain least-loaded placement, about 70% of replays (174 of 250) pile onto the respawned, empty thread and run one after another. Weighting a replay as 50 units spread them as 83/56/56/55.
- A cold thread (spawn, Wasm compile, first step) costs 26.5–29 ms.

### Q2 surprises

1. **Head-of-line blocking is the real cost of the deadline.** A job that runs just under the deadline on every step could stall its whole thread on every step [assumption: not probed].
2. **A respawned thread attracts replays,** so placement has to weight replays.
3. **Thrashing is a cliff, not a slope** (about 30×). The cap must hold the working set; eviction is for idle runs.
4. **Inside the pool, replay costs about 3 ms more than the same work on one thread.** I didn't find the cause.

---

## Q3. Cross-process step cost

Code is in `xproc/`; raw output is in `results/q3-run1.txt` and `q3-run2.txt`. It uses the npm quickjs-ng 0.12.1 engine with a 64 MiB maximum, a 256 KiB stack and a 250 ms deadline. Load average was 4–6. The suite ran twice, and the tables show run 1 · run 2.

### Design

| File | What it does |
|---|---|
| `xproc/host.mjs` | **The sandbox host:** a separate Node process with one Wasm instance per run. Ops: `open`, `step`, `replay` (the whole history in one message), `close`, `ping`, `stats`. Steps run on its main thread. |
| `xproc/client.mjs` | **The runner side.** It spawns the host and multiplexes requests by `id` over one or more connections. Replies are untrusted: 8 MiB frame cap, `JSON.parse`, and the connection is dropped on an unknown id. It kills the host when it exits. |
| `xproc/bench.mjs` | Subcommands: `inproc`, `xproc`, `ping`, `multi`, `replay`, `open`, `all` |

- **Framing: newline-delimited JSON.** `JSON.stringify` never emits a raw newline, so the newline is a safe delimiter, and each side needs about 10 lines of code. A length prefix only pays off for binary payloads.
- **`h.now()` and `h.random()` are produced in the host.** A synchronous Wasm import cannot block on a socket, so each step reply carries the values as `recs`. On replay, the runner sends them back.

### Results [observed] (`cd xproc && node bench.mjs all`)

**Per step, p50 / p99 in µs** (small 47 B answer, async generator, 20,000 steps per cell):

| Concurrent runs | Same process | **Cross process, 1 connection** | Cross process, 4 connections | Cross process, 1 connection per run |
|---|---|---|---|---|
| 1 | 14.2 / 26.5 · 12.9 / 24.7 | **40.8 / 81.2 · 37.9 / 77.6** | n/a | n/a |
| 4 | 13.7 / 17.7 · 13.4 / 17.2 | **82.7 / 199 · 79.7 / 206** | 69.5 / 230 · 67.6 / 172 | n/a |
| 100 | 15.0 / 23.9 · 14.1 / 19.0 † | **2,237 / 4,530 · 2,159 / 3,382** | 2,228 / 4,943 · 1,865 / 2,873 | 2,345 / 3,516 · 2,111 / 3,493 |

† The same-process cells time only the step call itself. In-process queueing at 100 runs would add about 1.5 ms. **At 4 or more runs, compare throughput instead.**

**Other cases:**

| Case | Same process | Cross process |
|---|---|---|
| Sync generator, 1 / 4 / 100 runs (p50 / p99, µs) | 8.5 / 11.0 · 9.3 / 11.7 · 9.6 / 17.0 | 27.2 / 70.2 · 60.9 / 148 · 1,530 / 2,664 |
| 2 KB answer, 1 / 4 / 100 runs (p50 / p99, µs) | 35.1 / 43.0 · 35.6 / 43.4 · 36.5 / 47.2 | 62.2 / 129 · 184.6 / 398 · 5,234 / 13,805 |
| IPC floor (`ping`, no engine), 1 in flight | n/a | 11.3–17.1 µs p50, 32–38 µs p99 |
| IPC floor, 100 in flight | n/a | about 105 µs p50; 815–881k round trips/s |

**Throughput, steps/s** (async generator, small answer):

| Setup | 1 run | 4 runs | 100 runs | 1,000 runs |
|---|---|---|---|---|
| Same process | 65.8k / 72.7k | 71.2k / 73.0k | 64.0k / 68.5k | n/a |
| Cross process, 1 host | 23.4k / 26.1k | 44.9k / 47.1k | **43.2k / 45.9k** | 33.7k / 34.1k (p50 29.6 ms) |
| Cross process, **4 hosts** | n/a | 46.5k / 69.7k | **171.5k / 137.2k** (p50 0.54–0.59 ms) | 136.6k / 136.4k |

**CPU per step:**
- same process: 15–19 µs;
- cross process: 32–49 µs in total, split as runner 9–13 µs plus host 23–35 µs.

**Open and replay:**

| Measure | Same process | Cross process |
|---|---|---|
| Open, p50 / p99 | 0.38–0.43 / 1.38–1.49 ms | 0.67 / 2.08–2.33 ms |
| Host process spawn to ready | n/a | 29–31 ms |
| **Replay of 1,000 steps** (206,657 B of history, median of 7) | 14.4 / 13.6 ms | **whole history in one message: 19.3 / 18.4 ms**<br>runner-driven, 1,000 round trips: 35.7 / 40.5 ms |

**Where the extra 25 µs goes** at 1 run. The round trip is about 38–41 µs:
- about 13 µs of engine work, which the same-process path also pays;
- about 11–17 µs of socket round trip (new);
- about 10–15 µs of extra JSON work (new): the answer is parsed, then re-stringified into QuickJS, and the reply is stringified, then parsed again.

### Q3 surprises

1. **The protocol has to carry `h.now()` and `h.random()`.** The host, not the runner, is where these values come from. A compromised host can lie only to its own run.
2. **Driving replay from the runner costs twice as much** as shipping the history in one message.
3. **The overhead is mostly JSON work, not the socket.**
4. **A runner that crashed during development left its host process running.** Production needs a supervisor, or a parent-death signal.

---

## Surprises across the spike

1. **Upstream's own GHSA-m53g regression test crashes both npm builds:** ng 0.12.1 at a GC assertion, and Bellard 2025-09-13 with an out-of-bounds access. ADR-0052 currently cites only the ng build. The Bellard variant on npm is affected too.
2. **The emscripten build was missing `malloc_usable_size` because quickjs-ng's `cutils.h` has no `EMSCRIPTEN` branch,** not because dlmalloc lacks the function. Fixing it took a 15-line `JS_NewRuntime2` wrapper in the glue, and upstream's source needed no patch.
3. **An out-of-memory error with the memory still held leaves the runtime trapping on later calls.** This happens on both builds, each at a different limit. The run stays contained only if its instance is dropped.
4. **quickjs-ng v0.17.0 broke the glue's C API** (`JS_NewArrayBuffer`), and v0.17.0 uses about 25% more RSS per paused run.
5. **Releases lag master on security fixes.** 26 commits on master since v0.17.0 include an out-of-memory use-after-free fix, and since 2026-10-11 there is no advisory feed.
6. **The build is fast and reproducible:** 18 s, and byte-identical across two runs. Owning it is cheap mechanically; the cost is the watching.

---

## Recommended text for ADR-0052 decision 7

Replace the paragraph headed "Helix owns the Wasm build", and the build bullets after it, with:

> **Helix owns the Wasm build.** Helix CI builds quickjs-ng to Wasm with the script from spike-quickjs-2 (`build/build.sh`). The build:
> - starts from a **pinned quickjs-ng release amalgam**, sha256-checked (v0.17.0 at the time of writing), or from a pinned master commit when an unreleased memory-safety fix is needed;
> - reuses quickjs-emscripten's C glue at a pinned commit, plus a Helix patch of about 40 lines;
> - reuses its JS FFI from the pinned npm package;
> - compiles with `emcc` from the `emscripten/emsdk` image pinned by digest, using quickjs-emscripten's release flags;
> - leaves out quickjs-libc, so there are no `std` or `os` modules.
>
> The Helix patch:
> - installs malloc functions that report emscripten's `malloc_usable_size`, so that QuickJS's memory limit holds. Without it, a 32 MiB limit let a job reach 2 GiB; with it, the same job stops at 31 MiB;
> - adapts the glue to upstream API changes.
>
> The build takes about 20 s, and two runs were byte-identical. Each Helix release records the upstream tag or commit, the amalgam sha256, the emsdk digest and the `.wasm` sha256. The stock `quickjs-emscripten-core` (pinned) loads the build through a six-line variant object.
>
> **Release checks.** Every engine bump runs the spike's suite and must pass:
> - the job smoke test;
> - the memory-limit bombs;
> - the CPU-interrupt and stack probes;
> - the out-of-memory-afterwards probe;
> - the list of globals against the ambient-API allowlist;
> - the Wasm import list;
> - upstream's security regression tests, adapted to run without `std.gc()`, starting with `test_array_to_gc.js` (GHSA-m53g-qx47-3h38). This test crashes both npm builds and passes on the Helix build.
>
> **Standing cost, named.** quickjs-ng publishes no advisories or CVEs, and security fixes land on master weeks before a release. The jobs-plane owner reviews quickjs-ng's master commits at least weekly, and re-releases from a pinned commit when a memory-safety fix lands. Estimated effort is about half a day per routine upstream release, and 1–3 days when the C API or emsdk breaks (one break in five releases, from 0.12.1 to 0.17.0).

Replace the memory row of the limits table with:

> | Memory | Two layers:<br>- the QuickJS heap limit, `setMemoryLimit` (for example 48 MiB), which now holds in the Helix build;<br>- a hard `WebAssembly.Memory` **maximum** per instance (default 64 MiB), which is the guarantee.<br>**Any out-of-memory error (including an error that arrives as `null`) is terminal for the instance.** The run fails, and the instance is dropped without another call into it: the spike showed later calls into a runtime still holding its memory can trap with an out-of-bounds access. | Per run |

Replace the CPU-per-step row's scope cell, and add these paragraphs after "A runaway or memory-bomb job stops only its own run":

> **The sandbox host process: router plus pinned threads.** Each sandbox process runs a router on its main thread and N `worker_threads`, sized to the cgroup's cores.
> - **Pinning.** A run's Wasm instance lives on exactly one thread; V8 cannot clone a `WebAssembly.Memory` or `Instance`. Its steps are routed there. Moving a run means replaying it.
> - **Placement.** A new or replayed run goes to the live thread with the least load, where a queued replay counts as about 50 resident steps. Without that weight, a respawned thread took about 70% of the replays.
> - **Eviction.** Each thread has a resident cap and an idle TTL. Eviction disposes an idle instance, and the next step replays it: about 4 ms for 10 steps, about 19 ms for 1,000. **The cap must hold the active working set:** when it doesn't, throughput falls about 30×.
> - **Thread death.** When a thread dies (`terminate()`, an uncaught exception or `process.exit`), its runs and in-flight steps are replayed on other threads. In the spike, 250 runs recovered in 83–195 ms with 0 steps lost or duplicated.
> - **Deadline.** The interrupt fails only the spinning run, but every run on that thread waits out the full deadline (other threads: p99 under 0.4 ms). Keep the deadline at 100–250 ms, and fail a run that repeatedly nears it against its CPU budget.
> - **Cost.** About +20 µs per step. 4 threads gave about 100k steps/s with 1,000 paused runs, scaling linearly to 8 threads. About 0.4–0.5 MiB per paused run, plus about 24 MiB per thread.
>
> **Runner ↔ sandbox protocol.** The runner (`helix-jobs`) talks to sandbox processes over a Unix socket, or the pool's private network, using newline-delimited JSON multiplexed by request id. Frames are capped at 8 MiB.
> - **Untrusted replies.** Every frame from the sandbox is untrusted input: size-capped, parsed, matched to an outstanding id and validated like a yielded request.
> - **Ops:**
>   - `open`: source, input, limits;
>   - `step`: answer → `{done, value, recs}`;
>   - `replay`: the whole history in one message → the first unanswered yield;
>   - `close`.
> - **Recorded values.** `h.now()` and `h.random()` values are produced in the sandbox, returned as `recs`, and appended to the history by the runner. They are sent back on replay.
> - **The runner's history is the source of truth.** The router in the sandbox process holds only a cache of it.
> - **Measured cost of the split:**
>   - per step: +25 µs at p50 (38–41 µs against 13–14 µs); p99 60–80 µs;
>   - open: 0.67 ms;
>   - replay of 1,000 steps: 18–19 ms against 14 ms. Replay driven step by step from the runner costs twice as much and is not used.
>
>   This is negligible against steps paced by the upstream.
> - **Sizing and supervision.** One sandbox thread saturates at about 45–60k steps/s, so the pool is sized by concurrent active runs. A supervisor reaps sandbox processes when the runner dies, and replays their runs elsewhere.

Update the measured table at "Measured in the spike" to the Helix build:
- start: about 0.5–0.6 ms;
- step: 11–12 µs (async) or 8 µs (sync), plus about 20 µs for the thread hop and about 25 µs for the process hop;
- replay of 1,000 steps: 11–12 ms in-thread, 18–19 ms over the socket;
- memory: **about 0.5 MiB per paused run** (v0.17.0; it was 0.4 MiB on v0.12.1).

Also strike "The spike enumerated 20 imports" and replace it with 19, the count for the Helix build without libc.

---

## Could not verify

- **ASan confirmation of GHSA-m53g.** I ran upstream's regression test, adapted to force GC by allocation pressure instead of calling `std.gc()`, but I didn't build an ASan variant. I did not attempt the advisory's exploit, and its PoC is not public.
- **Cause of the trap after out-of-memory.** I didn't establish whether the out-of-bounds trap comes from quickjs-emscripten's glue or from the engine. I also didn't check whether master's `8e14a39` ("Fix use-after-free when JS_NewContext runs out of memory") fixes it.
- **Conformance and fuzzing:** I didn't run test262 or upstream's full test suite against the Helix build, and I didn't fuzz it.
- **Other platforms:**
  - I didn't check whether the build is byte-identical on an x86_64 builder. Both builds ran in the arm64 emsdk image on the same machine.
  - All measurements ran on macOS arm64 under a load average of 4–7. Nothing was measured on Linux, in ACA, or under cgroup CPU quotas.
- **Cause of the RSS increase:** the +25% RSS per paused run on v0.17.0 is attributed to the arena allocator without measurement.
- **Maintenance effort:** the per-release figures are an estimate from one five-release jump, not a tracked history.
- **Q2 gaps:**
  - a real native crash inside a thread (SIGSEGV kills the whole process, which makes it a process-pool concern) [assumption];
  - out-of-memory at the process level;
  - durable history writes inside the pool;
  - a job that runs just under the deadline on every step;
  - the cause of the extra ~3 ms replay cost inside the pool;
  - why RSS didn't fall after eviction.
- **Q3 gaps:**
  - TCP, or TLS, between ACA apps instead of a Unix socket;
  - a binary codec, or passing answers through as raw strings (I estimate it would save about 10 µs at 2 KB [assumption]);
  - Q2's threads combined with Q3's process split. The combined step cost is estimated, not measured, at about 55–60 µs p50 [assumption].
- **Engine used for Q2 and Q3:** both ran on the npm 0.12.1 engine, not the Helix build. Q1 shows the engine share per step is 1–3 µs lower on the Helix build, so I don't expect the conclusions to change [assumption].

## How to re-run

From `spike-quickjs-2/`, after `npm ci`:

```
build/build.sh [OUT]                    # Helix build. Env: HELIX_MALLOC_USABLE_SIZE=0, HELIX_NO_LIBC=0, EMSDK_IMAGE=…, MIN_NODE_VERSION=…
node q1/smoke.mjs ng helix; node q1/memlimit-check.mjs; node q1/memlimit-check2.mjs
node q1/probes.mjs helix; node q1/stack-check.mjs ng,helix; node q1/imports.mjs ng,helix
node q1/oom-after.mjs helix limit32 objects; node q1/ghsa-m53g-regress.mjs ng,helix,bellard
node q1/perf.mjs ng,helix; node --expose-gc q1/mem.mjs helix 1000
node pool/bench.mjs latency|throughput 1000 20|isolation 500|evict|churn|idle|recovery terminate|transfer
cd xproc && node bench.mjs all
```