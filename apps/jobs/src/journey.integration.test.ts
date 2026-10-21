import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  GatewayAuditPageSchema,
  type GatewayAuditPage,
  HealthStatusSchema,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  ManifestUpdateResultSchema,
  type JobSnapshot,
} from "@azx-pbc/shared";

import {
  createLiveApp,
  startJsonOrigin,
  startRealStack,
  waitFor,
  type AppSession,
  type ControlledJsonOrigin,
  type DevClient,
  type HttpReply,
  type PortalClient,
  type RealStack,
} from "./test/realStack.js";

/**
 * The hosted-app and development jobs journey, over the REAL stack: an owner
 * grants background jobs through the portal's approvals write-gate, a user
 * submits work through the served app and collects the result from a fresh
 * session, a running job is cancelled, another tenant user sees nothing, the
 * dev gateway runs the same operations in its own namespace, and the portal's
 * request reporting describes what actually happened.
 *
 * Nothing here fakes a service or inserts a row a route should create: every
 * job operation goes through the edge's `/_api/jobs/*` gateway (hosted app) or
 * the dev gateway, and the one controlled thing is the harness's loopback JSON
 * origin the jobs' outbound GET is pointed at.
 */

// ── shared journey state ─────────────────────────────────────────────────────

let stack: RealStack;
let origin: ControlledJsonOrigin;
let slug: string;
let bob: PortalClient;
let alice: PortalClient;
let bobSession: AppSession;

/** The prod and dev submission attempts the test makes, counted as they go — leg 6 asserts the ledger row counts against these. */
const prodAttempts = { n: 0 };
const devAttempts = { n: 0 };

let prodJobId: string | undefined;
let prodKey: string | undefined;
let prodBody: string | undefined;
let devJobId: string | undefined;

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`the journey never produced ${what}`);
  return value;
};

beforeAll(async () => {
  stack = await startRealStack({ label: "journey" });
  origin = await startJsonOrigin();
}, 240_000);

afterAll(async () => {
  await origin?.close();
  if (stack) await stack.close();
});

// ── small drivers over the harness clients ───────────────────────────────────

