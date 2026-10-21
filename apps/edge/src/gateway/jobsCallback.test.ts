import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { request as undiciRequest } from "undici";
import { INSTRUCTION_HEADER, type JobRequestError } from "@azx-pbc/shared";
import { deriveJobsInstructionKey, mintJobsInstruction } from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_OUTCOME,
  INSTR_JOBS_CALLBACKS,
  ROUTE_JOBS_FETCH,
  SPAN_JOBS_FETCH_DEV,
  SPAN_JOBS_FETCH_EDGE,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import type { ProxiedOriginCredential } from "../registry/projection.js";
import { FakeUsageStore, registryEntry } from "../test/fakes.js";
import { FakeOidcClient, FakeRegistry, FakeSessionStore, FakeBlobReader } from "../test/fakes.js";
import { testAuthConfig, testDevGatewayConfig, testEdgeConfig } from "../test/config.js";
import { buildApp } from "../app.js";
import { buildDevGateway } from "../devGateway/app.js";
import { until, withServer } from "../test/socket.js";
import { FakeBurnStore, FakeEgress } from "./jobsCallbackFixtures.js";
import { deriveInstructionKey } from "./instruction.js";

/**
 * The signed jobs→edge fetch-callback receiver (`gateway/jobsCallback.ts`) —
 * the route an executing job calls for its one governed outbound GET. The
 * policy core's own decisions are pinned in `fetchPolicy.test.ts`; this suite
 * pins what only the ROUTE can prove: the instruction verification and key
 * selection over the shared signing engine, the tier refusal that never
 * spends a nonce, the burn-before-dispatch order, the signed claims' flow
 * into the unattended authority, the bounded response vocabulary, the
 * fail-closed wiring on both receiver processes, and the abort path.
 */

const SERVER_ID = "jobs";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const JOB_ID = "job-123";
const OWNER_OID = "oid-triggering-user";
const TARGET = "https://api.github.com/users/octocat";
/** A non-base-domain host → the edge classifies it as platform traffic. */
const PLATFORM_HOST = { host: "helix-jobs-callback.internal" };
const APP_HOST = { host: "demo.local.helix.azxlabs.io:8080" };

const secret = randomBytes(32);
const instructionKey = deriveInstructionKey(secret);

/** Distinct roots per direction — the fixture encodings of 32 random bytes. */
const ROOTS = {
  edgeToJobs: randomBytes(32).toString("base64"),
  jobsToEdge: randomBytes(32).toString("base64"),
  otherServer: randomBytes(32).toString("base64"),
};
/** The callback verification key the edge derives from its configured root. */
const CALLBACK_KEY = deriveJobsInstructionKey(ROOTS.jobsToEdge, "jobsToEdge");
/** Another server's callback key — a token signed with it must never verify here. */
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

interface CallbackHarness {
  app: FastifyInstance;
  egress: FakeEgress;
  usage: FakeUsageStore;
  burns: FakeBurnStore;
}

function buildCallbackEdge(
  opts: {
    connections?: Map<string, ProxiedOriginCredential>;
    requestsPerDay?: number | null;
    jobsGeneration?: string;
    archived?: boolean;
    devBypass?: boolean;
    egress?: FakeEgress;
    burns?: FakeBurnStore;
    usage?: FakeUsageStore;
    /** A second configured server — the multi-server key-selection cases. */
    secondServer?: { id: string; jobsToEdgeKey: Uint8Array };
  } = {},
): CallbackHarness {
  const egress = opts.egress ?? new FakeEgress();
  const usage: FakeUsageStore = opts.usage === undefined ? new FakeUsageStore() : opts.usage;
  const burns = opts.burns ?? new FakeBurnStore();
  const app = buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      allowUnauthenticated: opts.devBypass ?? false,
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
          ...(opts.secondServer
            ? {
                [opts.secondServer.id]: {
                  server: opts.secondServer.id,
                  endpoint: "https://jobs2.internal.helix",
                  edgeToJobsKey: new Uint8Array(
                    deriveJobsInstructionKey(ROOTS.otherServer, "edgeToJobs"),
                  ),
                  jobsToEdgeKey: opts.secondServer.jobsToEdgeKey,
                },
              }
            : {}),
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
        archived: opts.archived ?? false,
        fetch: {
          connections:
            opts.connections ?? new Map([["https://api.github.com", { kind: "keyless" }]]),
          requestsPerDay: opts.requestsPerDay ?? null,
          shim: false,
        },
        ...(opts.jobsGeneration !== undefined ? { jobsGeneration: opts.jobsGeneration } : {}),
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
  return { app, egress, usage, burns };
}

