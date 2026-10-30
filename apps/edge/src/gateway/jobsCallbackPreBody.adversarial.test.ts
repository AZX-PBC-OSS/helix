import { randomBytes } from "node:crypto";
import { connect } from "node:net";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { INSTRUCTION_HEADER, JOBS_CAPACITY_DEFAULTS, JOBS_MAX_INPUT_BYTES } from "@azx-pbc/shared";
import {
  deriveJobsInstructionKey,
  JobsOperations,
  JobsSigningDomains,
  mintJobsInstruction,
  sha256BodyDigest,
  signJobsInstructionClaims,
} from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_OUTCOME,
  ATTR_REASON,
  ROUTE_JOBS_FETCH,
  SPAN_JOBS_FETCH_EDGE,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
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

/**
 * The fetch callback authenticates before it reads the body
 * (`gateway/jobsCallback.ts`). The route is reachable from the internet, so a
 * request whose instruction header cannot verify must be refused without the
 * edge reading — let alone buffering — a single body byte.
 *
 * Every refusal here is presented over a body stream that records whether it
 * was ever read and never ends: a handler that read it would hang the test,
 * and one that only peeked would show a read. The header-verified cases then
 * pin the other half: the body is read, a body that does not match the signed
 * digest is refused without spending the nonce, and the token still redeems
 * with its own body.
 */

const SERVER_ID = "jobs";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = "job-123";
const OWNER_OID = "oid-triggering-user";
const TARGET = "https://api.github.com/users/octocat";
const PLATFORM_HOST = "helix-jobs-callback.internal";

const secret = randomBytes(32);
const instructionKey = deriveInstructionKey(secret);
const ROOTS = {
  edgeToJobs: randomBytes(32).toString("base64"),
  jobsToEdge: randomBytes(32).toString("base64"),
  otherServer: randomBytes(32).toString("base64"),
};
const CALLBACK_KEY = deriveJobsInstructionKey(ROOTS.jobsToEdge, "jobsToEdge");
const OTHER_KEY = deriveJobsInstructionKey(ROOTS.otherServer, "jobsToEdge");

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
  burns: FakeBurnStore;
}

function buildCallbackEdge(): Harness {
  const egress = new FakeEgress();
  const burns = new FakeBurnStore();
  const app = buildApp({
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
    instructionKey,
    jobsCallbackBurns: burns,
  });
  return { app, egress, burns };
}

const nowS = (): number => Math.floor(Date.now() / 1_000);
const validBody = (): Buffer => Buffer.from(JSON.stringify({ url: TARGET }), "utf8");

async function mint(
  opts: { body?: Buffer; key?: Uint8Array; iatS?: number; env?: "prod" | "dev" } = {},
): Promise<string> {
  return mintJobsInstruction(
    {
      operation: "fetch",
      server: SERVER_ID,
      identity: {
        appId: APP_ID,
        env: opts.env ?? "prod",
        ownerKind: "user",
        ownerOid: OWNER_OID,
        type: `${SERVER_ID}:fetch`,
      },
      jobId: JOB_ID,
      generation: "1",
      body: new Uint8Array(opts.body ?? validBody()),
      iatS: opts.iatS ?? nowS(),
    },
    new Uint8Array(opts.key ?? CALLBACK_KEY),
  );
}

/** A correctly keyed token whose signed resource is another route's. */
async function mintForOtherResource(): Promise<string> {
  const iat = nowS();
  return signJobsInstructionClaims(
    JobsSigningDomains.jobsToEdge.jwtTyp,
    {
      iss: `helix-jobs:${SERVER_ID}`,
      aud: `helix-edge-jobs-callback:${SERVER_ID}`,
      jti: `other-resource-${randomBytes(4).toString("hex")}`,
      iat,
      exp: iat + 30,
      server: SERVER_ID,
      operation: "fetch",
      method: JobsOperations.fetch.method,
      resource: "/internal/jobs/v1/fetch-other",
      bodySha256: sha256BodyDigest(new Uint8Array(validBody())),
      appId: APP_ID,
      env: "prod",
      ownerKind: "user",
      ownerOid: OWNER_OID,
      type: `${SERVER_ID}:fetch`,
      jobId: JOB_ID,
      generation: "1",
    },
    new Uint8Array(CALLBACK_KEY),
  );
}

/** A body that never ends and records every read — the handler must never touch it. */
function untouchableBody(): { stream: Readable; reads: () => number } {
  let reads = 0;
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const stream = new Readable({
    read() {
      reads += 1;
      this.push(chunk);
    },
  });
  return { stream, reads: () => reads };
}

