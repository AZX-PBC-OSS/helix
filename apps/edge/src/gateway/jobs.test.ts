import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { request as undiciRequest } from "undici";
import type { FastifyInstance } from "fastify";
import { SESSION_COOKIE } from "../auth/cookies.js";
import { jobRequestError, JOBS_CAPACITY_DEFAULTS, JOBS_MAX_INPUT_BYTES } from "@azx-pbc/shared";
import { HttpJobsForwarder } from "../jobs/forwarder.js";
import { deriveJobsInstructionKey } from "@azx-pbc/shared/jobsSigning";
import { JobsSubmissionThrottle } from "./jobsThrottle.js";
import { InMemoryCounterStore, type CounterStore } from "./counterStore.js";
import { buildApp } from "../app.js";
import { hashSessionToken, newSessionToken } from "../auth/sessions.js";
import { FakeJobsServiceReceiver } from "../test/jobsReceiver.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import { until, withServer } from "../test/socket.js";
import {
  buildDevJobsEdge,
  buildDisabledJobsEdge,
  buildJobsEdge,
  buildJobsEdgeApp as buildEdgeApp,
  FakeJobsForwarder,
  isJobsError,
  JOBS_APP_ID as APP_ID,
  JOBS_DEV_APP_ID as DEV_APP_ID,
  JOBS_HOST as HOST,
  JOBS_ORIGIN as ORIGIN,
  seedJobsSession as seedSession,
  type JobsHarness,
} from "../test/jobsGateway.js";
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

async function submit(
  edge: Pick<JobsHarness, "app" | "sessions">,
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

const DEV_BEARER = "dev-token-plant";
const DEV_ORIGIN = "https://myapp.lovable.app";

/** A second app in the registry, for the deployment-aggregate route test. */
const APP_B_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** `seedJobsSession` pins the harness app's id; the multi-app tests need one per appId. */
async function seedSessionFor(
  sessions: FakeSessionStore,
  appId: string,
  oid: string,
): Promise<string> {
  const id = randomUUID();
  await sessions.createPending({
    id,
    appId,
    user: { oid, displayName: oid, name: null, email: null, kind: "user", groups: [] },
    refreshDueAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const token = newSessionToken();
  await sessions.redeem(id, appId, hashSessionToken(token));
  return token;
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
  });

  it("an archived app is the 410 — before any jobs decision", async () => {
    const harness = buildJobsEdge({ archived: true });
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    expect(res.status).toBe(410);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
  });

  it("an unauthenticated caller gets the caller gate's 401, not a jobs envelope", async () => {
    const harness = buildJobsEdge();
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token: null,
      payload: "{}",
    });
    expect(res.status).toBe(401);
    expect(isJobsError(res.json, "unauthorized")).toBe(false);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
  });

  it("an app without the jobs grant is refused, and one granted another server's type too", async () => {
    const noGrant = buildJobsEdge({ jobs: null });
    const t1 = await seedSession(noGrant.sessions, "alice");
    const r1 = await submit(noGrant, "/_api/jobs/jobs/types/fetch", { token: t1, payload: "{}" });
    expect(r1.status).toBe(403);
    expect(noGrant.forwarder.submitSpecs).toHaveLength(0);

    const otherServer = buildJobsEdge({ jobs: { types: ["other:fetch"] } });
    const t2 = await seedSession(otherServer.sessions, "alice");
    const r2 = await submit(otherServer, "/_api/jobs/jobs/types/fetch", {
      token: t2,
      payload: "{}",
    });
    expect(r2.status).toBe(403);
    expect(isJobsError(r2.json, "forbidden")).toBe(true);
    expect(otherServer.forwarder.submitSpecs).toHaveLength(0);
  });

  it("a type that is not a type is one no grant can cover — 403, nothing forwarded", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/Fetch%2Fx", {
      token,
      payload: "{}",
    });
    expect(res.status).toBe(403);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
  });
});

