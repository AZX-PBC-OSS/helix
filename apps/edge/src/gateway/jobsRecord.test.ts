import { describe, expect, it } from "vitest";
import { request as undiciRequest } from "undici";
import { jobRequestError, type JobSnapshot } from "@azx-pbc/shared";
import { HttpJobsForwarder } from "../jobs/forwarder.js";
import { deriveJobsInstructionKey } from "@azx-pbc/shared/jobsSigning";
import { FakeJobsServiceReceiver } from "../test/jobsReceiver.js";
import { withServer } from "../test/socket.js";
import {
  buildDevJobsEdge,
  buildDisabledJobsEdge,
  buildJobsEdge,
  buildJobsEdgeApp,
  FakeJobsForwarder,
  isJobsError,
  JOBS_APP_ID as APP_ID,
  JOBS_DEV_APP_ID as DEV_APP_ID,
  JOBS_DEV_BEARER as DEV_BEARER,
  JOBS_DEV_ORIGIN as DEV_ORIGIN,
  JOBS_HOST as HOST,
  JOBS_ORIGIN as ORIGIN,
  seedJobsSession as seedSession,
} from "../test/jobsGateway.js";
import { SESSION_COOKIE } from "../auth/cookies.js";
import {
  ROUTE_JOBS_CANCEL,
  ROUTE_JOBS_CANCEL_DEV,
  ROUTE_JOBS_RESULT,
  ROUTE_JOBS_RESULT_DEV,
  ROUTE_JOBS_SNAPSHOT,
  ROUTE_JOBS_SNAPSHOT_DEV,
  SPAN_JOBS_CANCEL_EDGE,
  SPAN_JOBS_CANCEL_DEV,
  SPAN_JOBS_RESULT_EDGE,
  SPAN_JOBS_RESULT_DEV,
  SPAN_JOBS_SNAPSHOT_EDGE,
  SPAN_JOBS_SNAPSHOT_DEV,
} from "@azx-pbc/shared/telemetry";

/**
 * The app-facing jobs reference routes — poll, result read, cancellation —
 * on both serving surfaces. The submission route's decisions are pinned in
 * `jobs.test.ts`; these routes share its gate sequence and forwarding seam,
 * so what is pinned here is what is DIFFERENT about them: the reference
 * routing (the `{server, jobId}` pair, an unknown server reading as the
 * unknown-job 404), the forwarded grants governing the receiver's own
 * enforcement, the schema-conformant success responses, the cancellation's
 * CSRF seam, and the polls' no-origin-check read posture.
 */

const SNAPSHOT: JobSnapshot = {
  server: "jobs",
  jobId: "job-123",
  type: "jobs:fetch",
  status: "running",
  attempt: 1,
  progress: { step: 1, of: 2, label: "halfway" },
  cancellationRequested: false,
  resultExpiresAt: null,
  recordExpiresAt: null,
  error: null,
};

interface Res {
  status: number;
  text: string;
  json: unknown;
  headers: Record<string, unknown>;
}

type InjectableApp = {
  inject(args: {
    method: string;
    url: string;
    headers: Record<string, string>;
  }): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }>;
};

function isSnapshot(value: unknown): value is JobSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { server?: unknown }).server === "jobs" &&
    (value as { jobId?: unknown }).jobId === "job-123" &&
    (value as { type?: unknown }).type === "jobs:fetch"
  );
}

