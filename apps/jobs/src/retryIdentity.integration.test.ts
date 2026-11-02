import { randomBytes, randomUUID } from "node:crypto";

import { Client as PgClient, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  HealthStatusSchema,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  ManifestUpdateResultSchema,
  type App,
  type JobSnapshot,
} from "@azx-pbc/shared";
import { buildJobsInternalResource, sha256BodyDigest } from "@azx-pbc/shared/jobsSigning";

import {
  createLiveApp,
  startJsonOrigin,
  startRealStack,
  waitFor,
  type AppSession,
  type ControlledJsonOrigin,
  type HttpReply,
  type JobsLink,
  type PortalClient,
  type RealStack,
} from "./test/realStack.js";

/**
 * Retry identity under concurrent and uncertain submission, over the REAL
 * stack: the acceptance transaction's retained-key contract (ADR-0003)
 * observed end to end through the edge's `/_api/jobs/*` gateway and the
 * harness's faultable edge→jobs relay. Simultaneous keyed submits from two
 * sessions, owner-scoped key namespaces, unkeyed work, lost and hung-up and
 * delayed replies, an edge crash and a jobs crash, a failed request-log
 * write, and a validation skew between the platform version that accepted a
 * job and the version that executes it.
 *
 * "Accepted work" is never a reply's claim: the durable wrapper records and
 * runner rows are read directly from the jobs store, and the controlled
 * origin's request log counts executions. Every scenario gets its own origin
 * path so the counts stay unambiguous.
 */

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let origin: ControlledJsonOrigin;
let jobsLink: JobsLink;
let bob: PortalClient;
let alice: PortalClient;
let jobsDb: Pool;

interface AppUnderTest {
  readonly app: App;
  readonly slug: string;
}

let appA: AppUnderTest;
let appB: AppUnderTest;
let appC: AppUnderTest;
let appD: AppUnderTest;
let appE: AppUnderTest;

let sessionA: AppSession;
let sessionB: AppSession;
let sessionC: AppSession;
let sessionD: AppSession;
let sessionE: AppSession;

/** Test 1's submission identity, reused by test 2's conflict legs. */
let concKey: string | undefined;
let concBody: string | undefined;

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`the suite never produced ${what}`);
  return value;
};

beforeAll(async () => {
  stack = await startRealStack({ label: "retryidentity", jobsLink: true });
  const link = stack.jobsLink;
  if (link === null) {
    throw new Error("startRealStack({ jobsLink: true }) produced no jobs link");
  }
  jobsLink = link;
  origin = await startJsonOrigin();
  // Every scenario's path is configured even where nothing should fetch it:
  // an unexpected GET must answer 200 and be caught by the count, not 404.
  for (const path of [
    "/conc",
    "/ns",
    "/unkeyed",
    "/lost",
    "/hangup",
    "/slowreply",
    "/ledger",
    "/edgecrash",
    "/jobscrash",
    "/skew-a",
    "/skew-b",
    "/skew-c",
  ]) {
    origin.respond(path, { json: { ok: path } });
  }
  origin.respond("/refused", { status: 404, json: { error: "not here" } });

  bob = await stack.portalAs("bob@azx.dev");
  alice = await stack.portalAs("alice@azx.dev");

  appA = await createGrantedApp("conc");
  appB = await createGrantedApp("ns");
  appC = await createGrantedApp("uncertain");
  appD = await createGrantedApp("restarts");
  appE = await createGrantedApp("skew");

  // The jobs service admits an app's work only after the portal delivered
  // that app's lifecycle state to it — wait once, after all five apps exist.
  const passesBefore = (await lifecycleDeliveryReading()).passes;
  await waitForLifecycleDelivery(passesBefore);

  sessionA = await stack.appSession(appA.slug, "bob@azx.dev");
  sessionB = await stack.appSession(appB.slug, "bob@azx.dev");
  sessionC = await stack.appSession(appC.slug, "bob@azx.dev");
  sessionD = await stack.appSession(appD.slug, "bob@azx.dev");
  sessionE = await stack.appSession(appE.slug, "bob@azx.dev");

  jobsDb = new Pool({ connectionString: stack.jobsOwnerDsn, max: 2 });
}, 300_000);

