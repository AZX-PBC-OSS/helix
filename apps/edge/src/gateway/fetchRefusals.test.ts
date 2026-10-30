import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { request as undiciRequest } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { hashDevToken, newDevToken } from "@azx-pbc/shared/devToken";
import { INSTRUCTION_HEADER, JOBS_CAPACITY_DEFAULTS, type Env } from "@azx-pbc/shared";
import { deriveJobsInstructionKey, mintJobsInstruction } from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_APP_ID,
  ATTR_CAPABILITY,
  ATTR_OUTCOME,
  INSTR_GATEWAY_CALLS,
  ROUTE_JOBS_FETCH,
} from "@azx-pbc/shared/telemetry";
import {
  startRecordingTelemetry,
  type RecordedMetric,
  type RecordingTelemetry,
} from "@azx-pbc/telemetry/testing";
import { buildApp } from "../app.js";
import { buildDevGateway } from "../devGateway/app.js";
import type { DevTokenRow, DevTokenStore } from "../devGateway/devTokenStore.js";
import { testAuthConfig, testDevGatewayConfig, testEdgeConfig } from "../test/config.js";
import { until, withServer } from "../test/socket.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";
import { FakeBurnStore } from "./jobsCallbackFixtures.js";
import { deriveInstructionKey } from "./instruction.js";
import type { EgressProvider, EgressRequest, EgressResponse } from "./egressProvider.js";

/**
 * How the browser fetch route ledgers and meters its refusals, end to end
 * through `buildApp` and `buildDevGateway`: the request-body size refusal at
 * both of its points (before minting, and while streaming to egress), and the
 * separate denial-row budgets each category of refusal gets on both
 * processes. The policy core's own view of the same refusals is in
 * `fetchPolicy.test.ts`.
 */

// One recording for the file: the edge's ProxyTracer and meter cache their
// first provider, so metric assertions read before/after deltas.
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

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOST = { host: "demo.local.helix.azxlabs.io" };
const ORIGIN = "https://demo.local.helix.azxlabs.io:8080";
const URL_PATH = "/_api/fetch/https://api.github.com/x";
const CAP = 64;
const key = deriveInstructionKey(randomBytes(32));

/** Drains the request body the way egress would, then answers 200. */
class DrainingEgress implements EgressProvider {
  calls: EgressRequest[] = [];

  async proxy(req: EgressRequest): Promise<EgressResponse> {
    this.calls.push(req);
    if (req.body instanceof Readable) {
      for await (const chunk of req.body) void chunk;
    }
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: Readable.from([Buffer.from("{}")]),
      outcome: "ok",
    };
  }

  async close(): Promise<void> {}
}

const SERVER_ID = "jobs";
const CALLBACK_KEY = deriveJobsInstructionKey(randomBytes(32).toString("base64"), "jobsToEdge");
const OWNER_OID = "oid-triggering-user";
/** The default `DenialThrottle` budget every category gets per window. */
const DENIAL_BUDGET = 20;

/** One configured jobs server, so the callback receiver is wired. */
const JOBS_CONFIG = {
  servers: {
    [SERVER_ID]: {
      server: SERVER_ID,
      endpoint: "https://jobs.internal.helix",
      edgeToJobsKey: new Uint8Array(
        deriveJobsInstructionKey(randomBytes(32).toString("base64"), "edgeToJobs"),
      ),
      jobsToEdgeKey: new Uint8Array(CALLBACK_KEY),
    },
  },
  timeoutMs: 30_000,
  refuseDiagnosticTypes: false,
  submissionLimits: JOBS_CAPACITY_DEFAULTS,
};

function buildEdge(): { app: FastifyInstance; egress: DrainingEgress; usage: FakeUsageStore } {
  const egress = new DrainingEgress();
  const usage = new FakeUsageStore();
  const app = buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      allowUnauthenticated: false,
      fetch: { egressUrl: null, instructionSecret: null, timeoutMs: 30_000, maxBodyBytes: CAP },
      jobs: JOBS_CONFIG,
    }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "demo",
        blobPrefix: "apps/a/1/",
        visibilityMode: "public",
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
    usage,
    egress,
    instructionKey: key,
    jobsCallbackBurns: new FakeBurnStore(),
  });
  return { app, egress, usage };
}

/** `helix.gateway.calls` for this app's fetch capability, per outcome. */
function callsByOutcome(points: RecordedMetric[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const p of points) {
    if (
      p.name !== INSTR_GATEWAY_CALLS ||
      p.attributes[ATTR_CAPABILITY] !== "fetch" ||
      p.attributes[ATTR_APP_ID] !== APP_ID
    ) {
      continue;
    }
    const outcome = String(p.attributes[ATTR_OUTCOME]);
    out.set(outcome, (out.get(outcome) ?? 0) + p.value);
  }
  return out;
}

