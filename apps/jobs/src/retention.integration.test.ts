import { randomBytes, randomUUID } from "node:crypto";

import { Client as PgClient, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  HealthStatusSchema,
  JOB_TERMINAL_STATUSES,
  JOBS_CLEANUP_CHECK,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  ManifestUpdateResultSchema,
  type App,
  type HealthCheck,
  type HealthStatus,
  type JobSnapshot,
} from "@azx-pbc/shared";

import { type DiagnosticJobInput } from "./diagnostics.js";
import { JOBS_JOB_RECORD_QUALIFIED, JOBS_PGBOSS_SCHEMA } from "./policy.js";
import {
  createLiveApp,
  startJsonOrigin,
  startRealStack,
  waitFor,
  type AppSession,
  type ControlledJsonOrigin,
  type HttpReply,
  type PortalClient,
  type RealStack,
} from "./test/realStack.js";

/**
 * The retention contract, through the REAL running platform (dev IdP, portal,
 * egress, jobs, edge, dev gateway — child processes of the harness): the
 * logical horizons bind at the read path immediately, while the physical
 * bytes are still stored — a result past its seven-day lifetime reads
 * `expired` and answers 410, a record past its thirty-day lifetime reads as
 * an unknown job — for every terminal outcome, with active work never removed
 * by age. The real cleanup loop (`src/cleanup.ts`, on the jobs service's
 * normal boot) later removes the content physically: a result's bytes alone,
 * keeping the record, its retry key and its runner row until the record
 * horizon, then the record and its runner row together in one transaction.
 * After a jobs outage, the first pass removes the overdue backlog and the
 * `jobs_cleanup` check reads degraded until a pass opens on a cleared store.
 * And a cleanup pass racing reuse of a released key cannot delete the
 * replacement job, its runner row or its key mapping.
 *
 * The one stand-in: days passing are simulated by backdating `created_at` /
 * `terminal_at` on `jobs.job_record` rows through the jobs owner DSN — the
 * cleanup loop, the read horizons, the edge gateway and the jobs routes are
 * all the real ones, and no test-only knob exists anywhere in production
 * code. Backdate instants come from the database's own `now()`.
 *
 * The tests run sequentially in file order and share one stack, one app per
 * scenario so the edge's per-app submission window never binds.
 */

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let origin: ControlledJsonOrigin;
let bob: PortalClient;
let alice: PortalClient;
let jobsDb: Pool;
let platformDb: Pool;

type AppKey = "expiry" | "outcomes" | "restore" | "race";
const APP_KEYS: readonly AppKey[] = ["expiry", "outcomes", "restore", "race"];

const apps = {} as Record<AppKey, { app: App; slug: string }>;
const sessions = {} as Record<AppKey, AppSession>;

/** The first scenario's result-expired job — the `expired` outcome of the second scenario's record-retirement leg. */
let expiredJob: { jobId: string; key: string } | undefined;

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`the suite never produced ${what}`);
  return value;
};

const SHORT: DiagnosticJobInput = { steps: 1 };

// ── submission drivers ───────────────────────────────────────────────────────

const DIAGNOSTIC_SUBMIT_PATH = "/_api/jobs/jobs/types/diagnostic";
const FETCH_SUBMIT_PATH = "/_api/jobs/jobs/types/fetch";
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;
const resultPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}/result`;

type ApiClient = AppSession;

const newKey = (role: string): string => `ret-${role}-${randomUUID()}`;

/**
 * One submission attempt — the exact bytes and key a retry of this submit
 * would reuse. A retryable 503 is retried ONCE with the SAME key and the SAME
 * bytes — the keyed-retry rule, whose retained-key comparison recovers the
 * first attempt's job if it was accepted.
 */
async function submitBody(
  client: ApiClient,
  path: string,
  body: string,
  key: string,
): Promise<HttpReply> {
  const attempt = (): Promise<HttpReply> =>
    client.api("POST", path, {
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body,
    });
  const first = await attempt();
  if (first.status === 503) return attempt();
  return first;
}

function submitInput(
  client: ApiClient,
  input: DiagnosticJobInput,
  key: string,
): Promise<HttpReply> {
  return submitBody(client, DIAGNOSTIC_SUBMIT_PATH, JSON.stringify(input), key);
}

/** The 202 body of an acceptance or a keyed recovery. */
function parseAccepted(reply: HttpReply) {
  return JobAcceptedSchema.parse(reply.json());
}

/** The bounded error code a refused reply carries. */
function parseErrorCode(reply: HttpReply): string {
  return JobRequestErrorSchema.parse(reply.json()).code;
}

/**
 * One jobs read through the edge, retrying the retryable 503 — right after a
 * jobs restart the edge's own reachability probe may still be catching up,
 * and a 503 is an observation failure, never an execution one.
 */
async function edgeOperation(
  api: ApiClient["api"],
  method: string,
  path: string,
): Promise<HttpReply> {
  const first = await api(method, path);
  if (first.status !== 503) return first;
  return waitFor(
    stack,
    `the edge to answer ${method} ${path} (a 503 is the retryable unavailability)`,
    { timeoutMs: 30_000 },
    async () => {
      const res = await api(method, path);
      return res.status === 503 ? undefined : res;
    },
  );
}

/** One snapshot read, parsed against the wire schema. */
async function readSnapshot(api: ApiClient["api"], jobId: string): Promise<JobSnapshot> {
  const res = await edgeOperation(api, "GET", statusPath(jobId));
  expect(res.status, `the status read of job ${jobId}`).toBe(200);
  return JobSnapshotSchema.parse(res.json());
}

/**
 * Poll the snapshot until `until` holds. Every poll is parsed against the
 * wire schema; a retryable 503 keeps polling inside the same bound (an
 * observation failure is never an execution failure); anything else non-200
 * fails loudly.
 */
async function pollSnapshot(
  api: ApiClient["api"],
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

// ── health readers ───────────────────────────────────────────────────────────

/** One health read, asserting the always-200 contract every time — the body alone carries the state. */
async function healthOf(name: "jobs" | "edge"): Promise<HealthStatus> {
  const url =
    name === "jobs"
      ? `http://localhost:${stack.ports.jobs}/health`
      : `https://${stack.baseDomain}:${stack.ports.edge}/health`;
  const res = await stack.request(url);
  expect(res.status, `the ${name} /health answers HTTP 200 in every state`).toBe(200);
  return HealthStatusSchema.parse(res.json());
}

