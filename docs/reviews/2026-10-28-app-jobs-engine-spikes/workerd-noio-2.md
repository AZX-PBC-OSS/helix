# Spike: workerd for no-I/O app-authored jobs — follow-up (noio-2)

2026-10-28. Follow-up to `workerd-noio.md`, for ADR-0051 decision 7. This run covers the parts that need **no attack code**: Q3 (one container per (app, owner), on Docker), the Q2(c) globals audit, and the Q2 prelude hardening with the benign non-determinism probes replayed clean. The Q1 shim-import hijack and the Q2(b) async-interleaving tests are **not** done here; they are listed as open with draft mitigations.

**Evidence tags:** **[observed]** measured here · **[earlier]** from `workerd-noio.md` · **[assumed]** inferred, not measured.

Raw outputs: `results/*.txt`, `results/audit-raw.json`, `globals-audit.json`. Code: `platform/prelude.mjs` (hardened), `explore/audit.mjs`, `make-audit.mjs`, `nondet-test.mjs`, `docker/{gen,driver}.mjs`, `docker/{run,coldstart,killreplay}.sh`.

## Versions

- workerd `1.20261014.1` (self-reports `workerd 2026-10-14`); darwin-arm64 for local runs, the pinned linux-arm64 build (`../docker/pkg/x/package/bin/workerd`, same `1.20261014.1`) in containers.
- esbuild `0.25.10`, Node `v24.18.0`.
- SES `2.3.0` (published 2026-08-13) installed under `vendor/` — **not exercised** (lockdown belongs to Q1, skipped).
- Compat date `2026-10-01`. `globalOutbound` = deny worker (403, no DNS).
- Docker `29.6.2` / Docker Desktop 4.83.0 (Linux arm64 VM). Image `node:24-bookworm-slim`.
- macOS 27 arm64 host.

**To reproduce:** `./build.sh`; `(node upstream.mjs &)`; `node nondet-test.mjs`; `node make-audit.mjs`; `./docker/run.sh`, `./docker/coldstart.sh`, `./docker/killreplay.sh`.

## Summary

- **Determinism leaks closed** [observed]. `Intl` default dates and `crypto.subtle.generateKey` are neutralised in the prelude; all 15 benign non-determinism probes now replay clean, including with a deliberate delay that previously exposed the `Intl` leak. ListGen still runs and replays clean under the hardened prelude.
- **A new leak class was found and closed** [observed]. The parent prelude neutralised timers by writing `globalThis.setTimeout = …`, but the Web-API globals (`setTimeout`, `MessageChannel`, `fetch`, …) live on the **global's prototype**, so the real `setTimeout` stayed reachable through `Object.getPrototypeOf(globalThis).setTimeout` and ran. The v2 prelude neutralises these on the prototype chain, not just as an own-property shadow. (`Date` was already safe — it is an own intrinsic, not on the prototype.)
- **Globals audit** [observed]. 83 own properties of `globalThis` and 79 members of its prototype chain were enumerated and classified: 130 deterministic, 28 neutralised (18 by the prelude, 3 by the engine, 6 by config, 1 I/O sink), 2 residual non-determinism sources that are mitigated outside the prelude. Written as `globals-audit.json` to serve as an upgrade gate.
- **One container per (app, owner) works** [observed]. 3 locked-down containers held 20 paused runs each. Working set ~22–23 MiB (cgroup) for two of three containers; workerd's own cold start inside a container is ~0–40 ms (Docker orchestration adds ~1.4 s). Killing one container left the other two answering; its 20 runs recovered by replay into a fresh container in **14 ms, zero non-determinism**. By plain observation, a container cannot see another's processes, network or socket.
- **One container of three used ~1.8× the memory of its identical siblings** [observed], unexplained.

## Q3. One container per (app, owner), on Docker