afterAll(async () => {
  await origin?.close();
  await jobsDb?.end();
  if (stack) await stack.close();
});

// ── small drivers over the harness clients ───────────────────────────────────

const SUBMIT_PATH = "/_api/jobs/jobs/types/fetch";
const SUBMIT_RESOURCE = buildJobsInternalResource("submit");
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;

/** One submission attempt: optional retry key, exact body bytes, optional abort signal. */
async function submit(
  session: AppSession,
  opts: { key?: string | null; body: string; signal?: AbortSignal },
): Promise<HttpReply> {
  return session.api("POST", SUBMIT_PATH, {
    headers: {
      "Content-Type": "application/json",
      ...(typeof opts.key === "string" ? { "Idempotency-Key": opts.key } : {}),
    },
    body: opts.body,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
}

/**
 * Attach the rejection handler to a submit promise at birth, so a rejection
 * the test expects later is never an unhandled one while other awaits run.
 */
type SubmitOutcome = { kind: "replied"; reply: HttpReply } | { kind: "failed"; error: unknown };
const settle = (pending: Promise<HttpReply>): Promise<SubmitOutcome> =>
  pending.then(
    (reply) => ({ kind: "replied", reply }),
    (error) => ({ kind: "failed", error }),
  );

/** One snapshot read, parsed against the wire schema. */
async function readSnapshot(api: AppSession["api"], jobId: string): Promise<JobSnapshot> {
  const res = await api("GET", statusPath(jobId));
  expect(res.status, `status read of job ${jobId}`).toBe(200);
  return JobSnapshotSchema.parse(res.json());
}

/**
 * Poll the snapshot until `until` holds. Every poll is parsed against the
 * wire schema; a retryable 503 keeps polling inside the same bound (an
 * observation failure is never an execution failure); anything else non-200
 * fails loudly.
 */
async function pollSnapshot(
  api: AppSession["api"],
  jobId: string,
  until: (snapshot: JobSnapshot) => boolean,
  timeoutMs: number,
): Promise<JobSnapshot> {
  let last: JobSnapshot | undefined;
  return waitFor(
    stack,
    () => `job ${jobId} — last snapshot: ` + (last === undefined ? "<none>" : JSON.stringify(last)),
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

/** The durable accepted work of one app: wrapper records and runner rows, read directly. */
async function jobCounts(appId: string): Promise<{ records: number; runnerRows: number }> {
  const records = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jobs.job_record WHERE app_id = $1`,
    [appId],
  );
  const runnerRows = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pgboss.job WHERE group_id = $1`,
    [`${appId}:prod`],
  );
  return { records: records.rows[0]?.n ?? 0, runnerRows: runnerRows.rows[0]?.n ?? 0 };
}

/** Submissions the relay carried to jobs — the edge's forwards, not the replies. */
function forwardedSubmitCount(): number {
  return jobsLink.forwarded.filter((f) => f.method === "POST" && f.path === SUBMIT_RESOURCE).length;
}

function originGets(path: string): number {
  return origin.requests.filter((r) => r.path === path).length;
}

// ── setup helpers ────────────────────────────────────────────────────────────

/**
 * Create, deploy and promote an app, then grant it the jobs:fetch type and
 * the controlled origin as a keyless fetch origin — exactly the SPA
 * capability editor's save body for these choices. The origin is elevated,
 * so its save files a pending approval that alice (never the requester)
 * approves.
 */
async function createGrantedApp(purpose: string): Promise<AppUnderTest> {
  const slug = `ri-${purpose}-${randomBytes(3).toString("hex")}`;
  const app = await createLiveApp(stack, bob, {
    slug,
    files: {
      "index.html":
        '<!doctype html><html><head><meta charset="utf-8"><title>retry identity</title></head>' +
        "<body><p>retry-identity-app</p></body></html>",
    },
  });
  const capabilities = {
    mcp: [],
    externalOrigins: [],
    fetch: { shim: false, origins: [{ origin: origin.origin }] },
    jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE] },
  };
  const saved = await bob.put(`/api/v1/apps/${slug}/manifest`, { capabilities });
  expect(saved.status, `the manifest save for ${slug}`).toBe(200);
  const saveResult = ManifestUpdateResultSchema.parse(saved.json());
  const pendingId = must(saveResult.pending, `the pending origin approval for ${slug}`);
  const approved = await alice.post(`/api/v1/approvals/${pendingId}/approve`);
  expect(approved.status, `the origin approval for ${slug}`).toBe(200);
  return { app, slug };
}

// ── lifecycle-delivery waits (the admission gate's precondition) ─────────────

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
 * Wait — bounded — for a delivery pass that ENDED after `passesBefore` was
 * read (so the reading cannot be from before the apps existed) and reports
 * every target synchronized.
 */
async function waitForLifecycleDelivery(passesBefore: number): Promise<void> {
  await waitFor(
    stack,
    "the portal's jobs_lifecycle_delivery check to end a pass (after the apps' creation) with every target synchronized",
    { timeoutMs: 90_000 },
    async () => {
      const reading = await lifecycleDeliveryReading();
      return reading.passes > passesBefore && reading.synchronized ? true : undefined;
    },
  );
}

// ── the suite ────────────────────────────────────────────────────────────────

describe("concurrent keyed submissions", () => {
  test(
    "simultaneous identical keyed submits from two sessions recover one job and one execution",
    { timeout: 180_000 },
    async () => {
      // Two tabs, same owner: a second session on app A.
      const second = await stack.appSession(appA.slug, "bob@azx.dev");
      const key = `ri-conc-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/conc` });

      const submitsBefore = forwardedSubmitCount();
      const fire = (session: AppSession): Promise<HttpReply>[] =>
        Array.from({ length: 3 }, () => submit(session, { key, body }));
      const replies = await Promise.all([...fire(sessionA), ...fire(second)]);

      for (const reply of replies) {
        expect(reply.status, "a simultaneous keyed submit").toBe(202);
      }
      const accepted = replies.map((r) => JobAcceptedSchema.parse(r.json()));
      const jobIds = new Set(accepted.map((a) => a.jobId));
      expect(jobIds.size, "every reply carries the same jobId").toBe(1);
      expect(
        new Set(accepted.map((a) => `${a.server}:${a.jobId}`)).size,
        "one distinct {server, jobId}",
      ).toBe(1);
      const jobId = must(accepted[0], "the recovered job's id").jobId;

      // The durable evidence: one wrapper record, one runner row.
      expect(await jobCounts(appA.app.id)).toEqual({ records: 1, runnerRows: 1 });

      // All six forwards reached jobs — and nothing more: no edge-side
      // automatic resubmission behind the concurrent retries.
      expect(forwardedSubmitCount() - submitsBefore).toBe(6);

      await pollSnapshot(sessionA.api, jobId, (s) => s.status === "succeeded", 120_000);
      expect(originGets("/conc")).toBe(1);

      concKey = key;
      concBody = body;
    },
  );

  test(
    "exact-byte conflicts: equivalent JSON reserialized and different-but-invalid bytes both conflict, creating nothing",
    { timeout: 180_000 },
    async () => {
      const key = must(concKey, "test 1's retry key");
      const body = must(concBody, "test 1's body");

      // The same JSON reserialized is DIFFERENT bytes — a conflict, not a
      // recovery (identity is exact bytes, not JSON equivalence).
      const reserialized = JSON.stringify(JSON.parse(body), null, 2);
      const reserializedReply = await submit(sessionA, { key, body: reserialized });
      expect(reserializedReply.status).toBe(409);
      expect(JobRequestErrorSchema.parse(reserializedReply.json()).code).toBe(
        "idempotency_conflict",
      );

      // Bytes that are invalid for new work still CONFLICT while carrying a
      // used key — the retained-key comparison precedes validation.
      const invalid = JSON.stringify({ url: 5 });
      const keyedInvalid = await submit(sessionA, { key, body: invalid });
      expect(keyedInvalid.status).toBe(409);
      expect(JobRequestErrorSchema.parse(keyedInvalid.json()).code).toBe("idempotency_conflict");

      // The same bytes WITHOUT a key are new work — validation refuses them.
      const unkeyedInvalid = await submit(sessionA, { body: invalid });
      expect(unkeyedInvalid.status).toBe(400);
      expect(JobRequestErrorSchema.parse(unkeyedInvalid.json()).code).toBe("payload_invalid");

      // Nothing above created work or executed.
      expect(await jobCounts(appA.app.id)).toEqual({ records: 1, runnerRows: 1 });
      expect(originGets("/conc")).toBe(1);
    },
  );
});

