import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { INSTRUCTION_HEADER } from "@azx-pbc/shared";
import { deriveJobsInstructionKey, signJobsInstructionClaims } from "@azx-pbc/shared/jobsSigning";
import {
  JOBS_GOLDEN_TOKEN_VECTORS,
  JOBS_SIGNING_VECTOR_ROOTS,
  JOBS_SIGNING_VECTORS,
  type JobsGoldenTokenVector,
} from "@azx-pbc/shared/jobsSigningVectors";
import { ROUTE_JOBS_FETCH, SPAN_JOBS_FETCH_EDGE } from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { deriveInstructionKey } from "./instruction.js";
import { FakeBurnStore, FakeEgress } from "./jobsCallbackFixtures.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";
import { testAuthConfig, testDevGatewayConfig, testEdgeConfig } from "../test/config.js";
import { buildApp } from "../app.js";
import { buildDevGateway } from "../devGateway/app.js";

/**
 * The fetch-direction signing vectors judged against the EDGE callback
 * receiver — this service's half of criterion 71's conformance rule. The jobs
 * receiver's suite counts these vectors and refuses to absorb them; this file
 * is where they are judged: every fetch vector is presented to a receiver
 * built exactly as the vector expects — the server it serves, the root it
 * holds (which may deliberately be another direction's or another server's
 * derivation), the clock it verifies at — through the real route, and the
 * receiver's answer must match the corpus's verdict. An accept vector must
 * reach the dispatch (the span's final `dispatched` outcome); a reject vector
 * must fail with the corpus's reason on the span. A served rejection, an
 * acceptance that never dispatched, or a 500 never conforms.
 *
 * The corpus is stateless and the receiver is not (the burn), so every vector
 * gets a fresh receiver. The dev-tier accept vector is judged at the
 * dev-tier receiver — the corpus's `why` states the tier travels signed and
 * each receiver serves its own.
 */

const VECTOR_APP_ID = "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f";
const VECTOR_GENERATION = "7";
const VECTOR_ORIGIN = "https://example.com";

let recording: RecordingTelemetry;

beforeAll(() => {
  recording = startRecordingTelemetry();
  // The corpus's verification clock is its own fixed instant (`present.nowS`);
  // the receiver reads the real clock, so the suite runs under a faked Date
  // pinned to the vector instant — the same `toFake: ["Date"]` precision
  // `apps/jobs/src/execution.test.ts` uses, leaving every other timer real.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(1_800_000_000 * 1_000));
});
afterEach(() => {
  recording.reset();
});
afterAll(async () => {
  vi.useRealTimers();
  await recording.restore();
});

/** The key one vector root id defines — what a receiver "holding" it verifies with. */
function signingKey(keyId: string): Uint8Array {
  const entry = JOBS_SIGNING_VECTOR_ROOTS[keyId];
  if (!entry) throw new Error(`no such vector root: ${keyId}`);
  return new Uint8Array(deriveJobsInstructionKey(entry.root, entry.direction));
}

function receiverRegistry() {
  return new FakeRegistry([
    registryEntry({
      appId: VECTOR_APP_ID,
      slug: "vector-app",
      blobPrefix: "apps/v/1/",
      visibilityMode: "internal",
      fetch: {
        connections: new Map([[VECTOR_ORIGIN, { kind: "keyless" }]]),
        requestsPerDay: null,
        shim: false,
      },
      jobsGeneration: VECTOR_GENERATION,
    }),
  ]);
}

function receiverJobsConfig(server: string, keyId: string) {
  return {
    servers: {
      [server]: {
        server,
        endpoint: "https://jobs.internal.helix",
        edgeToJobsKey: signingKey("edge-to-jobs.jobs"),
        jobsToEdgeKey: signingKey(keyId),
      },
    },
    timeoutMs: 30_000,
    refuseDiagnosticTypes: false,
  };
}

/** The prod-tier receiver (the production edge composition, corpus root held). */
function prodCallbackReceiver(server: string, keyId: string): FastifyInstance {
  const app = buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      fetch: {
        egressUrl: "http://egress.internal",
        instructionSecret: randomBytes(32),
        timeoutMs: 30_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
      jobs: receiverJobsConfig(server, keyId),
    }),
    registry: receiverRegistry(),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    egress: new FakeEgress(),
    usage: new FakeUsageStore(),
    instructionKey: deriveInstructionKey(randomBytes(32)),
    jobsCallbackBurns: new FakeBurnStore(),
  });
  return app;
}