**Setup** [observed]. Each (app, owner) is one container running `workerd serve` as PID 1 under the profile from the brief: `--network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 256m --memory-swap 256m --cpus 1`. Each job container mounts **only its own** socket volume (`n2sock<i>` at `/sock`) and its own read-only run-dir (`/app`). A separate trusted container runs the upstream and the driver and mounts all three socket volumes (`/s0 /s1 /s2`); it is the only process touching more than one container. The job has no network and no bindings; the driver speaks the shim's documented `/start`, `/step`, `/replay`, `/stats`, `/health` protocol over the Unix sockets — no exploit code anywhere. "Paused run" = a listgen run (5 synthetic properties) started and stepped 3 times, then left paused mid-wave in the isolate. `/stats` confirmed 20 paused runs in each container.

### Memory per container (`results/docker-q3.txt`)

| Container | Idle RSS / PSS (`/proc/1/smaps_rollup`) | With 20 paused runs, RSS / PSS | cgroup working set (`docker stats`) |
|---|---|---|---|
| c0 | 35.2 / 25.3 MB | 42.1 / 28.1 MB | 23.3 MiB |
| c1 | 35.1 / 25.1 MB | 41.9 / 28.0 MB | 22.1 MiB |
| c2 | 55.9 / 46.1 MB **(outlier)** | 57.9 / 44.1 MB | 64.1 MiB **(outlier)** |

- Per paused run (c0, c1): **~340 KB RSS / ~145 KB PSS** incremental. Higher than the parent spike's ~22 KB [earlier]; the difference is small-N noise plus JIT warm-up on the first real steps, and these runs are paused mid-wave with 4 active child generators each. [observed, cause [assumed]]
- `docker stats` (cgroup `memory.current`, which drops the file-backed workerd binary that `/proc` RSS counts) puts the real per-container working set at **~22–23 MiB** for two of three. That is the better "memory per container" figure. [observed]
- **c2 is an unexplained outlier**: an identical listgen container that used ~1.8× the memory of c0/c1 on every measure. Could not attribute it (GC not yet run, heap fragmentation, or a warm-up path). [observed]

### Cold start of a container (`results/docker-coldstart.txt`)

Measured with an in-container timer (`date +%s%N` until the socket file appears) separate from host wall time, over 3 trials:

- **workerd's own boot** (container command start → socket present): **~0–40 ms** (40 ms on the first, cold-cache trial; ~0 ms after). Consistent with the parent spike's 10–17 ms in-process cold start [earlier].
- **Docker-run wall time** (host: container create + start + log poll): **~1.4 s**, essentially all Docker/Desktop-VM orchestration, not workerd. [observed]

### Replay recovery when one container is killed (`results/docker-killreplay.txt`)

[observed] Sequence:
1. Before: all three containers report 20 paused runs; all answer `/health`.
2. `docker kill n2-c1` (SIGKILL). c1's socket then refuses connections; **c0 and c2 kept answering** — killing one container did not touch the others.
3. A replacement c1 cold-started on the same socket volume in ~1.4 s and came up with **0 paused runs** (the killed process's sticky state was gone, as designed).
4. The driver replayed c1's 20 journalled histories into the replacement: **20 recovered, 0 non-determinism, 14 ms total**; `/stats` then showed 20 paused runs again.

This is the ADR's model: the container is the failure domain; the journal (held by the trusted runner) is the source of truth; recovery is by replay and is fast.

### Runs in one container cannot see or affect another's — by observation (`results/docker-q3.txt`)

[observed] From a shell `docker exec`'d into c0 (no exploit code, only `/proc`, `/proc/net`, `ls`):

- **Processes:** c0 sees only its own `workerd` (PID 1) and the exec shell. No sibling's process is visible — separate PID namespaces.
- **Network:** `/proc/net/dev` shows `lo` plus unconfigured kernel tunnel pseudo-devices and **no `eth0`**; `/proc/net/tcp` has 0 entries. `--network none` holds.
- **Filesystem:** `/app` is read-only and holds only c0's own modules; `/sock` holds only c0's own `job.sock`; `/s1` does not exist inside c0 (`ls /s1` → "No such file or directory"). `/proc/mounts` references only c0's own socket and app mounts.

So a container's only shared surface with the rest of the system is its own socket volume, which only the trusted runner also mounts. A sibling container is not reachable by process, network or filesystem. (This observes container-boundary isolation; it does **not** test a V8 escape, and uid-per-run separation inside one container was already covered by the parent spike's `docker/siblings.sh` [earlier].)

