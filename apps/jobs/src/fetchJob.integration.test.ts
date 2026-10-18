import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";

import { JOBS_MAX_INPUT_BYTES } from "@azx-pbc/shared";

import { JobsExecutionError, type JobsExecutionContext } from "./execution.js";
import { JOBS_FETCH_OUTBOUND_TIMEOUT_MS, makeFetchJobHandler } from "./fetchJob.js";
import { deriveJobsInstructionKey } from "@azx-pbc/shared/jobsSigning";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import { buildApp as buildEdgeApp } from "../../edge/src/app.js";
import type { ProxiedOriginCredential } from "../../edge/src/registry/projection.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../../edge/src/test/fakes.js";
import { testAuthConfig, testEdgeConfig } from "../../edge/src/test/config.js";
import { until, withServer } from "../../edge/src/test/socket.js";
import { FakeBurnStore, FakeEgress } from "../../edge/src/gateway/jobsCallbackFixtures.js";

/**
 * The outbound fetch handler against the REAL signed callback receiver
 * (`gateway/jobsCallback.ts`), over a real socket — the jobs→edge hop as
 * production carries it: the receiver verifies the handler's minted
 * instruction against its own jobs→edge key, burns the nonce, resolves its
 * registry entry, fences the generation and dispatches through the (faked)
 * egress provider — the one true external boundary. The unit suite pins the
 * classification table; this one pins that a real receiver accepts the real
 * minter and that the two ends agree on the contract's answers.
 */

const SERVER_ID = "jobs";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = "job-123";
const OWNER_OID = "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d";
const TARGET = "https://api.github.com/users/octocat";

/** This leg's own roots — the jobs→edge root is shared by both ends, as one deployment's configuration is. */
const ROOTS = {
  jobsToEdge: randomBytes(32).toString("base64"),
};
const CALLBACK_KEY = deriveJobsInstructionKey(ROOTS.jobsToEdge, "jobsToEdge");

let recording: RecordingTelemetry;

beforeAll(() => {
  recording = startRecordingTelemetry();
});
afterEach(() => {
  recording.reset();
});
afterAll(async () => {
  await recording.restore();
});

interface Harness {
  app: FastifyInstance;
  egress: FakeEgress;
}

/**
 * The edge build with its callback route wired: the fetch policy's egress is
 * the observing fake; the registry entry carries the app's keyless origin
 * permission and the lifecycle generation the callbacks are fenced against.
 */
function buildEdge(
  opts: {
    status?: number;
    responseBody?: Readable | null;
    delayMs?: number;
    connections?: Map<string, ProxiedOriginCredential>;
    jobsGeneration?: string;
    /** A different jobs→edge key than the handler mints with — the wrong-key leg. */
    otherKey?: Uint8Array;
  } = {},
): Harness {
  const egress = new FakeEgress();
  if (opts.status !== undefined) egress.status = opts.status;
  if (opts.responseBody !== undefined) egress.responseBody = opts.responseBody;
  if (opts.delayMs !== undefined) egress.delayMs = opts.delayMs;
  const app = buildEdgeApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      allowUnauthenticated: false,
      fetch: {
        egressUrl: "http://egress.internal",
        instructionSecret: randomBytes(32),
        timeoutMs: 30_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
      jobs: {
        servers: {
          [SERVER_ID]: {
            server: SERVER_ID,
            endpoint: "https://jobs.internal.helix",
            edgeToJobsKey: new Uint8Array(32).fill(1),
            jobsToEdgeKey: new Uint8Array(opts.otherKey ?? CALLBACK_KEY),
          },
        },
        timeoutMs: 30_000,
      },
    }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "demo",
        blobPrefix: "apps/a/1/",
        visibilityMode: "internal",
        fetch: {
          connections:
            opts.connections ?? new Map([["https://api.github.com", { kind: "keyless" }]]),
          requestsPerDay: null,
          shim: false,
        },
        jobsGeneration: opts.jobsGeneration ?? "1",
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    egress,
    usage: new FakeUsageStore(),
    instructionKey: randomBytes(32),
    jobsCallbackBurns: new FakeBurnStore(),
  });
  return { app, egress };
}