/** The dev-tier receiver (the dev-gateway composition, corpus root held). */
function devCallbackReceiver(server: string, keyId: string): FastifyInstance {
  return buildDevGateway({
    config: testDevGatewayConfig({
      fetch: {
        egressUrl: "http://egress.internal",
        instructionSecret: randomBytes(32),
        timeoutMs: 30_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
      jobs: receiverJobsConfig(server, keyId),
    }),
    registry: receiverRegistry(),
    devTokens: {
      async resolve() {
        return null;
      },
      async originAllowed() {
        return false;
      },
      async close() {},
    },
    appData: null,
    usage: new FakeUsageStore(),
    llmProvider: null,
    egress: new FakeEgress(),
    instructionKey: deriveInstructionKey(randomBytes(32)),
    jobsForwarder: null,
    jobsCallbackBurns: new FakeBurnStore(),
    portal: null,
  });
}

async function present(app: FastifyInstance, token: string, body: Uint8Array): Promise<void> {
  await app.inject({
    method: "POST",
    url: ROUTE_JOBS_FETCH,
    headers: {
      host: "helix-jobs-callback.internal",
      [INSTRUCTION_HEADER]: token,
      "content-type": "application/json",
      "content-length": String(body.byteLength),
    },
    body: Buffer.from(body),
  });
}

function lastCallbackSpan(): { outcome: unknown; reason: unknown } | undefined {
  const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_FETCH_EDGE);
  const span = spans.at(-1);
  return (
    span && { outcome: span.attributes["helix.outcome"], reason: span.attributes["helix.reason"] }
  );
}

describe("the edge fetch-callback receiver against the shared signing vectors", () => {
  test("every fetch-direction vector's verdict matches through the real route", async () => {
    const failures: string[] = [];
    const fetchVectors = JOBS_SIGNING_VECTORS.filter(
      (v) => v.present.expected.operation === "fetch",
    );
    expect(fetchVectors.length).toBeGreaterThan(0);
    for (const vector of fetchVectors) {
      const expected = vector.present.expected;
      // The dev accept vector names its own tier — judged at the dev
      // receiver, the way the deployment routes it.
      const isDevVector =
        vector.expect === "accept" && (vector.sign.claims as Record<string, unknown>).env === "dev";
      const app = isDevVector
        ? devCallbackReceiver(expected.server, vector.present.keyId)
        : prodCallbackReceiver(expected.server, vector.present.keyId);
      const token = await signJobsInstructionClaims(
        vector.sign.typ,
        vector.sign.claims,
        signingKey(vector.sign.keyId),
      );
      await present(app, token, expected.body);
      const span = lastCallbackSpan();
      if (vector.expect === "accept") {
        if (span?.outcome !== "dispatched") {
          failures.push(
            `"${vector.name}": expected the dispatch to run (outcome "dispatched"), got ` +
              `"${String(span?.outcome)}" reason "${String(span?.reason)}"`,
          );
        }
      } else if (span?.outcome !== "rejected" || span.reason !== vector.expect.reject) {
        failures.push(
          `"${vector.name}": expected rejection "${vector.expect.reject}", got outcome ` +
            `"${String(span?.outcome)}" reason "${String(span?.reason)}"`,
        );
      }
      await app.close();
    }
    expect(failures).toEqual([]);
  });

  test("the recorded golden fetch token verifies through the real route", async () => {
    const golden = JOBS_GOLDEN_TOKEN_VECTORS.filter(
      (v: JobsGoldenTokenVector) => v.expected.operation === "fetch",
    );
    expect(golden.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const vector of golden) {
      const app = prodCallbackReceiver(vector.expected.server, vector.keyId);
      await present(app, vector.token, vector.expected.body);
      const span = lastCallbackSpan();
      if (vector.expect === "accept" && span?.outcome !== "dispatched") {
        failures.push(
          `"${vector.name}": expected the dispatch to run, got outcome ` +
            `"${String(span?.outcome)}" reason "${String(span?.reason)}"`,
        );
      }
      await app.close();
    }
    expect(failures).toEqual([]);
  });
});