async function get(
  app: InjectableApp,
  url: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await app.inject({
    method: "GET",
    url,
    headers: {
      host: HOST.host,
      "sec-fetch-mode": "cors",
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      ...headers,
    },
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

async function cancel(
  app: InjectableApp,
  url: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<Res> {
  const res = await app.inject({
    method: "DELETE",
    url,
    headers: {
      host: HOST.host,
      "sec-fetch-mode": "cors",
      // A browser's DELETE always carries Origin — the CSRF seam fails
      // closed without it, so the harness sends the same-origin one.
      origin: ORIGIN,
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      ...headers,
    },
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

describe("the reference routes' gates keep their existing responses", () => {
  it("an unknown app is the plain-text 404; an archived app the 410; a stale registry the serving 503", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");

    const unknownApp = await get(harness.app, "/_api/jobs/jobs/job-123", token, {
      host: "nosuch.local.helix.azxlabs.io",
    });
    expect(unknownApp.status).toBe(404);
    expect(unknownApp.text).toContain("Not found");

    const archived = buildJobsEdge({ archived: true });
    const archivedToken = await seedSession(archived.sessions, "alice");
    const archivedRes = await get(archived.app, "/_api/jobs/jobs/job-123", archivedToken);
    expect(archivedRes.status).toBe(410);
    expect(archived.forwarder.recordSpecs).toHaveLength(0);

    const stale = buildJobsEdge({ loaded: false });
    const staleToken = await seedSession(stale.sessions, "alice");
    const staleRes = await get(stale.app, "/_api/jobs/jobs/job-123", staleToken);
    expect(staleRes.status).toBe(503);
    expect(isJobsError(staleRes.json, "jobs_disabled")).toBe(false);
  });

  it("an unauthenticated poll gets the caller gate's 401, and an anonymous one the jobs check's 403", async () => {
    const harness = buildJobsEdge();
    const noSession = await get(harness.app, "/_api/jobs/jobs/job-123", null);
    expect(noSession.status).toBe(401);
    expect(isJobsError(noSession.json, "forbidden")).toBe(false);

    const publicApp = buildJobsEdge({ visibilityMode: "public" });
    const anon = await get(publicApp.app, "/_api/jobs/jobs/job-123", null);
    expect(anon.status).toBe(403);
    expect(isJobsError(anon.json, "forbidden")).toBe(true);
  });

  it("a shared-password principal is refused the jobs check's 403 on every reference route", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "pw-visitor-oid", "password");
    expect((await get(harness.app, "/_api/jobs/jobs/job-123", token)).status).toBe(403);
    expect((await get(harness.app, "/_api/jobs/jobs/job-123/result", token)).status).toBe(403);
    expect((await cancel(harness.app, "/_api/jobs/jobs/job-123", token)).status).toBe(403);
  });
});

describe("reference routing", () => {
  it("an unknown server reads the same 404 job_not_found as an unknown job — never the submission's 400", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    for (const url of ["/_api/jobs/nosuch/job-123", "/_api/jobs/nosuch/job-123/result"]) {
      const res = await get(harness.app, url, token);
      expect(res.status, url).toBe(404);
      expect(isJobsError(res.json, "job_not_found"), url).toBe(true);
    }
    const cancelled = await cancel(harness.app, "/_api/jobs/nosuch/job-123", token);
    expect(cancelled.status).toBe(404);
    expect(isJobsError(cancelled.json, "job_not_found")).toBe(true);
    expect(harness.forwarder.submitSpecs).toHaveLength(0);
    expect(harness.forwarder.recordSpecs).toHaveLength(0);
  });

  it("a fully disabled installation answers 503 jobs_disabled on every reference route", async () => {
    const harness = buildDisabledJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    expect((await get(harness.app, "/_api/jobs/jobs/job-123", token)).status).toBe(503);
    expect((await get(harness.app, "/_api/jobs/jobs/job-123/result", token)).status).toBe(503);
    expect((await cancel(harness.app, "/_api/jobs/jobs/job-123", token)).status).toBe(503);
  });

  it("a job id that is not a job id reads the unknown-job 404 and never mints an instruction", async () => {
    // The signed resource binding cannot carry an id the grammar refuses —
    // and a malformed reference names no job on any server. An id over the
    // grammar's 128 characters never even reaches the handler: Fastify's
    // maxParamLength (set to the grammar's bound) refuses it 414 first.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    for (const bad of ["not_a_job!", "fetch/x"]) {
      const res = await get(harness.app, `/_api/jobs/jobs/${encodeURIComponent(bad)}`, token);
      expect(res.status, bad).toBe(404);
      expect(isJobsError(res.json, "job_not_found"), bad).toBe(true);
    }
    // Over the grammar's 128 characters the router itself refuses to match
    // (its maxParamLength) — the plain not-found, still never an instruction.
    const oversized = await get(harness.app, `/_api/jobs/jobs/${"x".repeat(129)}`, token);
    expect(oversized.status).toBe(404);
    expect(harness.forwarder.recordSpecs).toHaveLength(0);
  });

  it("a job id of exactly the grammar's 128 characters routes — the reference grammar's bound", async () => {
    // The maxParamLength the routes set is the grammar's own bound, not a
    // second limit: an id that parses must reach the forward.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const longest = "j".repeat(128);
    const res = await get(harness.app, `/_api/jobs/jobs/${longest}`, token);
    expect(res.status).toBe(200);
    expect(harness.forwarder.recordSpecs[0]!.jobId).toBe(longest);
  });

  it("forwards the trusted owner and the CURRENT grants for the server's own enforcement", async () => {
    // The edge decides nothing about a record's type or ownership — it binds
    // its resolution (env from the surface, oid from the session) and the
    // projection's current server-scoped grant set into the instruction.
    const harness = buildJobsEdge({
      jobsGeneration: "7",
      jobs: { types: ["jobs:fetch", "other:gen"] },
    });
    const token = await seedSession(harness.sessions, "alice");
    await get(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(harness.forwarder.recordSpecs).toHaveLength(1);
    const spec = harness.forwarder.recordSpecs[0]!;
    expect(spec.operation).toBe("snapshot");
    expect(spec.server).toBe("jobs");
    expect(spec.jobId).toBe("job-123");
    expect(spec.identity).toEqual({
      appId: APP_ID,
      env: "prod",
      ownerKind: "user",
      ownerOid: "alice",
      allowedTypes: ["jobs:fetch"],
    });

    // An app with NO grant forwards an empty set — the receiver's 403 is the
    // revocation answer, and the edge neither guesses it locally nor widens it.
    const noGrant = buildJobsEdge({ jobs: null });
    const noGrantToken = await seedSession(noGrant.sessions, "alice");
    await get(noGrant.app, "/_api/jobs/jobs/job-123", noGrantToken);
    expect(noGrant.forwarder.recordSpecs[0]!.identity.allowedTypes).toEqual([]);
  });

  it("equal ids on different servers never alias — each route names its own server", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    await get(harness.app, "/_api/jobs/other/job-123", token);
    // "other" is not configured — the 404, and nothing forwarded to "jobs".
    expect(harness.forwarder.recordSpecs).toHaveLength(0);
  });
});

describe("the poll's success and failure responses", () => {
  it("a validated snapshot is forwarded unchanged, no-store", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    // Odd spacing in the snapshot body: what the server sent is what the
    // caller reads — never a re-serialization of the parsed value.
    const oddBytes = JSON.stringify(SNAPSHOT).replace('{"server"', '{ "server"');
    harness.forwarder.snapshotVerdict = {
      kind: "found",
      status: 200,
      snapshot: SNAPSHOT,
      rawBody: new TextEncoder().encode(oddBytes),
    };
    const res = await get(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toBe(oddBytes);
    expect(isSnapshot(res.json)).toBe(true);
  });

  it("the receiver's refusals are forwarded with their own statuses — the foreign job's 404, the lapsed grant's 403", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");

    harness.forwarder.snapshotVerdict = {
      kind: "refused",
      status: 404,
      error: jobRequestError("job_not_found"),
    };
    const notFound = await get(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(notFound.status).toBe(404);
    expect(isJobsError(notFound.json, "job_not_found")).toBe(true);

    harness.forwarder.snapshotVerdict = {
      kind: "refused",
      status: 403,
      error: jobRequestError("forbidden"),
    };
    const forbidden = await get(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(forbidden.status).toBe(403);
    expect(isJobsError(forbidden.json, "forbidden")).toBe(true);
    expect(forbidden.headers["cache-control"]).toBe("no-store");
  });

  it("an unreachable server and an invalid response both answer the retryable 503 — never a fabricated snapshot", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");

    harness.forwarder.snapshotVerdict = { kind: "unreachable", error: new Error("no answer") };
    const unreachable = await get(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(unreachable.status).toBe(503);
    expect(isJobsError(unreachable.json, "jobs_unavailable")).toBe(true);
    expect(unreachable.headers["cache-control"]).toBe("no-store");

    harness.forwarder.snapshotVerdict = { kind: "invalid_response", status: 200 };
    const invalid = await get(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(invalid.status).toBe(503);
    expect(isJobsError(invalid.json, "jobs_unavailable")).toBe(true);
    // Not a 404: a failed poll must never read as a missing job.
    expect(isJobsError(invalid.json, "job_not_found")).toBe(false);
  });
});

describe("the result read's responses", () => {
  it("a successful result is forwarded as received — JSON null included — no-store", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");

    harness.forwarder.resultVerdict = {
      kind: "found",
      status: 200,
      rawBody: new TextEncoder().encode("null"),
    };
    const nullResult = await get(harness.app, "/_api/jobs/jobs/job-123/result", token);
    expect(nullResult.status).toBe(200);
    expect(nullResult.text).toBe("null");
    expect(nullResult.json).toBe(null);
    expect(nullResult.headers["cache-control"]).toBe("no-store");

    const oddBytes = '{"items":[1, 2],  "nested":{"a":true}}';
    harness.forwarder.resultVerdict = {
      kind: "found",
      status: 200,
      rawBody: new TextEncoder().encode(oddBytes),
    };
    const odd = await get(harness.app, "/_api/jobs/jobs/job-123/result", token);
    expect(odd.status).toBe(200);
    expect(odd.text).toBe(oddBytes);
  });

  it("the stateful 409s and the 410 are forwarded with their own statuses", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");

    harness.forwarder.resultVerdict = {
      kind: "refused",
      status: 409,
      error: jobRequestError("job_not_ready", { status: "running", error: null }),
    };
    const notReady = await get(harness.app, "/_api/jobs/jobs/job-123/result", token);
    expect(notReady.status).toBe(409);
    expect(isJobsError(notReady.json, "job_not_ready")).toBe(true);
    expect(notReady.json).toMatchObject({ status: "running", error: null });

    harness.forwarder.resultVerdict = {
      kind: "refused",
      status: 410,
      error: jobRequestError("result_expired"),
    };
    const expired = await get(harness.app, "/_api/jobs/jobs/job-123/result", token);
    expect(expired.status).toBe(410);
    expect(isJobsError(expired.json, "result_expired")).toBe(true);
    expect(expired.headers["cache-control"]).toBe("no-store");
  });

  it("an unreachable server answers 503 — never an empty or failed-looking result", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    harness.forwarder.resultVerdict = { kind: "unreachable", error: new Error("no answer") };
    const res = await get(harness.app, "/_api/jobs/jobs/job-123/result", token);
    expect(res.status).toBe(503);
    expect(isJobsError(res.json, "jobs_unavailable")).toBe(true);
  });
});

describe("the cancellation route", () => {
  it("a validated acknowledgement is forwarded unchanged, no-store", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const ackBytes = '{"server":"jobs",  "jobId":"job-123","cancellationRequested":true}';
    harness.forwarder.cancelVerdict = {
      kind: "accepted",
      status: 202,
      cancellation: { server: "jobs", jobId: "job-123", cancellationRequested: true },
      rawBody: new TextEncoder().encode(ackBytes),
    };
    const res = await cancel(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(res.status).toBe(202);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toBe(ackBytes);
    expect(res.json).toMatchObject({ cancellationRequested: true });
  });

  it("is a mutation: a cross-origin cancellation is refused before any forward", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await cancel(harness.app, "/_api/jobs/jobs/job-123", token, {
      origin: "https://evil.example",
    });
    expect(res.status).toBe(403);
    expect(harness.forwarder.recordSpecs).toHaveLength(0);
  });

  it("is a mutation with no origin signal at all: refused fail-closed before any forward", async () => {
    // Neither Origin nor Sec-Fetch-Site — the shape curl, a native client, or
    // a browser too old for Fetch Metadata presents. The same-origin seam
    // fails closed on the missing header; a cancellation that sailed through
    // here would ride the victim's session from a context no browser marks
    // same-origin. Nothing may be minted for it.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    const res = await harness.app.inject({
      method: "DELETE",
      url: "/_api/jobs/jobs/job-123",
      headers: {
        host: HOST.host,
        "sec-fetch-mode": "cors",
        cookie: `${SESSION_COOKIE}=${token}`,
      },
    });
    expect(res.statusCode).toBe(403);
    expect(isJobsError(JSON.parse(res.body), "forbidden")).toBe(true);
    expect(harness.forwarder.recordSpecs).toHaveLength(0);
  });

  it("the receiver's terminal 409 and the unknown-job 404 are forwarded with their own statuses", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");

    harness.forwarder.cancelVerdict = {
      kind: "refused",
      status: 409,
      error: jobRequestError("job_terminal", { status: "succeeded", error: null }),
    };
    const terminal = await cancel(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(terminal.status).toBe(409);
    expect(isJobsError(terminal.json, "job_terminal")).toBe(true);
    expect(terminal.json).toMatchObject({ status: "succeeded", error: null });

    harness.forwarder.cancelVerdict = {
      kind: "refused",
      status: 404,
      error: jobRequestError("job_not_found"),
    };
    const notFound = await cancel(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(notFound.status).toBe(404);
    expect(isJobsError(notFound.json, "job_not_found")).toBe(true);
  });

  it("an unreachable server answers the retryable 503 — never a fabricated acknowledgement", async () => {
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    harness.forwarder.cancelVerdict = { kind: "unreachable", error: new Error("no answer") };
    const res = await cancel(harness.app, "/_api/jobs/jobs/job-123", token);
    expect(res.status).toBe(503);
    expect(isJobsError(res.json, "jobs_unavailable")).toBe(true);
    // A 503 is uncertainty, never "not cancelled" asserted as fact.
    expect(isJobsError(res.json, "job_not_found")).toBe(false);
  });
});