/** One named sub-check of a health body — throws when absent, never a silent undefined. */
function check(body: HealthStatus, name: string): HealthCheck {
  const found = body.checks?.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(
      `the ${body.service} health body carries no ${name} check: ${JSON.stringify(body.checks)}`,
    );
  }
  return found;
}

/** The cleanup loop's completed-pass count, from the jobs body's `jobs_cleanup` metrics. */
async function cleanupPasses(): Promise<number> {
  return check(await healthOf("jobs"), JOBS_CLEANUP_CHECK).metrics?.passes ?? 0;
}

/**
 * Wait for a fresh cleanup pass before backdating: the next steady pass is
 * then ~60 s away, so a backdated row cannot be removed by an in-flight pass
 * before the test takes its lock.
 */
async function waitForFreshPass(): Promise<void> {
  const before = await cleanupPasses();
  await waitFor(
    stack,
    "the next cleanup pass to complete (the jobs_cleanup pass count to advance)",
    { timeoutMs: 90_000 },
    async () => ((await cleanupPasses()) > before ? true : undefined),
  );
}

// ── the store, through the jobs owner DSN ────────────────────────────────────

interface RecordRow {
  jobId: string;
  runnerJobId: string | null;
  retryKey: string | null;
  status: string;
  /** `result IS NOT NULL` — the jsonb `null` value counts as present. */
  resultPresent: boolean;
}

const RECORD_COLUMNS = `job_id AS "jobId", runner_job_id AS "runnerJobId", retry_key AS "retryKey",
                        status, result IS NOT NULL AS "resultPresent"`;

async function recordRow(
  jobId: string,
  client: PgClient | Pool = jobsDb,
): Promise<RecordRow | undefined> {
  const res = await client.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
    [jobId],
  );
  return res.rows[0];
}

async function recordRows(jobIds: readonly string[]): Promise<RecordRow[]> {
  const res = await jobsDb.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = ANY($1::text[])`,
    [jobIds],
  );
  return res.rows;
}

async function recordsWithKey(appId: string, retryKey: string): Promise<RecordRow[]> {
  const res = await jobsDb.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM ${JOBS_JOB_RECORD_QUALIFIED}
      WHERE app_id = $1 AND retry_key = $2`,
    [appId, retryKey],
  );
  return res.rows;
}

/** The store's wrapper-record count for one app — the durable side of acceptance. */
async function appRecordCount(appId: string): Promise<number> {
  const res = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`,
    [appId],
  );
  return res.rows[0]?.n ?? 0;
}

async function runnerRowCount(runnerJobIds: readonly string[]): Promise<number> {
  if (runnerJobIds.length === 0) return 0;
  const res = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id = ANY($1::uuid[])`,
    [runnerJobIds],
  );
  return res.rows[0]?.n ?? 0;
}

/**
 * The one stand-in for time passing: backdate the store's own timestamps by
 * the database's `now()`, so the real horizons and the real cleanup loop read
 * the row as aged. A null `terminalAge` leaves `terminal_at` untouched (an
 * active record has none).
 */
async function backdateRecords(
  jobIds: readonly string[],
  createdAge: string,
  terminalAge: string | null,
): Promise<void> {
  if (terminalAge === null) {
    await jobsDb.query(
      `UPDATE ${JOBS_JOB_RECORD_QUALIFIED} SET created_at = now() - $1::interval
        WHERE job_id = ANY($2::text[])`,
      [createdAge, [...jobIds]],
    );
    return;
  }
  await jobsDb.query(
    `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
        SET created_at = now() - $1::interval, terminal_at = now() - $2::interval
      WHERE job_id = ANY($3::text[])`,
    [createdAge, terminalAge, [...jobIds]],
  );
}

