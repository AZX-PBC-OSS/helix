# Engine spikes for app-authored jobs (2026-10-28)

Evidence for [ADR-0053](../../adr/0053-app-authored-jobs.md). Five time-boxed spikes tested two candidate engines for running app-authored job code that does no I/O. ADR-0053 cites them as `[report Q]`, for example `[quickjs-2 Q1]`.

| Report | Cited as | What it tested |
|---|---|---|
| [quickjs-1.md](quickjs-1.md) | `quickjs-1` | QuickJS compiled to WebAssembly: research (QuickJS vs quickjs-ng, security record, Wasm runtimes, production users) and Q1–Q11 measured on the npm `quickjs-emscripten` build; Javy plus Wasmtime as a comparison |
| [quickjs-2.md](quickjs-2.md) | `quickjs-2` | Follow-up: a Helix-owned quickjs-ng Wasm build (Q1), a `worker_threads` pool with thread affinity (Q2), and the cost of a separate sandbox process (Q3) |
| [workerd-io.md](workerd-io.md) | `workerd-io` | Self-hosted workerd where the job performs its own I/O through a governed outbound worker. Not the chosen design; kept for the "jobs that do their own I/O" alternative and for workerd's limits (Q5) |
| [workerd-noio.md](workerd-noio.md) | `workerd-noio` | workerd running the no-I/O design: step cost, replay, memory, runaway code, escape surface, crash recovery, non-determinism, isolation unit (Q1–Q10) |
| [workerd-noio-2.md](workerd-noio-2.md) | `workerd-noio-2` | Follow-up: one container per (app, owner) on Docker (Q3), a globals audit (Q2(c)) and prelude hardening (Q2). The shim-import hijack fix was **not** verified |

Read these with three caveats:

- **ADR numbers inside the reports are from earlier drafts.** At the time, the design and the two engines were drafted as separate, competing ADRs, so "ADR-0051", "ADR-0052" and "decision 7" in the reports refer to those drafts, not to the current ADR-0051 and ADR-0052. ADR-0053 is the single merged record.
- **The reports name each claim's evidence:** `[observed]` was measured, `[source]` was read from upstream code or an advisory, `[research]` is from published material, and `[assumption]`/`[assumed]` was not tested. ADR-0053 relies only on observed and source claims for its guarantees.
- **The spike code and raw outputs (`results/`, probes, the build script) are not committed here.** The reports quote the numbers they rely on. The QuickJS build script becomes part of the implementation, not this record.

All spike data was synthetic. Measurements are from a developer laptop (macOS, arm64, Docker Desktop); ACA and production hardware may differ.
