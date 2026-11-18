# ADR 53 sandbox experiments

Run from the repository root:

```sh
pnpm install
pnpm --filter @azx-pbc/sandbox-poc probe
pnpm --filter @azx-pbc/sandbox-poc probe cpu
```

This is an investigative baseline using pinned quickjs-emscripten 0.32.0,
not the Helix-owned engine required by [ADR 53](../../docs/adr/0053-app-authored-jobs.md).
The package is private and no platform service imports it.

The full run prints one JSON record per probe and exits nonzero if any
expectation fails. A parent process gives each child five seconds and caps
captured output. Each child creates a fresh Wasm module and exits after its
probe, including after OOM. The environment contains only PATH.
Limits are an 8 MiB QuickJS heap, 128 KiB stack, and 150 ms execution deadline.
Elapsed times include process startup and engine loading; they are not step benchmarks.

Probes cover ambient globals, Function constructor access, randomness, module
loading, spinning code including try/catch, endless microtasks, recursion,
ordinary arrays, ArrayBuffer allocation, prototype pollution followed by a fresh
process canary, and Promise.all replay against two fixed recorded answers.
The replay probe is a guest-side smoke test, not a durable runner or authenticated
host protocol. The canary tests process separation, not co-resident instances.

## Observations on 2026-11-17

Node 24.15.0, Linux, npm engine 0.32.0: 12 of 13 probes met their expectations.
The ordinary-array heap bomb stopped at the CPU deadline, not with an allocation
failure. This remains a failing probe; it does not establish a hard heap bound.
The 64 MiB ArrayBuffer allocation was rejected. CPU and microtask loops stopped,
including code trying to catch interrupts. The async replay returned 42.

## What remains to investigate

This harness does not enforce a hard WebAssembly.Memory maximum, OS network
denial, filesystem isolation, cgroup memory limits, or credential isolation after
an engine escape. A subprocess still has the host user's permissions. Run only
these fixed probes in a disposable development environment; do not use this as
an arbitrary-code execution service.

Next experiments should substitute the reproducible Helix engine, enumerate and
pin Wasm imports and guest globals, run upstream security regressions, measure
peak linear memory and RSS, and exercise co-resident-instance canaries.
Then add an external JSON request/answer driver with history divergence,
crash/replay and request refusal tests, followed by a network-denied container
pool. No production telemetry seam is introduced here; JSON output is local
experimental evidence.

API reference: [upstream runtime documentation](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten-core/classes/QuickJSRuntime.md).