async function mintCallbackInstruction(
  opts: {
    /** The body the instruction binds — presented verbatim. */
    body?: Buffer | unknown;
    env?: "prod" | "dev";
    server?: string;
    key?: Uint8Array;
    generation?: string;
    jobId?: string;
    ownerKind?: "user" | "dev";
    ownerOid?: string;
    iatS?: number;
  } = {},
): Promise<{ token: string; body: Buffer }> {
  const body =
    opts.body instanceof Buffer
      ? opts.body
      : Buffer.from(JSON.stringify(opts.body ?? { url: TARGET }), "utf8");
  const token = await mintJobsInstruction(
    {
      operation: "fetch",
      server: opts.server ?? SERVER_ID,
      identity: {
        appId: APP_ID,
        env: opts.env ?? "prod",
        ownerKind: opts.ownerKind ?? "user",
        ownerOid: opts.ownerOid ?? OWNER_OID,
        type: `${opts.server ?? SERVER_ID}:fetch`,
      },
      jobId: opts.jobId ?? JOB_ID,
      generation: opts.generation ?? "1",
      body,
      iatS: opts.iatS ?? Math.floor(Date.now() / 1_000),
    },
    opts.key ?? new Uint8Array(CALLBACK_KEY),
  );
  return { token, body };
}

async function present(
  app: FastifyInstance,
  args: { token: string; body: Buffer; host?: string; url?: string },
): Promise<{ status: number; json: unknown; text: string }> {
  const res = await app.inject({
    method: "POST",
    url: args.url ?? ROUTE_JOBS_FETCH,
    headers: {
      ...(args.host === undefined ? PLATFORM_HOST : { host: args.host }),
      [INSTRUCTION_HEADER]: args.token,
      "content-type": "application/json",
      "content-length": String(args.body.length),
    },
    body: args.body,
  });
  let json: unknown;
  try {
    json = res.json();
  } catch {
    json = null;
  }
  return { status: res.statusCode, json, text: res.body };
}

function isJobsError(value: unknown, code: string): value is JobRequestError {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === code;
}

/** Flush the fire-and-forget denial ledger row, the way the policy suite does. */
async function flushDenialRow(usage: FakeUsageStore): Promise<void> {
  await until(() => usage.records.length > 0, "the denial's ledger row");
}

async function callbacksDelta(
  points: { name: string; value: number; attributes: Record<string, unknown> }[],
): Promise<number> {
  return points.filter((p) => p.name === INSTR_JOBS_CALLBACKS).reduce((n, p) => n + p.value, 0);
}