describe("identity namespaces and unkeyed work", () => {
  test(
    "two owners reusing one key and identical bytes get separate jobs that never cross",
    { timeout: 180_000 },
    async () => {
      const dana = await stack.appSession(appB.slug, "dana@azx.dev");
      const key = `ri-ns-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/ns` });

      const bobReply = await submit(sessionB, { key, body });
      const danaReply = await submit(dana, { key, body });
      expect(bobReply.status).toBe(202);
      expect(danaReply.status).toBe(202);
      const bobJob = JobAcceptedSchema.parse(bobReply.json());
      const danaJob = JobAcceptedSchema.parse(danaReply.json());
      expect(bobJob.jobId).not.toBe(danaJob.jobId);

      // Each replay recovers its own owner's job.
      const bobReplay = await submit(sessionB, { key, body });
      expect(bobReplay.status).toBe(202);
      expect(JobAcceptedSchema.parse(bobReplay.json()).jobId).toBe(bobJob.jobId);
      const danaReplay = await submit(dana, { key, body });
      expect(danaReplay.status).toBe(202);
      expect(JobAcceptedSchema.parse(danaReplay.json()).jobId).toBe(danaJob.jobId);

      // A job reference is readable only inside its own namespace.
      const bobReadsDanas = await sessionB.api("GET", statusPath(danaJob.jobId));
      expect(bobReadsDanas.status).toBe(404);
      expect(JobRequestErrorSchema.parse(bobReadsDanas.json()).code).toBe("job_not_found");
      const danaReadsBobs = await dana.api("GET", statusPath(bobJob.jobId));
      expect(danaReadsBobs.status).toBe(404);
      expect(JobRequestErrorSchema.parse(danaReadsBobs.json()).code).toBe("job_not_found");

      expect(await jobCounts(appB.app.id)).toEqual({ records: 2, runnerRows: 2 });

      await pollSnapshot(sessionB.api, bobJob.jobId, (s) => s.status === "succeeded", 120_000);
      await pollSnapshot(dana.api, danaJob.jobId, (s) => s.status === "succeeded", 120_000);
      expect(originGets("/ns")).toBe(2);
    },
  );

  test(
    "each unkeyed POST is new work, even with identical bytes",
    { timeout: 180_000 },
    async () => {
      const body = JSON.stringify({ url: `${origin.origin}/unkeyed` });

      const first = await submit(sessionB, { body });
      const second = await submit(sessionB, { body });
      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      const firstJob = JobAcceptedSchema.parse(first.json());
      const secondJob = JobAcceptedSchema.parse(second.json());
      expect(firstJob.jobId).not.toBe(secondJob.jobId);

      expect(await jobCounts(appB.app.id)).toEqual({ records: 4, runnerRows: 4 });

      await pollSnapshot(sessionB.api, firstJob.jobId, (s) => s.status === "succeeded", 120_000);
      await pollSnapshot(sessionB.api, secondJob.jobId, (s) => s.status === "succeeded", 120_000);
      expect(originGets("/unkeyed")).toBe(2);
    },
  );

  test(
    "a job whose origin refuses fails as itself, and its keyed replay recovers the failed job without running it again",
    { timeout: 180_000 },
    async () => {
      const key = `ri-refused-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/refused` });

      const submitted = await submit(sessionB, { key, body });
      expect(submitted.status).toBe(202);
      const jobId = JobAcceptedSchema.parse(submitted.json()).jobId;

      const failed = await pollSnapshot(sessionB.api, jobId, (s) => s.status === "failed", 120_000);
      expect(failed.error?.code).toBe("upstream_error");
      // One outbound GET per execution attempt of this one job.
      const attempts = must(failed.attempt, "the failed job's attempt number");
      expect(originGets("/refused")).toBe(attempts);

      // The edge discarded the refused upstream body and kept serving: the
      // replay reaches jobs through the same edge process.
      const replay = await submit(sessionB, { key, body });
      expect(replay.status).toBe(202);
      const replayed = JobAcceptedSchema.parse(replay.json());
      expect(replayed.jobId).toBe(jobId);
      expect(replayed.status).toBe("failed");
      expect(originGets("/refused")).toBe(attempts);
      expect(await jobCounts(appB.app.id)).toEqual({ records: 5, runnerRows: 5 });
    },
  );
});