/** The handler's execution context over the harness's identity. */
function context(
  over: { input?: unknown; signal?: AbortSignal; generation?: string } = {},
): JobsExecutionContext {
  return {
    input: over.input ?? { url: TARGET },
    attempt: 1,
    record: {
      server: SERVER_ID,
      jobId: JOB_ID,
      type: "jobs:fetch",
      appId: APP_ID,
      env: "prod",
      ownerKind: "user",
      ownerOid: OWNER_OID,
      generation: over.generation ?? "1",
    },
    signal: over.signal ?? new AbortController().signal,
    report: async () => "persisted",
  };
}

/** The reason a handler died with — every terminal exit is a JobsExecutionError. */
async function failureOf(run: () => Promise<unknown>): Promise<JobsExecutionError["code"]> {
  try {
    await run();
  } catch (error) {
    if (error instanceof JobsExecutionError) return error.code;
    throw error;
  }
  throw new Error("the handler did not fail");
}

function handlerFor(base: string, over: { timeoutMs?: number } = {}) {
  return makeFetchJobHandler({
    serverId: SERVER_ID,
    prodCallbackUrl: base,
    devCallbackUrl: `${base}/dev-unused`,
    jobsToEdgeKey: new Uint8Array(CALLBACK_KEY),
    timeoutMs: over.timeoutMs ?? JOBS_FETCH_OUTBOUND_TIMEOUT_MS,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

describe("the fetch handler against the real callback receiver", () => {
  test("a valid callback dispatches the governed GET and the streamed JSON is the result", async () => {
    const h = buildEdge();
    await withServer(h.app, async (base) => {
      const result = await handlerFor(base)(context());
      expect(result).toEqual({ ok: true });
      expect(h.egress.calls).toHaveLength(1);
      expect(h.egress.calls[0]!.method).toBe("GET");
      expect(h.egress.calls[0]!.target).toBe(TARGET);
      expect(h.egress.calls[0]!.headers).toEqual({});
    });
  }, 20_000);

  test("a delegated-credential origin is refused before any upstream call — the terminal reason is the delegated prohibition", async () => {
    const h = buildEdge({
      connections: new Map([
        ["https://api.github.com", { kind: "provider", provider: "github", required: true }],
      ]),
    });
    await withServer(h.app, async (base) => {
      expect(await failureOf(() => handlerFor(base)(context()))).toBe("delegated_unattended");
      expect(h.egress.calls).toHaveLength(0);
    });
  }, 20_000);

  test("a stale lifecycle generation is fenced before dispatch — no upstream call, no keyless fallback", async () => {
    const h = buildEdge({ jobsGeneration: "2" });
    await withServer(h.app, async (base) => {
      expect(await failureOf(() => handlerFor(base)(context({ generation: "1" })))).toBe(
        "outbound_forbidden",
      );
      expect(h.egress.calls).toHaveLength(0);
    });
  }, 20_000);

  test("the upstream's non-success is the bounded upstream failure — the edge's own body never arrives", async () => {
    const h = buildEdge({ status: 404 });
    await withServer(h.app, async (base) => {
      expect(await failureOf(() => handlerFor(base)(context()))).toBe("upstream_error");
      expect(h.egress.calls).toHaveLength(1); // the call happened; the answer is what failed
    });
  }, 20_000);

  test("a minting key the receiver does not configure cannot cause an upstream call — the platform's own refusal", async () => {
    const h = buildEdge({ otherKey: new Uint8Array(32).fill(3) });
    await withServer(h.app, async (base) => {
      expect(await failureOf(() => handlerFor(base)(context()))).toBe("platform_error");
      expect(h.egress.calls).toHaveLength(0);
    });
  }, 20_000);

  test("an oversized upstream response is stopped at the result allowance — result_too_large, nothing stored", async () => {
    // Far over the 64-KiB allowance, streamed in chunks.
    const chunk = Buffer.alloc(8192, 0x62);
    const oversized = Readable.from(
      (function* () {
        for (let i = 0; i < 40; i++) yield chunk; // 320 KiB
      })(),
    );
    const h = buildEdge({ responseBody: oversized });
    await withServer(h.app, async (base) => {
      expect(await failureOf(() => handlerFor(base)(context()))).toBe("result_too_large");
    });
  }, 20_000);

  test("the attempt's cancellation aborts the outbound path through the real receiver", async () => {
    const h = buildEdge({ delayMs: 15_000 });
    await withServer(h.app, async (base) => {
      const controller = new AbortController();
      const run = handlerFor(base)(context({ signal: controller.signal }));
      const failed = failureOf(() => run);
      setTimeout(() => controller.abort(), 100);
      expect(await failed).toBe("cancelled");
      // The hang-up reached the egress forward — the receiver's own
      // client-gone abort did its work. The teardown races the verdict;
      // the observation is polled, never assumed.
      await until(() => h.egress.abortedDuringCall, "the egress forward's abort");
    });
  }, 20_000);

  test("the dispatch's outbound bound aborts the forward — the job's reason is the timeout", async () => {
    const h = buildEdge({ delayMs: 15_000 });
    await withServer(h.app, async (base) => {
      const failed = failureOf(() => handlerFor(base, { timeoutMs: 500 })(context()));
      const outcome = await failed;
      expect(outcome).toBe("timeout");
      await until(() => h.egress.abortedDuringCall, "the egress forward's abort");
    });
  }, 20_000);

  test("the outbound bound expires MID-STREAM on a trickling answer — the read is stopped, the forward's stream torn down, the reason the timeout", async () => {
    // The answer's headers flush fast and the body trickles: the bound must
    // stop the READ and the connection, classifying the timeout — no
    // partial result accepted. (The edge's propagation of a client hang-up
    // into its forward is the callback ticket's own pinned contract; what
    // this leg adds is the mid-stream bound on the dispatching side, and
    // the observable consequence on the edge: the egress response stream,
    // still open, is torn down when the reader goes away.)
    let streamTornDown = false;
    const holding = new Readable({ read() {} });
    holding.on("close", () => {
      streamTornDown = true;
    });
    const drip = setInterval(() => holding.push(Buffer.alloc(1024, 0x63)), 40);
    const h = buildEdge({ responseBody: holding });
    try {
      await withServer(h.app, async (base) => {
        const failed = failureOf(() => handlerFor(base, { timeoutMs: 700 })(context()));
        expect(await failed).toBe("timeout");
        await until(() => streamTornDown, "the egress stream's teardown");
      });
    } finally {
      clearInterval(drip);
      holding.destroy();
      await h.app.close();
    }
  }, 20_000);

  test("an input whose dispatch body sits exactly at the callback's body cap dispatches — the inclusive bound holds through the real receiver", async () => {
    // The submission cap and the callback-body cap are the same inclusive
    // 64-KiB constant, and the dispatch body between them is the handler's
    // own construction. A job admitted at the cap's exact edge must still
    // dispatch: one byte of construction growth, or one strict comparison on
    // either reader, would start dying platform_error at the receiver with
    // every shorter leg staying green.
    const url = `https://api.github.com/${"a".repeat(JOBS_MAX_INPUT_BYTES - 10 - 23)}`;
    expect(Buffer.byteLength(JSON.stringify({ url }))).toBe(JOBS_MAX_INPUT_BYTES);
    const h = buildEdge();
    await withServer(h.app, async (base) => {
      const result = await handlerFor(base)(context({ input: { url } }));
      expect(result).toEqual({ ok: true });
      expect(h.egress.calls[0]!.target).toBe(url);
    });
  }, 20_000);

  test("an input one byte past the callback's body cap is refused before any upstream call — the same constant through the same real bytes", async () => {
    // The handler's own parse carries no length bound (the length cap is the
    // submission's), so the handler dispatches what it is given and the
    // receiver's cap is the refusal: the 413 envelope is the platform
    // failure, and the egress forward never happens.
    const url = `https://api.github.com/${"a".repeat(JOBS_MAX_INPUT_BYTES - 10 - 23 + 1)}`;
    expect(Buffer.byteLength(JSON.stringify({ url }))).toBe(JOBS_MAX_INPUT_BYTES + 1);
    const h = buildEdge();
    await withServer(h.app, async (base) => {
      expect(await failureOf(() => handlerFor(base)(context({ input: { url } })))).toBe(
        "platform_error",
      );
      expect(h.egress.calls).toHaveLength(0);
    });
  }, 20_000);
});