describe("POST /internal/jobs/v1/fetch — a valid callback", () => {
  it("dispatches one governed GET through the policy and streams the upstream bytes", async () => {
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.text)).toEqual({ ok: true });
    expect(h.egress.calls).toHaveLength(1);
    // The outbound call is the policy's own: a GET the POST merely transported,
    // against the signed URL, with no caller-selected headers to forward.
    expect(h.egress.calls[0]!.method).toBe("GET");
    expect(h.egress.calls[0]!.target).toBe(TARGET);
    expect(h.egress.calls[0]!.headers).toEqual({});
    // The nonce was consumed before the dispatch.
    expect(h.burns.burned).toHaveLength(1);
    // The ledger row carries the triggering principal as attribution.
    expect(h.usage.records).toContainEqual(
      expect.objectContaining({
        capability: "fetch",
        outcome: "ok",
        model: "https://api.github.com",
        path: "/users/octocat",
        method: "GET",
        userOid: OWNER_OID,
        userKind: "user",
        userName: null,
        userEmail: null,
      }),
    );
    await h.app.close();
  });

  it("mints the ordinary attested egress instruction — no delegated evidence, no user kind", async () => {
    // The unattended mint attests exactly what the authority stated: the
    // triggering principal for the ledger, and nothing a delegated call would
    // carry. Keyless here; the secret-backed case is the same minus connection.
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction();
    await present(h.app, { token, body });

    const instruction = h.egress.calls[0]!.instruction;
    // Decoded with the egress instruction key (the mint the core made), not
    // the jobs→edge one — the two token families must never cross.
    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(instruction, instructionKey);
    expect(payload.origin).toBe("https://api.github.com");
    expect(payload.userOid).toBe(OWNER_OID);
    expect(payload.env).toBe("prod");
    expect(payload.userKind).toBeUndefined();
    expect(payload.provider).toBeUndefined();
    await h.app.close();
  });

  it("names the stored connection for a secret-bound origin", async () => {
    const h = buildCallbackEdge({
      connections: new Map([
        ["https://api.github.com", { kind: "secret", connection: "github-token" }],
      ]),
    });
    const { token, body } = await mintCallbackInstruction();
    await present(h.app, { token, body });

    const { jwtVerify } = await import("jose");
    const { payload } = await jwtVerify(h.egress.calls[0]!.instruction, instructionKey);
    // The connection NAME rides the mint (that is what egress resolves); the
    // secret's VALUE does not exist on this side of the boundary at all.
    expect(payload.connection).toBe("github-token");
    await h.app.close();
  });

  it("attributes a dev-owner job with the dev principal kind", async () => {
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction({ ownerKind: "dev" });
    await present(h.app, { token, body });

    expect(h.usage.records).toContainEqual(
      expect.objectContaining({ capability: "fetch", outcome: "ok", userKind: "dev" }),
    );
    await h.app.close();
  });

  it("verifies a token minted by the second of several configured servers — the signature selects the key", async () => {
    // With one configured server, "each candidate verify pins `server` to that
    // key's own server" is indistinguishable from pinning a fixed server for
    // every attempt. Two servers: a token signed by the second must verify
    // against the second key WITH the second server's identity — the first
    // candidate's failure (its key, its server) must not stick.
    const SECOND_ID = "jobs-backup";
    const h = buildCallbackEdge({
      secondServer: { id: SECOND_ID, jobsToEdgeKey: new Uint8Array(OTHER_KEY) },
    });
    const { token, body } = await mintCallbackInstruction({ server: SECOND_ID, key: OTHER_KEY });
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(200);
    expect(h.egress.calls).toHaveLength(1);
    expect(h.burns.burned).toHaveLength(1);
    await h.app.close();
  });
});