describe("uncertain submissions", () => {
  test(
    "a reply lost after commit is a 503, never proof of nonacceptance; the keyed retry recovers the committed job",
    { timeout: 180_000 },
    async () => {
      const key = `ri-lost-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/lost` });

      const i = jobsLink.interceptNextSubmit("drop");
      const failed = await submit(sessionC, { key, body });
      expect(failed.status).toBe(503);
      expect(JobRequestErrorSchema.parse(failed.json()).code).toBe("jobs_unavailable");

      // Jobs DID answer, and its answer was a commit — the client just never
      // saw it.
      const upstream = await i.upstreamReply;
      expect(upstream.status).toBe(202);
      const committed = JobAcceptedSchema.parse(JSON.parse(upstream.body));
      const jobId = committed.jobId;

      expect(await jobCounts(appC.app.id)).toEqual({ records: 1, runnerRows: 1 });

      const retry = await submit(sessionC, { key, body });
      expect(retry.status).toBe(202);
      expect(JobAcceptedSchema.parse(retry.json()).jobId).toBe(jobId);
      expect(await jobCounts(appC.app.id)).toEqual({ records: 1, runnerRows: 1 });

      await pollSnapshot(sessionC.api, jobId, (s) => s.status === "succeeded", 120_000);
      expect(originGets("/lost")).toBe(1);
    },
  );

  test(
    "a client that hangs up while the reply is in flight recovers the same job",
    { timeout: 180_000 },
    async () => {
      const key = `ri-hangup-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/hangup` });

      const i = jobsLink.interceptNextSubmit("hold");
      const controller = new AbortController();
      const outcome = settle(submit(sessionC, { key, body, signal: controller.signal }));

      // The submission committed at jobs while the reply was held.
      const upstream = await i.upstreamReply;
      expect(upstream.status).toBe(202);
      const committed = JobAcceptedSchema.parse(JSON.parse(upstream.body));
      const jobId = committed.jobId;

      // The client gives up; the edge notices and abandons its forward.
      controller.abort();
      const result = await outcome;
      expect(result.kind, "the aborted submit rejects").toBe("failed");
      await i.downstreamClosed;
      i.release();

      const retry = await submit(sessionC, { key, body });
      expect(retry.status).toBe(202);
      expect(JobAcceptedSchema.parse(retry.json()).jobId).toBe(jobId);

      // Only the one job — the abandoned forward's work was not duplicated.
      expect(await jobCounts(appC.app.id)).toEqual({ records: 2, runnerRows: 2 });

      await pollSnapshot(sessionC.api, jobId, (s) => s.status === "succeeded", 120_000);
      expect(originGets("/hangup")).toBe(1);
    },
  );

  test(
    "a submission that outlives the edge's 30 s forward bound is uncertain, and the keyed retry recovers it",
    { timeout: 240_000 },
    async () => {
      const key = `ri-slow-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/slowreply` });

      const i = jobsLink.interceptNextSubmit("hold");
      // The edge abandons the forward at its own 30 s bound and answers the
      // retryable 503 — the caller's patience, not the jobs outcome.
      const failed = await submit(sessionC, { key, body });
      expect(failed.status).toBe(503);
      expect(JobRequestErrorSchema.parse(failed.json()).code).toBe("jobs_unavailable");

      const upstream = await i.upstreamReply;
      expect(upstream.status).toBe(202);
      const committed = JobAcceptedSchema.parse(JSON.parse(upstream.body));
      const jobId = committed.jobId;

      // A no-op: the edge already gave up, so there is no connection left to
      // deliver the reply to.
      i.release();

      const retry = await submit(sessionC, { key, body });
      expect(retry.status).toBe(202);
      expect(JobAcceptedSchema.parse(retry.json()).jobId).toBe(jobId);
      expect(await jobCounts(appC.app.id)).toEqual({ records: 3, runnerRows: 3 });

      await pollSnapshot(sessionC.api, jobId, (s) => s.status === "succeeded", 120_000);
      expect(originGets("/slowreply")).toBe(1);
    },
  );
});