## Q2(c). Globals audit — `globals-audit.json`

[observed] `explore/audit.mjs` walks `Reflect.ownKeys(globalThis)` and recurses through values, their statics and their prototypes (depth 4), capturing 858 KB of raw records (`results/audit-raw.json`). `make-audit.mjs` classifies each entry and writes `globals-audit.json`. Enumeration at compat date `2026-10-01`: **83 own properties of `globalThis`, 79 members of the global prototype chain** (`ServiceWorkerGlobalScope` → `WorkerGlobalScope` → `EventTarget` → `Object`).

**Classification (160 named entries):**

| Kind | Count | How |
|---|---|---|
| deterministic | 130 | pure intrinsics / data utilities (`Array`, `JSON`, `URL`, `TextEncoder`, streams, `Buffer`, static `navigator`/`origin`/`Cloudflare`, …) |
| neutralised — prelude | 18 | `Date`, `Math`(.random), `performance`, `crypto`, `scheduler`, `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `setImmediate`, `clearImmediate`, `MessageChannel`, `AbortSignal`(.timeout), `Atomics`(.waitAsync), `Intl`, `WeakRef`, `FinalizationRegistry`, `process`(.getBuiltinModule removed) |
| neutralised — engine | 3 | `eval`, `Function` (code-gen disallowed → EvalError), `WebAssembly` (compile blocked) |
| neutralised — config | 6 | `fetch`, `WebSocket`, `EventSource`, `caches`, `Cache`, `CacheStorage` (deny outbound, no cache) |
| neutralised — I/O sink | 1 | `console` (platform-captured; nothing readable back) |
| **non-determinism source (residual)** | 2 | see below |

**Residual non-determinism sources, mitigated outside the prelude** [observed + reasoning]:
- `import('node:timers')` (and `node:perf_hooks`) — the real `node:*` timers are a scheduling/time source. Not reachable at runtime now that `process.getBuiltinModule` is removed, and forbidden by the build rule (no `node:*` imports in the app bundle). Gate: build rule + `getBuiltinModule` removal, **not** the prelude.
- Isolate-global state (an app property on `globalThis`) — persists across runs that **share an isolate** (the `moduleState` probe counts 1, 2, 3). Cross-run leak, mitigated by one-isolate-per-(app,owner), not by the prelude.

The JSON carries the full entry list with mechanism and note per name, plus `meta` (workerd version, compat date, outbound mode, counts). Diff it against this baseline on each workerd upgrade; a new top-level or prototype member, or a kind change, is a release-gate hit.

**Things the audit confirmed present at this compat date** [observed]: `AbortSignal.timeout`, `MessageChannel`, `Atomics.waitAsync`, `process.getBuiltinModule`, `WeakRef`/`FinalizationRegistry`, `node:timers` — all from the previous spike's "could not verify" list, now classified and (where ambient sources) neutralised.

## Q2. Prelude hardening and clean replays

The hardened prelude is `platform/prelude.mjs` (v2). Every patch records its outcome in `patchReport`; `/prelude` returned all 21 entries as `patched` (plus `queueMicrotask` left intact). Changes over the parent:

1. **`Intl` default dates** [observed]. `Intl.DateTimeFormat.prototype.format`/`formatToParts`/`formatRange*` are **per-instance getters** in V8 (the parent's naive `proto[m]` read failed silently), so v2 wraps the getter: the bound formatter is returned, and a missing date argument is replaced by the run's logical clock. Verified: with a 1.3 s delay before replay (which forces the real second to tick), the old prelude's `intlFormat` probe was **caught as a leak at step 0**; v2 **replays clean**.
2. **`crypto.subtle.generateKey`** [observed]. Replaced with a throwing stub (random key material). Old prelude: `subtleGenerateKey` **leak caught at step 0**. v2: throws deterministically → replays clean.
3. **Extra schedulers removed** [observed] (`results/schedulers.txt`): `AbortSignal.timeout`, `MessageChannel`, `Atomics.waitAsync`, `setImmediate`/`clearImmediate` all throw; `queueMicrotask` left intact (microtask ordering is deterministic within a step).
4. **`process.getBuiltinModule` removed** [observed]. It was a back-door to `node:*` without an `import` statement; it now throws "is not a function".
5. **`WeakRef` / `FinalizationRegistry`** [observed]. Replaced with throwing stubs as defence against a GC-timing side channel. (Whether GC timing actually leaks is a Q2(a) attack test, not run here.)
6. **Prototype-shadow fix** [observed] (`results/proto-gap.txt`, `proto-gap-fixed.txt`). Timers and `MessageChannel` are neutralised across `globalThis` **and** its prototype chain. Before the fix, `Object.getPrototypeOf(globalThis).setTimeout.call(globalThis, …)` scheduled a real timer; after, it throws the same stub.

**Benign non-determinism probes replay clean** [observed] (`results/nondet.txt`). For each source, a sticky run in process A is SIGKILLed, then replayed in a fresh process B; replay compares request URLs and effects, so any residual ambient read surfaces as a non-determinism error. All 15 sources — `dateNow`, `newDate`, `dateViaCtor`, `mathRandom`, `perfNow`, `getRandomValues`, `intlFormat`, `processHrtime`, `nodeCryptoRandom`, `nodePerfHooks`, `nodeTimers`, `subtleGenerateKey`, `moduleState`, `hDeterministic`, `none` — replay clean under v2.

**ListGen still runs** [observed] (`results/listgen-v2.txt`): 20/20 properties, 18 hits, 127 calls, 6 back-offs, 38 steps, ~18.5 s against the 12 rps upstream; its 38-step history replays clean in a fresh process in 2 ms. The hardened prelude does not break the real workload.

## Surprises

1. **The prototype-shadow gap.** `globalThis[name] = stub` only shadows a Web-API global; the real one survives on `ServiceWorkerGlobalScope.prototype` and is both reachable and callable. The parent prelude's timer neutralisation was therefore incomplete. (Intrinsics like `Date` are own properties and were fine.) The most important finding here.
2. **`Intl.*.format` is a getter, not a method.** A patch that reads the method off the prototype throws "incompatible receiver" and, wrapped in try/catch, fails silently — which is how the parent's Intl leak survived unnoticed.
3. **The old `Intl` leak is timing-flaky.** It is only caught when the wall-clock second changes between record and replay, so a fast replay can make a real leak look clean. v2 removes the dependence by construction.
4. **cgroup working set is ~half of `/proc` RSS** here, because the 140 MB workerd binary is a read-only bind mount (file-backed, shared) that `/proc` RSS counts and `docker stats` does not.
5. **One of three identical containers used ~1.8× the memory** of its siblings, unexplained.
6. **Docker cold start is ~1.4 s of orchestration** around a ~0–40 ms workerd boot; the engine is not the cost.

## Recommended text for ADR-0051 decision 7

Replace the "Determinism and ambient APIs" hardening with the following (the import-hijack half still needs the Q1 verification — see "Could not verify"):

> **Determinism is enforced by a prelude that patches own *and* prototype copies.** The Web-platform globals (`setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`/`clearInterval`/`clearImmediate`, `MessageChannel`, `fetch`, …) live on the global object's **prototype**, not as own properties, so assigning `globalThis.X` only shadows them and leaves the real one reachable via `Object.getPrototypeOf(globalThis).X`. The prelude neutralises each such name across `globalThis` and every prototype in the chain, and verifies the real one is no longer reachable. ECMAScript intrinsics (`Date`, `Math`, …) are own properties and need only an own-property patch.
>
> **The prelude neutralises, at the pinned compat date:** `Date` (including the indirect constructor), `Math.random`, all timers and `scheduler.wait`, `performance.now`/`timeOrigin`, `crypto.getRandomValues`/`randomUUID`, **`crypto.subtle.generateKey`**, **`Intl.DateTimeFormat` default-date formatting** (a per-instance getter that must be wrapped, not replaced), **`AbortSignal.timeout`**, **`MessageChannel`**, **`Atomics.waitAsync`**, and **`process.getBuiltinModule`** (a runtime back-door to `node:*` that the no-`node:*`-imports build rule alone does not close). `WeakRef` and `FinalizationRegistry` are replaced with throwing stubs as defence against GC-timing side channels. `queueMicrotask` is left intact (deterministic within a step).
>
> **A globals audit gates every workerd upgrade.** `globals-audit.json` enumerates every own property of `globalThis` and every member of its prototype chain at the pinned compat date and classifies each as deterministic, neutralised (by prelude / engine / config) or a residual non-determinism source. At this compat date there are 83 own + 79 prototype members; all ambient sources are neutralised; the only residual sources are the `node:*` timer modules (closed by the build rule plus removing `getBuiltinModule`) and isolate-global state (closed by one-isolate-per-(app,owner)). An upgrade must re-run the audit and diff it; any new member or kind change blocks the upgrade.

For the **isolation-unit** paragraph, add from the container measurements:

> **Measured on Docker (one container per (app, owner), the stated profile).** Three containers held 20 paused runs each. Working set ~22–23 MiB per container (cgroup); workerd's own cold start inside a container is ~0–40 ms, with Docker orchestration adding ~1.4 s. SIGKILL of one container left the others serving and lost only that container's sticky state; its 20 runs recovered by replay from the journal in 14 ms with zero non-determinism. By process-, network- and filesystem-level observation, a container cannot see or reach another container's runs; the only shared surface is each container's own socket volume, which only the trusted runner also mounts.

## Could not verify

- **Q1 shim-import hijack and its fixes.** Bundling platform + app into one module (variant a), the closure-held run map (variant b), self-import reachability of the handler/run-map, and frozen intrinsics (SES `lockdown()` or hand-rolled) with ListGen under them — **not tested** (need the attack code, out of scope this pass). Draft mitigations to verify next:
  - bundle prelude + shim + app into one main module so no platform module name exists to `import`, and keep the run `Map` in a module closure that is never exported;
  - have the shim reject any invocation that does not carry a genuine `ExecutionContext` (the `ctx` prototype is `ExecutionContext` and is not reachable from globals — observed but unused here);
  - serialise steps one-at-a-time per isolate so there is no second in-flight generator to drive;
  - as defence in depth, freeze intrinsics with a pinned SES `lockdown()` (2.3.0 is vendored) and confirm ListGen runs under frozen primordials.
- **Q2(a) GC timing.** Whether `WeakRef`/`FinalizationRegistry` actually leak GC timing into a run — only their removal is verified, not that GC timing is observable without them.
- **Q2(b) async interleaving.** Whether a step that awaits a microtask- vs macrotask-resolved promise, or a failing internal call, can break the prelude's `det.enter`/`det.exit` "current run" context and let one run observe another's timing — **not tested**. (v2 removes several macrotask schedulers, which narrows but does not close this.)
- **The c2 memory outlier** (~1.8× its siblings) was not explained.
- **Cold start** is bounded below by Docker orchestration (~1.4 s) on Docker Desktop's Linux VM; bare-metal or ACA may differ.
- **Per-paused-run memory** is small-N (20 runs) and baseline-dominated; the ~340 KB RSS / ~145 KB PSS figure is an upper bound, not the asymptotic per-run cost.
- **SES `lockdown()`** was installed but not run.
- All numbers are a single machine; no seccomp profile audit.