describe("POST /internal/jobs/v1/fetch — instructions that cannot dispatch", () => {
  it("refuses a replayed token before any second effect", async () => {
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction();
    const first = await present(h.app, { token, body });
    expect(first.status).toBe(200);
    const second = await present(h.app, { token, body });

    expect(second.status).toBe(401);
    expect(isJobsError(second.json, "unauthorized")).toBe(true);
    expect(h.egress.calls).toHaveLength(1);
    expect(h.burns.burned).toHaveLength(1);
    await h.app.close();
  });

  it("refuses an altered body — the digest binding — without burning or dispatching", async () => {
    const h = buildCallbackEdge();
    const { token } = await mintCallbackInstruction();
    const altered = Buffer.from(JSON.stringify({ url: "https://api.evil.com/steal" }), "utf8");
    const answer = await present(h.app, { token, body: altered });

    expect(answer.status).toBe(401);
    expect(h.egress.calls).toHaveLength(0);
    expect(h.burns.burned).toHaveLength(0);
    await h.app.close();
  });

  it("refuses a token from another server's root, and an expired one, before any burn", async () => {
    const h = buildCallbackEdge();
    const foreign = await mintCallbackInstruction({ key: new Uint8Array(OTHER_KEY) });
    const foreignAnswer = await present(h.app, foreign);
    expect(foreignAnswer.status).toBe(401);

    const expired = await mintCallbackInstruction({
      iatS: Math.floor(Date.now() / 1_000) - 120,
    });
    const expiredAnswer = await present(h.app, expired);
    expect(expiredAnswer.status).toBe(401);

    const missing = await present(h.app, {
      token: "",
      body: Buffer.from(JSON.stringify({ url: TARGET }), "utf8"),
    });
    expect(missing.status).toBe(401);

    expect(h.egress.calls).toHaveLength(0);
    expect(h.burns.burned).toHaveLength(0);
    await h.app.close();
  });

  it("refuses the opposite signed tier WITHOUT consuming its nonce", async () => {
    // A dev-signed token misrouted to the production edge is refused, and the
    // refusal spends nothing: the token must still be usable at its own tier's
    // receiver (the two processes are separate nonce spaces).
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction({ env: "dev" });
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(403);
    expect(isJobsError(answer.json, "forbidden")).toBe(true);
    expect(h.egress.calls).toHaveLength(0);
    expect(h.burns.burned).toHaveLength(0);
    await h.app.close();
  });

  it("refuses an unknown or archived app before the dispatch", async () => {
    const h = buildCallbackEdge({ archived: true });
    const { token, body } = await mintCallbackInstruction();
    const archived = await present(h.app, { token, body });
    expect(archived.status).toBe(403);
    expect(isJobsError(archived.json, "outbound_forbidden")).toBe(true);
    await h.app.close();

    // An app id nothing in the registry answers to: the same refusal, no
    // disclosure of which arm it was.
    const stranger = buildCallbackEdge();
    const foreignApp = await mintCallbackInstruction();
    // Sign for an app id the registry does not carry.
    const body2 = foreignApp.body;
    const { mintJobsInstruction: mint2 } = await import("@azx-pbc/shared/jobsSigning");
    const strangerToken = await mint2(
      {
        operation: "fetch",
        server: SERVER_ID,
        identity: {
          appId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          env: "prod",
          ownerKind: "user",
          ownerOid: OWNER_OID,
          type: `${SERVER_ID}:fetch`,
        },
        jobId: JOB_ID,
        generation: "1",
        body: new Uint8Array(body2),
        iatS: Math.floor(Date.now() / 1_000),
      },
      new Uint8Array(CALLBACK_KEY),
    );
    const strangerAnswer = await present(stranger.app, { token: strangerToken, body: body2 });
    expect(strangerAnswer.status).toBe(403);
    expect(isJobsError(strangerAnswer.json, "outbound_forbidden")).toBe(true);
    expect(stranger.egress.calls).toHaveLength(0);
    await stranger.app.close();
  });

  it("fences a stale lifecycle generation before dispatch, as 403 outbound_forbidden", async () => {
    // The job was admitted under generation 1; the app has since moved to 2.
    // The fence is the core's; the route's contract is that the SIGNED
    // generation is what it fences with, and the answer is the criterion's
    // 403 `outbound_forbidden` before any dial.
    const h = buildCallbackEdge({ jobsGeneration: "2" });
    const { token, body } = await mintCallbackInstruction({ generation: "1" });
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(403);
    expect(isJobsError(answer.json, "outbound_forbidden")).toBe(true);
    expect(h.egress.calls).toHaveLength(0);
    await flushDenialRow(h.usage);
    expect(h.usage.records).toContainEqual(
      expect.objectContaining({ capability: "fetch", outcome: "forbidden", statusCode: 403 }),
    );
    await h.app.close();
  });

  it("refuses an ungranted origin, as 403 outbound_forbidden", async () => {
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction({
      body: { url: "https://api.evil.com/steal" },
    });
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(403);
    expect(isJobsError(answer.json, "outbound_forbidden")).toBe(true);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();
  });

  it("refuses a delegated origin with no keyless fallback", async () => {
    // A user's OAuth connection must never be spent unattended — and never
    // stripped so the call can retry keyless. The refusal is the answer.
    const h = buildCallbackEdge({
      connections: new Map([
        ["https://api.github.com", { kind: "provider", provider: "github-app", required: false }],
        ["https://api.stripe.com", { kind: "keyless" }],
      ]),
    });
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(403);
    expect(isJobsError(answer.json, "delegated_unattended")).toBe(true);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();
  });

  it("refuses on the fetch budget with 429 outbound_quota_exceeded", async () => {
    const h = buildCallbackEdge({ requestsPerDay: 1 });
    h.usage.fetchToday = 1;
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(429);
    expect(isJobsError(answer.json, "outbound_quota_exceeded")).toBe(true);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();
  });

  it("refuses a verified body that is not a fetch input, and an over-bound body", async () => {
    const h = buildCallbackEdge();
    // The digest binds the junk, so the token verifies — the parse refuses.
    const junk = await mintCallbackInstruction({ body: { nope: true } });
    const junkAnswer = await present(h.app, junk);
    expect(junkAnswer.status).toBe(400);
    expect(isJobsError(junkAnswer.json, "payload_invalid")).toBe(true);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();

    // Over the input bound: refused before verification (nothing holds it).
    const over = buildCallbackEdge();
    const huge = Buffer.from(
      JSON.stringify({ url: `https://api.github.com/${"a".repeat(66_000)}` }),
      "utf8",
    );
    const overToken = await mintCallbackInstruction({ body: huge });
    const overAnswer = await present(over.app, { token: overToken.token, body: huge });
    expect(overAnswer.status).toBe(413);
    expect(isJobsError(overAnswer.json, "payload_too_large")).toBe(true);
    expect(over.egress.calls).toHaveLength(0);
    await over.app.close();
  });

  it("answers 503 when the burn store cannot answer — never lets the call run unburned", async () => {
    const burns = new FakeBurnStore();
    burns.unavailable = new Error("burn store down");
    const h = buildCallbackEdge({ burns });
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(503);
    expect(isJobsError(answer.json, "jobs_unavailable")).toBe(true);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();
  });

  it("spends the nonce even when the dispatch refuses, so a re-presentation replays rather than re-refuses", async () => {
    // The gate order's other half: the burn precedes the entry resolution and
    // the body parse, so ANY verified, tier-passing token is single-use — even
    // one whose dispatch can only refuse. A re-presentation therefore answers
    // the replay refusal, never a second evaluation of the original one.
    const h = buildCallbackEdge();
    // An app id the registry does not carry: 403 on the first presentation…
    const strangerBody = Buffer.from(JSON.stringify({ url: TARGET }), "utf8");
    const { mintJobsInstruction: mint2 } = await import("@azx-pbc/shared/jobsSigning");
    const strangerToken = await mint2(
      {
        operation: "fetch",
        server: SERVER_ID,
        identity: {
          appId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          env: "prod",
          ownerKind: "user",
          ownerOid: OWNER_OID,
          type: `${SERVER_ID}:fetch`,
        },
        jobId: JOB_ID,
        generation: "1",
        body: new Uint8Array(strangerBody),
        iatS: Math.floor(Date.now() / 1_000),
      },
      new Uint8Array(CALLBACK_KEY),
    );
    const first = await present(h.app, { token: strangerToken, body: strangerBody });
    expect(first.status).toBe(403);
    expect(isJobsError(first.json, "outbound_forbidden")).toBe(true);
    // …and 401 (replay) on the second — the refusal spent the nonce.
    const strangerReplay = await present(h.app, { token: strangerToken, body: strangerBody });
    expect(strangerReplay.status).toBe(401);
    expect(isJobsError(strangerReplay.json, "unauthorized")).toBe(true);

    // A verified body that is not a fetch input: the parse refuses 400, and
    // the nonce is spent with it.
    const junk = await mintCallbackInstruction({ body: { nope: true } });
    const junkFirst = await present(h.app, junk);
    expect(junkFirst.status).toBe(400);
    const junkReplay = await present(h.app, junk);
    expect(junkReplay.status).toBe(401);

    expect(h.egress.calls).toHaveLength(0);
    expect(h.burns.burned).toHaveLength(2);
    await h.app.close();
  });

  it("caps how many policy denials it meters, while still refusing every callback", async () => {
    // The callback shares the browser route's denial throttle (one policy core,
    // one ledger): a retry loop through the callback must not append denial
    // rows unbounded either. Every presentation is a fresh, verifying
    // instruction against an ungranted origin — the cap throttles metering,
    // never authz.
    const h = buildCallbackEdge();
    const attempts = 25;
    for (let i = 0; i < attempts; i += 1) {
      const { token, body } = await mintCallbackInstruction({
        body: { url: `https://api.evil.com/steal-${i}` },
      });
      const answer = await present(h.app, { token, body });
      expect(answer.status).toBe(403);
    }
    const denials = h.usage.records.filter((r) => r.outcome === "forbidden");
    expect(denials.length).toBeGreaterThan(0);
    expect(denials.length).toBeLessThan(attempts);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();
  });

  it("answers 503 jobs_disabled when the callback is not wired", async () => {
    // Fully disabled jobs (no servers configured): the route still exists and
    // answers the distinguishable refusal.
    const app = buildApp({
      config: testEdgeConfig({ auth: testAuthConfig() }),
      registry: new FakeRegistry([]),
      blob: new FakeBlobReader(),
      sessions: new FakeSessionStore(),
      oidc: new FakeOidcClient(),
    });
    const answer = await present(app, {
      token: "unverified",
      body: Buffer.from(JSON.stringify({ url: TARGET }), "utf8"),
    });
    expect(answer.status).toBe(503);
    expect(isJobsError(answer.json, "jobs_disabled")).toBe(true);
    await app.close();
  });

  it("answers 503 when jobs is configured but the fetch machinery is not", async () => {
    // Jobs configured (keys load) but no egress/instruction key: the dispatch
    // cannot run, so the route refuses fail-closed rather than half-serve.
    const app = buildApp({
      config: testEdgeConfig({
        auth: testAuthConfig(),
        jobs: {
          servers: {
            [SERVER_ID]: {
              server: SERVER_ID,
              endpoint: "https://jobs.internal.helix",
              edgeToJobsKey: new Uint8Array(
                deriveJobsInstructionKey(ROOTS.edgeToJobs, "edgeToJobs"),
              ),
              jobsToEdgeKey: new Uint8Array(CALLBACK_KEY),
            },
          },
          timeoutMs: 30_000,
          refuseDiagnosticTypes: false,
        },
      }),
      registry: new FakeRegistry([
        registryEntry({ appId: APP_ID, slug: "demo", blobPrefix: "apps/a/1/" }),
      ]),
      blob: new FakeBlobReader(),
      sessions: new FakeSessionStore(),
      oidc: new FakeOidcClient(),
      jobsCallbackBurns: new FakeBurnStore(),
    });
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(app, { token, body });
    expect(answer.status).toBe(503);
    expect(isJobsError(answer.json, "jobs_disabled")).toBe(true);
    await app.close();
  });
});

