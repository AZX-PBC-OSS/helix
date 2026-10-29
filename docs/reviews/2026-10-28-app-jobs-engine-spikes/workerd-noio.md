# Spike: workerd as the engine for no-I/O app-authored jobs

2026-10-28 · about 75 minutes. Lightly condensed; all numbers kept.

**Evidence tags:**
- **[observed]**: measured in this spike.
- **[earlier]**: from `workerd-io.md`.
- **[assumed]**: inferred, not measured.

Raw outputs are in `results/*.txt`.

**Versions:**
- workerd `1.20261014.1` (darwin-arm64)
- esbuild `0.25.10`
- Node `v24.18.0`
- macOS 27 arm64. No Docker in this spike.
- Compat date `2026-10-01` (2024-01-01 also tried)

**To run:** `./build.sh`, then `(node upstream.mjs &)`, then `node bench.mjs <overhead|replay|memory|runaway|escape|nondet|e2e|isolation>`, plus `node crash.mjs` and `node node-driver.mjs replay|live 10`.

## Summary

**The design works on workerd:**
- **The job.** An async generator. `h.fetch`, `h.all`, `h.now` and `h.random` only build descriptions; the job never touches the network.
- **The runner.** Trusted Node code. It performs every request through a gateway stub, which applies a global AIMD token bucket, a per-run call cap, an allowlist, `select`, and idempotency keys. The runner journals `{request, answer}` and resumes the job.
- **Sticky mode.** A module-level `Map<runId, generator>` inside the isolate.
- **Replay mode.** Re-run from the journal, then continue live.
- **End-to-end runs.** ListGen finished 50/50 in 36.8 s with 301 answered calls. After a SIGKILL of both the runner and workerd mid-run, replay recovered with **zero duplicate** answered requests.

**The mechanics are cheap** [observed], so cost does not decide anything:
- a sticky step takes about 0.08 ms; a resume about 1–2 µs;
- a cold replay of 1,000 steps takes 2.5 ms, and 5,000 steps take 9.4 ms;
- a paused run uses about 13–27 KB.

**What matters is isolation and determinism.**
1. **Runs that share an isolate are one trust domain** [observed]. One run patched intrinsics to steal another's requests and sent them out through its own allowed `h.fetch`. It also used `import("./shim.mjs")` to resume another run with forged answers, and nothing detected it. Separate isolates stopped both attacks.
2. **The process is the failure domain** [observed]. A runaway in one isolate blocked other isolates in the same process. Only SIGKILL stops it, and that kills every sticky run in the process. Replay recovered 19 runs of 100 steps each in about 16 ms.
3. **Determinism is mostly enforceable** with a platform prelude module.
4. **`network = (allow = [])` still does host DNS lookups** on hostnames the job chooses. Use a 403 "deny" worker as `globalOutbound`.

**The I/O spike's "container (or uid) per run" finding no longer holds.** It was driven by credentials and egress sockets in the sandbox, and this design has neither. The new rule:
- an isolate per data scope;
- a process as the CPU and memory blast radius;
- an OS sandbox per process.

A uid per run becomes optional hardening.

## What was built (in `noio/`)

**Platform code:**
- `platform/prelude.mjs`: evaluated before the app. It neutralises `Date`, `Math.random`, timers, `scheduler.wait`, `performance.now`, `crypto.getRandomValues` and `randomUUID`.
- `platform/shim.mjs`: the entry point. It handles `POST /start`, `/step` and `/replay`, and returns a request, a done signal, an error or a non-determinism error. `h.now()` is the time the runner stamped on the last answer. `h.random()` is a PRNG seeded from the runId. Both are recorded as effects.
- `platform/deny.mjs`: the outbound sink. It returns 403 and refuses `connect`.
- `platform/loader.mjs`: an experimental WorkerLoader host.