const SUBMIT_PATH = "/_api/jobs/jobs/types/fetch";
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;
const resultPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}/result`;

/** Both hosted-app and dev-gateway clients expose the same call shape. */
type JobsApi = AppSession["api"] | DevClient["api"];

/**
 * One submission attempt series: the attempt is counted (the ledger records
 * every attempt, so leg 6 counts against exactly this counter), and a
 * retryable 503 is retried ONCE with the SAME key and the SAME bytes — the
 * keyed-retry rule, whose retained-key comparison recovers the first
 * attempt's job if it was accepted.
 */
async function submitJob(
  api: JobsApi,
  idempotencyKey: string,
  body: string,
  attempts: { n: number },
): Promise<HttpReply> {
  const attempt = (): Promise<HttpReply> => {
    attempts.n += 1;
    return api("POST", SUBMIT_PATH, {
      headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body,
    });
  };
  const first = await attempt();
  if (first.status === 503) return attempt();
  return first;
}

/** One snapshot read, parsed against the wire schema. */
async function readSnapshot(api: JobsApi, jobId: string): Promise<JobSnapshot> {
  const res = await api("GET", statusPath(jobId));
  expect(res.status, `status read of job ${jobId}`).toBe(200);
  return JobSnapshotSchema.parse(res.json());
}

/**
 * Poll the snapshot until `until` holds. Every poll is parsed against the
 * wire schema; a retryable 503 keeps polling inside the same bound (an
 * observation failure is never an execution failure); anything else non-200
 * fails loudly. The timeout names the job and the LAST snapshot.
 */
async function pollSnapshot(
  api: JobsApi,
  jobId: string,
  target: string,
  until: (snapshot: JobSnapshot) => boolean,
  timeoutMs: number,
): Promise<JobSnapshot> {
  let last: JobSnapshot | undefined;
  return waitFor(
    stack,
    () =>
      `job ${jobId} to reach "${target}" — last snapshot: ` +
      (last === undefined ? "<none>" : JSON.stringify(last)),
    { timeoutMs },
    async () => {
      const res = await api("GET", statusPath(jobId));
      if (res.status === 503) return undefined;
      expect(res.status, `status poll of job ${jobId}`).toBe(200);
      last = JobSnapshotSchema.parse(res.json());
      return until(last) ? last : undefined;
    },
  );
}

/** The portal `/health` body's lifecycle-delivery reading: pass count and whether every configured target is synchronized. */
async function lifecycleDeliveryReading(): Promise<{ passes: number; synchronized: boolean }> {
  const res = await stack.request(`${stack.portalUrl}/health`);
  expect(res.status, "portal /health status").toBe(200);
  const body = HealthStatusSchema.parse(res.json());
  const check = body.checks?.find((c) => c.name === JOBS_LIFECYCLE_DELIVERY_CHECK);
  const metrics = check?.metrics;
  if (!metrics) return { passes: 0, synchronized: false };
  return {
    passes: metrics.passes ?? 0,
    synchronized: (metrics.targets ?? 0) > 0 && metrics.synchronizedTargets === metrics.targets,
  };
}

/**
 * The jobs service admits an app's work only after the portal has delivered
 * that app's lifecycle state to it. Wait — bounded — for a delivery pass that
 * ENDED after `passesBefore` was read (so the reading cannot be from before
 * the app existed) and reports every target synchronized.
 */
async function waitForLifecycleDelivery(passesBefore: number): Promise<void> {
  await waitFor(
    stack,
    "the portal's jobs_lifecycle_delivery check to end a pass (after the app's creation) with every target synchronized",
    { timeoutMs: 90_000 },
    async () => {
      const reading = await lifecycleDeliveryReading();
      return reading.passes > passesBefore && reading.synchronized ? true : undefined;
    },
  );
}

/** Wait — bounded — for the job's outbound GET to arrive at the controlled origin. */
async function awaitOriginArrival(path: string, hold: { arrived: Promise<void> }): Promise<void> {
  await waitFor(
    stack,
    `the job's outbound GET to reach the origin at ${path}`,
    { timeoutMs: 60_000 },
    async () => (origin.requests.some((r) => r.path === path) ? true : undefined),
  );
  // The origin records the request before resolving the hold, so this is
  // already settled — awaited so the brief's contract holds by construction.
  await hold.arrived;
}

// ── the journey ──────────────────────────────────────────────────────────────