describe("POST /internal/jobs/v1/fetch — the surfaces it must not serve", () => {
  it("never serves the callback on an app host, even over a valid token", async () => {
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(h.app, { token, body, host: APP_HOST.host });

    expect(answer.status).toBe(404);
    expect(h.egress.calls).toHaveLength(0);
    expect(h.burns.burned).toHaveLength(0);
    await h.app.close();
  });

  it("requires signature verification even with the dev authentication bypass on", async () => {
    const h = buildCallbackEdge({ devBypass: true });
    const body = Buffer.from(JSON.stringify({ url: TARGET }), "utf8");
    const answer = await present(h.app, { token: "", body });

    expect(answer.status).toBe(401);
    expect(h.egress.calls).toHaveLength(0);
    await h.app.close();
  });

  it("refuses a presentation carrying a query — no signed claim can name one", async () => {
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(h.app, { token, body, url: `${ROUTE_JOBS_FETCH}?x=1` });

    expect(answer.status).toBe(401);
    expect(h.egress.calls).toHaveLength(0);
    expect(h.burns.burned).toHaveLength(0);
    await h.app.close();
  });
});

describe("POST /internal/jobs/v1/fetch — the upstream answers", () => {
  it("answers a bounded upstream_error for a non-2xx upstream, and destroys the body", async () => {
    // The upstream's own body never reaches jobs (criterion 32: sanitized,
    // distinct reasons). The abandoned stream is destroyed, not left open.
    const egress = new FakeEgress();
    let destroyed = false;
    egress.responseBody = new Readable({
      read() {},
      destroy(err, cb) {
        destroyed = true;
        cb(err ?? null);
      },
    });
    egress.responseBody.push(Buffer.from("upstream body that must never arrive"));
    egress.status = 404;
    egress.outcome = "refusal";
    const h = buildCallbackEdge({ egress });
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(502);
    expect(isJobsError(answer.json, "upstream_error")).toBe(true);
    expect(answer.text).not.toContain("upstream body");
    expect(destroyed).toBe(true);
    // The ledger row keeps the truth of what the upstream said.
    expect(h.usage.records).toContainEqual(
      expect.objectContaining({ capability: "fetch", outcome: "refusal", statusCode: 404 }),
    );
    await h.app.close();
  });

  it("answers a bounded upstream_error for a failed forward — distinguishable in telemetry", async () => {
    const egress = new FakeEgress();
    egress.failure = new Error("dial failed");
    const h = buildCallbackEdge({ egress });
    const { token, body } = await mintCallbackInstruction();
    const answer = await present(h.app, { token, body });

    expect(answer.status).toBe(502);
    expect(isJobsError(answer.json, "upstream_error")).toBe(true);

    // The two failure shapes answer identically to jobs (both are the job's
    // upstream failure) and stay distinguishable to the operator — the span
    // outcome carries which one happened.
    const routeSpan = recording.spans().find((s) => s.name === SPAN_JOBS_FETCH_EDGE);
    expect(routeSpan?.attributes[ATTR_OUTCOME]).toBe("upstream_failed");
    await h.app.close();
  });

  it("aborts the egress call when jobs hangs up mid-stream", async () => {
    // Over a real socket: jobs' cancellation and its outbound timeout are the
    // client hang-ups this path exists for. A held-open egress "upstream" and
    // an aborting client — the forward must not run on.
    const egress = new FakeEgress();
    egress.delayMs = 5_000;
    const h = buildCallbackEdge({ egress });
    await withServer(h.app, async (base) => {
      const { token, body } = await mintCallbackInstruction();
      const ac = new AbortController();
      const pending = undiciRequest(`${base}${ROUTE_JOBS_FETCH}`, {
        method: "POST",
        headers: {
          ...PLATFORM_HOST,
          [INSTRUCTION_HEADER]: token,
          "content-type": "application/json",
          "content-length": String(body.length),
        },
        body,
        signal: ac.signal,
      }).catch(() => undefined);
      await until(() => egress.calls.length === 1, "egress to be dialed");
      ac.abort();
      await pending;
      await until(() => egress.abortedDuringCall, "the egress call to be aborted");
    });
  });

  it("streams the upstream bytes to jobs over the transport, not a buffered copy", async () => {
    // The success contract at the transport level: the upstream's chunks
    // arrive as the callback's body, complete and unmodified — what jobs
    // validates and bounds on the other side.
    const egress = new FakeEgress();
    egress.responseBody = Readable.from([Buffer.from('{"first":'), Buffer.from('"chunk"}')]);
    const h = buildCallbackEdge({ egress });
    await withServer(h.app, async (base) => {
      const { token, body } = await mintCallbackInstruction();
      const res = await undiciRequest(`${base}${ROUTE_JOBS_FETCH}`, {
        method: "POST",
        headers: {
          ...PLATFORM_HOST,
          [INSTRUCTION_HEADER]: token,
          "content-type": "application/json",
          "content-length": String(body.length),
        },
        body,
      });
      expect(res.statusCode).toBe(200);
      expect(await res.body.json()).toEqual({ first: "chunk" });
    });
    expect(h.egress.abortedDuringCall).toBe(false);
  });
});