describe("a failed or abandoned poll changes nothing", () => {
  it("a poll through the app reaches a verifying receiver with its trusted attribution, and the snapshot returns", async () => {
    // The one test where every hop is real: the route authorizes against the
    // registry and the session, the production forwarder mints and forwards
    // over a real socket, and the stand-in receiver authenticates the
    // instruction through the SHARED verifier before answering — the only
    // stand-in is the jobs service's own internals (the assembled check is
    // separate work).
    const ROOT = Buffer.alloc(32, 1).toString("base64");
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = {
      status: 200,
      body: JSON.stringify(SNAPSHOT),
    };
    const base = await receiver.start();
    const { app, sessions } = buildJobsEdgeApp(
      new HttpJobsForwarder(
        [
          {
            server: "jobs",
            endpoint: base,
            edgeToJobsKey: deriveJobsInstructionKey(ROOT, "edgeToJobs"),
          },
        ],
        {
          timeoutMs: 5_000,
        },
      ),
      { jobsGeneration: "4" },
    );
    const token = await seedSession(sessions, "alice");
    const res = await get(app, "/_api/jobs/jobs/job-123", token);
    await app.close();

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    // The snapshot bytes the receiver answered are what the caller read.
    expect(res.text).toBe(JSON.stringify(SNAPSHOT));
    expect(receiver.verifyFailures).toEqual([]);
    const captured = receiver.recordCalls[0]!;
    expect(captured.operation).toBe("snapshot");
    expect(captured.claims).toMatchObject({
      server: "jobs",
      operation: "snapshot",
      resource: "/internal/jobs/v1/jobs/job-123",
      method: "GET",
      appId: APP_ID,
      env: "prod",
      ownerKind: "user",
      ownerOid: "alice",
      allowedTypes: ["jobs:fetch"],
    });
    await receiver.stop();
  });

  it("abandons the forward when the poller hangs up, with no retry and no cancellation", async () => {
    // The case the wiring's guard exists for (the same test the submission
    // route holds for its copy): the poll's response never arrives, the
    // client gives up, and the forward aborts — an observation failure, never
    // an execution one. The jobs receiver saw exactly ONE presentation: no
    // retry, no second instruction, no cancellation instruction.
    const ROOT = Buffer.alloc(32, 1).toString("base64");
    const KEY = deriveJobsInstructionKey(ROOT, "edgeToJobs");
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = { delayMs: 10_000 };
    const base = await receiver.start();
    const { app, sessions } = buildJobsEdgeApp(
      new HttpJobsForwarder([{ server: "jobs", endpoint: base, edgeToJobsKey: KEY }], {
        timeoutMs: 10_000,
      }),
    );
    const token = await seedSession(sessions, "alice");
    await withServer(app, async (base_) => {
      const ac = new AbortController();
      const pending = undiciRequest(`${base_}/_api/jobs/jobs/job-123`, {
        method: "GET",
        headers: {
          host: HOST.host,
          "sec-fetch-site": "same-origin",
          cookie: `${SESSION_COOKIE}=${token}`,
        },
        signal: ac.signal,
      }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
      ac.abort();
      await pending;
      await new Promise((r) => setTimeout(r, 100));
      expect(receiver.recordCalls).toHaveLength(1);
      expect(receiver.calls).toHaveLength(0);
    });
    await app.close();
    await receiver.stop();
  });

  it("a receiver verification failure travels as the refused 401 — never a fabricated snapshot", async () => {
    // The key-rotation shape: the edge holds a root the receiver no longer
    // verifies with. The refusal is the receiver's own envelope, forwarded.
    const ROOT = Buffer.alloc(32, 1).toString("base64");
    const OTHER_ROOT = Buffer.alloc(32, 2).toString("base64");
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const { app, sessions } = buildJobsEdgeApp(
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
    const res = await get(app, "/_api/jobs/jobs/job-123", token);
    await app.close();
    expect(receiver.recordCalls).toHaveLength(0);
    expect(receiver.verifyFailures).toHaveLength(1);
    expect(res.status).toBe(401);
    expect(isJobsError(res.json, "unauthorized")).toBe(true);
    await receiver.stop();
  });
});

describe("the dev gateway's reference routes", () => {
  it("polls and cancels with the dev tier's trusted attribution (env=dev, ownerKind=dev)", async () => {
    const forwarder = new FakeJobsForwarder("jobs");
    const app = await buildDevJobsEdge(forwarder);
    const poll = await app.inject({
      method: "GET",
      url: "/myapp/_api/jobs/jobs/job-123",
      headers: {
        host: "dev-api.local.helix.azxlabs.io",
        origin: DEV_ORIGIN,
        authorization: `Bearer ${DEV_BEARER}`,
      },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.headers["cache-control"]).toBe("no-store");
    expect(forwarder.recordSpecs).toHaveLength(1);
    expect(forwarder.recordSpecs[0]!.identity).toEqual({
      appId: DEV_APP_ID,
      env: "dev",
      ownerKind: "dev",
      ownerOid: "oid-developer",
      allowedTypes: ["jobs:fetch"],
    });

    const cancelRes = await app.inject({
      method: "DELETE",
      url: "/myapp/_api/jobs/jobs/job-123",
      headers: {
        host: "dev-api.local.helix.azxlabs.io",
        origin: DEV_ORIGIN,
        authorization: `Bearer ${DEV_BEARER}`,
      },
    });
    expect(cancelRes.statusCode).toBe(202);
    expect(forwarder.recordSpecs).toHaveLength(2);
    await app.close();
  });

  it("a missing dev token gets the resolver's 401, not a jobs envelope", async () => {
    const forwarder = new FakeJobsForwarder("jobs");
    const app = await buildDevJobsEdge(forwarder);
    const res = await app.inject({
      method: "GET",
      url: "/myapp/_api/jobs/jobs/job-123",
      headers: { host: "dev-api.local.helix.azxlabs.io", origin: DEV_ORIGIN },
    });
    expect(res.statusCode).toBe(401);
    expect(forwarder.recordSpecs).toHaveLength(0);
    await app.close();
  });

  it("the same disabled posture: a null forwarder answers 503 jobs_disabled", async () => {
    const app = await buildDevJobsEdge(null);
    const res = await app.inject({
      method: "GET",
      url: "/myapp/_api/jobs/jobs/job-123",
      headers: {
        host: "dev-api.local.helix.azxlabs.io",
        origin: DEV_ORIGIN,
        authorization: `Bearer ${DEV_BEARER}`,
      },
    });
    expect(res.statusCode).toBe(503);
    expect(isJobsError(JSON.parse(res.body), "jobs_disabled")).toBe(true);
    await app.close();
  });

  it("serves the result read too, and a job id at the grammar's 128 characters routes there", async () => {
    // Fastify 5 reads maxParamLength once, at the factory, for every
    // parametric route: the dev gateway is its own factory, so its own
    // 128-character bound is what this exercises — on the result route, whose
    // URL the dev surface had not otherwise served in these suites.
    const forwarder = new FakeJobsForwarder("jobs");
    const app = await buildDevJobsEdge(forwarder);
    const longest = "j".repeat(128);
    const res = await app.inject({
      method: "GET",
      url: `/myapp/_api/jobs/jobs/${longest}/result`,
      headers: {
        host: "dev-api.local.helix.azxlabs.io",
        origin: DEV_ORIGIN,
        authorization: `Bearer ${DEV_BEARER}`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(forwarder.recordSpecs).toHaveLength(1);
    expect(forwarder.recordSpecs[0]!.operation).toBe("result");
    expect(forwarder.recordSpecs[0]!.jobId).toBe(longest);
    await app.close();
  });
});

describe("the route surfaces identify themselves", () => {
  it("the poll, result and cancel spans name their surface's route pattern", async () => {
    const { startRecordingTelemetry } = await import("@azx-pbc/telemetry/testing");
    const recording = startRecordingTelemetry();
    try {
      const harness = buildJobsEdge();
      const token = await seedSession(harness.sessions, "alice");
      await get(harness.app, "/_api/jobs/jobs/job-123", token);
      await get(harness.app, "/_api/jobs/jobs/job-123/result", token);
      await cancel(harness.app, "/_api/jobs/jobs/job-123", token);

      const snapshotSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_SNAPSHOT_EDGE);
      expect(snapshotSpans).toHaveLength(1);
      expect(snapshotSpans[0]!.attributes["http.route"]).toBe(ROUTE_JOBS_SNAPSHOT);
      expect(snapshotSpans[0]!.attributes["helix.outcome"]).toBe("found");
      // No url.path: the route's segments are caller-chosen.
      expect(snapshotSpans[0]!.attributes["url.path"]).toBeUndefined();

      const resultSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_RESULT_EDGE);
      expect(resultSpans).toHaveLength(1);
      expect(resultSpans[0]!.attributes["http.route"]).toBe(ROUTE_JOBS_RESULT);
      expect(resultSpans[0]!.attributes["helix.outcome"]).toBe("found");

      const cancelSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_CANCEL_EDGE);
      expect(cancelSpans).toHaveLength(1);
      expect(cancelSpans[0]!.attributes["http.route"]).toBe(ROUTE_JOBS_CANCEL);
      expect(cancelSpans[0]!.attributes["helix.outcome"]).toBe("found");

      // The dev surface's own span names, under the same recording — all
      // three operations, so every one of the six route spans' name↔route
      // binding is pinned by this suite.
      const devApp = await buildDevJobsEdge(new FakeJobsForwarder("jobs"));
      const devHeaders = {
        host: "dev-api.local.helix.azxlabs.io",
        origin: DEV_ORIGIN,
        authorization: `Bearer ${DEV_BEARER}`,
      };
      await devApp.inject({
        method: "GET",
        url: "/myapp/_api/jobs/jobs/job-123",
        headers: devHeaders,
      });
      await devApp.inject({
        method: "GET",
        url: "/myapp/_api/jobs/jobs/job-123/result",
        headers: devHeaders,
      });
      await devApp.inject({
        method: "DELETE",
        url: "/myapp/_api/jobs/jobs/job-123",
        headers: devHeaders,
      });
      await devApp.close();
      const devSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_SNAPSHOT_DEV);
      expect(devSpans).toHaveLength(1);
      expect(devSpans[0]!.attributes["http.route"]).toBe(ROUTE_JOBS_SNAPSHOT_DEV);
      const devResultSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_RESULT_DEV);
      expect(devResultSpans).toHaveLength(1);
      expect(devResultSpans[0]!.attributes["http.route"]).toBe(ROUTE_JOBS_RESULT_DEV);
      const devCancelSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_CANCEL_DEV);
      expect(devCancelSpans).toHaveLength(1);
      expect(devCancelSpans[0]!.attributes["http.route"]).toBe(ROUTE_JOBS_CANCEL_DEV);
    } finally {
      await recording.restore();
    }
  });
});