**Apps:**
- `apps/listgen.js`: tiers T0–T4, a 15-call cap, and 4 properties in flight as child generators multiplexed through `h.all`.
- `trivial`, `runaway`, `nondet`, `probes`, `pollute` and `shared`.

**Runner and gateway:**
- `gateway-stub.mjs`: AIMD (halve the rate on a 429, add 0.25 rps on success), a call cap, an allowlist. It holds the credential and sends `x-idempotency-key = runId/seq/item`.
- `runner.mjs`: generates the config and spawns workerd. It keeps a JSONL journal with per-item answer records, and a per-step watchdog that SIGKILLs.
- `upstream.mjs`: the parent's stub on port 18181, 12 rps with about 3% random 429s, keeping a count per idempotency key.

## Answers

### Q1. Per-step overhead in sticky mode [observed]

| Measure | p50 | p90 | p99 |
|---|---|---|---|
| `GET /health` (transport) | 0.066 ms | 0.088 ms | 0.139 ms |
| `POST /step`, 1 run | 0.080 ms | 0.099 ms | 0.165 ms |
| `POST /step`, 4 concurrent (about 31k steps/s) | 0.121 ms | 0.147 ms | 0.216 ms |
| ListGen step (`h.all` of 4) | 0.094 ms | 0.165 ms | 0.531 ms |
| Generator resume inside the isolate | about 1–2 µs | | |

Transport and JSON dominate the step cost. `performance.now()` has 1 ms resolution inside workerd.

### Q2. Replay time against history length (fresh process, 5 runs each) [observed]

| History | Size | Round trip p50 | Time inside the isolate |
|---|---|---|---|
| 10 | 1.7 KB | 0.51 ms | <1 ms |
| 100 | 17 KB | 0.58 ms | 0–1 ms |
| 1,000 | 174 KB | 2.5 ms | 1–2 ms |
| 5,000 | 878 KB | 9.4 ms | 4 ms |
| ListGen full run (145 steps) | 82 KB | 7.7 ms | 7 ms (cold JIT) |

Replay time grows linearly and is dominated by JSON parsing. Replay can serve as the source of truth, with sticky state as a cache.

### Q3. Memory per paused run [observed]

These are macOS RSS figures, upper bounds that include garbage. The baseline is about 30.2 MB.

| Paused runs | Trivial job | ListGen job |
|---|---|---|
| 1 | +0.5 MB | +0.8 MB |
| 100 | +2.3 MB (23 KB each) | +7.6 MB (78 KB each, includes warm-up) |
| 1,000 | +18 MB (18 KB each) | +26 MB (27 KB each) |
| 5,000 | +71 MB (14.5 KB each) | +109 MB (22 KB each) |

**WorkerLoader** (one isolate per run, needs `--experimental`):
- about 2.1 MB per isolate, 655 MB at 300 isolates;
- creating the isolate plus the first step took 1.7–2.7 ms at p50;
- each later step took 0.21 ms.

### Q4. A runaway loop inside a step [observed]

**Setup:** 20 sticky runs of 100 answered steps each, plus one run that loops forever after its third step. Both a synchronous `for(;;){}` and an `await null` chain were tested.

**Blast radius:**
- Steps for healthy runs in the same process hung until the kill: 800 ms, then "socket hang up".
- A runaway in isolate A blocked `/health` on isolate B in the same process, because one thread serves all isolates.

**What the runner must do:**
1. **Per-step wall-clock watchdog.** A watchdog of about 1 s fired at 1,003–1,005 ms and SIGKILLed workerd. A legitimate step takes microseconds, so about 1 s is safe.
2. **`RLIMIT_CPU` only as a backstop.** It is a lifetime budget: `ulimit -t 2` sent SIGXCPU at 1,997 ms. Use it only with one run per process; otherwise use cgroup `cpu.max`.
3. **Quarantine the culprit.** Replaying it loops again. If steps run concurrently, every outstanding step is suspect: either serialise steps per process, or replay suspects one at a time.
4. **Memory:** cgroup `memory.max`. Running out of memory aborts the whole process, and `--max-old-space-size` doesn't cover ArrayBuffers [earlier].