describe("the callback route's telemetry", () => {
  it("carries the surface span and one counter point per presentation", async () => {
    const h = buildCallbackEdge();
    const before = await callbacksDelta(await recording.metrics());
    const { token, body } = await mintCallbackInstruction();
    await present(h.app, { token, body });
    // A refusal path too.
    await present(h.app, { token, body });

    const after = await callbacksDelta(await recording.metrics());
    expect(after - before).toBe(2);

    const routeSpan = recording.spans().find((s) => s.name === SPAN_JOBS_FETCH_EDGE);
    expect(routeSpan).toBeDefined();
    expect(routeSpan?.attributes["http.route"]).toBe(ROUTE_JOBS_FETCH);
    expect(routeSpan?.attributes["helix.jobs.operation"]).toBe("fetch");
    // The dispatch's own outcome supersedes the verification verdict; the
    // replay's word is the verification half.
    const outcomes = recording
      .spans()
      .filter((s) => s.name === SPAN_JOBS_FETCH_EDGE)
      .map((s) => s.attributes[ATTR_OUTCOME]);
    expect(outcomes).toContain("dispatched");
    expect(outcomes).toContain("replayed");
    await h.app.close();
  });

  it("leaks no target URL, token or owner identity onto any span", async () => {
    // The callback's inputs are all sensitive-shaped: the signed target may
    // embed a credential in its path, the instruction is a bearer token, and
    // the owner oid is personal identity. The global redaction suite plants
    // secrets on ITS surfaces; this scan is the callback path's own — every
    // attribute of every span the route emits, serialized and searched.
    const h = buildCallbackEdge();
    const { token, body } = await mintCallbackInstruction();
    await present(h.app, { token, body });
    // A denial path too — the core's target attributes only ever carry a
    // matched-allowlist origin, and the refusals carry none.
    await present(h.app, { token, body });

    const serialized = JSON.stringify(
      recording.spans().map((s) => ({ name: s.name, attributes: s.attributes })),
    );
    // The bounded path attribute the policy core records (`helix.target.path`,
    // capped, query dropped) is the established posture — the same one the
    // browser fetch path has. What must never appear: the full URL (scheme +
    // host together), the bearer instruction, the owner oid.
    expect(serialized).not.toContain(TARGET);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(OWNER_OID);
    await h.app.close();
  });
});