describe("edge and jobs restarts", () => {
  test(
    "an edge crash mid-submission, then restart: the keyed retry through the new edge recovers the job",
    { timeout: 180_000 },
    async () => {
      const key = `ri-edgecrash-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/edgecrash` });

      const i = jobsLink.interceptNextSubmit("hold");
      const outcome = settle(submit(sessionD, { key, body }));

      // Committed at jobs while the edge holds the forward open.
      const upstream = await i.upstreamReply;
      expect(upstream.status).toBe(202);
      const committed = JobAcceptedSchema.parse(JSON.parse(upstream.body));
      const jobId = committed.jobId;

      await stack.crash("edge");
      const result = await outcome;
      expect(result.kind, "the crashed edge's submit rejects").toBe("failed");
      i.release();
      await stack.start("edge");

      // The same session cookie: the edge is stateless and the signing
      // secret survives the restart.
      const retry = await submit(sessionD, { key, body });
      expect(retry.status).toBe(202);
      expect(JobAcceptedSchema.parse(retry.json()).jobId).toBe(jobId);
      expect(await jobCounts(appD.app.id)).toEqual({ records: 1, runnerRows: 1 });

      await pollSnapshot(sessionD.api, jobId, (s) => s.status === "succeeded", 120_000);
      expect(originGets("/edgecrash")).toBe(1);
    },
  );

  test(
    "a jobs crash after a lost reply, then restart: the retry recovers the job and nothing executes again",
    { timeout: 180_000 },
    async () => {
      const key = `ri-jobscrash-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/jobscrash` });

      const i = jobsLink.interceptNextSubmit("drop");
      const failed = await submit(sessionD, { key, body });
      expect(failed.status).toBe(503);
      expect(JobRequestErrorSchema.parse(failed.json()).code).toBe("jobs_unavailable");
      const upstream = await i.upstreamReply;
      expect(upstream.status).toBe(202);
      const committed = JobAcceptedSchema.parse(JSON.parse(upstream.body));
      const jobId = committed.jobId;

      // The 503 did not stop the committed work: it runs to completion.
      await pollSnapshot(sessionD.api, jobId, (s) => s.status === "succeeded", 120_000);
      expect(originGets("/jobscrash")).toBe(1);

      await stack.crash("jobs");
      await stack.start("jobs");

      const retry = await submit(sessionD, { key, body });
      expect(retry.status).toBe(202);
      const replayed = JobAcceptedSchema.parse(retry.json());
      expect(replayed.jobId).toBe(jobId);
      expect(replayed.status).toBe("succeeded");

      // The replay recovered the record; it did not create or run work again.
      expect(await jobCounts(appD.app.id)).toEqual({ records: 2, runnerRows: 2 });
      expect(originGets("/jobscrash")).toBe(1);
    },
  );

  test(
    "a failed request-log write changes neither acceptance nor execution",
    { timeout: 180_000 },
    async () => {
      const appId = appD.app.id;
      expect(appId, "the app id is a uuid before it is interpolated into SQL").toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      const key = `ri-ledger-${randomUUID()}`;
      const body = JSON.stringify({ url: `${origin.origin}/ledger` });

      const countLedger = async (): Promise<number> => {
        const client = new PgClient({
          connectionString: stack.platformOwnerDsn,
          connectionTimeoutMillis: 15_000,
        });
        await client.connect();
        try {
          const res = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM gateway_calls WHERE "appId" = $1 AND capability = 'jobs'`,
            [appId],
          );
          return res.rows[0]?.n ?? 0;
        } finally {
          await client.end();
        }
      };
      // The whole edge log (appended across restarts), so the count can never
      // shrink as the tail rolls.
      const ledgerFailures = (): number =>
        stack.logTail("edge", Number.MAX_SAFE_INTEGER).split("gateway.usage_record_failed").length -
        1;

      // The trigger's own connection: created, used, and dropped in a finally,
      // so a failing assertion can never leave the refusal in place.
      const scoped = async (): Promise<{ before: number; jobId: string }> => {
        const client = new PgClient({
          connectionString: stack.platformOwnerDsn,
          connectionTimeoutMillis: 15_000,
        });
        await client.connect();
        try {
          // Refuse ONLY this app's jobs request-log rows — the edge's
          // fire-and-forget ledger write fails, the submission does not.
          await client.query(`
            CREATE OR REPLACE FUNCTION ri_refuse_jobs_ledger() RETURNS trigger LANGUAGE plpgsql AS
              $$ BEGIN RAISE EXCEPTION 'request ledger unavailable'; END $$;
          `);
          await client.query(`
            CREATE TRIGGER ri_refuse_jobs_ledger BEFORE INSERT ON gateway_calls FOR EACH ROW
              WHEN (NEW.capability = 'jobs' AND NEW."appId" = '${appId}'::uuid)
              EXECUTE FUNCTION ri_refuse_jobs_ledger();
          `);
          const before = await countLedger();
          const failuresBefore = ledgerFailures();

          const submitted = await submit(sessionD, { key, body });
          expect(submitted.status, "acceptance does not depend on the request log").toBe(202);
          const jobId = JobAcceptedSchema.parse(submitted.json()).jobId;

          await waitFor(
            stack,
            "the edge to log gateway.usage_record_failed after the submit",
            { timeoutMs: 60_000 },
            async () => (ledgerFailures() > failuresBefore ? true : undefined),
          );
          expect(await countLedger(), "the refused row never landed").toBe(before);
          return { before, jobId };
        } finally {
          await client.query("DROP TRIGGER IF EXISTS ri_refuse_jobs_ledger ON gateway_calls");
          await client.query("DROP FUNCTION IF EXISTS ri_refuse_jobs_ledger()");
          await client.end();
        }
      };
      const { before, jobId } = await scoped();

      // The accepted job executed normally, oblivious to the ledger failure.
      const final = await pollSnapshot(
        sessionD.api,
        jobId,
        (s) => s.status === "succeeded",
        120_000,
      );
      expect(final.jobId).toBe(jobId);
      expect(originGets("/ledger")).toBe(1);
      expect(await jobCounts(appD.app.id)).toEqual({ records: 3, runnerRows: 3 });

      const replay = await submit(sessionD, { key, body });
      expect(replay.status).toBe(202);
      const replayed = JobAcceptedSchema.parse(replay.json());
      expect(replayed.jobId).toBe(jobId);
      expect(replayed.status).toBe("succeeded");
      expect(originGets("/ledger")).toBe(1);
      // The request log records REQUESTS, not jobs: the replay's own row
      // lands now that the trigger is gone.
      await waitFor(
        stack,
        `the replay's ledger row to land (from ${before})`,
        { timeoutMs: 60_000 },
        async () => {
          const n = await countLedger();
          return n === before + 1 ? n : undefined;
        },
      );
    },
  );
});