describe("submission reachability", () => {
  it("an unknown server answers 400 job_server_unknown, forwarding nothing", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/nosuch/types/fetch", { token, payload: "{}" });
    expect(res.status).toBe(400);
    expect(isJobsError(res.json, "job_server_unknown")).toBe(true);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
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
    expect(harness.forwarder.submitSpecs).toHaveLength(1);
    const spec = harness.forwarder.submitSpecs[0]!;
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
    expect(Buffer.from(harness.forwarder.submitSpecs[0]!.body).toString()).toBe(raw);
  });

  it("grants for other servers ride the projection, scoped to the addressed one", async () => {
    const harness = buildJobsEdge({ jobs: { types: ["jobs:fetch", "other:gen"] } });
    const token = await seedSession(harness.sessions, "alice");
    await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(harness.forwarder.submitSpecs[0]!.identity.allowedTypes).toEqual(["jobs:fetch"]);
  });

  it("a valid acceptance is forwarded unchanged, no-store", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    // Odd spacing in the acceptance body: what the server sent is what the
    // caller reads.
    const oddBytes = '{"server":"jobs",  "jobId":"job-123","status":"queued"}';
    harness.forwarder.submitVerdict = {
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
    harness.forwarder.submitVerdict = { kind: "refused", status: 409, error: conflict };
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

    harness.forwarder.submitVerdict = { kind: "unreachable", error: new Error("no answer") };
    const r1 = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(r1.status).toBe(503);
    expect(isJobsError(r1.json, "jobs_unavailable")).toBe(true);
    expect(r1.headers["cache-control"]).toBe("no-store");

    harness.forwarder.submitVerdict = { kind: "invalid_response", status: 202 };
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
    expect(harness.forwarder.submitSpecs[0]!.idempotencyKey).toBe("a, b");
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
    // 128 bytes exactly is valid, and a multibyte key under the byte cap rides.
    const okKey = "k".repeat(128);
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
      headers: { "idempotency-key": okKey },
    });
    expect(res.status).toBe(202);
    expect(harness.forwarder.submitSpecs[0]!.idempotencyKey).toBe(okKey);
  });

  it("a body of exactly the 64-KiB bound is accepted and forwarded whole", async () => {
    // The bound is inclusive on both paths: the declared fast-path refuses
    // only over it, and the byte counter's cap counts exactly to it.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const raw = "x".repeat(JOBS_MAX_INPUT_BYTES);
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: raw });
    expect(res.status).toBe(202);
    expect(Buffer.from(harness.forwarder.submitSpecs[0]!.body).byteLength).toBe(
      JOBS_MAX_INPUT_BYTES,
    );
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
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
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
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