// ── The dev tier's receiver ──────────────────────────────────────────────────

function buildDevCallbackEdge(): CallbackHarness & { devKey: Uint8Array } {
  const egress = new FakeEgress();
  const usage = new FakeUsageStore();
  const burns = new FakeBurnStore();
  const devJobsToEdge = deriveJobsInstructionKey(randomBytes(32).toString("base64"), "jobsToEdge");
  const app = buildDevGateway({
    config: testDevGatewayConfig({
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
            jobsToEdgeKey: new Uint8Array(devJobsToEdge),
          },
        },
        timeoutMs: 30_000,
        refuseDiagnosticTypes: false,
      },
    }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "myapp",
        blobPrefix: "apps/d/1/",
        visibilityMode: "internal",
        fetch: {
          connections: new Map([["https://api.github.com", { kind: "keyless" }]]),
          requestsPerDay: null,
          shim: false,
        },
      }),
    ]),
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
    usage,
    llmProvider: null,
    egress,
    instructionKey,
    jobsForwarder: null,
    jobsCallbackBurns: burns,
    portal: null,
  });
  return { app, egress, usage, burns, devKey: devJobsToEdge };
}

describe("the dev gateway's callback route", () => {
  it("dispatches a dev-signed callback and refuses the production tier", async () => {
    const h = buildDevCallbackEdge();
    // One jobs→edge root per server signs BOTH tiers' callbacks (the root is
    // per server and direction, never per tier) — the tier is the signed
    // `env` claim, which is what each receiver refuses the other's on.
    const devToken = await mintJobsInstruction(
      {
        operation: "fetch",
        server: SERVER_ID,
        identity: {
          appId: APP_ID,
          env: "dev",
          ownerKind: "dev",
          ownerOid: "oid-developer",
          type: `${SERVER_ID}:fetch`,
        },
        jobId: JOB_ID,
        generation: "1",
        body: new Uint8Array(Buffer.from(JSON.stringify({ url: TARGET }), "utf8")),
        iatS: Math.floor(Date.now() / 1_000),
      },
      h.devKey,
    );
    const devAnswer = await present(h.app, {
      token: devToken,
      body: Buffer.from(JSON.stringify({ url: TARGET }), "utf8"),
    });
    expect(devAnswer.status).toBe(200);
    expect(h.egress.calls).toHaveLength(1);
    expect(h.usage.records).toContainEqual(
      expect.objectContaining({ capability: "fetch", outcome: "ok", env: "dev" }),
    );

    // A production-signed token: verified in shape, refused for its tier.
    const prodToken = await mintJobsInstruction(
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
        body: new Uint8Array(Buffer.from(JSON.stringify({ url: TARGET }), "utf8")),
        iatS: Math.floor(Date.now() / 1_000),
      },
      new Uint8Array(h.devKey),
    );
    const prodAnswer = await present(h.app, {
      token: prodToken,
      body: Buffer.from(JSON.stringify({ url: TARGET }), "utf8"),
    });
    expect(prodAnswer.status).toBe(403);
    expect(h.egress.calls).toHaveLength(1);

    const devSpan = recording.spans().find((s) => s.name === SPAN_JOBS_FETCH_DEV);
    expect(devSpan).toBeDefined();
    expect(devSpan?.attributes[ATTR_OUTCOME]).toBe("dispatched");
    await h.app.close();
  });
});