/** Is the record's `terminal_at` within the last hour, judged by the database's clock? */
async function terminalAtIsRecent(jobId: string): Promise<boolean> {
  const res = await jobsDb.query<{ recent: boolean }>(
    `SELECT terminal_at > now() - interval '1 hour' AS recent
       FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
    [jobId],
  );
  return res.rows[0]?.recent === true;
}

// ── deterministic control of the cleanup loop ────────────────────────────────

interface RowHold {
  readonly holder: PgClient;
  readonly pid: number;
  release(): Promise<void>;
}

/**
 * Open a dedicated client, take FOR UPDATE locks inside an open transaction,
 * and hand the client back. The open transaction keeps the locks: the cleanup
 * loop's own statement on those rows then blocks, times out against its 10 s
 * statement timeout, and fails the pass — so nothing the loop does commits
 * until `release()`. Plain reads from any session keep working (a plain
 * SELECT takes no row locks).
 */
async function holdRows(lockSql: string, params: unknown[]): Promise<RowHold> {
  const holder = new PgClient({ connectionString: stack.jobsOwnerDsn });
  await holder.connect();
  let released = false;
  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    await holder.query("COMMIT").catch(() => {});
    await holder.end().catch(() => {});
  };
  try {
    await holder.query("BEGIN");
    await holder.query(lockSql, params);
    const pid = await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    return { holder, pid: must(pid.rows[0], "the lock holder's backend pid").pid, release };
  } catch (error) {
    released = true;
    await holder.query("ROLLBACK").catch(() => {});
    await holder.end().catch(() => {});
    throw error;
  }
}

/** Hold record rows against the cleanup loop's result arm (its UPDATE blocks). */
async function holdRecordRows(jobIds: readonly string[]): Promise<RowHold> {
  return holdRows(
    `SELECT job_id FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = ANY($1::text[]) FOR UPDATE`,
    [jobIds],
  );
}

/**
 * Hold runner rows against the record arm's runner delete: the record DELETE
 * succeeds inside the pass's own uncommitted transaction, then the runner
 * delete blocks — the mid-retirement state.
 */
async function holdRunnerRows(runnerJobIds: readonly string[]): Promise<RowHold> {
  return holdRows(
    `SELECT id FROM ${JOBS_PGBOSS_SCHEMA}.job WHERE id = ANY($1::uuid[]) FOR UPDATE`,
    [runnerJobIds],
  );
}

/** Wait until some session's statement is blocked on the held locks. */
async function waitForCleanupBlocked(hold: RowHold): Promise<void> {
  await waitFor(
    stack,
    "the cleanup pass's own statement to block on the held locks",
    { timeoutMs: 90_000 },
    async () => {
      const res = await jobsDb.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
        [hold.pid],
      );
      return (res.rows[0]?.n ?? 0) > 0 ? true : undefined;
    },
  );
}

// ── the edge submission throttle's deployment-wide window ────────────────────

const DEPLOYMENT_BUCKET_KEY = "jobs:submit:deployment";
const DEPLOYMENT_WINDOW_LIMIT = 100;

interface BucketRow {
  count: number;
  /** `"resetAt" <= now()` evaluated by the database — never by this process's clock. */
  resetAtPassed: boolean;
}

async function readBucket(bucketKey: string): Promise<BucketRow | null> {
  const res = await platformDb.query<{ count: number; resetAtPassed: boolean }>(
    `SELECT count, ("resetAt" <= now()) AS "resetAtPassed"
       FROM rate_counters WHERE "bucketKey" = $1`,
    [bucketKey],
  );
  const row = res.rows[0];
  return row === undefined ? null : { count: row.count, resetAtPassed: row.resetAtPassed };
}

/**
 * Before a burst, make sure the deployment-wide submission window has room
 * for it, or wait (bounded) for the window to roll rather than answer an
 * unplanned 429 — a 429 here is a test bug, never an outcome.
 */
async function ensureDeploymentHeadroom(attempts: number): Promise<void> {
  const row = await readBucket(DEPLOYMENT_BUCKET_KEY);
  if (row === null || row.resetAtPassed || row.count + attempts <= DEPLOYMENT_WINDOW_LIMIT) return;
  await waitFor(
    stack,
    "the deployment-wide submission window to reset",
    { timeoutMs: 75_000 },
    async () => {
      const current = await readBucket(DEPLOYMENT_BUCKET_KEY);
      return current === null || current.resetAtPassed ? true : undefined;
    },
  );
}

// ── setup helpers ────────────────────────────────────────────────────────────

/**
 * Create, deploy and promote an app, then grant it exactly the given jobs
 * types and — optionally — the controlled origin as a keyless fetch origin.
 * The jobs types are baseline grants and apply directly; the fetch origin is
 * an elevated grant, so the save opens a pending approval that alice (not the
 * requester) approves.
 */
async function createJobsApp(
  purpose: string,
  jobTypes: readonly string[],
  withFetchOrigin: boolean,
): Promise<{ app: App; slug: string }> {
  const slug = `ret-${purpose}-${randomBytes(3).toString("hex")}`;
  const app = await createLiveApp(stack, bob, {
    slug,
    files: {
      "index.html":
        '<!doctype html><html><head><meta charset="utf-8"><title>jobs retention</title></head>' +
        `<body><p>retention-${purpose}</p></body></html>`,
    },
  });
  const capabilities: {
    mcp: string[];
    externalOrigins: string[];
    fetch: { shim: boolean; origins: Array<{ origin: string }> };
    jobs?: { types: string[] };
  } = { mcp: [], externalOrigins: [], fetch: { shim: false, origins: [] } };
  if (jobTypes.length > 0) capabilities.jobs = { types: [...jobTypes] };
  if (withFetchOrigin) capabilities.fetch.origins = [{ origin: origin.origin }];
  const saved = await bob.put(`/api/v1/apps/${slug}/manifest`, { capabilities });
  expect(saved.status, `the manifest save for ${slug}`).toBe(200);
  const saveResult = ManifestUpdateResultSchema.parse(saved.json());
  if (withFetchOrigin) {
    const pendingId = must(saveResult.pending ?? undefined, `a pending approval id for ${slug}`);
    const approved = await alice.post(`/api/v1/approvals/${pendingId}/approve`);
    expect(approved.status, `the fetch-origin approval for ${slug}`).toBe(200);
  } else {
    expect(saveResult.pending ?? null, `the manifest save for ${slug} applied directly`).toBeNull();
  }
  return { app, slug };
}

// ── lifecycle-delivery wait (the admission gate's precondition) ──────────────

/** The portal `/health` body's lifecycle-delivery reading: pass count and whether every configured target is synchronized. */
async function lifecycleDeliveryReading(): Promise<{ passes: number; synchronized: boolean }> {
  const res = await stack.request(`${stack.portalUrl}/health`);
  expect(res.status, "the portal /health read").toBe(200);
  const body = HealthStatusSchema.parse(res.json());
  const delivery = body.checks?.find((c) => c.name === JOBS_LIFECYCLE_DELIVERY_CHECK);
  const metrics = delivery?.metrics ?? {};
  if (metrics.passes === undefined) return { passes: 0, synchronized: false };
  return {
    passes: metrics.passes,
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

beforeAll(async () => {
  stack = await startRealStack({ label: "retention", diagnostics: true });
  origin = await startJsonOrigin();
  bob = await stack.portalAs("bob@azx.dev");
  alice = await stack.portalAs("alice@azx.dev");

  apps.expiry = await createJobsApp(
    "expiry",
    [JOBS_DIAGNOSTIC_QUALIFIED_TYPE, JOBS_FETCH_QUALIFIED_TYPE],
    true,
  );
  apps.outcomes = await createJobsApp(
    "outcomes",
    [JOBS_DIAGNOSTIC_QUALIFIED_TYPE, JOBS_FETCH_QUALIFIED_TYPE],
    true,
  );
  apps.restore = await createJobsApp("restore", [JOBS_DIAGNOSTIC_QUALIFIED_TYPE], false);
  apps.race = await createJobsApp("race", [JOBS_DIAGNOSTIC_QUALIFIED_TYPE], false);

  // The jobs service admits an app's work only after the portal delivered
  // that app's lifecycle state to it — wait once, after all the apps exist.
  const passesBefore = (await lifecycleDeliveryReading()).passes;
  await waitForLifecycleDelivery(passesBefore);

  for (const key of APP_KEYS) {
    sessions[key] = await stack.appSession(apps[key].slug, "bob@azx.dev");
  }

  jobsDb = new Pool({ connectionString: stack.jobsOwnerDsn, max: 3 });
  platformDb = new Pool({ connectionString: stack.platformOwnerDsn, max: 3 });
}, 480_000);

afterAll(async () => {
  await jobsDb?.end();
  await platformDb?.end();
  await origin?.close();
  if (stack) await stack.close();
}, 120_000);

describe("result expiry at the read horizon", () => {
  test(
    "a result past seven days is unreadable at once while its bytes are still stored, and the real result arm later removes only the bytes",
    { timeout: 600_000 },
    async () => {
      const session = sessions.expiry;
      const appId = apps.expiry.app.id;

      await ensureDeploymentHeadroom(4);

      // Both shapes the result horizon covers: a diagnostic object result,
      // and the fetch type's JSON null — a successful result whose stored
      // bytes are the token `null`, never SQL NULL.
      const kdKey = newKey("kd");
      const kdReply = await submitInput(session, SHORT, kdKey);
      expect(kdReply.status, `the diagnostic submission: ${kdReply.text}`).toBe(202);
      const kd = parseAccepted(kdReply);

      const knKey = newKey("kn");
      origin.respond("/nul", { json: null });
      const knReply = await submitBody(
        session,
        FETCH_SUBMIT_PATH,
        JSON.stringify({ url: `${origin.origin}/nul` }),
        knKey,
      );
      expect(knReply.status, `the fetch submission: ${knReply.text}`).toBe(202);
      const kn = parseAccepted(knReply);

      await pollSnapshot(session.api, kd.jobId, (s) => s.status === "succeeded", 60_000);
      await pollSnapshot(session.api, kn.jobId, (s) => s.status === "succeeded", 60_000);
      const knResult = await session.api("GET", resultPath(kn.jobId));
      expect(knResult.status, "the JSON-null result read before expiry").toBe(200);
      expect(JSON.parse(knResult.text), "the fetch job's result is JSON null").toBeNull();

      const kdRowBefore = must(await recordRow(kd.jobId), "the diagnostic record");
      const knRowBefore = must(await recordRow(kn.jobId), "the fetch record");
      expiredJob = { jobId: kd.jobId, key: kdKey };

      await waitForFreshPass();
      // Past the seven-day result horizon, far inside the thirty-day record
      // horizon. The record-row hold keeps the result arm's UPDATE blocked
      // (its 10 s statement timeout fails the pass, which retries) — the
      // physical bytes cannot move while the logical horizons are asserted.
      await backdateRecords([kd.jobId, kn.jobId], "8 days", "7 days 1 hour");
      const hold = await holdRecordRows([kd.jobId, kn.jobId]);
      try {
        for (const [name, job] of [
          ["diagnostic", kd],
          ["fetch", kn],
        ] as const) {
          const snapshot = await readSnapshot(session.api, job.jobId);
          expect(snapshot.status, `the ${name} job's status past the result horizon`).toBe(
            "expired",
          );
          expect(snapshot.resultExpiresAt, `the ${name} job's resultExpiresAt`).not.toBeNull();
          expect(snapshot.recordExpiresAt, `the ${name} job's recordExpiresAt`).not.toBeNull();
          const result = await session.api("GET", resultPath(job.jobId));
          expect(result.status, `the ${name} job's result read past the horizon`).toBe(410);
          expect(parseErrorCode(result), `the ${name} job's result error code`).toBe(
            "result_expired",
          );
        }

        // The retry key still resolves against the expired record: identical
        // bytes recover it with its current public status; different bytes
        // conflict at any age.
        const identical = await submitInput(session, SHORT, kdKey);
        expect(
          identical.status,
          `the identical replay while the result is physically retained: ${identical.text}`,
        ).toBe(202);
        const identicalAccepted = parseAccepted(identical);
        expect(identicalAccepted.jobId, "the replay recovers the original job").toBe(kd.jobId);
        expect(identicalAccepted.status, "the recovered job's public status").toBe("expired");
        const conflict = await submitInput(session, { steps: 2 }, kdKey);
        expect(conflict.status, `the changed-bytes replay: ${conflict.text}`).toBe(409);
        expect(parseErrorCode(conflict), "the conflict's error code").toBe("idempotency_conflict");

        // Logical expiry ran ahead of physical removal: both rows still store
        // their result — the fetch job's is the jsonb null value, which is
        // SQL-not-null.
        const kdHeld = must(await recordRow(kd.jobId, hold.holder), "the held diagnostic record");
        const knHeld = must(await recordRow(kn.jobId, hold.holder), "the held fetch record");
        expect(
          kdHeld.resultPresent,
          "the diagnostic record's result bytes are still stored while the read horizon has expired them",
        ).toBe(true);
        expect(
          knHeld.resultPresent,
          "the fetch record's result column is SQL-not-null (the jsonb null value) while the read horizon has expired it",
        ).toBe(true);
        expect(await appRecordCount(appId), "the replay and the conflict created no job").toBe(2);
      } finally {
        await hold.release();
      }

      // The real loop's result arm removes the bytes and converges the stored
      // status in the same statement.
      await waitFor(
        stack,
        "the cleanup loop's result arm to remove both stored results",
        { timeoutMs: 150_000 },
        async () => {
          const rows = await recordRows([kd.jobId, kn.jobId]);
          return rows.length === 2 && rows.every((r) => !r.resultPresent && r.status === "expired")
            ? true
            : undefined;
        },
      );

      // The record, its retry key and its runner row survive the result arm.
      const kdRowAfter = must(await recordRow(kd.jobId), "the diagnostic record after removal");
      const knRowAfter = must(await recordRow(kn.jobId), "the fetch record after removal");
      expect(kdRowAfter.retryKey, "the diagnostic record keeps its retry key").toBe(
        kdRowBefore.retryKey,
      );
      expect(kdRowAfter.runnerJobId, "the diagnostic record keeps its runner row").toBe(
        kdRowBefore.runnerJobId,
      );
      expect(knRowAfter.retryKey, "the fetch record keeps its retry key").toBe(
        knRowBefore.retryKey,
      );
      expect(knRowAfter.runnerJobId, "the fetch record keeps its runner row").toBe(
        knRowBefore.runnerJobId,
      );
      const keptRunnerIds = [kdRowAfter, knRowAfter].map((r) =>
        must(r.runnerJobId, "a kept record's runner id"),
      );
      expect(await runnerRowCount(keptRunnerIds), "both runner rows still exist").toBe(2);

      for (const [name, job] of [
        ["diagnostic", kd],
        ["fetch", kn],
      ] as const) {
        const snapshot = await readSnapshot(session.api, job.jobId);
        expect(snapshot.status, `the ${name} job's status after the result removal`).toBe(
          "expired",
        );
        const result = await session.api("GET", resultPath(job.jobId));
        expect(result.status, `the ${name} job's result read after the removal`).toBe(410);
        expect(parseErrorCode(result), `the ${name} job's result error code`).toBe(
          "result_expired",
        );
      }

      const identicalAfter = await submitInput(session, SHORT, kdKey);
      expect(
        identicalAfter.status,
        `the identical replay after the result removal: ${identicalAfter.text}`,
      ).toBe(202);
      expect(parseAccepted(identicalAfter).jobId, "the recovery answers the original job").toBe(
        kd.jobId,
      );
      const conflictAfter = await submitInput(session, { steps: 2 }, kdKey);
      expect(
        conflictAfter.status,
        `the changed-bytes replay after the removal: ${conflictAfter.text}`,
      ).toBe(409);
      expect(parseErrorCode(conflictAfter), "the conflict's error code").toBe(
        "idempotency_conflict",
      );
      expect(await appRecordCount(appId), "the replays after the removal created no job").toBe(2);
    },
  );
});

