import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { newQuickJSWASMModule } from "quickjs-emscripten";

const cases: Record<string, { source: string; error?: RegExp; expected?: unknown }> = {
  ambient: {
    source:
      'JSON.stringify(["process","require","fetch","Date","WebAssembly","Atomics","WeakRef","FinalizationRegistry","console","setTimeout"].map(k => typeof globalThis[k]))',
    expected: JSON.stringify(Array(10).fill("undefined")),
  },
  constructor: { source: 'Function("return typeof process")()', expected: "undefined" },
  random: { source: "Math.random()", error: /disabled/ },
  imports: { source: 'import x from "node:fs";', error: /module|load/i },
  cpu: { source: "while(true) {}", error: /interrupted/ },
  catchCpu: { source: "while(true) { try { while(true) {} } catch {} }", error: /interrupted/ },
  microtasks: {
    source: "Promise.resolve().then(function spin(){return Promise.resolve().then(spin)}); void 0",
    error: /interrupted|deadline/,
  },
  stack: { source: "(function recurse(){ return recurse()+1 })()", error: /stack/ },
  heap: {
    source: 'const a=[]; while(true) a.push(new Array(10000).fill("x"));',
    error: /memory|alloc/i,
  },
  arrayBuffer: { source: "new ArrayBuffer(64 * 1024 * 1024).byteLength", error: /memory|alloc/i },
  pollution: { source: "Object.prototype.canary = 123; 42", expected: 42 },
  canary: {
    source: "JSON.stringify([typeof Object.prototype.canary, 6*7])",
    expected: '["undefined",42]',
  },
  asyncReplay: {
    source: `globalThis.answer = null;
      const history = [{request: {id: 1}, answer: 20}, {request: {id: 2}, answer: 22}];
      let cursor = 0;
      const h = Object.freeze({fetch: async request => {
        const entry = history[cursor++];
        if (JSON.stringify(entry.request) !== JSON.stringify(request)) throw Error("nondeterminism");
        return entry.answer;
      }});
      (async () => {
        const values = await Promise.all([h.fetch({id:1}), h.fetch({id:2})]);
        answer = values.reduce((a,b) => a+b,0);
      })(); void 0;`,
    expected: 42,
  },
};
const name = process.argv[2];
if (!name) {
  let failures = 0;
  for (const probe of Object.keys(cases)) {
    const started = performance.now();
    // A separate process bounds hangs outside QuickJS's interrupt machinery.
    // This is not an OS security sandbox and does not impose a Wasm memory cap.
    const child = spawnSync(process.execPath, [import.meta.filename, probe], {
      env: { PATH: process.env.PATH ?? "" },
      timeout: 5000,
      maxBuffer: 65536,
      encoding: "utf8",
    });
    const passed = child.status === 0;
    if (!passed) failures++;
    console.log(
      JSON.stringify({
        probe,
        passed,
        elapsedMs: Math.round(performance.now() - started),
        status: child.status,
        signal: child.signal,
        detail: child.stdout.trim(),
        stderr: child.stderr.slice(0, 1000),
        supervisorError: child.error?.message,
      }),
    );
  }
  process.exitCode = failures ? 1 : 0;
} else {
  const probe = cases[name];
  assert(probe, "unknown probe");
  const engine = await newQuickJSWASMModule();
  const runtime = engine.newRuntime();
  runtime.setMemoryLimit(8 * 1024 * 1024);
  runtime.setMaxStackSize(128 * 1024);
  const deadline = performance.now() + 150;
  runtime.setInterruptHandler(() => performance.now() > deadline);
  const context = runtime.newContext();
  const evaluate = (source: string) => {
    const result = context.evalCode(source);
    if (result.error) {
      const error: unknown = context.dump(result.error);
      result.error.dispose();
      throw new Error(JSON.stringify(error));
    }
    const value: unknown = context.dump(result.value);
    result.value.dispose();
    return value;
  };
  try {
    evaluate(`for (const key of ["Date","WebAssembly","Atomics","WeakRef","FinalizationRegistry","console"]) delete globalThis[key];
      Object.defineProperty(Math, "random", {value: () => {throw Error("disabled")}, writable:false, configurable:false});`);
    let value = evaluate(probe.source);
    while (runtime.hasPendingJob()) {
      if (performance.now() > deadline) throw new Error("deadline");
      const result = runtime.executePendingJobs(1);
      if (result.error) {
        const error: unknown = context.dump(result.error);
        result.error.dispose();
        throw new Error(JSON.stringify(error));
      }
    }
    if (name === "asyncReplay") value = evaluate("answer");
    assert.equal(probe.error, undefined, "limit did not reject");
    assert.deepEqual(value, probe.expected);
    console.log(JSON.stringify({ value }));
  } catch (error) {
    const message = String(error);
    if (!probe.error?.test(message)) throw error;
    console.log(JSON.stringify({ rejection: message }));
  }
  // Terminal process per probe: never call back into a runtime after OOM.
  process.exit(0);
}