describe("the submission buckets and the recorded requests", () => {
  /** The per-app/env window's allowance, as the platform defaults set it. */
  const APP_WINDOW = JOBS_CAPACITY_DEFAULTS.submissionAttemptsPerAppEnv;

  it("an exhausted window refuses submission with 429 rate_limited, forwarding nothing", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    for (let i = 0; i < APP_WINDOW; i += 1) {
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
      expect(res.status).toBe(202);
    }
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(res.status).toBe(429);
    expect(isJobsError(res.json, "rate_limited")).toBe(true);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(harness.forwarder.submitSpecs).toHaveLength(APP_WINDOW);
  });

  it("both windows span the configured servers — another prefix adds no allowance", async () => {
    const harness = buildJobsEdge({
      forwarder: new FakeJobsForwarder("jobs", "other"),
      jobs: { types: ["jobs:fetch", "other:fetch"] },
    });
    const token = await seedSession(harness.sessions, "alice");
    for (let i = 0; i < APP_WINDOW; i += 1) {
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
      expect(res.status).toBe(202);
    }
    // The bucket key carries no server: the "other" prefix's first submission
    // is already the window's (N+1)th attempt for this app and environment.
    const res = await submit(harness, "/_api/jobs/other/types/fetch", { token, payload: "{}" });
    expect(res.status).toBe(429);
    expect(isJobsError(res.json, "rate_limited")).toBe(true);
  });

  it("invalid, refused and uncertain attempts are charged, like replays — no refund", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const acceptedVerdict = harness.forwarder.submitVerdict;
    // Four refusals that never mint an instruction, each still charged: an
    // unknown server (the bump precedes server resolution), an invalid key,
    // and an uncertain ending.
    const unknown = await submit(harness, "/_api/jobs/nosuch/types/fetch", {
      token,
      payload: "{}",
    });
    expect(unknown.status).toBe(400);
    const badKey = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
      headers: { "idempotency-key": "" },
    });
    expect(badKey.status).toBe(400);
    harness.forwarder.submitVerdict = { kind: "unreachable", error: new Error("no answer") };
    const uncertain = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    expect(uncertain.status).toBe(503);
    harness.forwarder.submitVerdict = acceptedVerdict;
    for (let i = 0; i < APP_WINDOW - 3; i += 1) {
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
      expect(res.status).toBe(202);
    }
    const exhausted = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: "{}",
    });
    expect(exhausted.status).toBe(429);
    expect(isJobsError(exhausted.json, "rate_limited")).toBe(true);
  });

  it("a keyed replay consumes allowance like any other attempt", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    for (let i = 0; i < APP_WINDOW; i += 1) {
      // The same key and bytes each time: every one is a recorded request, and
      // every one is an attempt.
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
        token,
        payload: '{"url":"https://api.vendor.test/v1"}',
        headers: { "idempotency-key": "same-key" },
      });
      expect(res.status).toBe(202);
    }
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: '{"url":"https://api.vendor.test/v1"}',
      headers: { "idempotency-key": "same-key" },
    });
    expect(res.status).toBe(429);
  });

  it("status/result/cancel retain their ordinary controls — never the submission buckets", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    for (let i = 0; i < APP_WINDOW; i += 1) {
      await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    }
    const poll = await harness.app.inject({
      method: "GET",
      url: "/_api/jobs/jobs/job-123",
      headers: { host: HOST.host, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(poll.statusCode).toBe(200);
    const cancel = await harness.app.inject({
      method: "DELETE",
      url: "/_api/jobs/jobs/job-123",
      headers: { host: HOST.host, cookie: `${SESSION_COOKIE}=${token}`, origin: ORIGIN },
    });
    expect(cancel.statusCode).toBe(202);
  });

  it("shared-password refusals are not charged — they are not authenticated jobs principals", async () => {
    const harness = buildJobsEdge();
    // A shared-password visitor resolves authenticated-but-ineligible: the
    // jobs authorization check refuses 403, and the attempt never reaches the
    // buckets — the caller the platform does not attribute jobs to buys no
    // window (and drains none).
    const pwToken = await seedSession(harness.sessions, "pw-visitor-oid", "password");
    for (let i = 0; i < APP_WINDOW; i += 1) {
      const anon = await submit(harness, "/_api/jobs/jobs/types/fetch", {
        token: pwToken,
        payload: "{}",
      });
      expect(anon.status).toBe(403);
    }
    // The window is still empty: the full allowance is there for the
    // authenticated principal jobs is for.
    const token = await seedSession(harness.sessions, "alice");
    for (let i = 0; i < APP_WINDOW; i += 1) {
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
      expect(res.status).toBe(202);
    }
  });

  it("a disabled attempt is neither charged nor recorded", async () => {
    // One throttle shared by BOTH builds, keyed on the same app and env: if
    // the disabled 503 consumed anything, the enabled build's window would be
    // short by one.
    const sharedThrottle = new JobsSubmissionThrottle(
      new InMemoryCounterStore(),
      JOBS_CAPACITY_DEFAULTS,
    );
    const disabled = buildDisabledJobsEdge({ jobsSubmissionThrottle: sharedThrottle });
    const token = await seedSession(disabled.sessions, "alice");
    const gone = await submit(disabled, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(gone.status).toBe(503);

    const harness = buildJobsEdge({ jobsSubmissionThrottle: sharedThrottle });
    const token2 = await seedSession(harness.sessions, "alice");
    for (let i = 0; i < APP_WINDOW; i += 1) {
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
        token: token2,
        payload: "{}",
      });
      expect(res.status).toBe(202);
    }
  });

  it("records each counted attempt once — acceptance, replay, and refusals with their catalogue code", async () => {
    const usage = new FakeUsageStore();
    const harness = buildJobsEdge({ usage });
    const token = await seedSession(harness.sessions, "alice");
    const payload = '{"url":"https://api.vendor.test/v1"}';
    await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload,
      headers: { "idempotency-key": "k1" },
    });
    await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload,
      headers: { "idempotency-key": "k1" },
    });
    const conflict = jobRequestError("idempotency_conflict", { status: "queued", error: null });
    harness.forwarder.submitVerdict = { kind: "refused", status: 409, error: conflict };
    await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload });

    expect(usage.records).toHaveLength(3);
    for (const row of usage.records) {
      expect(row).toMatchObject({
        appId: APP_ID,
        env: "prod",
        userOid: "alice",
        userKind: "user",
        capability: "jobs",
        model: "jobs:fetch",
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    // The replays are recorded REQUESTS: a second `ok`, never a unique-job claim.
    expect(usage.records[0]).toMatchObject({ outcome: "ok", statusCode: 202, errorDetail: null });
    expect(usage.records[1]).toMatchObject({ outcome: "ok", statusCode: 202 });
    expect(usage.records[2]).toMatchObject({
      outcome: "conflict",
      statusCode: 409,
      errorDetail: "idempotency_conflict",
    });
    // The retry key never rides the row.
    expect(JSON.stringify(usage.records)).not.toContain("k1");
  });

  it("maps the server's refusals onto the ledger's own outcome vocabulary", async () => {
    const usage = new FakeUsageStore();
    const harness = buildJobsEdge({ usage });
    const token = await seedSession(harness.sessions, "alice");
    const cases: {
      status: number;
      code: "forbidden" | "jobs_capacity_exceeded" | "payload_invalid" | "jobs_unavailable";
      outcome: string;
    }[] = [
      { status: 403, code: "forbidden", outcome: "forbidden" },
      { status: 429, code: "jobs_capacity_exceeded", outcome: "quota_blocked" },
      { status: 400, code: "payload_invalid", outcome: "refusal" },
      { status: 503, code: "jobs_unavailable", outcome: "error" },
    ];
    for (const c of cases) {
      harness.forwarder.submitVerdict = {
        kind: "refused",
        status: c.status,
        error: jobRequestError(c.code),
      };
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
      expect(res.status).toBe(c.status);
    }
    expect(usage.records.map((r) => r.outcome)).toEqual(cases.map((c) => c.outcome));
    expect(usage.records.map((r) => r.statusCode)).toEqual(cases.map((c) => c.status));
    expect(usage.records.map((r) => r.errorDetail)).toEqual(cases.map((c) => c.code));
  });

  it("an uncertain ending records a request failure — never proof about the job", async () => {
    const usage = new FakeUsageStore();
    const harness = buildJobsEdge({ usage });
    const token = await seedSession(harness.sessions, "alice");
    harness.forwarder.submitVerdict = { kind: "unreachable", error: new Error("no answer") };
    await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(usage.records[0]).toMatchObject({
      outcome: "error",
      statusCode: 503,
      errorDetail: "unreachable",
    });
    // The row measured a round trip; a duration was carried (any non-negative one).
    expect(usage.records[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("a ledger write failure never changes acceptance", async () => {
    const usage = new FakeUsageStore();
    usage.record = async () => {
      throw new Error("the ledger is down");
    };
    const harness = buildJobsEdge({ usage });
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", {
      token,
      payload: '{"url":"https://api.vendor.test/v1"}',
    });
    // The acceptance is forwarded unchanged — the best-effort write is
    // nobody's gate.
    expect(res.status).toBe(202);
    expect(res.json).toEqual({ server: "jobs", jobId: "job-123", status: "queued" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("the throttle refusals' rows are bounded — a flood cannot fill the ledger", async () => {
    const usage = new FakeUsageStore();
    const harness = buildJobsEdge({ usage });
    const token = await seedSession(harness.sessions, "alice");
    // Drain the window, then keep hammering: every 429 after the first
    // DENIAL_MAX refuses writes nothing. The first in-window rows plus the
    // denial budget's rows are the whole flood's audit trail.
    const DENIAL_MAX = 20; // the DenialThrottle default the route composes
    for (let i = 0; i < APP_WINDOW + DENIAL_MAX + 25; i += 1) {
      await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    }
    const refused = usage.records.filter((r) => r.outcome === "quota_blocked");
    expect(refused).toHaveLength(DENIAL_MAX);
    for (const row of refused) {
      expect(row).toMatchObject({
        statusCode: 429,
        errorDetail: "rate_limited",
        model: "jobs:fetch",
      });
    }
    // The in-window rows are the acceptance-era ones: one row per counted attempt.
    expect(usage.records).toHaveLength(APP_WINDOW + DENIAL_MAX);
  });

  it("records nothing when no ledger is wired, and nothing for a disabled attempt", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(harness.usage).toBeNull();

    const usage = new FakeUsageStore();
    const disabled = buildDisabledJobsEdge({ usage });
    const disabledToken = await seedSession(disabled.sessions, "alice");
    await submit(disabled, "/_api/jobs/jobs/types/fetch", { token: disabledToken, payload: "{}" });
    expect(usage.records).toEqual([]);
  });

  it("the reference operations are not ledger rows — submissions only", async () => {
    // ADR-0004's semantics are submission-specific; per-poll rows would flood
    // an append-only table the design never budgets for. The poll, result read
    // and cancellation keep their spans and ordinary request controls — and
    // write nothing, in their success and failure endings alike, even with the
    // ledger wired.
    const usage = new FakeUsageStore();
    const harness = buildJobsEdge({ usage });
    const token = await seedSession(harness.sessions, "alice");
    await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(usage.records).toHaveLength(1);

    const poll = await harness.app.inject({
      method: "GET",
      url: "/_api/jobs/jobs/job-123",
      headers: { host: HOST.host, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(poll.statusCode).toBe(200);
    const result = await harness.app.inject({
      method: "GET",
      url: "/_api/jobs/jobs/job-123/result",
      headers: { host: HOST.host, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(result.statusCode).toBe(200);
    const cancel = await harness.app.inject({
      method: "DELETE",
      url: "/_api/jobs/jobs/job-123",
      headers: { host: HOST.host, cookie: `${SESSION_COOKIE}=${token}`, origin: ORIGIN },
    });
    expect(cancel.statusCode).toBe(202);
    expect(usage.records).toHaveLength(1);

    // The failed observation writes nothing either — an uncertain ending is
    // not a submission attempt.
    harness.forwarder.snapshotVerdict = { kind: "unreachable", error: new Error("no answer") };
    const failedPoll = await harness.app.inject({
      method: "GET",
      url: "/_api/jobs/jobs/job-123",
      headers: { host: HOST.host, cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(failedPoll.statusCode).toBe(503);
    expect(usage.records).toHaveLength(1);
  });

  it("the local refusals record their rows in the shared vocabulary too", async () => {
    // The forwarded refusals' mapping is pinned above; these are the refusals
    // the edge answers before any forward exists — same ledger row shape, same
    // vocabulary, the requested `server:type` in the model column (bounded,
    // caller-chosen: the column's established trust level for app-controlled
    // content).
    const usage = new FakeUsageStore();
    const harness = buildJobsEdge({ usage });
    const token = await seedSession(harness.sessions, "alice");
    const cases: {
      url: string;
      headers?: Record<string, string>;
      status: number;
      outcome: string;
      errorDetail: string;
      model: string;
    }[] = [
      {
        // The bump precedes server resolution: the row carries what the caller
        // asked for, valid or not.
        url: "/_api/jobs/nosuch/types/fetch",
        status: 400,
        outcome: "refusal",
        errorDetail: "job_server_unknown",
        model: "nosuch:fetch",
      },
      {
        url: "/_api/jobs/jobs/types/fetch",
        headers: { "idempotency-key": "" },
        status: 400,
        outcome: "refusal",
        errorDetail: "idempotency_key_invalid",
        model: "jobs:fetch",
      },
      {
        url: "/_api/jobs/jobs/types/Fetch%2Fx",
        status: 403,
        outcome: "forbidden",
        errorDetail: "forbidden",
        model: "jobs:Fetch/x",
      },
      {
        url: "/_api/jobs/jobs/types/fetch",
        headers: { "content-length": String(65_537) },
        status: 413,
        outcome: "refusal",
        errorDetail: "payload_too_large",
        model: "jobs:fetch",
      },
    ];
    for (const c of cases) {
      const res = await submit(harness, c.url, { token, payload: "{}", headers: c.headers });
      expect(res.status, c.errorDetail).toBe(c.status);
    }
    expect(usage.records.map((r) => [r.outcome, r.statusCode, r.errorDetail, r.model])).toEqual(
      cases.map((c) => [c.outcome, c.status, c.errorDetail, c.model]),
    );
  });

  it("a second app is refused by the deployment window at the route — the aggregate is shared", async () => {
    // The route's whole contribution to the deployment aggregate is the two
    // values it hands `consume` (`entry.appId`, `caller.env`); the bucket
    // arithmetic for it is unit-pinned, but only a second ROUTE-level app
    // proves the aggregate is really deployment-wide — a route that charged
    // the deployment bucket per app (or stopped charging it at all) passes
    // every single-app test.
    const sharedThrottle = new JobsSubmissionThrottle(new InMemoryCounterStore(), {
      ...JOBS_CAPACITY_DEFAULTS,
      submissionAttemptsPerAppEnv: 10,
      submissionAttemptsDeployment: 3,
    });
    const sessions = new FakeSessionStore();
    const forwarder = new FakeJobsForwarder("jobs");
    const app = buildApp({
      config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
      registry: new FakeRegistry([
        registryEntry({
          appId: APP_ID,
          slug: "demo",
          blobPrefix: "apps/a/1/",
          visibilityMode: "internal",
          jobs: { types: ["jobs:fetch"] },
        }),
        registryEntry({
          appId: APP_B_ID,
          slug: "demo2",
          blobPrefix: "apps/b/1/",
          visibilityMode: "internal",
          jobs: { types: ["jobs:fetch"] },
        }),
      ]),
      blob: new FakeBlobReader(),
      sessions,
      oidc: new FakeOidcClient(),
      jobsForwarder: forwarder,
      jobsSubmissionThrottle: sharedThrottle,
    });
    const tokenA = await seedSessionFor(sessions, APP_ID, "alice");
    for (let i = 0; i < 3; i += 1) {
      const res = await submit({ app, sessions }, "/_api/jobs/jobs/types/fetch", {
        token: tokenA,
        payload: "{}",
      });
      expect(res.status).toBe(202);
    }
    // app-b's own window is empty; only the aggregate app-a filled refuses it.
    const tokenB = await seedSessionFor(sessions, APP_B_ID, "bob");
    const res = await submit({ app, sessions }, "/_api/jobs/jobs/types/fetch", {
      token: tokenB,
      payload: "{}",
      headers: { host: "demo2.local.helix.azxlabs.io" },
      origin: "https://demo2.local.helix.azxlabs.io:8080",
    });
    expect(res.status).toBe(429);
    expect(isJobsError(res.json, "rate_limited")).toBe(true);
    // The refusal forwarded nothing: the three forwards are all app-a's.
    expect(forwarder.submitSpecs).toHaveLength(3);
    for (const spec of forwarder.submitSpecs) {
      expect(spec.identity.appId).toBe(APP_ID);
    }
  });

  it("a counter-store failure at the buckets fails closed — the forward never happens", async () => {
    // The gate cannot complete when the counter store is down: the request
    // must be refused (fail closed), never admitted past a gate that did not
    // answer — and nothing is minted or recorded on the way out.
    const failingStore: CounterStore = {
      bump: async () => {
        throw new Error("the counter store is down");
      },
      reset: async () => {},
      sweep: async () => {},
      close: async () => {},
    };
    const usage = new FakeUsageStore();
    const harness = buildJobsEdge({
      usage,
      jobsSubmissionThrottle: new JobsSubmissionThrottle(failingStore, JOBS_CAPACITY_DEFAULTS),
    });
    const token = await seedSession(harness.sessions, "alice");
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(res.status).toBe(500);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
    expect(usage.records).toHaveLength(0);
  });

  it("a partial bucket failure fails closed and the charge it made stands", async () => {
    // The two windows are two store statements: the second can fail after the
    // first charged. The request must still refuse with nothing forwarded, and
    // whichever charge landed is not refunded — the next attempt finds a
    // window spent. Both limits are 1, so the 429 lands whichever window the
    // failed attempt charged (and a rollback would answer 202 instead).
    const inner = new InMemoryCounterStore();
    let bumps = 0;
    const partiallyFailingStore: CounterStore = {
      bump: (key, windowMs) => {
        bumps += 1;
        if (bumps === 2) return Promise.reject(new Error("the counter store is down"));
        return inner.bump(key, windowMs);
      },
      reset: (key) => inner.reset(key),
      sweep: () => inner.sweep(),
      close: () => inner.close(),
    };
    const usage = new FakeUsageStore();
    const harness = buildJobsEdge({
      usage,
      jobsSubmissionThrottle: new JobsSubmissionThrottle(partiallyFailingStore, {
        ...JOBS_CAPACITY_DEFAULTS,
        submissionAttemptsPerAppEnv: 1,
        submissionAttemptsDeployment: 1,
      }),
    });
    const token = await seedSession(harness.sessions, "alice");
    const first = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(first.status).toBe(500);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
    expect(usage.records).toHaveLength(0);
    const second = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(second.status).toBe(429);
    expect(isJobsError(second.json, "rate_limited")).toBe(true);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
  });

  it("the window is exact under concurrent submissions — the decision rides the post-increment count", async () => {
    // A check-then-act refactor (read the count, then decide, then increment)
    // admits past the window only when attempts overlap; the atomic bump
    // makes exactly the window's worth of accepts land however the requests
    // interleave.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const results = await Promise.all(
      Array.from({ length: APP_WINDOW + 7 }, () =>
        submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" }),
      ),
    );
    const accepted = results.filter((r) => r.status === 202);
    const limited = results.filter((r) => r.status === 429);
    expect(accepted).toHaveLength(APP_WINDOW);
    expect(limited).toHaveLength(7);
    for (const r of limited) {
      expect(isJobsError(r.json, "rate_limited")).toBe(true);
    }
    expect(harness.forwarder.submitSpecs).toHaveLength(APP_WINDOW);
  });

  it("the config-resolved submission limits reach the composition's own throttle", async () => {
    // No injected throttle: the fallback construction inside buildApp is what
    // must consume `config.jobs.submissionLimits` (EDGE_JOBS_LIMITS's
    // resolution), so a wiring that silently fell back to the platform
    // defaults would answer 202 here.
    const harness = buildJobsEdge({
      submissionLimits: { ...JOBS_CAPACITY_DEFAULTS, submissionAttemptsPerAppEnv: 2 },
    });
    const token = await seedSession(harness.sessions, "alice");
    for (let i = 0; i < 2; i += 1) {
      const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
      expect(res.status).toBe(202);
    }
    const res = await submit(harness, "/_api/jobs/jobs/types/fetch", { token, payload: "{}" });
    expect(res.status).toBe(429);
    expect(isJobsError(res.json, "rate_limited")).toBe(true);
    expect(harness.forwarder.submitSpecs).toHaveLength(2);
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
      await until(() => harness.forwarder.submitSpecs.length === 1, "the forward to settle");
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
      expect(harness.forwarder.submitSpecs).toHaveLength(0);
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
    const spec = forwarder.submitSpecs[0]!;
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
    expect(forwarder.submitSpecs).toHaveLength(0);
    await app.close();
  });

  it("the same disabled posture: a null forwarder answers 503 jobs_disabled", async () => {
    const app = await buildDevJobsEdge(null);
    const res = await devSubmit(app, DEV_BEARER);
    expect(res.status).toBe(503);
    expect(isJobsError(res.json, "jobs_disabled")).toBe(true);
    await app.close();
  });

  it("the config-resolved submission limits reach the dev composition's own throttle", async () => {
    // The dev gateway constructs its throttle inside buildDevGateway with no
    // injection seam — the config is the only way limits reach it, so the
    // route is the proof that the wiring holds on this composition too.
    const forwarder = new FakeJobsForwarder("jobs");
    const app = await buildDevJobsEdge(forwarder, {
      submissionLimits: { ...JOBS_CAPACITY_DEFAULTS, submissionAttemptsPerAppEnv: 2 },
    });
    for (let i = 0; i < 2; i += 1) {
      const res = await devSubmit(app, DEV_BEARER);
      expect(res.status).toBe(202);
    }
    const res = await devSubmit(app, DEV_BEARER);
    expect(res.status).toBe(429);
    expect(isJobsError(res.json, "rate_limited")).toBe(true);
    expect(forwarder.submitSpecs).toHaveLength(2);
    await app.close();
  });
});
