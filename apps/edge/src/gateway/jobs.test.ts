import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { request as undiciRequest } from "undici";
import type { FastifyInstance } from "fastify";
import { hashDevToken } from "@azx-pbc/shared/devToken";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { hashSessionToken, newSessionToken } from "../auth/sessions.js";
import { buildApp } from "../app.js";
import { testAuthConfig, testDevGatewayConfig, testEdgeConfig } from "../test/config.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  registryEntry,
} from "../test/fakes.js";
import { type JobRequestError, jobRequestError, JOBS_MAX_INPUT_BYTES } from "@azx-pbc/shared";
import type { JobsSubmitForward, JobsForwarder, JobsSubmitSpec } from "../jobs/forwarder.js";
import type { DevTokenStore } from "../devGateway/devTokenStore.js";
import { HttpJobsForwarder } from "../jobs/forwarder.js";
import { deriveJobsInstructionKey } from "@azx-pbc/shared/jobsSigning";
import { FakeJobsServiceReceiver } from "../test/jobsReceiver.js";
import { until, withServer } from "../test/socket.js";
import {
  ROUTE_JOBS_SUBMIT,
  ROUTE_JOBS_SUBMIT_DEV,
  SPAN_JOBS_SUBMIT_EDGE,
  SPAN_JOBS_SUBMIT_DEV,
} from "@azx-pbc/shared/telemetry";

/**
 * The app-facing jobs submission route (`POST /_api/jobs/:server/types/:type`).
 * The forwarder's transport is tested against a real socket in
 * `jobs/forwarder.test.ts`; here a fake forwarder stands in for it so every
 * route decision — gates, attribution, retry-key handling, body bound, and
 * what each forward verdict answers — is pinned in isolation.
 */

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PREFIX = "apps/a/1/";
const HOST = { host: "demo.local.helix.azxlabs.io" };
const ORIGIN = "https://demo.local.helix.azxlabs.io:8080";

const ACCEPTED_BYTES = JSON.stringify({
  server: "jobs",
  jobId: "job-123",
  status: "queued",
});

class FakeJobsForwarder implements JobsForwarder {
  readonly #configured = new Set<string>();
  specs: JobsSubmitSpec[] = [];
  verdict: JobsSubmitForward = {
    kind: "accepted",
    status: 202,
    accepted: { server: "jobs", jobId: "job-123", status: "queued" },
    rawBody: new TextEncoder().encode(ACCEPTED_BYTES),
  };

  constructor(...configured: string[]) {
    for (const s of configured) this.#configured.add(s);
  }

  has(server: string): boolean {
    return this.#configured.has(server);
  }

  async submit(spec: JobsSubmitSpec): Promise<JobsSubmitForward> {
    this.specs.push(spec);
    return this.verdict;
  }

  async close(): Promise<void> {}
}

interface Harness {
  app: FastifyInstance;
  forwarder: FakeJobsForwarder;
  sessions: FakeSessionStore;
}

interface EntryOpts {
  visibilityMode?: "internal" | "public" | "group";
  jobs?: { types: string[] } | null;
  jobsGeneration?: string;
  appSlug?: string;
  archived?: boolean;
  loaded?: boolean;
}

/** The base build: ANY forwarder (the real one in the join tests, a fake otherwise). */
function buildEdgeApp(
  forwarder: JobsForwarder,
  opts: EntryOpts = {},
): { app: FastifyInstance; sessions: FakeSessionStore } {
  const sessions = new FakeSessionStore();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry(
      [
        registryEntry({
          appId: APP_ID,
          slug: opts.appSlug ?? "demo",
          blobPrefix: PREFIX,
          visibilityMode: opts.visibilityMode ?? "internal",
          jobs: opts.jobs === undefined ? { types: ["jobs:fetch"] } : opts.jobs,
          archived: opts.archived ?? false,
          ...(opts.jobsGeneration !== undefined ? { jobsGeneration: opts.jobsGeneration } : {}),
        }),
      ],
      { loaded: opts.loaded ?? true },
    ),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    jobsForwarder: forwarder,
  });
  return { app, sessions };
}

function buildJobsEdge(opts: { forwarder?: FakeJobsForwarder } & EntryOpts = {}): Harness {
  const forwarder = opts.forwarder ?? new FakeJobsForwarder("jobs");
  return { ...buildEdgeApp(forwarder, opts), forwarder };
}

