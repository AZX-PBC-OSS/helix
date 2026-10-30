import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { INSTRUCTION_HEADER, JOBS_CAPACITY_DEFAULTS, JOBS_MAX_RESULT_BYTES } from "@azx-pbc/shared";
import { deriveJobsInstructionKey, mintJobsInstruction } from "@azx-pbc/shared/jobsSigning";
import { ROUTE_JOBS_FETCH } from "@azx-pbc/shared/telemetry";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import { buildApp } from "../app.js";
import { until, withServer } from "../test/socket.js";
import { FakeBurnStore, FakeEgress } from "./jobsCallbackFixtures.js";
import { deriveInstructionKey } from "./instruction.js";
import { JOBS_CALLBACK_RESPONSE_CAP_BYTES } from "./jobsCallback.js";

/**
 * The edge's own cap on the callback's 2xx stream (`gateway/jobsCallback.ts`,
 * `jobs/resultCap.ts`), judged the way jobs reads it.
 *
 * Jobs refuses a result past `JOBS_MAX_RESULT_BYTES` as `result_too_large`
 * and a stream that breaks after the headers as `upstream_error`
 * (`apps/jobs/src/fetchJob.ts`). The cap must therefore never turn an
 * oversized upstream into a broken stream or a short body: it ends the body
 * cleanly at one byte past the allowance, however the upstream chunks it.
 * `readLikeJobs` below is jobs' bounded read, rule for rule; the real-stack
 * suite (`apps/jobs/src/outboundFetch.integration.test.ts`) drives the same
 * classification through the running services.
 */

const SERVER_ID = "jobs";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PLATFORM_HOST = "helix-jobs-callback.internal";
const TARGET = "https://api.github.com/users/octocat";

const secret = randomBytes(32);
const ROOTS = {
  edgeToJobs: randomBytes(32).toString("base64"),
  jobsToEdge: randomBytes(32).toString("base64"),
};
const CALLBACK_KEY = deriveJobsInstructionKey(ROOTS.jobsToEdge, "jobsToEdge");

function buildCallbackEdge(egress: FakeEgress) {
  return buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      fetch: {
        egressUrl: "http://egress.internal",
        instructionSecret: secret,
        timeoutMs: 30_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
      jobs: {
        servers: {
          [SERVER_ID]: {
            server: SERVER_ID,
            endpoint: "https://jobs.internal.helix",
            edgeToJobsKey: new Uint8Array(deriveJobsInstructionKey(ROOTS.edgeToJobs, "edgeToJobs")),
            jobsToEdgeKey: new Uint8Array(CALLBACK_KEY),
          },
        },
        timeoutMs: 30_000,
        refuseDiagnosticTypes: false,
        submissionLimits: JOBS_CAPACITY_DEFAULTS,
      },
    }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "demo",
        blobPrefix: "apps/a/1/",
        visibilityMode: "internal",
        fetch: {
          connections: new Map([["https://api.github.com", { kind: "keyless" }]]),
          requestsPerDay: null,
          shim: false,
        },
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    egress,
    usage: new FakeUsageStore(),
    instructionKey: deriveInstructionKey(secret),
    jobsCallbackBurns: new FakeBurnStore(),
  });
}

type JobsRead =
  | { kind: "bytes"; body: Uint8Array }
  | { kind: "over"; delivered: number }
  | { kind: "failed" };

/**
 * Jobs' `readBounded` (`apps/jobs/src/fetchJob.ts`), rule for rule, plus the
 * total the edge delivered — read on past jobs' trip so the test can see the
 * edge's own framing.
 */
async function readLikeJobs(response: Response): Promise<JobsRead> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let over = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > JOBS_MAX_RESULT_BYTES) over = true;
      else chunks.push(value);
    }
  } catch {
    // Jobs checks the trip as each chunk arrives, so a stream that tripped
    // and then broke still classifies as over.
    return over ? { kind: "over", delivered: total } : { kind: "failed" };
  }
  if (over) return { kind: "over", delivered: total };
  return { kind: "bytes", body: new Uint8Array(Buffer.concat(chunks)) };
}