async function presentUnreadable(
  h: Harness,
  headers: Record<string, string | string[]>,
  url: string = ROUTE_JOBS_FETCH,
): Promise<{ status: number; code: unknown; reads: number }> {
  const body = untouchableBody();
  const res = await h.app.inject({
    method: "POST",
    url,
    headers: {
      host: PLATFORM_HOST,
      "content-type": "application/json",
      // A claimed body far over every bound: the refusal must not depend on it.
      "content-length": String(10 * 1024 * 1024),
      ...headers,
    },
    payload: body.stream,
  });
  const reads = body.reads();
  body.stream.destroy();
  return { status: res.statusCode, code: (res.json() as { code?: unknown }).code, reads };
}

async function presentBody(
  h: Harness,
  token: string,
  body: Buffer,
): Promise<{ status: number; code: unknown }> {
  const res = await h.app.inject({
    method: "POST",
    url: ROUTE_JOBS_FETCH,
    headers: {
      host: PLATFORM_HOST,
      [INSTRUCTION_HEADER]: token,
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    payload: body,
  });
  let code: unknown;
  try {
    code = (res.json() as { code?: unknown }).code;
  } catch {
    code = undefined;
  }
  return { status: res.statusCode, code };
}

function lastSpan(): { outcome: unknown; reason: unknown } {
  const span = recording
    .spans()
    .filter((s) => s.name === SPAN_JOBS_FETCH_EDGE)
    .at(-1);
  return { outcome: span?.attributes[ATTR_OUTCOME], reason: span?.attributes[ATTR_REASON] };
}

function flipSignature(token: string): string {
  const last = token.lastIndexOf(".");
  const first = token[last + 1];
  return token.slice(0, last + 1) + (first === "a" ? "b" : "a") + token.slice(last + 2);
}

describe("the callback refuses an unverifiable header without reading the body", () => {
  const cases: {
    name: string;
    headers: () => Promise<Record<string, string | string[]>>;
    url?: string;
    reason: string;
  }[] = [
    { name: "no instruction header", headers: async () => ({}), reason: "missing" },
    {
      name: "an empty instruction header",
      headers: async () => ({ [INSTRUCTION_HEADER]: "" }),
      reason: "missing",
    },
    {
      name: "a repeated instruction header",
      headers: async () => ({ [INSTRUCTION_HEADER]: [await mint(), await mint()] }),
      reason: "malformed",
    },
    {
      name: "a header that is not a token",
      headers: async () => ({ [INSTRUCTION_HEADER]: "not-a-token" }),
      reason: "malformed",
    },
    {
      name: "a token with a broken signature",
      headers: async () => ({ [INSTRUCTION_HEADER]: flipSignature(await mint()) }),
      reason: "signature",
    },
    {
      name: "a token signed under another server's key",
      headers: async () => ({ [INSTRUCTION_HEADER]: await mint({ key: OTHER_KEY }) }),
      reason: "signature",
    },
    {
      name: "an expired token",
      headers: async () => ({ [INSTRUCTION_HEADER]: await mint({ iatS: nowS() - 120 }) }),
      reason: "expired",
    },
    {
      name: "a token for another resource",
      headers: async () => ({ [INSTRUCTION_HEADER]: await mintForOtherResource() }),
      reason: "resource",
    },
    {
      name: "a valid token presented with a query string",
      headers: async () => ({ [INSTRUCTION_HEADER]: await mint() }),
      url: `${ROUTE_JOBS_FETCH}?x=1`,
      reason: "resource",
    },
  ];

  for (const c of cases) {
    it(`${c.name}: 401, no body read, no burn, no dispatch`, async () => {
      const h = buildCallbackEdge();
      const answer = await presentUnreadable(h, await c.headers(), c.url);

      expect(answer.status).toBe(401);
      expect(answer.code).toBe("unauthorized");
      expect(answer.reads, "the body stream was read").toBe(0);
      expect(lastSpan()).toEqual({ outcome: "rejected", reason: c.reason });
      expect(h.burns.burned).toHaveLength(0);
      expect(h.egress.calls).toHaveLength(0);
      await h.app.close();
    });
  }

  it("an unauthenticated oversized body is rejected (401), not payload_too_large (413)", async () => {
    // Before the reorder this was a 413 reached by reading 64 KiB of an
    // anonymous caller's body; the header now decides first.
    const h = buildCallbackEdge();
    const answer = await presentUnreadable(h, {});
    expect(answer.status).toBe(401);
    expect(lastSpan().outcome).toBe("rejected");
    expect(answer.reads).toBe(0);
    await h.app.close();
  });

  it("refuses the opposite signed tier before reading the body, without a burn", async () => {
    const h = buildCallbackEdge();
    const answer = await presentUnreadable(h, { [INSTRUCTION_HEADER]: await mint({ env: "dev" }) });

    expect(answer.status).toBe(403);
    expect(answer.code).toBe("forbidden");
    expect(answer.reads).toBe(0);
    expect(lastSpan().outcome).toBe("wrong_tier");
    expect(h.burns.burned).toHaveLength(0);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();
  });

  it("answers an anonymous never-ending upload over a real socket without waiting for it", async () => {
    // The transport-level proof: the request claims 10 MiB and sends a
    // trickle that never completes. The 401 must arrive while the upload is
    // still open — a handler that read the body would wait forever.
    const h = buildCallbackEdge();
    await withServer(h.app, async (base) => {
      const { port } = new URL(base);
      const head = await new Promise<string>((resolve, reject) => {
        const sock = connect(Number(port), "127.0.0.1", () => {
          sock.write(
            `POST ${ROUTE_JOBS_FETCH} HTTP/1.1\r\n` +
              `Host: ${PLATFORM_HOST}\r\n` +
              "content-type: application/json\r\n" +
              `content-length: ${10 * 1024 * 1024}\r\n` +
              "\r\n",
          );
          sock.write(Buffer.alloc(1024, 0x61));
        });
        let raw = "";
        sock.on("data", (d) => {
          raw += d.toString();
          if (raw.includes("\r\n\r\n") && raw.includes("}")) {
            sock.destroy();
            resolve(raw);
          }
        });
        sock.on("error", reject);
      });
      expect(head.startsWith("HTTP/1.1 401")).toBe(true);
      expect(head).toContain('"code":"unauthorized"');
    });
    expect(h.burns.burned).toHaveLength(0);
  });
});

describe("the callback reads the body only after the header verifies", () => {
  it("a tampered body passes the header phase, fails the body phase, and spends no nonce", async () => {
    const h = buildCallbackEdge();
    const body = validBody();
    const token = await mint({ body });
    const tampered = Buffer.from(JSON.stringify({ url: "https://api.evil.com/steal" }), "utf8");

    const refused = await presentBody(h, token, tampered);
    expect(refused).toEqual({ status: 401, code: "unauthorized" });
    expect(lastSpan()).toEqual({ outcome: "rejected", reason: "body" });
    expect(h.burns.burned).toHaveLength(0);
    expect(h.egress.calls).toHaveLength(0);

    // The token was never spent, so it still redeems with the body it names.
    const redeemed = await presentBody(h, token, body);
    expect(redeemed.status).toBe(200);
    expect(h.burns.burned).toHaveLength(1);
    expect(h.egress.calls).toHaveLength(1);
    await h.app.close();
  });

  it("a valid token dispatches end to end, and its replay is refused", async () => {
    const h = buildCallbackEdge();
    const body = validBody();
    const token = await mint({ body });

    expect((await presentBody(h, token, body)).status).toBe(200);
    expect(lastSpan().outcome).toBe("dispatched");

    const replay = await presentBody(h, token, body);
    expect(replay).toEqual({ status: 401, code: "unauthorized" });
    expect(lastSpan().outcome).toBe("replayed");
    expect(h.egress.calls).toHaveLength(1);
    await h.app.close();
  });

  it("a verified token over a chunked body past the bound is refused at the counter, unburned", async () => {
    // No content-length, so only the byte counter can refuse it.
    const h = buildCallbackEdge();
    const huge = Buffer.from(
      JSON.stringify({ url: `https://api.github.com/${"a".repeat(JOBS_MAX_INPUT_BYTES)}` }),
      "utf8",
    );
    const token = await mint({ body: huge });
    // The trip destroys the request stream (the excess is never read), which
    // `inject` surfaces as a rejected request; the verdict is the span's.
    const res = await h.app
      .inject({
        method: "POST",
        url: ROUTE_JOBS_FETCH,
        headers: {
          host: PLATFORM_HOST,
          [INSTRUCTION_HEADER]: token,
          "content-type": "application/json",
        },
        payload: Readable.from([huge.subarray(0, 40_000), huge.subarray(40_000)]),
      })
      .catch(() => null);
    await until(() => lastSpan().outcome !== undefined, "the callback span");
    if (res) expect(res.statusCode).toBe(413);
    expect(lastSpan().outcome).toBe("payload_too_large");
    expect(h.burns.burned).toHaveLength(0);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();
  });
});