describe("record expiry for every terminal outcome", () => {
  test(
    "terminal records past thirty days answer 404 while physically retained, are retired with their runner rows together, and active work survives by age",
    { timeout: 600_000 },
    async () => {
      const session = sessions.outcomes;
      const appId = apps.outcomes.app.id;
      // The expired job lives in the expiry app — its reads go through that
      // app's own session scope.
      const expirySession = sessions.expiry;

      await ensureDeploymentHeadroom(6);

      // succeeded
      const ksKey = newKey("ks");
      const ksReply = await submitInput(session, SHORT, ksKey);
      expect(ksReply.status, `the succeeded scenario's submission: ${ksReply.text}`).toBe(202);
      const ks = parseAccepted(ksReply);
      await pollSnapshot(session.api, ks.jobId, (s) => s.status === "succeeded", 60_000);

      // failed — retryLimit 2, so failAtStep: 1 exhausts the three attempts.
      const kfKey = newKey("kf");
      const kfReply = await submitInput(session, { steps: 1, failAtStep: 1 }, kfKey);
      expect(kfReply.status, `the failed scenario's submission: ${kfReply.text}`).toBe(202);
      const kf = parseAccepted(kfReply);
      await pollSnapshot(session.api, kf.jobId, (s) => s.status === "failed", 120_000);

      // cancelled
      const kcKey = newKey("kc");
      const kcReply = await submitInput(session, { steps: 20, stepDelayMs: 1000 }, kcKey);
      expect(kcReply.status, `the cancelled scenario's submission: ${kcReply.text}`).toBe(202);
      const kc = parseAccepted(kcReply);
      await pollSnapshot(session.api, kc.jobId, (s) => s.status === "running", 60_000);
      const cancel = await session.api("DELETE", statusPath(kc.jobId));
      expect(cancel.status, `the cancellation of the running job: ${cancel.text}`).toBe(202);
      await pollSnapshot(session.api, kc.jobId, (s) => s.status === "cancelled", 60_000);

      // crashed — a held outbound fetch, the worker SIGKILLed mid-attempt;
      // pg-boss's heartbeat detects the lost claim and the recovery sweeper
      // projects the outcome.
      const kxKey = newKey("kx");
      const crashHold = origin.hold("/crash");
      origin.respond("/crash", { json: { crash: true } });
      const kxReply = await submitBody(
        session,
        FETCH_SUBMIT_PATH,
        JSON.stringify({ url: `${origin.origin}/crash` }),
        kxKey,
      );
      expect(kxReply.status, `the crashed scenario's submission: ${kxReply.text}`).toBe(202);
      const kx = parseAccepted(kxReply);
      try {
        await waitFor(
          stack,
          "the fetch job's outbound GET to reach the origin at /crash",
          { timeoutMs: 60_000 },
          async () => (origin.requests.some((r) => r.path === "/crash") ? true : undefined),
        );
        await crashHold.arrived;
        await stack.crash("jobs");
        await stack.start("jobs");
        const kxFinal = await pollSnapshot(
          session.api,
          kx.jobId,
          (s) => (JOB_TERMINAL_STATUSES as readonly string[]).includes(s.status),
          180_000,
        );
        expect(kxFinal.status, "the SIGKILLed fetch job's terminal outcome").toBe("crashed");
      } finally {
        crashHold.release();
      }

      // active — backdate ONLY its created_at: it has no terminal_at, and no
      // age may remove active work.
      const kaKey = newKey("ka");
      const kaReply = await submitInput(session, { steps: 20, stepDelayMs: 1000 }, kaKey);
      expect(kaReply.status, `the active scenario's submission: ${kaReply.text}`).toBe(202);
      const ka = parseAccepted(kaReply);
      await pollSnapshot(session.api, ka.jobId, (s) => s.status === "running", 60_000);
      await backdateRecords([ka.jobId], "40 days", null);

      // The expired outcome is the result-expired job from the first scenario.
      const retired = [
        { jobId: ks.jobId, key: ksKey, appId, session },
        { jobId: kf.jobId, key: kfKey, appId, session },
        { jobId: kc.jobId, key: kcKey, appId, session },
        { jobId: kx.jobId, key: kxKey, appId, session },
        {
          jobId: must(expiredJob?.jobId, "the result-expired job's id from the first scenario"),
          key: must(expiredJob?.key, "the result-expired job's key"),
          appId: apps.expiry.app.id,
          session: expirySession,
        },
      ];
      const retiredIds = retired.map((r) => r.jobId);

      await waitForFreshPass();
      await backdateRecords(retiredIds, "32 days", "31 days");
      const runnerIds = (await recordRows(retiredIds)).map((r) =>
        must(r.runnerJobId, "a terminal record's runner id"),
      );
      const hold = await holdRunnerRows(runnerIds);
      try {
        await waitForCleanupBlocked(hold);

        // The read horizon is instant, whatever the physical state: every
        // retired record answers the unknown-job 404, and its result 404 too.
        for (const job of retired) {
          const status = await job.session.api("GET", statusPath(job.jobId));
          expect(status.status, `the status read of retired job ${job.jobId}`).toBe(404);
          expect(parseErrorCode(status), `the status read's error code for ${job.jobId}`).toBe(
            "job_not_found",
          );
          const result = await job.session.api("GET", resultPath(job.jobId));
          expect(result.status, `the result read of retired job ${job.jobId}`).toBe(404);
        }

        // The key's claim is still the record's: an identical replay is the
        // unreadable 404 (no work created), different bytes still conflict.
        const identicalReplay = await submitInput(session, SHORT, ksKey);
        expect(
          identicalReplay.status,
          `the identical replay past the record horizon: ${identicalReplay.text}`,
        ).toBe(404);
        expect(parseErrorCode(identicalReplay), "the replay's error code").toBe("job_not_found");
        const conflictReplay = await submitInput(session, { steps: 2 }, ksKey);
        expect(
          conflictReplay.status,
          `the changed-bytes replay past the horizon: ${conflictReplay.text}`,
        ).toBe(409);
        expect(parseErrorCode(conflictReplay), "the conflict's error code").toBe(
          "idempotency_conflict",
        );

        // Mid-retirement, the records are still physically present (the
        // deletion is uncommitted), and the replays created nothing new.
        for (const jobId of retiredIds) {
          const row = await recordRow(jobId, hold.holder);
          expect(
            row,
            `the record ${jobId} is still physically present under the hold`,
          ).toBeDefined();
        }
        for (const job of retired) {
          expect(
            await recordsWithKey(job.appId, job.key),
            `the key ${job.key} still maps to exactly its retired record`,
          ).toHaveLength(1);
        }
      } finally {
        await hold.release();
      }

      // The record arm retires every record together with its runner row.
      await waitFor(
        stack,
        "the cleanup loop's record arm to retire the terminal records with their runner rows",
        { timeoutMs: 150_000 },
        async () => {
          const rows = await recordRows(retiredIds);
          if (rows.length > 0) return undefined;
          return (await runnerRowCount(runnerIds)) === 0 ? true : undefined;
        },
      );

      // Active work was never pruned by age: the record and its runner row
      // survive the pass that retired the terminal ones. If the recovery
      // sweeper's absolute deadline made it terminal meanwhile, the terminal
      // instant is its own — recent, never the backdated age.
      const kaRow = must(
        await recordRow(ka.jobId),
        "the active job's record after the retirement pass",
      );
      const kaSnapshot = await readSnapshot(session.api, ka.jobId);
      if ((JOB_TERMINAL_STATUSES as readonly string[]).includes(kaSnapshot.status)) {
        expect(
          await terminalAtIsRecent(ka.jobId),
          "a backdated active job that turned terminal carries its own recent terminal instant",
        ).toBe(true);
      }
      expect(
        await runnerRowCount([must(kaRow.runnerJobId, "the active job's runner id")]),
        "the active job's runner row survives the retirement pass",
      ).toBe(1);

      // With the record physically gone, the key is free: the identical
      // replay is a NEW acceptance.
      await ensureDeploymentHeadroom(2);
      const reuseReplay = await submitInput(session, SHORT, ksKey);
      expect(reuseReplay.status, `the replay after the physical removal: ${reuseReplay.text}`).toBe(
        202,
      );
      const reused = parseAccepted(reuseReplay);
      expect(reused.jobId, "the freed key accepts a new job").not.toBe(ks.jobId);
      expect(
        await recordsWithKey(appId, ksKey),
        "exactly one record exists for the reused key",
      ).toHaveLength(1);
    },
  );
});