async function seedSession(
  sessions: FakeSessionStore,
  oid: string,
  kind: "user" | "password" = "user",
): Promise<string> {
  const id = randomUUID();
  await sessions.createPending({
    id,
    appId: APP_ID,
    user: { oid, displayName: oid, name: null, email: null, kind, groups: [] },
    refreshDueAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const token = newSessionToken();
  await sessions.redeem(id, APP_ID, hashSessionToken(token));
  return token;
}

async function submit(
  edge: Pick<Harness, "app" | "sessions">,
  url: string,
  opts: {
    token?: string | null;
    origin?: string | null;
    payload?: string;
    headers?: Record<string, string | undefined>;
  } = {},
): Promise<{ status: number; text: string; json: unknown; headers: Record<string, unknown> }> {
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  const res = await edge.app.inject({
    method: "POST",
    url,
    headers: {
      host: HOST.host,
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
      ...(origin ? { origin } : {}),
      ...(opts.token ? { cookie: `${SESSION_COOKIE}=${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  });
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return {
    status: res.statusCode,
    text: res.body,
    json,
    headers: res.headers as Record<string, unknown>,
  };
}

function isJobsError(value: unknown, code: string): value is JobRequestError {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === code;
}

/** The disabled build: no forwarding seam wired — the app alone answers. */
function buildDisabledJobsEdge(): Harness {
  const sessions = new FakeSessionStore();
  const app = buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([
      registryEntry({
        appId: APP_ID,
        slug: "demo",
        blobPrefix: PREFIX,
        visibilityMode: "internal",
        jobs: { types: ["jobs:fetch"] },
      }),
    ]),
    blob: new FakeBlobReader(),
    sessions,
    oidc: new FakeOidcClient(),
    jobsForwarder: null,
  });
  // The forwarder field is never consulted on this build; the type wants one.
  return { app, forwarder: new FakeJobsForwarder(), sessions };
}

const DEV_APP_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEV_BEARER = "dev-token-plant";
const DEV_ORIGIN = "https://myapp.lovable.app";

function fakeDevTokens(): DevTokenStore {
  return {
    async resolve(tokenHash: string) {
      return tokenHash === hashDevToken(DEV_BEARER)
        ? {
            appId: DEV_APP_ID,
            developerOid: "oid-developer",
            origins: [DEV_ORIGIN],
            expiresAt: new Date(Date.now() + 60_000),
            revokedAt: null,
          }
        : null;
    },
    async originAllowed() {
      return false;
    },
    async close() {},
  };
}

async function buildDevJobsEdge(jobsForwarder: JobsForwarder | null): Promise<FastifyInstance> {
  const { buildDevGateway } = await import("../devGateway/app.js");
  const app = buildDevGateway({
    config: testDevGatewayConfig(),
    registry: new FakeRegistry([
      registryEntry({
        appId: DEV_APP_ID,
        slug: "myapp",
        blobPrefix: "apps/d/1/",
        visibilityMode: "internal",
        jobs: { types: ["jobs:fetch"] },
      }),
    ]),
    devTokens: fakeDevTokens(),
    appData: null,
    usage: null,
    llmProvider: null,
    egress: null,
    instructionKey: null,
    jobsForwarder,
    portal: null,
  });
  return app;
}

function devSubmit(
  app: FastifyInstance,
  bearer: string | null,
): Promise<{
  status: number;
  json: unknown;
  headers: Record<string, unknown>;
}> {
  return app
    .inject({
      method: "POST",
      url: "/myapp/_api/jobs/jobs/types/fetch",
      headers: {
        host: "dev-api.local.helix.azxlabs.io",
        "content-type": "application/json",
        origin: DEV_ORIGIN,
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      payload: '{"url":"https://api.vendor.test/v1"}',
    })
    .then((res) => {
      let json: unknown;
      try {
        json = JSON.parse(res.body);
      } catch {
        json = null;
      }
      return {
        status: res.statusCode,
        json,
        headers: res.headers as Record<string, unknown>,
      };
    });
}

describe("the serving and caller gates keep their existing responses", () => {
  it("an unknown app is the plain-text 404 — no jobs envelope", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
      headers: { host: "nosuch.local.helix.azxlabs.io" },
    });
    expect(res.status).toBe(404);
    expect(res.text).toContain("Not found");
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("an archived app is the 410 — before any jobs decision", async () => {
    const harness = buildJobsEdge({ archived: true });
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    expect(res.status).toBe(410);
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("a stale registry is the serving gate's 503 — no jobs envelope", async () => {
    const harness = buildJobsEdge({ loaded: false });
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    expect(res.status).toBe(503);
    expect(isJobsError(res.json, "jobs_disabled")).toBe(false);
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("an unauthenticated caller gets the caller gate's 401, not a jobs envelope", async () => {
    const harness = buildJobsEdge();
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token: null,
      payload: "{}",
    });
    expect(res.status).toBe(401);
    expect(isJobsError(res.json, "unauthorized")).toBe(false);
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("a cross-origin submission is refused before any forward", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(harness.forwarder.specs).toHaveLength(0);
  });
});

describe("the jobs authorization check (after the serving/caller gates)", () => {
  it("a resolved anonymous caller on a public app receives 403 from the jobs check", async () => {
    const harness = buildJobsEdge({ visibilityMode: "public" });
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token: null,
      payload: "{}",
    });
    expect(res.status).toBe(403);
    expect(isJobsError(res.json, "forbidden")).toBe(true);
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("a shared-password principal is refused the same way", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "pw-visitor-oid", "password");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    expect(res.status).toBe(403);
    expect(isJobsError(res.json, "forbidden")).toBe(true);
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("an app without the jobs grant is refused, and one granted another server's type too", async () => {
    const noGrant = buildJobsEdge({ jobs: null });
    const t1 = await seedSession(noGrant.sessions, "alice");
    const r1 = await submit(noGrant, "/_api/jobs/jobs/types/fetch", { token: t1, payload: "{}" });
    expect(r1.status).toBe(403);
    expect(noGrant.forwarder.specs).toHaveLength(0);

    const otherServer = buildJobsEdge({ jobs: { types: ["other:fetch"] } });
    const t2 = await seedSession(otherServer.sessions, "alice");
    const r2 = await submit(otherServer, "/_api/jobs/jobs/types/fetch", {
      token: t2,
      payload: "{}",
    });
    expect(r2.status).toBe(403);
    expect(isJobsError(r2.json, "forbidden")).toBe(true);
    expect(otherServer.forwarder.specs).toHaveLength(0);
  });

  it("a type that is not a type is one no grant can cover — 403, nothing forwarded", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/Fetch%2Fx", {
      token,
      payload: "{}",
    });
    expect(res.status).toBe(403);
    expect(harness.forwarder.specs).toHaveLength(0);
  });
});

describe("submission reachability", () => {
  it("an unknown server answers 400 job_server_unknown, forwarding nothing", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/nosuch/types/fetch", { token, payload: "{}" });
    expect(res.status).toBe(400);
    expect(isJobsError(res.json, "job_server_unknown")).toBe(true);
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("a fully disabled installation answers 503 jobs_disabled", async () => {
    const harness = buildDisabledJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(res.status).toBe(503);
    expect(isJobsError(res.json, "jobs_disabled")).toBe(true);
  });

  it("forwards trusted attribution, the current generation, and the exact bytes", async () => {
    const harness = buildJobsEdge({ jobsGeneration: "7" });
    const token = await seedSession(harness.sessions, "alice");
    // Spacing and key order are the caller's: the bytes are forwarded, not
    // re-serialized.
    const raw = '{"url":"https://api.vendor.test/v1","note":"x"}  ';
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: raw,
      headers: { "idempotency-key": "retry-key-1" },
    });
    expect(res.status).toBe(202);
    expect(harness.forwarder.specs).toHaveLength(1);
    const spec = harness.forwarder.specs[0]!;
    expect(spec).toMatchObject({
      server: "jobs",
      type: "jobs:fetch",
      generation: "7",
      idempotencyKey: "retry-key-1",
    });
    expect(spec.identity).toEqual({
      appId: APP_ID,
      env: "prod",
      ownerKind: "user",
      ownerOid: "alice",
      allowedTypes: ["jobs:fetch"],
    });
    expect(Buffer.from(spec.body).toString()).toBe(raw);
  });

  it("forwards a syntactically invalid body unchanged — validity is the server's gate", async () => {
    // The edge never JSON-checks the input: a keyed replay of different bytes
    // must reach the server's retained-key comparison and be answered 409 even
    // when the bytes are not valid JSON for new work. A JSON check here would
    // answer the replay a 400 before its key was ever compared.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const raw = "this is not json — and it must still reach the comparison whole";
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: raw });
    expect(res.status).toBe(202);
    expect(Buffer.from(harness.forwarder.specs[0]!.body).toString()).toBe(raw);
  });

  it("grants for other servers ride the projection, scoped to the addressed one", async () => {
    const harness = buildJobsEdge({ jobs: { types: ["jobs:fetch", "other:gen"] } });
    const token = await seedSession(harness.sessions, "alice");
    await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(harness.forwarder.specs[0]!.identity.allowedTypes).toEqual(["jobs:fetch"]);
  });

  it("a valid acceptance is forwarded unchanged, no-store", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    // Odd spacing in the acceptance body: what the server sent is what the
    // caller reads.
    const oddBytes = '{"server":"jobs",  "jobId":"job-123","status":"queued"}';
    harness.forwarder.verdict = {
      kind: "accepted",
      status: 202,
      accepted: { server: "jobs", jobId: "job-123", status: "queued" },
      rawBody: new TextEncoder().encode(oddBytes),
    };
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: '{"url":"https://api.vendor.test/v1"}',
    });
    expect(res.status).toBe(202);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toBe(oddBytes);
  });

  it("a validated server refusal is forwarded with its own status and body", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const conflict = jobRequestError("idempotency_conflict", {
      status: "queued",
      error: null,
    });
    harness.forwarder.verdict = { kind: "refused", status: 409, error: conflict };
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    expect(res.status).toBe(409);
    expect(res.json).toEqual(conflict);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("an unreachable server and an invalid response both answer the retryable 503", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");

    harness.forwarder.verdict = { kind: "unreachable", error: new Error("no answer") };
    const r1 = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(r1.status).toBe(503);
    expect(isJobsError(r1.json, "jobs_unavailable")).toBe(true);
    expect(r1.headers["cache-control"]).toBe("no-store");

    harness.forwarder.verdict = { kind: "invalid_response", status: 202 };
    const r2 = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(r2.status).toBe(503);
    expect(isJobsError(r2.json, "jobs_unavailable")).toBe(true);
  });
});

describe("the retry key and the body bound", () => {
  it("reads one header value — Node joins a repeated header, and the joined string is one key", async () => {
    // Node's HTTP server joins duplicate header lines with ", " before they
    // reach any handler, so a "repeat" arrives as ONE value; the shared
    // retry-key rule is the only authority, and the receiver's signed-claim
    // comparison sees exactly the string the edge read and forwarded. The
    // deterministic reading is one key — pinned so it cannot quietly become
    // something else.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
      headers: { "idempotency-key": "a, b" },
    });
    expect(res.status).toBe(202);
    expect(harness.forwarder.specs[0]!.idempotencyKey).toBe("a, b");
  });

  it("a present-but-empty retry key is refused, never silently dropped to keyless", async () => {
    // A client that sent a key header and sent it EMPTY believes its submission
    // is keyed; treating that as "no key" would submit duplicate-able work
    // under that belief. The refusal is the honest answer.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
      headers: { "idempotency-key": "" },
    });
    expect(res.status).toBe(400);
    expect(isJobsError(res.json, "idempotency_key_invalid")).toBe(true);
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("a retry key that is whitespace-only or over 128 UTF-8 bytes is invalid", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    for (const bad of ["   ", "x".repeat(129), "é".repeat(65)]) {
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
        token,
        payload: "{}",
        headers: { "idempotency-key": bad },
      });
      expect(res.status).toBe(400);
      expect(isJobsError(res.json, "idempotency_key_invalid")).toBe(true);
    }
    expect(harness.forwarder.specs).toHaveLength(0);
    // 128 bytes exactly is valid, and a multibyte key under the byte cap rides.
    const okKey = "k".repeat(128);
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
      headers: { "idempotency-key": okKey },
    });
    expect(res.status).toBe(202);
    expect(harness.forwarder.specs[0]!.idempotencyKey).toBe(okKey);
  });

  it("a body of exactly the 64-KiB bound is accepted and forwarded whole", async () => {
    // The bound is inclusive on both paths: the declared fast-path refuses
    // only over it, and the byte counter's cap counts exactly to it.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const raw = "x".repeat(JOBS_MAX_INPUT_BYTES);
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: raw });
    expect(res.status).toBe(202);
    expect(Buffer.from(harness.forwarder.specs[0]!.body).byteLength).toBe(JOBS_MAX_INPUT_BYTES);
  });

  it("a lying content-length over the 64-KiB input bound is refused before reading", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
      headers: { "content-length": String(65_537) },
    });
    expect(res.status).toBe(413);
    expect(isJobsError(res.json, "payload_too_large")).toBe(true);
    expect(harness.forwarder.specs).toHaveLength(0);
  });

  it("a body over the cap with a lying small content-length is refused by the byte count", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const oversized = JSON.stringify({ url: "https://api.vendor.test/", pad: "x".repeat(66_000) });
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: oversized,
      headers: { "content-length": "10" },
    });
    expect(res.status).toBe(413);
    expect(isJobsError(res.json, "payload_too_large")).toBe(true);
    expect(harness.forwarder.specs).toHaveLength(0);
  });
});

describe("the route joined to the REAL forwarder (no fake in between)", () => {
  const ROOT = Buffer.alloc(32, 1).toString("base64");
  const KEY = deriveJobsInstructionKey(ROOT, "edgeToJobs");

  it("a submission through the app reaches a verifying receiver with its trusted attribution", async () => {
    // The one test where every hop is real: the route authorizes against the
    // registry and the session, the production forwarder mints and forwards
    // over a real socket, and the stand-in receiver authenticates the
    // instruction through the SHARED verifier before answering — the only
    // stand-in is the jobs service's own internals (the assembled check is
    // separate work).
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const { app, sessions } = buildEdgeApp(
      new HttpJobsForwarder([{ server: "jobs", endpoint: base, edgeToJobsKey: KEY }], {
        timeoutMs: 5_000,
      }),
      { jobsGeneration: "4" },
    );
    const token = await seedSession(sessions, "alice");
    const raw = '{"url":"https://api.vendor.test/v1"}';
    const res = await submit({ app, sessions }, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: raw,
      headers: { "idempotency-key": "retry-key-9" },
    });
    await app.close();

    expect(res.status).toBe(202);
    expect(res.headers["cache-control"]).toBe("no-store");
    // The acceptance bytes the receiver answered are what the caller read.
    expect(res.text).toBe(JSON.stringify({ server: "jobs", jobId: "job-123", status: "queued" }));
    expect(receiver.verifyFailures).toEqual([]);
    const captured = receiver.calls[0]!;
    expect(captured.claims).toMatchObject({
      server: "jobs",
      operation: "submit",
      appId: APP_ID,
      env: "prod",
      ownerKind: "user",
      ownerOid: "alice",
      allowedTypes: ["jobs:fetch"],
      type: "jobs:fetch",
      generation: "4",
      idempotencyKey: "retry-key-9",
    });
    expect(captured.presentedRetryKey).toBe("retry-key-9");
    expect(Buffer.from(captured.body).toString()).toBe(raw);
    await receiver.stop();
  });

  it("the receiver's refusal comes back as the route's own error answer", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = {
      status: 429,
      body: JSON.stringify({
        code: "jobs_capacity_exceeded",
        message: "No capacity is available to accept this job.",
      }),
    };
    const base = await receiver.start();
    const { app, sessions } = buildEdgeApp(
      new HttpJobsForwarder([{ server: "jobs", endpoint: base, edgeToJobsKey: KEY }], {
        timeoutMs: 5_000,
      }),
    );
    const token = await seedSession(sessions, "alice");
    const res = await submit({ app, sessions }, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    await app.close();
    expect(res.status).toBe(429);
    expect(isJobsError(res.json, "jobs_capacity_exceeded")).toBe(true);
    expect(res.headers["cache-control"]).toBe("no-store");
    await receiver.stop();
  });

  it("an unknown server with the REAL forwarder answers locally — nothing is dialed", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const { app, sessions } = buildEdgeApp(
      new HttpJobsForwarder([{ server: "jobs", endpoint: base, edgeToJobsKey: KEY }], {
        timeoutMs: 5_000,
      }),
    );
    const token = await seedSession(sessions, "alice");
    const res = await submit({ app, sessions }, "/_api/jobs/nosuch/types/fetch", {
      token,
      payload: "{}",
    });
    await app.close();
    expect(res.status).toBe(400);
    expect(isJobsError(res.json, "job_server_unknown")).toBe(true);
    expect(receiver.calls).toHaveLength(0);
    await receiver.stop();
  });

  it("a receiver verification failure travels as a refused 401 — the caller's session was never the problem", async () => {
    // The production-reachable key-rotation shape: the edge holds a root the
    // receiver no longer verifies with. The receiver's own 401 envelope is a
    // valid jobs error (the catalogue carries `unauthorized`), so the verdict
    // is a REFUSAL forwarded with its status — not invalid_response, not the
    // 503 uncertainty class, and not a fabricated acceptance. Nothing else in
    // the suites answers the receiver's verify-failure path.
    const OTHER_ROOT = Buffer.alloc(32, 2).toString("base64");
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const { app, sessions } = buildEdgeApp(
      new HttpJobsForwarder(
        [
          {
            server: "jobs",
            endpoint: base,
            edgeToJobsKey: deriveJobsInstructionKey(OTHER_ROOT, "edgeToJobs"),
          },
        ],
        { timeoutMs: 5_000 },
      ),
    );
    const token = await seedSession(sessions, "alice");
    const res = await submit({ app, sessions }, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    await app.close();

    expect(receiver.calls).toHaveLength(0);
    expect(receiver.verifyFailures).toHaveLength(1);
    expect(res.status).toBe(401);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(isJobsError(res.json, "unauthorized")).toBe(true);
    if (isJobsError(res.json, "unauthorized")) {
      // The fixed, sanitized catalogue message — never an echoed input.
      expect(res.json.message).toBe("The internal request is not authenticated.");
    }
    await receiver.stop();
  });
});

describe("transport-level behavior on a real socket", () => {
  it("aborts the forward when the client uploads fully and then hangs up", async () => {
    // The case the wiring's guard exists for (the same test the fetch route
    // holds for its copy of this wiring): the body arrived complete, so
    // `req.raw` never aborts and Fastify's onRequestAbort never fires — only
    // the RESPONSE's premature close marks the hang-up, and `writableEnded`
    // separates it from the route's own finished answer.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    // The forwarder holds the forward open until released, so the hang-up
    // lands while the forward is still in flight; the spec's signal is the
    // seam the real forwarder consumes.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let signalOfSpec: AbortSignal | null = null;
    const submitOnce = harness.forwarder.submit.bind(harness.forwarder);
    harness.forwarder.submit = async (spec) => {
      signalOfSpec = spec.signal;
      await held;
      return submitOnce(spec);
    };

    await withServer(harness.app, async (base) => {
      const ac = new AbortController();
      const pending = undiciRequest(`${base}/_api/jobs/jobs/types/fetch`, {
        method: "POST",
        headers: {
          host: HOST.host,
          origin: ORIGIN,
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${token}`,
        },
        body: "{}",
        signal: ac.signal,
      }).catch(() => undefined);
      await until(() => signalOfSpec !== null, "the forward to be minted");
      ac.abort();
      await pending;
      await until(() => signalOfSpec!.aborted, "the forward to be aborted");
      // Release before the harness closes the app: the handler is still
      // awaiting the held forward, and a graceful close waits for it.
      release();
      await until(() => harness.forwarder.specs.length === 1, "the forward to settle");
    });
  });

  it("refuses a body that never arrives whole — a lying content-length plus a half-close", async () => {
    // The one input class `inject` cannot produce: a request whose declared
    // length is never delivered. Over the real transport the request stream
    // errors at the premature close and the boundary refuses — 400, the
    // connection settles, and nothing is ever minted or forwarded; whichever
    // layer answers first (the request lifecycle's own error reply or the
    // route's bounded read), the answer is a refusal, never a fabricated 202.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    await withServer(harness.app, async (base) => {
      const { port } = new URL(base);
      const chunks: Buffer[] = [];
      let settled = false;
      const sock = connect({ host: "127.0.0.1", port: Number(port) }, () => {
        sock.write(
          [
            "POST /_api/jobs/jobs/types/fetch HTTP/1.1",
            `Host: ${HOST.host}`,
            `Origin: ${ORIGIN}`,
            "Sec-Fetch-Mode: cors",
            "Content-Type: application/json",
            `Cookie: ${SESSION_COOKIE}=${token}`,
            "Content-Length: 100",
            "",
            "ab",
          ].join("\r\n"),
        );
        // Half-close: 98 of the declared 100 bytes will never come.
        sock.end();
      });
      sock.on("data", (c) => chunks.push(c as Buffer));
      sock.on("close", () => (settled = true));
      sock.on("error", () => (settled = true));
      await until(() => settled, "the connection to settle");

      const answer = Buffer.concat(chunks).toString();
      expect(answer.startsWith("HTTP/1.1 400"), answer.slice(0, 60)).toBe(true);
      expect(harness.forwarder.specs).toHaveLength(0);
    });
  });
});

