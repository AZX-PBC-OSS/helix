import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { INSTRUCTION_HEADER, JOBS_MAX_INPUT_BYTES } from "@azx-pbc/shared";
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
import { withServer } from "../test/socket.js";
import { FakeBurnStore, FakeEgress } from "./jobsCallbackFixtures.js";
import { deriveInstructionKey } from "./instruction.js";

/**
 * Boundary attacks on the signed jobs→edge fetch-callback receiver's input
 * bounds (`gateway/jobsCallback.ts`). The receiver's suite pins the over side
 * of the input bound; these pin the edge cases around it that nothing else
 * holds: the bound is INCLUSIVE (a body of exactly `JOBS_MAX_INPUT_BYTES` —
 * the largest input the admission contract allows — must still dispatch), and
 * a fragment-carrying presentation must never reach a dispatch or spend a
 * nonce.
 *
 * The fragment case must ride a REAL socket: a fragment is not a legal part of
 * an HTTP request-target, so every HTTP client (and `app.inject`) strips it
 * before the bytes leave — the parser passes it through only on the wire. A
 * hand-written request is the only way to present one.
 */

const SERVER_ID = "jobs";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = "job-123";
const OWNER_OID = "oid-triggering-user";
const ORIGIN = "https://api.github.com";
const PLATFORM_HOST = { host: "helix-jobs-callback.internal" };

const secret = randomBytes(32);
const instructionKey = deriveInstructionKey(secret);
const ROOTS = {
  edgeToJobs: randomBytes(32).toString("base64"),
  jobsToEdge: randomBytes(32).toString("base64"),
};
const CALLBACK_KEY = deriveJobsInstructionKey(ROOTS.jobsToEdge, "jobsToEdge");

function buildCallbackEdge() {
  const egress = new FakeEgress();
  const usage = new FakeUsageStore();
  const burns = new FakeBurnStore();
  const app = buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      // Deliberately far above the input bound: the route must enforce the
      // jobs input bound itself, never inherit the transport's.
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
      },
    }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "demo",
        blobPrefix: "apps/a/1/",
        visibilityMode: "internal",
        fetch: {
          connections: new Map([[ORIGIN, { kind: "keyless" }]]),
          requestsPerDay: null,
          shim: false,
        },
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    egress,
    usage,
    instructionKey,
    jobsCallbackBurns: burns,
  });
  return { app, egress, burns };
}

async function mint(body: Buffer): Promise<string> {
  return mintJobsInstruction(
    {
      operation: "fetch",
      server: SERVER_ID,
      identity: {
        appId: APP_ID,
        env: "prod",
        ownerKind: "user",
        ownerOid: OWNER_OID,
        type: `${SERVER_ID}:fetch`,
      },
      jobId: JOB_ID,
      generation: "1",
      body: new Uint8Array(body),
      iatS: Math.floor(Date.now() / 1_000),
    },
    new Uint8Array(CALLBACK_KEY),
  );
}

describe("the callback receiver's input bounds", () => {
  it("dispatches a body of exactly the input bound — the inclusive edge", async () => {
    // The admission contract admits a job input of exactly JOBS_MAX_INPUT_BYTES
    // bytes; the receiver reads with the same constant. If the read were
    // exclusive, or one byte tighter, the largest legal input could never
    // dispatch — the job retries a 413 forever.
    let pad = 0;
    const body = (): Buffer =>
      Buffer.from(JSON.stringify({ url: `https://api.github.com/${"a".repeat(pad)}` }), "utf8");
    while (body().length < JOBS_MAX_INPUT_BYTES) pad += 1;
    expect(body().length).toBe(JOBS_MAX_INPUT_BYTES);

    const h = buildCallbackEdge();
    const token = await mint(body());
    const res = await h.app.inject({
      method: "POST",
      url: ROUTE_JOBS_FETCH,
      headers: {
        ...PLATFORM_HOST,
        [INSTRUCTION_HEADER]: token,
        "content-type": "application/json",
        "content-length": String(body().length),
      },
      body: body(),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(h.egress.calls).toHaveLength(1);
    expect(h.burns.burned).toHaveLength(1);
    await h.app.close();
  });

  it("refuses one byte past the input bound before verification — no nonce spent, no burn", async () => {
    // The sharpest off-by-one: one past the bound. The refusal precedes the
    // burn in the gate order (nothing unverifiable may consume a nonce), so a
    // regression that reordered the gates — or moved the cap a byte — turns
    // this red either way.
    let pad = 0;
    const body = (): Buffer =>
      Buffer.from(JSON.stringify({ url: `https://api.github.com/${"a".repeat(pad)}` }), "utf8");
    while (body().length < JOBS_MAX_INPUT_BYTES + 1) pad += 1;
    expect(body().length).toBe(JOBS_MAX_INPUT_BYTES + 1);

    const h = buildCallbackEdge();
    const token = await mint(body());
    const res = await h.app.inject({
      method: "POST",
      url: ROUTE_JOBS_FETCH,
      headers: {
        ...PLATFORM_HOST,
        [INSTRUCTION_HEADER]: token,
        "content-type": "application/json",
        "content-length": String(body().length),
      },
      body: body(),
    });

    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).code).toBe("payload_too_large");
    expect(h.egress.calls).toHaveLength(0);
    expect(h.burns.burned).toHaveLength(0);
    await h.app.close();
  });

  it("refuses a fragment-carrying presentation without dispatching or spending the nonce", async () => {
    // The instruction binds the bare resource path, so a presentation carrying
    // a fragment is not a presentation of it — the same rule the query refusal
    // holds, on the other presentation character. Presented with a fully
    // VALID instruction over a real socket, the only gate that can refuse is
    // the fragment check; the answer is the 401, and nothing is spent.
    const h = buildCallbackEdge();
    const body = Buffer.from(JSON.stringify({ url: `${ORIGIN}/x` }), "utf8");
    const token = await mint(body);
    await withServer(h.app, async (base) => {
      const { port } = new URL(base);
      const answer = await new Promise<string>((resolve, reject) => {
        const sock = connect(Number(port), "127.0.0.1", () => {
          sock.write(
            `POST ${ROUTE_JOBS_FETCH}#frag HTTP/1.1\r\n` +
              `Host: ${PLATFORM_HOST.host}\r\n` +
              `${INSTRUCTION_HEADER}: ${token}\r\n` +
              "content-type: application/json\r\n" +
              `content-length: ${body.length}\r\n` +
              "connection: close\r\n" +
              "\r\n",
          );
          sock.write(body);
        });
        let raw = "";
        sock.on("data", (d) => (raw += d.toString()));
        sock.on("close", () => resolve(raw));
        sock.on("error", reject);
      });

      expect(answer.startsWith("HTTP/1.1 401")).toBe(true);
      expect(answer).toContain('"code":"unauthorized"');
    });
    expect(h.egress.calls).toHaveLength(0);
    expect(h.burns.burned).toHaveLength(0);
    await h.app.close();
  });
});