describe("service restoration", () => {
  test(
    "after an outage the first pass removes the overdue content and jobs_cleanup reads degraded until a pass opens on a cleared store",
    { timeout: 600_000 },
    async () => {
      const session = sessions.restore;

      await ensureDeploymentHeadroom(2);
      const k1Key = newKey("k1");
      const k1Reply = await submitInput(session, SHORT, k1Key);
      expect(k1Reply.status, `the first restoration job's submission: ${k1Reply.text}`).toBe(202);
      const k1 = parseAccepted(k1Reply);
      const k2Key = newKey("k2");
      const k2Reply = await submitInput(session, SHORT, k2Key);
      expect(k2Reply.status, `the second restoration job's submission: ${k2Reply.text}`).toBe(202);
      const k2 = parseAccepted(k2Reply);
      await pollSnapshot(session.api, k1.jobId, (s) => s.status === "succeeded", 60_000);
      await pollSnapshot(session.api, k2.jobId, (s) => s.status === "succeeded", 60_000);
      const k2RunnerId = must(
        (await recordRow(k2.jobId))?.runnerJobId,
        "the second restoration job's runner id",
      );

      // Backdate while the loop cannot run: past the seven-day result horizon
      // plus the 48-hour removal grace (217 h — overdue result, readable
      // record), and past the thirty-day record horizon plus the grace
      // (769 h — overdue record).
      await stack.stop("jobs");
      await backdateRecords([k1.jobId], "218 hours", "217 hours");
      await backdateRecords([k2.jobId], "770 hours", "769 hours");
      // The degraded body would never satisfy the readiness wait.
      await stack.start("jobs", { until: "listener" });

      await waitFor(
        stack,
        "the jobs_cleanup check to read degraded with the overdue detail after the first post-restoration pass",
        { timeoutMs: 120_000 },
        async () => {
          const cleanup = check(await healthOf("jobs"), JOBS_CLEANUP_CHECK);
          return cleanup.status === "degraded" &&
            (cleanup.metrics?.passes ?? 0) >= 1 &&
            (cleanup.detail ?? "").includes("overdue")
            ? cleanup
            : undefined;
        },
      );

      // The first pass already did the removals: the overdue result's bytes
      // are gone and the overdue record retired with its runner row.
      const k1Row = must(await recordRow(k1.jobId), "the first job's record after the first pass");
      expect(k1Row.resultPresent, "the overdue result's bytes were removed by the first pass").toBe(
        false,
      );
      expect(k1Row.status, "the first job's stored status converged to expired").toBe("expired");
      expect(
        await recordRow(k2.jobId),
        "the overdue record was retired by the first pass",
      ).toBeUndefined();
      expect(
        await runnerRowCount([k2RunnerId]),
        "the overdue record's runner row was retired with it",
      ).toBe(0);

      // Nothing was extended: the logically expired content stays unreadable
      // while the check degrades.
      const k1Snapshot = await readSnapshot(session.api, k1.jobId);
      expect(k1Snapshot.status, "the first job's status while the check degrades").toBe("expired");
      const k1Result = await session.api("GET", resultPath(k1.jobId));
      expect(k1Result.status, "the first job's result read while the check degrades").toBe(410);
      expect(parseErrorCode(k1Result), "the first job's result error code").toBe("result_expired");
      const k2Status = await session.api("GET", statusPath(k2.jobId));
      expect(k2Status.status, "the second job's status while the check degrades").toBe(404);
      expect(parseErrorCode(k2Status), "the second job's status error code").toBe("job_not_found");

      await waitFor(
        stack,
        "the jobs_cleanup check to read ok again with the pass's removal counts",
        { timeoutMs: 150_000 },
        async () => {
          const cleanup = check(await healthOf("jobs"), JOBS_CLEANUP_CHECK);
          return cleanup.status === "ok" &&
            (cleanup.metrics?.resultsRemoved ?? 0) >= 1 &&
            (cleanup.metrics?.recordsRetired ?? 0) >= 1
            ? cleanup
            : undefined;
        },
      );

      // Leave a healthy stack for the next scenario.
      await waitFor(
        stack,
        "the jobs /health body to read ok after the restoration",
        { timeoutMs: 120_000 },
        async () => ((await healthOf("jobs")).status === "ok" ? true : undefined),
      );
    },
  );
});

