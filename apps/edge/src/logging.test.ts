import { Writable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { traceContextMixin } from "@azx-pbc/telemetry/correlation";
import { loggerOption } from "@azx-pbc/shared/logging";

/**
 * The redaction itself is unit-tested in `@azx-pbc/shared`. What lives here is
 * the half that needs a real Fastify + pino: that the serializer actually
 * attaches, survives the paths Fastify re-serializes the request on, and emits
 * the stock field shape. `buildApp` can't be used directly — `loggerOption()`
 * resolves to `false` under NODE_ENV=test, which is the behaviour under test in
 * the shared suite — so these build a bare instance with the same options.
 */

/** Capture what pino actually writes, through the real Fastify logger path. */
function captureLogs(): { lines: unknown[]; stream: Writable } {
  const lines: unknown[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n").filter(Boolean)) {
        lines.push(JSON.parse(line));
      }
      cb();
    },
  });
  return { lines, stream };
}

function buildLoggingApp(stream: Writable) {
  const option = loggerOption("production");
  if (option === false) throw new Error("loggerOption('production') must carry the serializer");
  return Fastify({ logger: { ...option, level: "info", stream } });
}

describe("the edge request serializer", () => {
  it("keeps the handoff token out of the access log", async () => {
    const { lines, stream } = captureLogs();
    const app = buildLoggingApp(stream);
    app.get("/_auth/complete", async () => ({ ok: true }));

    const secret = "eyJhbGciOiJIUzI1NiJ9.handoff-payload.signature";
    const res = await app.inject({
      method: "GET",
      url: `/_auth/complete?token=${secret}&rd=/`,
      headers: { host: "demo.local.helix.azxlabs.io" },
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(secret);

    const request = lines.find(
      (line): line is { req: { url: string; method: string; host: string } } =>
        typeof line === "object" && line !== null && "req" in line,
    );
    expect(request?.req.url).toBe("/_auth/complete?token=REDACTED&rd=/");
    // The stock fields survive — log consumers see the same shape.
    expect(request?.req.method).toBe("GET");
    expect(request?.req.host).toBe("demo.local.helix.azxlabs.io");
  });

  it("keeps an app's third-party credential out of the fetch-proxy log line", async () => {
    const { lines, stream } = captureLogs();
    const app = buildLoggingApp(stream);
    app.get("/_api/fetch/*", async () => ({ ok: true }));

    const secret = "sk-live-DEADBEEF";
    const res = await app.inject({
      method: "GET",
      url: `/_api/fetch/https://api.example.com/v1/models?api_key=${secret}`,
    });
    expect(res.statusCode).toBe(200);
    await app.close();

    expect(JSON.stringify(lines)).not.toContain(secret);
    const request = lines.find(
      (line): line is { req: { url: string } } =>
        typeof line === "object" && line !== null && "req" in line,
    );
    // Still says which upstream was called — the log stays useful.
    expect(request?.req.url).toBe("/_api/fetch/https://api.example.com/v1/models?REDACTED");
  });

  it("redacts on error paths too, where Fastify re-serializes the request", async () => {
    const { lines, stream } = captureLogs();
    const app = buildLoggingApp(stream);
    app.get("/_auth/complete", async () => {
      throw new Error("boom");
    });

    const secret = "handoff-token-value";
    const res = await app.inject({ method: "GET", url: `/_auth/complete?token=${secret}` });
    expect(res.statusCode).toBe(500);
    await app.close();

    expect(JSON.stringify(lines)).not.toContain(secret);
  });
});

describe("the edge log level", () => {
  it("reaches pino, so a raised level actually changes what is emitted", async () => {
    // The shared suite proves the level is *parsed*. This proves it is
    // *applied* — `loggerOption` returns a pino option object, and a level that
    // never reaches the constructor would be an entirely silent no-op.
    const { lines, stream } = captureLogs();
    const option = loggerOption("production", { prefix: "EDGE", env: { EDGE_LOG_LEVEL: "warn" } });
    if (option === false) throw new Error("loggerOption('production') must carry the serializer");
    const app = Fastify({ logger: { ...option, stream } });

    app.log.info({ marker: "dropped" }, "below the level");
    app.log.warn({ marker: "kept" }, "at the level");
    await app.close();

    const text = JSON.stringify(lines);
    expect(text).not.toContain("dropped");
    expect(text).toContain("kept");
  });
});

describe("the url serializer", () => {
  it("redacts a hand-logged URL under the top-level `url` key", async () => {
    // Issue #20 residual (b): the guarantee used to be scoped to `req.url`, so a
    // hand-rolled log call was on the honour system. The rule is now positive —
    // log a URL under the key `url` — and this is what makes it true.
    const { lines, stream } = captureLogs();
    const option = loggerOption("production", { env: {} });
    if (option === false) throw new Error("unreachable");
    const app = Fastify({ logger: { ...option, stream } });

    const token = "eyJhbGciOiJIUzI1NiJ9.PLANTED.signature";
    app.log.warn({ url: `/_auth/complete?token=${token}&rd=/` }, "hand-rolled");
    await app.close();

    const text = JSON.stringify(lines);
    expect(text).not.toContain(token);
    expect(text).toContain("/_auth/complete?token=REDACTED&rd=/");
  });

  it("covers the fetch-proxy target, which no parameter list could", async () => {
    const { lines, stream } = captureLogs();
    const option = loggerOption("production", { env: {} });
    if (option === false) throw new Error("unreachable");
    const app = Fastify({ logger: { ...option, stream } });

    const key = "sk-PLANTED-UPSTREAM-KEY";
    app.log.warn({ url: `/_api/fetch/https://api.vendor.test/v1?api_key=${key}` }, "proxied");
    await app.close();

    expect(JSON.stringify(lines)).not.toContain(key);
  });
});

describe("trace correlation on log lines", () => {
  it("adds nothing when no SDK is registered — the platform default", async () => {
    const { lines, stream } = captureLogs();
    const option = loggerOption("production", { env: {}, mixin: traceContextMixin });
    if (option === false) throw new Error("unreachable");
    const app = Fastify({ logger: { ...option, stream } });

    app.log.info({ marker: 1 }, "no tracing configured");
    await app.close();

    const line = lines.find(
      (l): l is Record<string, unknown> => typeof l === "object" && l !== null && "marker" in l,
    );
    expect(line).toBeDefined();
    expect("trace_id" in (line ?? {})).toBe(false);
  });
});
