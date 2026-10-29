# Spike: app-authored job code on self-hosted workerd

**Date:** 2026-10-28 · Spike for EK Yancy · Time-box about 90 minutes, plus a re-scope
**Raw outputs:** `results/*.txt`. No git repository was touched.
**Evidence tags:** [observed] = ran it; [source] = quoted from schema or source; [assumption] = not tested.

## Versions

| Item | Version |
|---|---|
| workerd (npm, exact pin) | `workerd@1.20261014.1` ("workerd 2026-10-14"), macOS binary `@cloudflare/workerd-darwin-arm64`, Docker `@cloudflare/workerd-linux-arm64@1.20261014.1` |
| esbuild (exact pin) | `0.25.10` |
| Node | v24.18.0 on macOS 27 arm64 |
| Docker | Engine 29.6.2 (Docker Desktop, linux/arm64 VM) |
| Container image | `node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c` |
| Worker `compatibilityDate` | `2026-10-01` |

## Summary

**The proposed shape works.** One esbuild ES module per app ran in one workerd process. `globalOutbound` sent traffic to a gateway over a Unix socket. workerd's implicit `internet` service was replaced by one with `network = (allow = [])`.

**Egress is fully contained.** Every `fetch()` reached the gateway, including example.com, 127.0.0.1, localhost, ::1 and 169.254.169.254. Raw `connect()` and WebSockets also reached it, as CONNECT and Upgrade requests.

**Attribution can't be forged.** The gateway knows the caller from which socket the call arrived on, plus a header injected by the config that the job cannot override.

**The job worked end to end:**
- 50 properties, using AIMD back-off;
- the gateway enforced a token bucket and a daily cap;
- a checkpoint was written per property;
- it also ran in a container with `--network none --read-only --cap-drop ALL`, connected to the gateway only through Unix sockets on a shared volume.

**Big caveat: self-hosted workerd enforces no CPU, wall-clock or memory limits.** The source comment says "Single-tenant policy: no limits". A `while(true){}` loop ran for 24 seconds at 100% CPU and blocked the whole process. Limits have to come from outside:

| Mechanism | What happened |
|---|---|
| `RLIMIT_CPU` | SIGXCPU at 3.0 s |
| Watchdog | Can SIGKILL the process |
| `--max-old-space-size` | Aborts the whole process, and does not cover ArrayBuffers |
| Container `--memory` | `OOMKilled` |

**Assumptions the spike contradicted:**
- `Date.now()` is **not** frozen during CPU work.
- Node APIs (`process`, a virtual `node:fs`) are present **without** `nodejs_compat` at a 2026 compat date.

**Long jobs:** use bounded invocations that resume from a checkpoint the platform stores. When an invocation is cancelled, its in-flight work dies and the gateway aborts the upstream call.

**Isolation between runs:** inside one container, runs that share a uid can ptrace each other and read each other's environment. Separate uids per run block that. Per-run socket permissions are still needed.

## What was built

- **`upstream.mjs`**: a stub Account Lookup with synthetic data only (`SYN-######`, "100 Example St").
  - About 20% of queries hit, chosen by hash.
  - Returns 429 above 12 requests per second, plus about 3% at random.
  - Requires the `x-job-token` header.
  - `&delay=` slows a response down for the cancellation tests.
- **`gateway.mjs`**: a separate Node process, so it stays outside the untrusted process's memory. It is shared across apps for global budgets, and holds the logs and credentials.
  - Three Unix sockets per app: `<app>.egress.sock`, `<app>.data.sock` and `<app>.ckpt.sock`. The socket identifies the app.
  - A token bucket and a daily cap.
  - An allowlist containing only `https://lookup.example.test`.
  - JSON-lines logs.
  - Injects a per-run token.
  - Passes aborts through to the upstream.
  - Refuses CONNECT and Upgrade.
  - A TCP admin port for the supervisor only.
- **`platform/shim.mjs`**: the platform's entry module (see "Invocation contract").
- **Job apps:**
  - `apps/planner.js`: tiers T0–T4, a 15-call cap, AIMD;
  - `apps/listgen-toy.js`: a single long invocation;
  - `apps/listgen-bounded.js`: bounded invocations using `ctx.checkpoint()`;
  - `apps/probes.js`: escape and limit probes.