async function outcomeDelta(run: () => Promise<void>): Promise<Map<string, number>> {
  const before = callsByOutcome(await recording.metrics());
  await run();
  const after = callsByOutcome(await recording.metrics());
  const delta = new Map<string, number>();
  for (const [outcome, n] of after) {
    const moved = n - (before.get(outcome) ?? 0);
    if (moved !== 0) delta.set(outcome, moved);
  }
  return delta;
}

describe("/_api/fetch — the request-body size refusal", () => {
  it("ledgers a declared oversized body as too_large: never dialled, no budget spent", async () => {
    const { app, egress, usage } = buildEdge();
    const delta = await outcomeDelta(async () => {
      const res = await app.inject({
        method: "POST",
        url: URL_PATH,
        headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
        payload: Buffer.alloc(CAP + 1, 0x61), // a truthful content-length over the cap
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().code).toBe("too_large");
    });

    expect(egress.calls).toHaveLength(0);
    await until(() => usage.records.length > 0, "the size refusal's ledger row");
    expect(usage.records).toEqual([
      expect.objectContaining({
        capability: "fetch",
        model: "https://api.github.com",
        outcome: "too_large",
        statusCode: 413,
        errorDetail: "request body exceeds the size cap",
        method: "POST",
        path: "/x",
      }),
    ]);
    // Its own metric label, never the allowlist denial's `forbidden`.
    expect(delta).toEqual(new Map([["too_large", 1]]));
    expect(await usage.fetchRequestsToday()).toBe(0);
    await app.close();
  });

  it("ledgers a streamed body that trips the cap as a 413 refusal that counts: egress was dialled", async () => {
    // No content-length: only the byte counter can find this one, and by then
    // the instruction is already on its way to egress.
    const { app, egress, usage } = buildEdge();
    const delta = await outcomeDelta(async () => {
      await withServer(app, async (base) => {
        const res = await undiciRequest(`${base}${URL_PATH}`, {
          method: "POST",
          headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
          body: Readable.from(Array.from({ length: 8 }, () => Buffer.alloc(40, 0x61))),
        }).catch(() => undefined);
        expect(res?.statusCode).toBe(413);
        expect(((await res?.body.json()) as { code: string }).code).toBe("too_large");
      });
    });

    expect(egress.calls).toHaveLength(1);
    expect(usage.records).toEqual([
      expect.objectContaining({
        capability: "fetch",
        outcome: "refusal",
        statusCode: 413,
        errorDetail: "request body exceeds the size cap",
        method: "POST",
      }),
    ]);
    expect(delta).toEqual(new Map([["refusal", 1]]));
    expect(await usage.fetchRequestsToday()).toBe(1);
  });
});

// ── Denial-row budgets ───────────────────────────────────────────────────────

const DEV_ORIGIN = "https://myapp.lovable.app";

/** A dev-token store holding one live token for the app. */
class OneTokenStore implements DevTokenStore {
  readonly token = newDevToken();
  readonly #row: DevTokenRow = {
    appId: APP_ID,
    developerOid: "oid-developer",
    origins: [DEV_ORIGIN],
    expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null,
  };
  async resolve(tokenHash: string): Promise<DevTokenRow | null> {
    return tokenHash === hashDevToken(this.token) ? this.#row : null;
  }
  async originAllowed(appId: string, origin: string): Promise<boolean> {
    return appId === APP_ID && origin === DEV_ORIGIN;
  }
  async close(): Promise<void> {}
}

function buildDev(): { app: FastifyInstance; usage: FakeUsageStore; tokens: OneTokenStore } {
  const usage = new FakeUsageStore();
  const tokens = new OneTokenStore();
  const app = buildDevGateway({
    config: testDevGatewayConfig({
      fetch: { egressUrl: null, instructionSecret: null, timeoutMs: 30_000, maxBodyBytes: CAP },
      jobs: JOBS_CONFIG,
    }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "myapp",
        blobPrefix: "apps/d/1/",
        fetch: {
          connections: new Map([["https://api.github.com", { kind: "keyless" }]]),
          requestsPerDay: null,
          shim: false,
        },
      }),
    ]),
    devTokens: tokens,
    appData: null,
    usage,
    llmProvider: null,
    egress: new DrainingEgress(),
    instructionKey: key,
    jobsForwarder: null,
    jobsCallbackBurns: new FakeBurnStore(),
    portal: null,
  });
  return { app, usage, tokens };
}

/** The browser route's request for one target, on the edge's app host. */
function edgeFetch(app: FastifyInstance, target: string, body?: Buffer) {
  return app.inject({
    method: body ? "POST" : "GET",
    url: `/_api/fetch/${target}`,
    headers: { ...HOST, origin: ORIGIN, "content-type": "application/octet-stream" },
    ...(body ? { payload: body } : {}),
  });
}