describe("the hosted-app and development jobs journey", () => {
  test(
    "leg 1: an owner creates, deploys and grants jobs through the portal",
    { timeout: 120_000 },
    async () => {
      bob = await stack.portalAs("bob@azx.dev");
      alice = await stack.portalAs("alice@azx.dev");

      // The catalogue advertises the one installed production type.
      const catalogue = await bob.get("/api/v1/capabilities");
      expect(catalogue.status).toBe(200);
      const catalogueBody = catalogue.json() as {
        jobs?: { types?: Array<{ id?: string }> };
      };
      expect(catalogueBody.jobs?.types?.some((t) => t.id === JOBS_FETCH_QUALIFIED_TYPE)).toBe(true);

      // Create, deploy and promote — the owner journey, through the real API.
      slug = `journey-${randomBytes(3).toString("hex")}`;
      const app = await createLiveApp(stack, bob, {
        slug,
        displayName: "Journey Jobs App",
        files: {
          "index.html": `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>journey jobs app</title></head>
  <body>
    <h1>journey-jobs-marker</h1>
    <p id="job-status">idle</p>
    <script type="module">
      // A real author's page: submit a background fetch with the session the
      // page already has, then poll the snapshot until it succeeds.
      const status = document.getElementById("job-status");
      const accepted = await fetch("/_api/jobs/jobs/types/fetch", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ url: "https://example.invalid/report" }),
      });
      const job = await accepted.json();
      for (;;) {
        const snapshot = await fetch("/_api/jobs/jobs/" + job.jobId, {
          credentials: "include",
        });
        const state = await snapshot.json();
        status.textContent = state.status;
        if (state.status === "succeeded" || state.status === "failed") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    </script>
  </body>
</html>`,
        },
      });
      expect(app.slug).toBe(slug);

      // The grant save — exactly the body the SPA capability editor sends
      // (`fromDraft`) for these choices: no llm, no data, a keyless fetch
      // origin, and the jobs type.
      const capabilities = {
        mcp: [],
        externalOrigins: [],
        fetch: { shim: false, origins: [{ origin: origin.origin }] },
        jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE] },
      };
      const saved = await bob.put(`/api/v1/apps/${slug}/manifest`, { capabilities });
      expect(saved.status).toBe(200);
      const saveResult = ManifestUpdateResultSchema.parse(saved.json());
      // The jobs type is baseline — applied now; the keyless fetch origin is
      // elevated — a pending approval request.
      expect(
        saveResult.applied.some((d) => d.path === `jobs.types[+${JOBS_FETCH_QUALIFIED_TYPE}]`),
      ).toBe(true);
      expect(saveResult.pending).not.toBeNull();
      const pendingId = must(saveResult.pending ?? undefined, "a pending approval id");

      // The applied/blocked split is visible on the manifest read: the jobs
      // grant is live, the origin is not.
      const afterSave = await bob.get(`/api/v1/apps/${slug}/manifest`);
      expect(afterSave.status).toBe(200);
      const afterSaveBody = afterSave.json() as {
        capabilities: {
          fetch?: { origins?: Array<{ origin?: string }> };
          jobs?: { types?: string[] };
        };
      };
      expect(afterSaveBody.capabilities.jobs?.types).toContain(JOBS_FETCH_QUALIFIED_TYPE);
      expect(
        afterSaveBody.capabilities.fetch?.origins?.some((o) => o.origin === origin.origin) ?? false,
      ).toBe(false);

      // Separation of duty: the requester may not approve their own request.
      const selfApprove = await bob.post(`/api/v1/approvals/${pendingId}/approve`);
      expect(selfApprove.status).toBe(403);

      // An admin who is not the requester approves; the manifest now has both.
      const approved = await alice.post(`/api/v1/approvals/${pendingId}/approve`);
      expect(approved.status).toBe(200);
      expect((approved.json() as { status?: string }).status).toBe("approved");

      const afterApprove = await bob.get(`/api/v1/apps/${slug}/manifest`);
      expect(afterApprove.status).toBe(200);
      const afterApproveBody = afterApprove.json() as {
        capabilities: {
          fetch?: { origins?: Array<{ origin?: string }> };
          jobs?: { types?: string[] };
        };
      };
      expect(
        afterApproveBody.capabilities.fetch?.origins?.some((o) => o.origin === origin.origin),
      ).toBe(true);
      expect(afterApproveBody.capabilities.jobs?.types).toContain(JOBS_FETCH_QUALIFIED_TYPE);
    },
  );

  test(
    "leg 2: a user opens the served app, submits, leaves and returns for the result",
    { timeout: 120_000 },
    async () => {
      // The real OIDC login through the edge and the dev IdP, then the served page.
      const session = await stack.appSession(slug, "bob@azx.dev");
      const page = await session.navigate("/");
      expect(page.status).toBe(200);
      expect(String(page.headers["content-type"])).toContain("text/html");
      expect(page.text).toContain("journey-jobs-marker");

      // First submission for this app: the jobs service admits work only
      // after the portal's lifecycle delivery reached it.
      const passesBefore = (await lifecycleDeliveryReading()).passes;
      await waitForLifecycleDelivery(passesBefore);

      const hold = origin.hold("/report");
      const report = { ok: true, n: 42, nested: { list: [1, 2, 3] }, nul: null };
      origin.respond("/report", { json: report });

      // Submit, then replay the identical key+bytes — retry identity.
      prodKey = `journey-${randomUUID()}`;
      prodBody = JSON.stringify({ url: `${origin.origin}/report` });
      const submitted = await submitJob(session.api, prodKey, prodBody, prodAttempts);
      expect(submitted.status).toBe(202);
      const accepted = JobAcceptedSchema.parse(submitted.json());
      expect(accepted.server).toBe("jobs");
      expect(["queued", "running"]).toContain(accepted.status);
      prodJobId = accepted.jobId;

      const replayed = await submitJob(session.api, prodKey, prodBody, prodAttempts);
      expect(replayed.status).toBe(202);
      expect(JobAcceptedSchema.parse(replayed.json()).jobId).toBe(prodJobId);

      // "Left": no client connection is open while the job executes.
      await awaitOriginArrival("/report", hold);
      const reportRequests = origin.requests.filter((r) => r.path === "/report");
      expect(reportRequests.length).toBe(1);
      expect(reportRequests[0]?.method).toBe("GET");
      // Keyless: no user credential leaked to the origin.
      expect(reportRequests[0]?.headers["authorization"]).toBeUndefined();
      expect(reportRequests[0]?.headers["cookie"]).toBeUndefined();

      // One status read while the job is held mid-flight.
      const held = await readSnapshot(session.api, prodJobId);
      expect(held.status).toBe("running");
      expect(held.cancellationRequested).toBe(false);

      hold.release();

      // "Return": a fresh login (new cookie) collects the result.
      bobSession = await stack.appSession(slug, "bob@azx.dev");
      const final = await pollSnapshot(
        bobSession.api,
        prodJobId,
        "succeeded",
        (s) => s.status === "succeeded",
        60_000,
      );
      expect(final.jobId).toBe(prodJobId);
      expect(final.type).toBe(JOBS_FETCH_QUALIFIED_TYPE);
      expect(final.error).toBeNull();
      expect(final.resultExpiresAt).not.toBeNull();
      expect(final.recordExpiresAt).not.toBeNull();
      expect(final.attempt).toBeTypeOf("number");
      expect(final.attempt).toBeGreaterThanOrEqual(1);

      // The result is exactly the origin's JSON — JSON null included.
      const result = await bobSession.api("GET", resultPath(prodJobId));
      expect(result.status).toBe(200);
      expect(JSON.parse(result.text)).toEqual(report);
      expect(String(result.headers["cache-control"])).toContain("no-store");

      // No re-execution by polling or replay.
      expect(origin.requests.filter((r) => r.path === "/report").length).toBe(1);

      // A terminal job is not cancellable.
      const cancel = await bobSession.api("DELETE", statusPath(prodJobId));
      expect(cancel.status).toBe(409);
      expect(JobRequestErrorSchema.parse(cancel.json()).code).toBe("job_terminal");
    },
  );

  test(
    "leg 3: cancellation of running work through the hosted app",
    { timeout: 120_000 },
    async () => {
      const hold = origin.hold("/slow");
      origin.respond("/slow", { json: { slow: true } });
      const key = `journey-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/slow` });
      const submitted = await submitJob(bobSession.api, key, body, prodAttempts);
      expect(submitted.status).toBe(202);
      const job = JobAcceptedSchema.parse(submitted.json());

      await awaitOriginArrival("/slow", hold);
      const cancel = await bobSession.api("DELETE", statusPath(job.jobId));
      expect(cancel.status).toBe(202);
      const ack = JobCancellationAcceptedSchema.parse(cancel.json());
      expect(ack.cancellationRequested).toBe(true);
      expect(ack.server).toBe("jobs");
      expect(ack.jobId).toBe(job.jobId);

      const snapshot = await pollSnapshot(
        bobSession.api,
        job.jobId,
        "cancelled",
        (s) => s.status === "cancelled",
        60_000,
      );
      expect(snapshot.cancellationRequested).toBe(true);
      hold.release();

      // A terminal job without a result: the stateful 409 with its own outcome.
      const result = await bobSession.api("GET", resultPath(job.jobId));
      expect(result.status).not.toBe(200);
      expect(JobRequestErrorSchema.parse(result.json()).code).toBe("job_terminal");
    },
  );

  test("leg 4: another owner cannot see the job", { timeout: 120_000 }, async () => {
    // dana is in eng-team; the internal app lets her in — but the job is bob's.
    const dana = await stack.appSession(slug, "dana@azx.dev");

    // The fixed unknown-job 404, against a well-formed id nobody created.
    const unknown = await dana.api("GET", statusPath(randomUUID()));
    expect(unknown.status).toBe(404);
    expect(JobRequestErrorSchema.parse(unknown.json()).code).toBe("job_not_found");
    const unknownBody = unknown.text;

    for (const [what, reply] of [
      ["status", await dana.api("GET", statusPath(must(prodJobId, "the leg-2 job")))],
      ["result", await dana.api("GET", resultPath(must(prodJobId, "the leg-2 job")))],
      ["cancel", await dana.api("DELETE", statusPath(must(prodJobId, "the leg-2 job")))],
    ] as const) {
      expect(reply.status, `dana's ${what} read of bob's job`).toBe(404);
      // Identical to the unknown-job answer — never a disclosure.
      expect(reply.text, `dana's ${what} read of bob's job`).toBe(unknownBody);
      expect(JobRequestErrorSchema.parse(reply.json()).code).toBe("job_not_found");
    }
  });

  test(
    "leg 5: the development gateway — the same four operations, separately owned",
    { timeout: 120_000 },
    async () => {
      // bob mints a dev token for a foreign origin, and the gateway runs the
      // same operations in the dev namespace.
      const minted = await bob.post(`/api/v1/apps/${slug}/dev-tokens`, {
        origins: ["http://localhost:5199"],
      });
      expect(minted.status).toBe(201);
      const token = (minted.json() as { token: string }).token;
      const dev = stack.devClient(slug, token, "http://localhost:5199");

      const devReport = { env: "dev", marker: `dev-result-${randomUUID()}` };
      origin.respond("/dev-report", { json: devReport });
      const devKey = `journey-${randomUUID()}`;
      const devBody = JSON.stringify({ url: `${origin.origin}/dev-report` });
      const submitted = await submitJob(dev.api, devKey, devBody, devAttempts);
      expect(submitted.status).toBe(202);
      const devAccepted = JobAcceptedSchema.parse(submitted.json());
      devJobId = devAccepted.jobId;

      const devFinal = await pollSnapshot(
        dev.api,
        devJobId,
        "succeeded",
        (s) => s.status === "succeeded",
        60_000,
      );
      expect(devFinal.error).toBeNull();
      const devResult = await dev.api("GET", resultPath(devJobId));
      expect(devResult.status).toBe(200);
      expect(JSON.parse(devResult.text)).toEqual(devReport);

      const devCancel = await dev.api("DELETE", statusPath(devJobId));
      expect(devCancel.status).toBe(409);
      expect(JobRequestErrorSchema.parse(devCancel.json()).code).toBe("job_terminal");

      // The dev gateway cancels running work too.
      const slowHold = origin.hold("/dev-slow");
      origin.respond("/dev-slow", { json: { slow: "dev" } });
      const slowKey = `journey-${randomUUID()}`;
      const slowBody = JSON.stringify({ url: `${origin.origin}/dev-slow` });
      const slowSubmitted = await submitJob(dev.api, slowKey, slowBody, devAttempts);
      expect(slowSubmitted.status).toBe(202);
      const slowJob = JobAcceptedSchema.parse(slowSubmitted.json());
      await awaitOriginArrival("/dev-slow", slowHold);
      const slowCancel = await dev.api("DELETE", statusPath(slowJob.jobId));
      expect(slowCancel.status).toBe(202);
      expect(JobCancellationAcceptedSchema.parse(slowCancel.json()).cancellationRequested).toBe(
        true,
      );
      await pollSnapshot(
        dev.api,
        slowJob.jobId,
        "cancelled",
        (s) => s.status === "cancelled",
        60_000,
      );
      slowHold.release();

      // Cross-environment and cross-principal reads are the same 404: the dev
      // namespace does not see bob's prod job, and bob's session does not see
      // the dev job.
      const devReadsProd = await dev.api("GET", statusPath(must(prodJobId, "the leg-2 job")));
      expect(devReadsProd.status).toBe(404);
      expect(JobRequestErrorSchema.parse(devReadsProd.json()).code).toBe("job_not_found");
      const bobReadsDev = await bobSession.api("GET", statusPath(must(devJobId, "the dev job")));
      expect(bobReadsDev.status).toBe(404);
      expect(JobRequestErrorSchema.parse(bobReadsDev.json()).code).toBe("job_not_found");

      // The same key + same bytes in the other namespace is a DIFFERENT job.
      const namespaced = await submitJob(
        dev.api,
        must(prodKey, "the leg-2 key"),
        must(prodBody, "the leg-2 body"),
        devAttempts,
      );
      expect(namespaced.status).toBe(202);
      expect(JobAcceptedSchema.parse(namespaced.json()).jobId).not.toBe(prodJobId);

      // An origin outside the token's registration: refused, and never a leak
      // of the job's result.
      const wrongOrigin = stack.devClient(slug, token, "http://localhost:5200");
      const wrongRead = await wrongOrigin.api("GET", statusPath(must(devJobId, "the dev job")));
      expect(wrongRead.status).toBe(403);
      expect(wrongRead.text).not.toContain(devReport.marker);
    },
  );

  test(
    "leg 6: portal request reporting describes what actually happened",
    { timeout: 120_000 },
    async () => {
      // The ledger is written best-effort and asynchronously: poll until the
      // counts are reached, then assert exact equality.
      const page = await waitFor<GatewayAuditPage>(
        stack,
        () => `the audit page to carry ${prodAttempts.n} prod and ${devAttempts.n} dev jobs rows`,
        { timeoutMs: 15_000, pollMs: 1_000 },
        async () => {
          const res = await bob.get(`/api/v1/apps/${slug}/audit?limit=200`);
          expect(res.status, "the app audit read").toBe(200);
          const parsed = GatewayAuditPageSchema.parse(res.json());
          const jobsRows = parsed.rows.filter((r) => r.capability === "jobs");
          const prod = jobsRows.filter((r) => r.env === "prod").length;
          const dev = jobsRows.filter((r) => r.env === "dev").length;
          return prod >= prodAttempts.n && dev >= devAttempts.n ? parsed : undefined;
        },
      );

      const jobsRows = page.rows.filter((r) => r.capability === "jobs");
      const prodRows = jobsRows.filter((r) => r.env === "prod");
      const devRows = jobsRows.filter((r) => r.env === "dev");
      // The ledger records REQUESTS, not unique jobs — the keyed replay (and
      // any 503 retry) is its own row.
      expect(prodRows.length).toBe(prodAttempts.n);
      expect(devRows.length).toBe(devAttempts.n);
      for (const row of jobsRows) {
        expect(row.model).toBe(JOBS_FETCH_QUALIFIED_TYPE);
      }

      // The outbound calls that completed are fetch rows attributed to the origin.
      const fetchRows = page.rows.filter((r) => r.capability === "fetch");
      expect(
        fetchRows.some((r) => r.model === origin.origin && r.env === "prod"),
        "a prod fetch row for the origin",
      ).toBe(true);
      expect(
        fetchRows.some((r) => r.model === origin.origin && r.env === "dev"),
        "a dev fetch row for the origin",
      ).toBe(true);
    },
  );
});