describe("validation skew", () => {
  test(
    "identical bytes recover a job accepted under older rules, and execution-time skew fails that same job",
    { timeout: 240_000 },
    async () => {
      // Fill the app's two execution slots with held work.
      const holdA = origin.hold("/skew-a");
      const holdB = origin.hold("/skew-b");
      const keyA = `ri-skewa-${randomUUID()}`;
      const keyB = `ri-skewb-${randomUUID()}`;
      const bodyA = JSON.stringify({ url: `${origin.origin}/skew-a` });
      const bodyB = JSON.stringify({ url: `${origin.origin}/skew-b` });
      const a = await submit(sessionE, { key: keyA, body: bodyA });
      const b = await submit(sessionE, { key: keyB, body: bodyB });
      expect(a.status).toBe(202);
      expect(b.status).toBe(202);
      await waitFor(
        stack,
        "both held executions' outbound GETs to reach the origin",
        { timeoutMs: 60_000 },
        async () => (originGets("/skew-a") >= 1 && originGets("/skew-b") >= 1 ? true : undefined),
      );
      await holdA.arrived;
      await holdB.arrived;

      // With both slots busy, job C is admitted but stays queued.
      const keyC = `ri-skewc-${randomUUID()}`;
      const bodyC = JSON.stringify({ url: `${origin.origin}/skew-c` });
      const c = await submit(sessionE, { key: keyC, body: bodyC });
      expect(c.status).toBe(202);
      const acceptedC = JobAcceptedSchema.parse(c.json());
      expect(acceptedC.status).toBe("queued");
      const jobIdC = acceptedC.jobId;
      expect((await readSnapshot(sessionE.api, jobIdC)).status).toBe("queued");
      expect(originGets("/skew-c")).toBe(0);

      // Two platform versions cannot run side by side in one stack, so the
      // durable rows an OLDER version wrote are recreated in place: its
      // rules accepted {"url", legacy: true} — invalid for new work today.
      // The record's stored digest and the runner row's carried input are
      // exactly what the acceptance transaction and the executing runner
      // read, so rewriting both is what an older version's commit left
      // behind.
      const legacyC = JSON.stringify({ url: `${origin.origin}/skew-c`, legacy: true });
      const legacyDigest = sha256BodyDigest(new TextEncoder().encode(legacyC));
      const runnerId = await jobsDb.query<{ runner_job_id: string }>(
        `SELECT runner_job_id FROM jobs.job_record WHERE job_id = $1`,
        [jobIdC],
      );
      const runnerJobId = must(runnerId.rows[0]?.runner_job_id, "job C's runner job id");
      const digestUpdate = await jobsDb.query(
        `UPDATE jobs.job_record SET body_sha256 = $1 WHERE job_id = $2`,
        [legacyDigest, jobIdC],
      );
      expect(digestUpdate.rowCount, "the digest update touched job C's record").toBe(1);
      const dataUpdate = await jobsDb.query(
        `UPDATE pgboss.job SET data = data || '{"legacy": true}'::jsonb WHERE id = $1::uuid`,
        [runnerJobId],
      );
      expect(dataUpdate.rowCount, "the runner-data update touched job C's row").toBe(1);

      // Recovery precedes validation: the older rules' bytes recover the job.
      const replayLegacy = await submit(sessionE, { key: keyC, body: legacyC });
      expect(replayLegacy.status).toBe(202);
      expect(JobAcceptedSchema.parse(replayLegacy.json()).jobId).toBe(jobIdC);
      // The newer rules' bytes are a DIFFERENT input for the same key.
      const replayBodyC = await submit(sessionE, { key: keyC, body: bodyC });
      expect(replayBodyC.status).toBe(409);
      expect(JobRequestErrorSchema.parse(replayBodyC.json()).code).toBe("idempotency_conflict");
      // And the older bytes are unrepresentable as NEW work.
      const unkeyedLegacy = await submit(sessionE, { body: legacyC });
      expect(unkeyedLegacy.status).toBe(400);
      expect(JobRequestErrorSchema.parse(unkeyedLegacy.json()).code).toBe("payload_invalid");

      // Free the slots: job C finally runs, and the CURRENT contract refuses
      // its input at execution time — the same accepted job, a terminal
      // failure, never a re-run of admission.
      holdA.release();
      holdB.release();
      const failed = await pollSnapshot(
        sessionE.api,
        jobIdC,
        (s) => s.status === "failed",
        120_000,
      );
      expect(failed.jobId).toBe(jobIdC);
      expect(failed.error?.code).toBe("execution_input_invalid");
      expect(originGets("/skew-c")).toBe(0);

      // The failed job still recovers by its key and original bytes.
      const replayFailed = await submit(sessionE, { key: keyC, body: legacyC });
      expect(replayFailed.status).toBe(202);
      const replayedFailed = JobAcceptedSchema.parse(replayFailed.json());
      expect(replayedFailed.jobId).toBe(jobIdC);
      expect(replayedFailed.status).toBe("failed");

      expect(await jobCounts(appE.app.id)).toEqual({ records: 3, runnerRows: 3 });
    },
  );
});