**Recovery:** a new workerd cold-started in 11–12 ms, and 19 healthy runs replayed in 15.5–16.5 ms in total.

### Q5. Escape surface with no outbound access [observed]

Three configurations were compared: `internet` with `allow=[]`; a deny worker; and a deny worker at compat date 2024-01-01.

| Probe | `internet` with `allow=[]` | Deny worker |
|---|---|---|
| `fetch` to example.com, 127.0.0.1, localhost, `[::1]`, 169.254.169.254, `lookup.example.test` | "internal error". The `.test` host produced "failed to lookup address information", so **host DNS ran** | 403, no stderr output |
| DNS-shaped exfiltration (`synthetic-secret-123.lookup.example.test`) | Host `getaddrinfo` was attempted | 403, no lookup |
| `cloudflare:sockets` `connect` | "proxy request failed" | "Network connection lost" |
| `node:net` | Fails | The connect event fires, then an error. No data sent; the upstream saw 0 requests |
| WebSocket | Fails | Fails |
| Cache (`caches.default`, `caches.open`) | "No Cache was configured" | Same |
| `node:dns` | DoH refused | ENOTFOUND |

**Results common to both outbound modes:**
- `WebAssembly.compile` is blocked by the embedder.
- `eval` and `Function` throw `EvalError`.
- `Atomics.wait` is blocked.
- `node:fs` is virtual (`/bundle`, `/tmp`, `/dev`), and writes go to memory only.
- `child_process` is not implemented.
- `process.env` is `{}`, and the `cloudflare:workers` `env` has no keys.
- **The app can `import("./shim.mjs")` and `import("./prelude.mjs")`.** That reaches the platform's internals, including the real `Date`.

**Compat date:**
- At 2024-01-01, every `node:*` import fails with "No such module", and `process` is undefined.
- At 2026-10-01, results with `nodejs_compat` were the same as without it. It has been on by default since 2026-08-04.

**`globalThis` at 2026-10-01** has 84 own properties; the full list is in `results/escape.txt`. Beyond the ECMAScript built-ins they include:
- `Buffer`, `Cloudflare`, `ServiceWorkerGlobalScope`;
- `caches`, `console`, `crypto`, `navigator`, `origin`, `performance`, `process`, `scheduler`, `self`, `global`;
- the timers, now as throwing stubs;
- `WebAssembly` (with `compile` blocked), `SharedArrayBuffer`, `Atomics`;
- `WeakRef`, `FinalizationRegistry`, `Intl`, `escape` and `unescape`.

### Q6. Crash recovery [observed]

**Sequence:**
1. The runner and workerd were both SIGKILLed at 9.0 s. The journal held 15 steps and 62 item answers.
2. Runner #2 cold-started workerd (16.8 ms).
3. It replayed the 15 steps in under 1 ms inside the isolate.
4. It reused 2 half-step answers from the journal, then continued live.

**Result:** 50/50 properties, 47 hits and 301 calls, identical to an uninterrupted run, in 44.5 s total. The upstream counted 301 answered keys, all distinct, with **0 duplicates**.

**Guarantee:** only items whose answers were not yet journalled can repeat, which means at most the in-flight items. Each repeat carries the same idempotency key, so a duplicate can be detected.

### Q7. Non-determinism [observed]

**Method:** a sticky run in process A put a candidate value into its URL. Process A was SIGKILLed, and the run was replayed 1.1 s later in process B.

**Neutralised (replay matched):**
- `h.now` and `h.random`;
- `Date.now`, `new Date()`, and the `Date` constructor obtained indirectly;
- `Math.random`, `performance.now`, `getRandomValues`;
- `process.hrtime`, `perf_hooks` and `randomBytes`, because their polyfills read the patched globals.