/** The same request on the dev gateway, under a dev token. */
function devFetch(app: FastifyInstance, tokens: OneTokenStore, target: string) {
  return app.inject({
    method: "GET",
    url: `/myapp/_api/fetch/${target}`,
    headers: { authorization: `Bearer ${tokens.token}`, origin: DEV_ORIGIN },
  });
}

/** A signed jobs callback for a GET of `target`, at the given tier. */
async function callback(app: FastifyInstance, env: Env, target: string) {
  const body = Buffer.from(JSON.stringify({ url: target }), "utf8");
  const token = await mintJobsInstruction(
    {
      operation: "fetch",
      server: SERVER_ID,
      identity: {
        appId: APP_ID,
        env,
        ownerKind: env === "dev" ? "dev" : "user",
        ownerOid: OWNER_OID,
        type: `${SERVER_ID}:fetch`,
      },
      jobId: "job-1",
      generation: "1",
      body: new Uint8Array(body),
      iatS: Math.floor(Date.now() / 1_000),
    },
    new Uint8Array(CALLBACK_KEY),
  );
  return app.inject({
    method: "POST",
    url: ROUTE_JOBS_FETCH,
    headers: {
      host: "helix-jobs-callback.internal",
      [INSTRUCTION_HEADER]: token,
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
}

/** Wait out the unawaited denial rows, then count one outcome's rows. */
async function rowsOf(usage: FakeUsageStore, expected: number, outcome: string): Promise<number> {
  await until(() => usage.records.length >= expected, `${expected} ledger rows`);
  return usage.records.filter((r) => r.outcome === outcome).length;
}

describe("the denial-row budgets — one per category", () => {
  it("does not let a run of oversized uploads silence the allowlist denial rows", async () => {
    const { app, usage } = buildEdge();
    for (let i = 0; i < DENIAL_BUDGET + 5; i += 1) {
      const res = await edgeFetch(app, "https://api.github.com/x", Buffer.alloc(CAP + 1));
      expect(res.statusCode).toBe(413);
    }
    expect(await rowsOf(usage, DENIAL_BUDGET, "too_large")).toBe(DENIAL_BUDGET);

    const denied = await edgeFetch(app, "https://api.evil.com/steal");
    expect(denied.statusCode).toBe(403);
    expect(await rowsOf(usage, DENIAL_BUDGET + 1, "forbidden")).toBe(1);
    await app.close();
  });

  it("does not let a run of allowlist denials silence the size refusal rows", async () => {
    const { app, usage } = buildEdge();
    for (let i = 0; i < DENIAL_BUDGET + 5; i += 1) {
      expect((await edgeFetch(app, "https://api.evil.com/steal")).statusCode).toBe(403);
    }
    expect(await rowsOf(usage, DENIAL_BUDGET, "forbidden")).toBe(DENIAL_BUDGET);

    const res = await edgeFetch(app, "https://api.github.com/x", Buffer.alloc(CAP + 1));
    expect(res.statusCode).toBe(413);
    expect(await rowsOf(usage, DENIAL_BUDGET + 1, "too_large")).toBe(1);
    await app.close();
  });

  it("keeps the edge's jobs callback denials on their own budget", async () => {
    const { app, usage } = buildEdge();
    for (let i = 0; i < DENIAL_BUDGET + 5; i += 1) {
      expect((await edgeFetch(app, "https://api.evil.com/steal")).statusCode).toBe(403);
    }
    await rowsOf(usage, DENIAL_BUDGET, "forbidden");

    const refused = await callback(app, "prod", "https://api.evil.com/steal");
    expect(refused.statusCode).toBe(403);
    await until(() => usage.records.length > DENIAL_BUDGET, "the callback's denial row");
    expect(usage.records.filter((r) => r.userOid === OWNER_OID)).toEqual([
      expect.objectContaining({ outcome: "forbidden", env: "prod" }),
    ]);
    await app.close();
  });

  it("keeps the dev gateway's jobs callback denials on their own budget", async () => {
    const { app, usage, tokens } = buildDev();
    for (let i = 0; i < DENIAL_BUDGET + 5; i += 1) {
      expect((await devFetch(app, tokens, "https://api.evil.com/steal")).statusCode).toBe(403);
    }
    await rowsOf(usage, DENIAL_BUDGET, "forbidden");

    const refused = await callback(app, "dev", "https://api.evil.com/steal");
    expect(refused.statusCode).toBe(403);
    await until(() => usage.records.length > DENIAL_BUDGET, "the callback's denial row");
    expect(usage.records.filter((r) => r.userOid === OWNER_OID)).toEqual([
      expect.objectContaining({ outcome: "forbidden", env: "dev" }),
    ]);
    await app.close();
  });
});