- **Harness:**
  - `supervisor.mjs`: generates the config, spawns workerd, invokes it over Unix sockets, samples memory;
  - `experiments.mjs`: the named experiments;
  - `docker/`: the container runs.

### Invocation contract

**workerd can only invoke a worker from a socket through `fetch`.** A bare `export default { run }` can't be called directly [observed]. So the platform's `shim.mjs` is the main module, and the app's bundle is a second module, `app.mjs`, that the shim imports. The shim:
- maps `POST /run` to `app.run`;
- strips the platform's `CKPT` binding from the env the app sees (the app saw `envKeys: ["DATA"]`);
- adds `ctx.state`, `ctx.deadline` and `ctx.checkpoint`.

Build command: `esbuild --bundle --format=esm --platform=neutral --external:node:* --external:cloudflare:*`.

## Answers

### Q1. Config fields: **works** [observed + source]

| Need | Field and notes |
|---|---|
| Route all `fetch()` to a service | `Worker.globalOutbound @6 :ServiceDesignator = "internet"`. Point it at an `ExternalServer` with `http = (style = proxy)` so the gateway sees full URLs. Node 24 then needs `http.createServer({ requireHostHeader: false })`, or it returns 400. |
| Forbid other network | Define the service yourself as `(name = "internet", network = (allow = []))`. If you don't, workerd creates an implicit one with `allow = ["public"]`. Deny lists are rejected at startup ("don't deny 'public', allow 'private' instead"). Leave `cacheApiOutbound` unset; `caches.default` then throws. |
| Bindings | `Worker.bindings = [ (name = "DATA", service = "gateway-data") ]`. Service bindings are fetch-only. **Never use `fromEnvironment` bindings**: they copy the host's environment variables into the worker. |
| Identity header the job can't forge | `HttpOptions.injectRequestHeaders` ("Any existing header with the same name is removed"). A job sending a forged `x-helix-app: appA` from app `probe` was logged as `claimedApp: "probe"`. |
| Unix socket or TCP | `Socket.address` takes `"unix:/path"`, `"unix-abstract:name"` (Linux) or `"host:port"`. `ExternalServer.address` takes the same forms. |
| Limits | **No field exists.** The only related setting is `Config.v8Flags`. |

macOS limits Unix socket paths to 104 bytes. Use relative paths in the spike, and short ones such as `/run/helix/<app>/` in production.

The working config is in `example-config.capnp`.

### Q2. Egress containment: **works; everything goes through the gateway** [observed]

`node experiments.mjs egress`, run on macOS and in Docker with identical results:

```
https://example.com/                       403 destination-not-allowed   (gateway)
http://127.0.0.1:18080/admin/stats         403 destination-not-allowed
http://127.0.0.1:18081/stats               403 destination-not-allowed   (upstream direct)
http://169.254.169.254/latest/meta-data/   403 destination-not-allowed
http://[::1]:18080/..., http://localhost:18080/...   403
https://lookup.example.test/lookup?...     403 no-active-run
forged x-helix-app header                  gateway logged claimedApp="probe"
cloudflare:sockets connect(127.0.0.1:18081) "proxy request failed"; gateway kind=egress-connect (refused)
new WebSocket(ws://127.0.0.1:18081)        "expected 101, received 403"; gateway kind=egress-upgrade
caches.default.match                       "No Cache was configured"
```

**Surprise:** `connect()` also goes through `globalOutbound`, arriving as CONNECT. The gateway must handle `connect` and `upgrade` events.

**Control test:** with `globalOutbound = "internet"` and `allow = []`, workerd refused every fetch itself ("connecting to example.com:443 is not allowed").

### Q3. Ambient access: **no host access found, but Node APIs are present** [observed]

At `compatibilityDate = 2026-10-01`, results were the same with and without `nodejs_compat`:

- **`process` exists.**
  - `process.env` is `{}`, even though `FAKE_SECRET` was set in workerd's OS environment, and even with `nodejs_compat_populate_process_env`.
  - `cwd()` returns `/bundle` and `pid` is 1.
  - `require` is undefined.