**Leaks, each caught at step 0:**
- `new Intl.DateTimeFormat().format()` with no argument;
- `crypto.subtle.generateKey` followed by `exportKey`;
- isolate-global state (expected 4, got 1).

**Bypass:** `import("./prelude.mjs")` gives the job the real `Date`.

**Limits** [assumed]:
- Only requests and effects are compared. A leak that changes only the return value goes unseen; hashing the return value would close that.
- `WeakRef` and `FinalizationRegistry` are untested.
- A truly async await could interleave runs and confuse the prelude's context.

**Fixes:** wrap `Intl` formatting so it uses the logical date; stub `subtle.generateKey`; bundle the platform modules so the app can't import them.

### Q8. The same module runs under plain Node [observed]

The `listgen.mjs` module was byte-identical in every place it ran (one SHA across 7 copies).
- **Replay:** the 145-step history recorded under workerd replayed in Node with 0 mismatches in 5.4 ms.
- **Live run** of 10 properties: 8 hits, 57 calls, 3 back-offs, in 10.1 s.

In a browser, `Date` and `Math.random` are deterministic only if the prelude is loaded there too.

### Q9. End to end, upstream at 12 rps (sticky, one process) [observed]

- **Wall time:** 36.8 s. The earlier spike, where the job did its own I/O, took 42.5 s.
- **Results:** 50/50, with 47 hits (T0 6, T1 12, T2 4, T3 1, T4 24) and 3 misses.
- **Calls:** 301 answered out of 314 gateway attempts.
- **Back-offs:** 13. AIMD took the rate from 8 rps down to 3.9 and finished at 7.05.
- **Other:** 82 steps, 0 duplicates, workerd RSS 31.5 MB.

### Q10. The isolation unit [observed, plus reasoning]

Test: one app (`shared`) with attacker and victim runs.

| Attack | Runs share an isolate | Separate isolates, same process | One isolate per run (WorkerLoader) |
|---|---|---|---|
| Patch intrinsics, capture the victim's requests, exfiltrate through the attacker's own allowlisted `h.fetch` | **Stole 50 items** | 0 | 0 |
| `import("./shim.mjs")`, then step the victim with forged answers | **Hijacked.** 4 properties became `SYN-FORGED`; the desync went undetected | Run not found | Not tested |
| Runaway loop | Blocks everyone | **Blocks the other isolate too** | Assumed to block |
| Out of memory | Kills the process [earlier] | Kills the process [earlier] | Kills the process [assumed] |

**Runs sharing an isolate form one integrity domain.** Frozen intrinsics would stop the pollution attack, but not the module import or the shared globals [assumed].

**Runs sharing only a process** resisted every JavaScript-level attack tried. They still share CPU, out-of-memory kills, the process kill, and memory that a V8 escape could read [assumed].

**Per-run OS isolation is no longer required:**
- secrets in the environment: none;
- egress-socket impersonation: impossible, because the job has no sockets;
- what remains: a same-uid ptrace exposes only co-resident runs' data and lets the attacker disrupt them.

**An OS sandbox per process is still required,** because a V8 escape gets workerd's own OS privileges.

**Answer:**
- an isolate per data scope;
- a process per failure domain;
- an OS sandbox per process;
- a uid or container per run is optional.

## Surprises

1. `allow = []` still resolves DNS on the host, which is an exfiltration channel. Fix: route outbound to a deny worker.
2. The app can `import()` platform modules, getting the real `Date` and the ability to hijack runs.
3. A runaway in one isolate blocks the other isolates in the same process.
4. The Node polyfills follow the patched globals; `Intl` and `crypto.subtle` do not.
5. Neutralising the timers breaks `node:net`'s error path.
6. `performance.now()` has 1 ms resolution.
7. Replay is cheap enough that sticky state is just a cache.
8. WorkerLoader gives one isolate per run in a single process, but it needs `--experimental`; it costs about 2.1 MB and 2 ms per run.
9. `nodejs_compat` is on by default from 2026-08-04. Compat date 2024-01-01 has no `process` and no `node:*`.