describe("the submission span", () => {
  it("names the surface route and carries only bounded attributes", async () => {
    const { startRecordingTelemetry } = await import("@azx-pbc/telemetry/testing");
    const recording = startRecordingTelemetry();
    try {
      const harness = buildJobsEdge();
      const token = await seedSession(harness.sessions, "alice");
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
        token,
        payload: '{"url":"https://api.vendor.test/v1"}',
        headers: { "idempotency-key": "PLANTED-RETRY-KEY" },
      });
      expect(res.status).toBe(202);

      const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_SUBMIT_EDGE);
      expect(spans.length).toBeGreaterThan(0);
      // The route is identified by its pattern — never by the request URL,
      // whose segments here are caller-chosen.
      for (const span of spans) {
        expect(span.attributes["http.route"]).toBe(ROUTE_JOBS_SUBMIT);
        expect(span.attributes["url.path"]).toBeUndefined();
        expect(span.attributes["url.full"]).toBeUndefined();
      }
      // The retry key and the submitted bytes are never on any span; the
      // ACCEPTED job id is — the join between this submission's trace and the
      // snapshot the app polls next.
      const dump = JSON.stringify(spans.map((s) => s.attributes));
      expect(dump).not.toContain("PLANTED-RETRY-KEY");
      expect(dump).not.toContain("api.vendor.test");
      expect(dump).toContain("job-123");

      // The dev surface under the SAME recording (the file's one — a second
      // recording records nothing, the ProxyTracers keep the first provider):
      // its span is its OWN surface's name and route pattern, so the
      // inventory's `.dev` row stays a real key for a per-surface dashboard.
      const devApp = await buildDevJobsEdge(new FakeJobsForwarder("jobs"));
      const devRes = await devSubmit(devApp, "dev-token-plant");
      await devApp.close();
      expect(devRes.status).toBe(202);
      const devSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_SUBMIT_DEV);
      expect(devSpans).toHaveLength(1);
      expect(devSpans[0]!.attributes["http.route"]).toBe(ROUTE_JOBS_SUBMIT_DEV);
      expect(devSpans[0]!.attributes["helix.outcome"]).toBe("accepted");
    } finally {
      await recording.restore();
    }
  });
});