- **`node:fs` imports, but its filesystem is virtual.**
  - `readdir("/")` shows `bundle`, `tmp` and `dev`.
  - `/etc/passwd` does not exist.
  - Writing to `/tmp/x` works even in a `--read-only` container, so it is in memory.
- **`child_process.execSync`** returns "not implemented".
- **`node:net` `connect`** is routed through `globalOutbound`.
- **`eval` and `new Function`** throw `EvalError`.

At `compatibilityDate = 2024-01-01` there is no `process` and no `node:fs`, even with `nodejs_compat`. **The compat date is what controls this, so it is a security control the platform must pin.**

**Flags to forbid** (as an allowlist, and never pass `--experimental`):
- `unsafe_module`, `experimental`
- `allow_eval_during_startup`, `allow_insecure_inefficient_logged_eval`, `allow_unsafe_function_constructor`
- `allow_natives_syntax`, `allow_natives_for_differential_fuzzing`
- `allow_importable_env`, `allow_custom_ports`, `allow_irrevocable_stub_storage`
- `enable_nodejs_inspector_module`, `enable_nodejs_inspector_local_dev`
- `enable_nodejs_child_process_module`, `enable_nodejs_http_server_modules`
- `nodejs_compat_populate_process_env`

`nodejs_compat` itself looks acceptable, but the probes were not exhaustive.

### Q4. Clock: **not frozen** [observed]

A loop of 3×10⁸ iterations moved `Date.now()` by 880 ms, and `performance.now()` also by 880 ms. The whole request took 933 ms. After `setTimeout(50)` the clock read 932 ms, and 932 ms after a data fetch. The clock offers no side-channel mitigation.

### Q5. Limits: **workerd enforces none** [observed + source]

**Source** (`src/workerd/server/factory/worker-factory.c++`, on `main` rather than the pinned tag, fetched 2026-10-28):

```
// Single-tenant policy: no limits, and tracing that feeds tail workers directly.
class NullIsolateLimitEnforcer final: public IsolateLimitEnforcer {
```

| Test | Result |
|---|---|
| `while(true){}` | 99–100% CPU for 24 s. A `/health` request to the same process timed out. Disconnecting the client didn't stop it; only SIGKILL did. |
| `ulimit -t 3` | SIGXCPU at 3.0 s. This is a lifetime budget for the process. |
| Heap allocation, no flags | About 1.44 GB, then "JavaScript heap out of memory", abort. |
| `--max-old-space-size=128` | Aborted at 166 MB. |
| ArrayBuffers with that flag | **Not capped**: 1.49 GB in 0.4 s. |
| Container `--memory 256m` | Exit 137, `OOMKilled`. A sibling app was unaffected. |

**Enforce limits like this:**

| Limit | Mechanism |
|---|---|
| CPU | `RLIMIT_CPU` or cgroup `cpu.max` |
| Wall clock | Watchdog that sends SIGKILL |
| Memory | cgroup `memory.max`, plus `--max-old-space-size` |

Each of these kills the whole process.

### Q6. Long-running jobs: **bounded invocations plus a checkpoint the platform stores** [observed]

**One long request.** When the client disconnected at 3.5 s, the job was cancelled after 3 of its 8 steps.

**`ctx.waitUntil`.**
- 40 steps of 1 s each completed, so there is no 30 s cap here.
- A SIGTERM ended the process in 7 ms after 3 of 10 steps, with no drain and no completion signal.

**In-flight fetch when the invocation is cancelled** (by client disconnect, or by SIGKILL of workerd):
- the gateway saw the connection close at about 1.0 s;
- it aborted the upstream call, which reported "caller still connected=false";
- the code after `await fetch` never ran.

The call was still counted against the cap. A real upstream may still complete or bill the request [assumption].

**Re-entrant restart (`listgen-toy`).**
- A SIGKILL at 6 s left 5 checkpoints.
- After restart the job did 45 properties and skipped 5, ending at 50/50.
- With `maxNew=10` it took 5 invocations.