async function callThroughEdge(
  upstream: Readable,
): Promise<{ read: JobsRead; egress: FakeEgress }> {
  const egress = new FakeEgress();
  egress.responseBody = upstream;
  const app = buildCallbackEdge(egress);
  const body = Buffer.from(JSON.stringify({ url: TARGET }), "utf8");
  const token = await mintJobsInstruction(
    {
      operation: "fetch",
      server: SERVER_ID,
      identity: {
        appId: APP_ID,
        env: "prod",
        ownerKind: "user",
        ownerOid: "oid-triggering-user",
        type: `${SERVER_ID}:fetch`,
      },
      jobId: "job-123",
      generation: "1",
      body: new Uint8Array(body),
      iatS: Math.floor(Date.now() / 1_000),
    },
    new Uint8Array(CALLBACK_KEY),
  );
  let read: JobsRead = { kind: "failed" };
  await withServer(app, async (base) => {
    const response = await fetch(`${base}${ROUTE_JOBS_FETCH}`, {
      method: "POST",
      headers: {
        host: PLATFORM_HOST,
        "content-type": "application/json",
        [INSTRUCTION_HEADER]: token,
      },
      body,
    });
    expect(response.status).toBe(200);
    read = await readLikeJobs(response);
  });
  return { read, egress };
}

/** An upstream that yields `total` bytes in `chunkSize` pieces and records how far it was pulled. */
function upstreamOf(total: number, chunkSize: number): { stream: Readable; pulled: () => number } {
  let pulled = 0;
  const stream = new Readable({
    read() {
      if (pulled >= total) {
        this.push(null);
        return;
      }
      const n = Math.min(chunkSize, total - pulled);
      pulled += n;
      this.push(Buffer.alloc(n, 0x61));
    },
  });
  return { stream, pulled: () => pulled };
}

describe("the callback's response cap", () => {
  it("sits one byte past jobs' result allowance", () => {
    expect(JOBS_CALLBACK_RESPONSE_CAP_BYTES).toBe(JOBS_MAX_RESULT_BYTES + 1);
  });

  it("passes a body exactly at the allowance through whole — jobs keeps it", async () => {
    const text = JSON.stringify("x".repeat(JOBS_MAX_RESULT_BYTES - 2));
    const { read } = await callThroughEdge(Readable.from([Buffer.from(text)]));
    expect(read.kind).toBe("bytes");
    if (read.kind === "bytes") expect(Buffer.from(read.body).toString()).toBe(text);
  });

  for (const [label, chunkSize] of [
    ["one chunk far past the cap", 4 * 1024 * 1024],
    ["many small chunks", 16 * 1024],
    ["a chunk that straddles the cap", JOBS_MAX_RESULT_BYTES - 10],
  ] as const) {
    it(`ends an oversized upstream cleanly at the cap (${label}) — jobs classifies result_too_large`, async () => {
      const total = 64 * 1024 * 1024;
      const upstream = upstreamOf(total, chunkSize);
      const { read } = await callThroughEdge(upstream.stream);

      expect(read.kind).toBe("over");
      if (read.kind === "over") expect(read.delivered).toBe(JOBS_CALLBACK_RESPONSE_CAP_BYTES);
      // The edge stopped pulling the upstream at the trip.
      await until(() => upstream.stream.destroyed, "the upstream body to be destroyed");
      expect(upstream.pulled()).toBeLessThan(total);
    });
  }

  it("never hands jobs a valid-JSON prefix of an oversized body", async () => {
    // The first JOBS_MAX_RESULT_BYTES bytes are a complete JSON string, and
    // the rest is whitespace. A cap that ended the body cleanly AT the
    // allowance would deliver exactly that prefix, which jobs would accept as
    // a result. One byte more makes it over.
    const prefix = JSON.stringify("x".repeat(JOBS_MAX_RESULT_BYTES - 2));
    expect(Buffer.byteLength(prefix)).toBe(JOBS_MAX_RESULT_BYTES);
    const text = prefix + " ".repeat(1024 * 1024);
    const { read } = await callThroughEdge(Readable.from([Buffer.from(text)]));
    expect(read.kind).toBe("over");
  });

  it("passes an upstream break below the cap through as a broken stream — jobs answers upstream_error", async () => {
    // What jobs sees when egress cuts the body (its own cap, or a transport
    // failure): the edge must not end it cleanly as if it were complete.
    const upstream = new Readable({
      read() {
        this.push(Buffer.from('{"partial":'));
        this.destroy(new Error("egress cut the body"));
      },
    });
    const { read } = await callThroughEdge(upstream);
    expect(read.kind).toBe("failed");
  });
});