describe("the dev gateway's submission route", () => {
  it("submits with the dev tier's trusted attribution (env=dev, ownerKind=dev)", async () => {
    const forwarder = new FakeJobsForwarder("jobs");
    const app = await buildDevJobsEdge(forwarder);
    const res = await devSubmit(app, DEV_BEARER);
    expect(res.status).toBe(202);
    expect(res.headers["cache-control"]).toBe("no-store");
    const spec = forwarder.specs[0]!;
    expect(spec.identity).toEqual({
      appId: DEV_APP_ID,
      env: "dev",
      ownerKind: "dev",
      ownerOid: "oid-developer",
      allowedTypes: ["jobs:fetch"],
    });
    await app.close();
  });

  it("a missing dev token gets the resolver's 401, not a jobs envelope", async () => {
    const forwarder = new FakeJobsForwarder("jobs");
    const app = await buildDevJobsEdge(forwarder);
    const res = await devSubmit(app, null);
    expect(res.status).toBe(401);
    expect(isJobsError(res.json, "forbidden")).toBe(false);
    expect(forwarder.specs).toHaveLength(0);
    await app.close();
  });

  it("the same disabled posture: a null forwarder answers 503 jobs_disabled", async () => {
    const app = await buildDevJobsEdge(null);
    const res = await devSubmit(app, DEV_BEARER);
    expect(res.status).toBe(503);
    expect(isJobsError(res.json, "jobs_disabled")).toBe(true);
    await app.close();
  });
});