**Bounded invocations (`listgen-bounded`, 4 s budget).**
- 10 invocations reached 50/50. The AIMD rate carried across invocations through the checkpoint.
- A SIGKILL mid-run left `next=5`. After restart: "inv 2 did 45, next=50, done=true".
- 50 writes for 50 distinct properties.
- The property in flight when the process died had its upstream calls repeated, so delivery is **at-least-once per unit of work**.

**Recommended shape:**
1. The supervisor loops on `POST /run?budgetMs=N`.
2. The job returns `{done:false}` when it reaches `ctx.deadline`.
3. The supervisor enforces the total budget across invocations.
4. State lives outside the process.
5. Upstream calls with side effects carry idempotency keys.

Don't use `waitUntil` or one long request.

### Q7. Cold start and footprint [observed]

**Cold start** (spawn to first `/health` response over a Unix socket, macOS, 10 runs): 9.1–15.1 ms, median 9.6 ms. One run after an idle period took 126.6 ms, probably a cold page cache [assumption]. Bundles were 4–6 KB.

**Memory:**
- macOS: 30 MB idle, 42.9 MB peak while running.
- Linux container: about 29 MB.
- Two idle processes (Linux `smaps_rollup`): RSS 36 MB / PSS 26 MB and RSS 47 MB / PSS 37 MB. About 10 MB of each is the shared binary.

**Runtime:**
- 50 properties took 42.5 s: 301 upstream calls and 14 back-offs.
- With the gateway set to 4 requests per second and a cap of 120, the job stopped cleanly at the daily cap after 18 properties. The gateway logged 7 rate-limit 429s and 1 daily-cap 429.

### Q8. Containerisation [observed]

1. **Host socket bind-mounted into the container (Docker Desktop on macOS): fails.** The socket files are visible but return `ECONNREFUSED` across the VM boundary. A Linux host should work [assumption].
2. **A named volume shared between containers: works.**
   - The gateway and upstream ran in one trusted container.
   - Each workerd ran in its own container with `--network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 1000:1000 --memory 256m --pids-limit 64 --cpus 1`.
   - Inside each workerd container: `CapEff=0`, only `lo` plus kernel tunnel stubs, and a read-only root filesystem.
   - Results matched the bare run: 50/50, 301 calls, 45.3 s.
3. **Sibling runs inside one container.** A shell running as A's uid stood in for code that had escaped V8:

| Attempt by run A on run B | Same uid | Distinct uids (1001 / 1002) |
|---|---|---|
| `ptrace(PTRACE_ATTACH)` | **succeeded** (no Yama; `cap-drop ALL` doesn't block same-uid ptrace) | denied (EPERM) |
| `/proc/B/environ` | **read `FAKE_RUN_SECRET=synthetic-not-real`** | denied |
| `/proc/B/mem` | **read 16 bytes** | denied |
| `/proc/B/fd` | succeeded | denied |
| See B's sockets in `/proc/net/unix` | yes | **yes (paths visible)** |
| Connect to B's invoke socket | HTTP 200 | EACCES (`srwxr-xr-x`) |
| `kill -STOP` | **succeeded** | denied |

**Conclusion:**
- Processes that share a uid have no boundary between them.
- A distinct uid per run blocks ptrace, `/proc` and signals.
- The gateway's per-app sockets (mode 0666 in the spike) would still let run A connect to B's egress socket and be attributed as B [assumption from file modes]. They need per-run ownership with mode 0600, or a peer-credential check (`SO_PEERCRED`).
- Runs in one container also share the PID view, the memory cgroup, `/proc/net/unix` and the CPU quota.

**Recommendation:** a container per run, or at minimum a cgroup, uid and socket directory per run.

### Q9. Process per app: **works; calls are attributed by socket** [observed]

Two workerd processes ran at the same time, sharing a `jobId` on purpose:

| | app1 | app2 |
|---|---|---|
| Checkpoints | 50 | 50 |
| Calls (as counted by the job) | 301 | 297 |
| Wall time | 85.8 s | 91.1 s |
| Peak memory | 40.5 MB | 40.3 MB |
| Gateway log | 328 upstream calls, `claimed=app1` | 327, `claimed=app2` |
| Key `ckpt/same-job-id/p000` | present | absent (namespaces are separate) |

**Surprise:** each app's wall time roughly doubled, because both shared the upstream's limit of 12 requests per second. The gateway needs a global bucket per upstream as well as per-app buckets.

## Surprises

1. There is no limit enforcement in self-hosted workerd (`NullIsolateLimitEnforcer`). A loop blocks the whole process.
2. `Date.now()` advances during CPU work.
3. Node APIs are present without `nodejs_compat` at a 2026 compat date, though the filesystem is virtual and the environment is empty. Pinning the compat date is therefore a security control.
4. `connect()` and WebSockets go through `globalOutbound`, as CONNECT and Upgrade.
5. `deny = ["public"]` is a startup error. Use `allow = []`.
6. Node 24 needs `requireHostHeader: false` to accept proxy-style requests.
7. macOS socket paths are limited to 104 bytes.
8. Docker Desktop doesn't pass Unix sockets between host and container.
9. `--max-old-space-size` doesn't cap ArrayBuffers.
10. Running out of heap aborts the whole process.
11. SIGTERM doesn't drain `waitUntil`.

## Recommendation for the ADR's engine section

**Keep:**
- workerd, with one esbuild ES module per app;
- `globalOutbound` to a gateway `ExternalServer` with `style = proxy`;
- `internet` set to `allow = []`;
- the `DATA` binding;
- identity from the socket plus `injectRequestHeaders`.

**Change or add:**
1. **Invocation contract.** Ship a platform shim as the main module, with the app as a second module. Strip platform-only bindings from the env the app sees.
2. **Make the run the unit of isolation, not the app.** Either a container per run, or a cgroup, uid and socket directory per run. Use a read-only image with `--network none`, `--cap-drop ALL`, `no-new-privileges`, a read-only root filesystem, and limits on memory, process count and CPU.
3. **The supervisor owns limits; workerd has none.**

   | Limit | Enforced by |
   |---|---|
   | CPU | `RLIMIT_CPU` and/or cgroup `cpu.max` |
   | Memory | cgroup `memory.max`, plus `--max-old-space-size` |
   | Wall clock | Watchdog |
   | Calls and dollars | Gateway |

4. **Bounded invocations.** Use `POST /run?budgetMs=` with a `ctx.checkpoint(state)` that the platform stores, and re-invoke until the job is done. Delivery is at-least-once.
5. **Pin `compatibilityDate` and allowlist flags.** Never pass `--experimental`, and never use `fromEnvironment`.
6. **Gateway requirements:**
   - refuse CONNECT and Upgrade;
   - pass aborts through;
   - keep a global bucket per upstream;
   - per-run sockets with mode 0600, or `SO_PEERCRED`;
   - an allowlist of headers;
   - count calls against caps when they are forwarded.
7. **Assume no timing mitigation from the clock.**

**What contradicts the proposed design:**
- Process per app is not enough isolation.
- The clock is not frozen.
- Limits must come from outside workerd.
- `fetch` is the only way to invoke a worker.
- "No Node APIs" holds only as a bundling rule, not at runtime.

## Variant B (pure-step / QuickJS orchestrator): **abandoned**

It was dropped before any code was written. The only check made: `quickjs-emscripten` is at 0.32.0.

## Could not verify

- The source quote for `NullIsolateLimitEnforcer` comes from `main`, not the pinned tag. Observed behaviour on the pinned version matched it.
- Bind-mounted sockets on a Linux host.
- Impersonation through the gateway socket when runs have distinct uids (inferred from file modes only).
- Cold start with a cold cache or a large bundle. macOS RSS includes shared pages.
- Whether a real upstream finishes or bills a request after the gateway aborts it.
- `waitUntil` beyond 40 s, and multi-hour single requests.
- Whether the forbidden flags are actually dangerous (only `allow_code_gen_from_strings` and `unsafe_module` were tried).
- A full audit of ambient APIs.
- seccomp, AppArmor and Yama on a production kernel (Docker Desktop has no Yama).
- One stray download: `npx workerd --help`, run from outside the spike directory, pulled `workerd@1.20261028.1` into `~/.npm/_npx`. It was not used.