## Recommendation for the workerd ADR (no-I/O design)

**Isolation:**
- **Isolate:** at most one data scope (app × tenant, or app × user). No WorkerLoader while it needs `--experimental`.
- **Process:** the failure domain. Default to one workerd per data scope: about 30 MB, of which about 10 MB is shared, with a cold start of 10–17 ms.
- **OS sandbox per process:** `--network none`, read-only root filesystem, `cap-drop ALL`, `no-new-privileges`, and pid, memory and CPU limits. No credentials or sockets inside. A uid per run is optional.

**Limits (the runner's job):**

| Limit | Mechanism |
|---|---|
| Wall clock per step | A watchdog of about 1 s that SIGKILLs |
| Culprit | Quarantine it, and replay suspects one at a time |
| Everyone else | Replay |
| CPU | cgroup `cpu.max` |
| Memory | cgroup `memory.max` plus `--max-old-space-size` |
| Per run | Caps on step count and history size |
| Gateway | Call cap, global bucket per upstream, AIMD, allowlist, `select`, URL and answer size caps |

**How the runner drives it:**
1. A keep-alive Unix socket exposing `/start`, `/step` and `/replay`.
2. Journal each item answer, then each step, before resuming.
3. Idempotency key `runId/seq/item`.
4. Replay is the source of truth; sticky state is a cache.
5. Compare requests and effects on replay.
6. A `seq` check on `/step`. This catches accidental desync; it is not a defence.

**What an install ships:**
- A pinned workerd binary.
- A config generator with: no bindings; `globalOutbound` set to deny; `internet` set to `allow=[]` as a backstop; a pinned compat date; an allowlist of flags; and never `--experimental`.
- The prelude and shim, extended to cover `Intl` and `subtle`, and possibly frozen intrinsics.
- A build rule: one esbuild ES module, with no `node:*` imports.
- The runner: journal, watchdog, replay, quarantine, gateway client.
- A container profile.
- A Node or browser driver.

**Open choice:** compat date 2024-01-01 removes `process` and `node:*` entirely, but it changes other behaviour as well.

## Comparable numbers

| Metric | workerd |
|---|---|
| Sticky step round trip, p50 | 0.080 ms (1 run) / 0.121 ms (4 concurrent) |
| Resume | about 1–2 µs |
| Cold replay at 10 / 100 / 1,000 / 5,000 steps | 0.51 / 0.58 / 2.5 / 9.4 ms |
| Paused run | about 13 KB (trivial) / about 21 KB (ListGen) |
| 100 paused runs | +2.3 / +7.6 MB |
| Process | about 30 MB RSS; 10–17 ms cold start (one outlier at 117 ms) |
| End to end, 50 properties at 12 rps | 36.8 s, 301 calls, 13 back-offs, 82 steps |
| Recovery, 19 runs × 100 steps | about 16 ms |
| Runaway | No limit inside the engine; external kill; the whole process is the blast radius |

## Could not verify

- That the DNS query leaves the host. Inferred only from `getaddrinfo` error text; no packet capture.
- Behaviour on Linux or in a container (macOS only), and seccomp.
- Memory of static per-slot Workers, compared with WorkerLoader.
- Out-of-memory behaviour inside a process with several isolates.
- Limits applied to WorkerLoader isolates.
- `WeakRef` and `FinalizationRegistry` as nondeterminism sources.
- Interleaving across truly async awaits.
- Self-import when the main module is a single bundle.
- What `node:timers` returns after the timers are neutralised.
- Whether lockdown (frozen intrinsics) works with ListGen.
- Memory figures are macOS RSS without a forced GC.
- The 1 ms resolution of in-isolate timings.
- The source quote for "no limits" is from workerd `main`, not the pinned tag [earlier].