describe("cleanup racing key reuse", () => {
  test(
    "a cleanup pass blocked mid-retirement never deletes the replacement job a replayed key creates",
    { timeout: 600_000 },
    async () => {
      const session = sessions.race;
      const appId = apps.race.app.id;

      await ensureDeploymentHeadroom(2);
      const krKey = newKey("kr");
      const krReply = await submitInput(session, SHORT, krKey);
      expect(krReply.status, `the raced key's first submission: ${krReply.text}`).toBe(202);
      const old = parseAccepted(krReply);
      await pollSnapshot(session.api, old.jobId, (s) => s.status === "succeeded", 60_000);
      const oldRunnerId = must(
        (await recordRow(old.jobId))?.runnerJobId,
        "the original job's runner id",
      );

      await waitForFreshPass();
      await backdateRecords([old.jobId], "32 days", "31 days");
      const hold = await holdRunnerRows([oldRunnerId]);
      let replacementJobId: string | null = null;
      try {
        await waitForCleanupBlocked(hold);

        // The record's deletion is uncommitted: the replay sees the retained
        // (but past-horizon) mapping and answers the unreadable 404.
        const blockedReplay = await submitInput(session, SHORT, krKey);
        expect(
          blockedReplay.status,
          `the replay while the record is mid-retirement: ${blockedReplay.text}`,
        ).toBe(404);
        expect(parseErrorCode(blockedReplay), "the mid-retirement replay's error code").toBe(
          "job_not_found",
        );
        expect(
          await recordsWithKey(appId, krKey),
          "exactly the original record exists for the key",
        ).toHaveLength(1);

        // The race: replays launched while the hold stands, the hold released
        // under them. Whatever interleaving results, no answer may conflict or
        // fail internally, and every acceptance must name the ONE replacement.
        await ensureDeploymentHeadroom(4);
        // A blocked pass rolls back at its statement timeout and retries, so
        // wait for a blocked attempt again: the release must land under one.
        await waitForCleanupBlocked(hold);
        const raced = Array.from({ length: 4 }, () => submitInput(session, SHORT, krKey));
        await hold.release();
        const racedReplies = await Promise.all(raced);
        for (const [attempt, reply] of racedReplies.entries()) {
          if (reply.status === 202) {
            const accepted = parseAccepted(reply);
            expect(
              accepted.jobId,
              "a raced acceptance never carries the retired job's id",
            ).not.toBe(old.jobId);
            if (replacementJobId === null) replacementJobId = accepted.jobId;
            expect(accepted.jobId, "every raced acceptance answers the same replacement job").toBe(
              replacementJobId,
            );
          } else {
            expect(
              [404, 503],
              `raced replay ${attempt + 1} is a 404 or an uncertain 503: ${reply.status} ${reply.text}`,
            ).toContain(reply.status);
            if (reply.status === 404) {
              expect(parseErrorCode(reply), `raced replay ${attempt + 1}'s error code`).toBe(
                "job_not_found",
              );
            }
          }
        }
      } finally {
        await hold.release();
      }

      await waitFor(
        stack,
        "the original record and its runner row to be gone",
        { timeoutMs: 150_000 },
        async () => {
          const recordGone = (await recordRow(old.jobId)) === undefined;
          const runnerGone = (await runnerRowCount([oldRunnerId])) === 0;
          return recordGone && runnerGone ? true : undefined;
        },
      );

      if (replacementJobId === null) {
        const followUp = await submitInput(session, SHORT, krKey);
        expect(followUp.status, `the follow-up replay after the removal: ${followUp.text}`).toBe(
          202,
        );
        const followUpAccepted = parseAccepted(followUp);
        expect(followUpAccepted.jobId, "the follow-up replay is not the retired job").not.toBe(
          old.jobId,
        );
        replacementJobId = followUpAccepted.jobId;
      }
      const newRunnerId = must(
        (await recordRow(replacementJobId))?.runnerJobId,
        "the replacement job's runner id",
      );
      expect(
        await recordsWithKey(appId, krKey),
        "exactly one record exists for the reused key",
      ).toHaveLength(1);
      expect(await runnerRowCount([newRunnerId]), "the replacement job's runner row exists").toBe(
        1,
      );

      // Further passes over the replacement remove nothing: restart (the boot
      // pass runs immediately) and wait for two more cadenced passes.
      await pollSnapshot(session.api, replacementJobId, (s) => s.status === "succeeded", 60_000);
      await stack.restart("jobs");
      const passesAfterRestart = await cleanupPasses();
      await waitFor(
        stack,
        "two further cleanup passes to run after the restart",
        { timeoutMs: 200_000 },
        async () => ((await cleanupPasses()) >= passesAfterRestart + 2 ? true : undefined),
      );

      const keptRow = must(
        await recordRow(replacementJobId),
        "the replacement record after the further passes",
      );
      expect(keptRow.retryKey, "the replacement keeps the retry key").toBe(krKey);
      expect(
        await runnerRowCount([
          must(keptRow.runnerJobId, "the replacement's runner id after the passes"),
        ]),
        "the replacement's runner row survives the further passes",
      ).toBe(1);
      const keptSnapshot = await readSnapshot(session.api, replacementJobId);
      expect(keptSnapshot.status, "the replacement's status after the further passes").toBe(
        "succeeded",
      );
      const keptResult = await session.api("GET", resultPath(replacementJobId));
      expect(keptResult.status, "the replacement's result read after the further passes").toBe(200);

      await ensureDeploymentHeadroom(2);
      const keptIdentical = await submitInput(session, SHORT, krKey);
      expect(
        keptIdentical.status,
        `the identical replay after the further passes: ${keptIdentical.text}`,
      ).toBe(202);
      expect(parseAccepted(keptIdentical).jobId, "the recovery answers the replacement").toBe(
        replacementJobId,
      );
      const keptConflict = await submitInput(session, { steps: 2 }, krKey);
      expect(
        keptConflict.status,
        `the changed-bytes replay on the replacement: ${keptConflict.text}`,
      ).toBe(409);
      expect(parseErrorCode(keptConflict), "the conflict's error code").toBe(
        "idempotency_conflict",
      );
    },
  );
});
