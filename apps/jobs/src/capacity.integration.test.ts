import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  HealthStatusSchema,
  JOBS_CAPACITY_CHECK,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_INTAKE_CHECK,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOB_TERMINAL_STATUSES,
  JOBS_WORKER_CHECK,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  ManifestUpdateResultSchema,
  type App,
  type HealthCheck,
  type HealthStatus,
  type JobAccepted,
  type JobSnapshot,
} from "@azx-pbc/shared";
import { ATTR_OUTCOME, INSTR_JOBS_SUBMISSIONS, SPAN_JOBS_SUBMIT } from "@azx-pbc/shared/telemetry";

import { type DiagnosticJobInput } from "./diagnostics.js";
import { JOBS_JOB_RECORD_QUALIFIED } from "./policy.js";
import {
  createLiveApp,
  startRealStack,
  waitFor,
  type AppSession,
  type DevClient,
  type HttpReply,
  type PortalClient,
  type RealStack,
} from "./test/realStack.js";

/**
 * Capacity protections for the background-jobs plane, through the REAL running
 * platform (dev IdP, portal, egress, jobs, edge, dev gateway — all child
 * processes): the edge submission throttle's fixed window under a refusal
 * flood, the per-app unfinished cap under concurrent contention, lowered
 * limits and a closed intake evicting nothing, retained-storage saturation
 * degrading the capacity check while reads and recovery continue, and physical
 * cleanup releasing retained capacity for new work — with the refusals and
 * recoveries visible in the exported telemetry and no retry key ever reaching
 * a log line or a telemetry payload.
 *
 * The edge's submission throttle defaults to ten attempts per app/environment
 * per 60-second fixed window and one hundred per window deployment-wide, and
 * every authenticated attempt is charged — invalid input, replays, refusals,
 * and the throttled attempts themselves. One scenario retunes it through
 * `EDGE_JOBS_LIMITS` on both gateways and restores the defaults. Each scenario gets
 * its own app, every burst checks the deployment-wide window's room first, and
 * a window's reset instant is compared against the platform database's own
 * `now()` — the counters live in its `rate_counters` table, and the test
 * process's clock is nobody's authority.
 *
 * The tests run sequentially in file order and share one stack; each leaves
 * the stack on its default configuration for the next. The telemetry scan is
 * the last test because a service flushes its final export batch at shutdown.
 */

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let bob: PortalClient;
let jobsDb: Pool;
let platformDb: Pool;

/** Every Idempotency-Key the suite has ever sent — the final privacy scan's population. */
const usedKeys = new Set<string>();

type AppKey = "throttle" | "tuned" | "contend" | "lowered" | "retained";
const APP_KEYS: readonly AppKey[] = ["throttle", "tuned", "contend", "lowered", "retained"];

const apps = {} as Record<AppKey, { app: App; slug: string }>;
const sessions = {} as Record<AppKey, AppSession>;

/** The lowered scenario's retained keys and job ids — the closed-intake leg replays and re-reads them. */
let loweredKeys: string[] = [];
let loweredJobIds: string[] = [];

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`the suite never produced ${what}`);
  return value;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const SHORT: DiagnosticJobInput = { steps: 1 };

// ── submission drivers ───────────────────────────────────────────────────────

const SUBMIT_PATH = "/_api/jobs/jobs/types/diagnostic";
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;
const resultPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}/result`;

/** An app session on the edge or a dev-token client on the dev gateway. */
type ApiClient = Pick<DevClient, "api">;

const newKey = (): string => `cap-${randomUUID()}`;

/**
 * One submission attempt — the exact bytes and key a retry of this submit
 * would reuse. Every key the suite sends passes through here, so the privacy
 * scan's population is complete by construction.
 */
function submitBody(client: ApiClient, body: string, key: string): Promise<HttpReply> {
  usedKeys.add(key);
  return client.api("POST", SUBMIT_PATH, {
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body,
  });
}

function submitInput(
  client: ApiClient,
  input: DiagnosticJobInput,
  key: string,
): Promise<HttpReply> {
  return submitBody(client, JSON.stringify(input), key);
}

/** The 202 body of an acceptance or a keyed recovery. */
function parseAccepted(reply: HttpReply): JobAccepted {
  return JobAcceptedSchema.parse(reply.json());
}

/** The bounded error code a refused reply carries. */
function parseErrorCode(reply: HttpReply): string {
  return JobRequestErrorSchema.parse(reply.json()).code;
}

// ── health, store and ledger readers ─────────────────────────────────────────

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

/** The store's wrapper-record count for one app — the durable side of acceptance. */
async function appRecordCount(appId: string): Promise<number> {
  const res = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`,
    [appId],
  );
  return res.rows[0]?.n ?? 0;
}

/** The store's wrapper-record count, whole deployment. */
async function storeRecordCount(): Promise<number> {
  const res = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}`,
  );
  return res.rows[0]?.n ?? 0;
}

/** The store's non-terminal wrapper-record count, whole deployment — the unfinished occupancy. */
async function storeUnfinishedCount(): Promise<number> {
  const res = await jobsDb.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE NOT (status = ANY($1::text[]))`,
    [[...JOB_TERMINAL_STATUSES]],
  );
  return res.rows[0]?.n ?? 0;
}

// ── the edge submission throttle's durable counters ──────────────────────────

const DEPLOYMENT_BUCKET_KEY = "jobs:submit:deployment";
const DEPLOYMENT_WINDOW_LIMIT = 100;

interface BucketRow {
  count: number;
  resetAt: Date;
  /** `"resetAt" <= now()` evaluated by the database — never by this process's clock. */
  resetAtPassed: boolean;
}

async function readBucket(bucketKey: string): Promise<BucketRow | null> {
  const res = await platformDb.query<{ count: number; resetAt: Date; resetAtPassed: boolean }>(
    `SELECT count, "resetAt", ("resetAt" <= now()) AS "resetAtPassed"
       FROM rate_counters WHERE "bucketKey" = $1`,
    [bucketKey],
  );
  const row = res.rows[0];
  return row === undefined
    ? null
    : { count: row.count, resetAt: row.resetAt, resetAtPassed: row.resetAtPassed };
}

const appBucketKey = (appId: string): string => `jobs:submit:app:prod:${appId}`;

/**
 * The deployment-wide window is shared by every app in this file: before a
 * burst, make sure the window has room for it, or wait (bounded) for the
 * window to roll rather than answer an unplanned 429.
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

/** The edge's request-ledger counts for one app's jobs calls: the throttle-refusal rows and the total. */
async function ledgerCounts(appId: string): Promise<{ refused: number; total: number }> {
  const res = await platformDb.query<{ refused: number; total: number }>(
    `SELECT count(*) FILTER (WHERE "errorDetail" = 'rate_limited')::int AS refused,
            count(*)::int AS total
       FROM gateway_calls
      WHERE "appId" = $1 AND capability = 'jobs'`,
    [appId],
  );
  const row = res.rows[0];
  return { refused: row?.refused ?? 0, total: row?.total ?? 0 };
}

/**
 * The ledger's writes are asynchronous and best-effort: wait until two reads
 * a second apart agree, so the assertion sees the settled counts.
 */
async function stableLedgerCounts(appId: string): Promise<{ refused: number; total: number }> {
  return waitFor(
    stack,
    "the edge's request-ledger rows to settle",
    { timeoutMs: 30_000 },
    async () => {
      const first = await ledgerCounts(appId);
      await sleep(1_000);
      const second = await ledgerCounts(appId);
      return first.refused === second.refused && first.total === second.total ? second : undefined;
    },
  );
}

// ── setup helpers ────────────────────────────────────────────────────────────

/**
 * Save an app's capabilities with exactly the jobs types given (and no fetch
 * origins) — the SPA capability editor's save body for these choices. The
 * jobs capability block is present only while it names at least one type (the
 * wire contract refuses an empty one). A jobs type is a baseline grant, so
 * the save applies directly with no pending approval.
 */
async function saveCapabilities(slug: string, jobTypes: readonly string[]): Promise<void> {
  const capabilities: {
    mcp: string[];
    externalOrigins: string[];
    fetch: { shim: boolean; origins: string[] };
    jobs?: { types: string[] };
  } = { mcp: [], externalOrigins: [], fetch: { shim: false, origins: [] } };
  if (jobTypes.length > 0) capabilities.jobs = { types: [...jobTypes] };
  const saved = await bob.put(`/api/v1/apps/${slug}/manifest`, { capabilities });
  expect(saved.status, `the manifest save for ${slug}`).toBe(200);
  const saveResult = ManifestUpdateResultSchema.parse(saved.json());
  expect(saveResult.pending ?? null, `the manifest save for ${slug} applied directly`).toBeNull();
}

/** Create, deploy and promote an app, then grant it ONLY the diagnostic type. */
async function createDiagnosticApp(purpose: string): Promise<{ app: App; slug: string }> {
  // The slug is a lowercase DNS label; the scenario keys are lowercase already.
  const slug = `cap-${purpose}-${randomBytes(3).toString("hex")}`;
  const app = await createLiveApp(stack, bob, {
    slug,
    files: {
      "index.html":
        '<!doctype html><html><head><meta charset="utf-8"><title>jobs capacity</title></head>' +
        `<body><p>capacity-${purpose}</p></body></html>`,
    },
  });
  await saveCapabilities(slug, [JOBS_DIAGNOSTIC_QUALIFIED_TYPE]);
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

// ── OTLP/JSON capture parsing ────────────────────────────────────────────────

type OtlpAttributes = ReadonlyArray<{ key?: unknown; value?: { stringValue?: unknown } }>;

function attrText(attributes: unknown, key: string): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (const entry of attributes as OtlpAttributes) {
    if (entry.key === key && typeof entry.value?.stringValue === "string") {
      return entry.value.stringValue;
    }
  }
  return undefined;
}

/** Does one OTLP/JSON metrics payload carry the instrument with a data point attributed `key = value`? */
function metricHasDataPoint(body: string, instrument: string, key: string, value: string): boolean {
  const parsed = JSON.parse(body) as {
    resourceMetrics?: Array<{
      scopeMetrics?: Array<{
        metrics?: Array<{
          name?: unknown;
          sum?: { dataPoints?: Array<{ attributes?: unknown }> };
        }>;
      }>;
    }>;
  };
  for (const rm of parsed.resourceMetrics ?? []) {
    for (const scope of rm.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        if (metric.name !== instrument) continue;
        for (const point of metric.sum?.dataPoints ?? []) {
          if (attrText(point.attributes, key) === value) return true;
        }
      }
    }
  }
  return false;
}

/** The `helix.outcome` values every span named `spanName` in one traces payload carries. */
function spanOutcomesIn(body: string, spanName: string): string[] {
  const parsed = JSON.parse(body) as {
    resourceSpans?: Array<{
      scopeSpans?: Array<{ spans?: Array<{ name?: unknown; attributes?: unknown }> }>;
    }>;
  };
  const outcomes: string[] = [];
  for (const rs of parsed.resourceSpans ?? []) {
    for (const scope of rs.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        if (span.name !== spanName) continue;
        const outcome = attrText(span.attributes, ATTR_OUTCOME);
        if (outcome !== undefined) outcomes.push(outcome);
      }
    }
  }
  return outcomes;
}

// ── the suite ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  stack = await startRealStack({ label: "capacity", diagnostics: true, telemetry: true });

  bob = await stack.portalAs("bob@azx.dev");

  for (const key of APP_KEYS) {
    apps[key] = await createDiagnosticApp(key);
  }

  // The jobs service admits an app's work only after the portal delivered
  // that app's lifecycle state to it — wait once, after all the apps exist.
  const passesBefore = (await lifecycleDeliveryReading()).passes;
  await waitForLifecycleDelivery(passesBefore);

  for (const key of APP_KEYS) {
    sessions[key] = await stack.appSession(apps[key].slug, "bob@azx.dev");
  }

  jobsDb = new Pool({ connectionString: stack.jobsOwnerDsn, max: 3 });
  platformDb = new Pool({ connectionString: stack.platformOwnerDsn, max: 3 });
}, 420_000);

afterAll(async () => {
  await jobsDb?.end();
  await platformDb?.end();
  if (stack) await stack.close();
}, 120_000);

describe("the submission throttle", () => {
  test(
    "a refusal flood is refused 429 rate_limited without forwarding, extends nothing, writes bounded ledger rows, and the window reset admits the same key",
    { timeout: 240_000 },
    async () => {
      const session = sessions.throttle;
      const appId = apps.throttle.app.id;

      await healthOf("jobs");
      const edgeBefore = await healthOf("edge");
      await ensureDeploymentHeadroom(45);

      // Exactly ten charged attempts, sequential: two invalid inputs, one
      // keyed acceptance, its identical replay, six more acceptances.
      const invalid = await submitBody(session, JSON.stringify({ steps: 0 }), newKey());
      expect(invalid.status, `the invalid input's submission: ${invalid.text}`).toBe(400);
      expect(parseErrorCode(invalid), "the invalid input's error code").toBe("payload_invalid");
      const invalidTwo = await submitBody(session, JSON.stringify({ steps: 0 }), newKey());
      expect(invalidTwo.status, `the second invalid input's submission: ${invalidTwo.text}`).toBe(
        400,
      );

      const key1 = newKey();
      const k1Reply = await submitInput(session, SHORT, key1);
      expect(k1Reply.status, `the keyed short job's submission: ${k1Reply.text}`).toBe(202);
      const k1 = parseAccepted(k1Reply);

      const k1Replay = await submitInput(session, SHORT, key1);
      expect(k1Replay.status, `the identical replay of the keyed job: ${k1Replay.text}`).toBe(202);
      expect(parseAccepted(k1Replay).jobId, "the replay recovered the original job").toBe(k1.jobId);

      for (let i = 0; i < 6; i++) {
        const reply = await submitInput(session, SHORT, newKey());
        expect(reply.status, `short job ${i + 1}'s submission: ${reply.text}`).toBe(202);
      }

      const bucketAtTen = must(await readBucket(appBucketKey(appId)), "the app's throttle bucket");
      expect(bucketAtTen.count, "exactly ten authenticated attempts are charged").toBe(10);
      const windowResetAt = bucketAtTen.resetAt;

      expect(
        await appRecordCount(appId),
        "the store holds the seven accepted jobs (the invalid inputs and the replay created nothing)",
      ).toBe(7);

      // The flood: thirty more attempts in parallel — ten replays of the
      // accepted key, twenty fresh keys — every one refused locally.
      const keyR = newKey();
      const floodKeys: string[] = [keyR, ...Array.from({ length: 19 }, () => newKey())];
      const flood = await Promise.all([
        ...Array.from({ length: 10 }, () => submitInput(session, SHORT, key1)),
        ...floodKeys.map((key) => submitInput(session, SHORT, key)),
      ]);
      for (const [attempt, reply] of flood.entries()) {
        expect(
          reply.status,
          `flood attempt ${attempt + 1} is refused 429: ${reply.status} ${reply.text}`,
        ).toBe(429);
        expect(parseErrorCode(reply), `flood attempt ${attempt + 1}'s error code`).toBe(
          "rate_limited",
        );
      }

      expect(
        await appRecordCount(appId),
        "the flood was never forwarded — the store holds exactly the seven jobs",
      ).toBe(7);
      const bucketAtFlood = must(
        await readBucket(appBucketKey(appId)),
        "the app's throttle bucket after the flood",
      );
      expect(
        bucketAtFlood.count,
        "the refused attempts are charged too — forty in the window",
      ).toBe(40);
      expect(
        bucketAtFlood.resetAt.getTime(),
        "refusals extend nothing — the window ends where it started",
      ).toBe(windowResetAt.getTime());

      // Reads are never charged: the keyed job's status and result answer
      // while the submission window is exhausted.
      await pollSnapshot(session.api, k1.jobId, (s) => s.status === "succeeded", 30_000);
      const resultWhile = await session.api("GET", resultPath(k1.jobId));
      expect(resultWhile.status, "the result read while throttled").toBe(200);

      const ledger = await stableLedgerCounts(appId);
      expect(
        ledger.refused,
        "the flood's refusal ledger rows (bounded — not one per attempt)",
      ).toBeGreaterThanOrEqual(1);
      expect(
        ledger.refused,
        "the flood's refusal ledger rows stay inside the 20-row denial budget",
      ).toBeLessThanOrEqual(20);
      expect(
        ledger.total,
        "the app's total ledger rows: ten charged attempts plus the bounded refusal rows",
      ).toBeLessThanOrEqual(30);

      // An ordinary busy refusal degrades nothing on either service.
      const jobsAfter = await healthOf("jobs");
      expect(check(jobsAfter, JOBS_CAPACITY_CHECK).status, "jobs_capacity after the flood").toBe(
        "ok",
      );
      expect(check(jobsAfter, JOBS_WORKER_CHECK).status, "jobs_worker after the flood").toBe("ok");
      const edgeAfter = await healthOf("edge");
      expect(
        (edgeAfter.checks ?? []).map((c) => `${c.name}:${c.status}`),
        "the edge's own checks are unchanged by the flood",
      ).toEqual((edgeBefore.checks ?? []).map((c) => `${c.name}:${c.status}`));
      expect(edgeAfter.status, "the edge's roll-up is unchanged by the flood").toBe(
        edgeBefore.status,
      );

      await waitFor(
        stack,
        "the app's submission window to reset",
        { timeoutMs: 75_000 },
        async () => {
          const bucket = await readBucket(appBucketKey(appId));
          return bucket === null || bucket.resetAtPassed ? true : undefined;
        },
      );
      await ensureDeploymentHeadroom(2);

      // The reset admits the refused key as NEW work and keeps the original
      // key's claim.
      const krRetry = await submitInput(session, SHORT, keyR);
      expect(krRetry.status, `the refused key's retry after the reset: ${krRetry.text}`).toBe(202);
      expect(
        parseAccepted(krRetry).jobId,
        "the refusal created nothing and claimed no key — the retry is a new job",
      ).not.toBe(k1.jobId);

      const k1After = await submitInput(session, SHORT, key1);
      expect(k1After.status, `the original key's replay after the reset: ${k1After.text}`).toBe(
        202,
      );
      expect(
        parseAccepted(k1After).jobId,
        "the window reset did not lose the original key's claim",
      ).toBe(k1.jobId);

      expect(
        await appRecordCount(appId),
        "the store holds the seven jobs plus the refused key's retry",
      ).toBe(8);
    },
  );
});

describe("operator-tuned submission limits", () => {
  test(
    "EDGE_JOBS_LIMITS retunes the edge's shared windows and the dev gateway's own throttle, dev submissions never touch the deployment-wide window, and a bad value stops both boots naming the key",
    { timeout: 300_000 },
    async () => {
      const session = sessions.tuned;
      const appId = apps.tuned.app.id;
      const tuned = { submissionAttemptsPerAppEnv: 3, submissionWindowSeconds: 20 };

      // A value the shared schema refuses stops each gateway at boot, naming
      // the variable without echoing what it was set to.
      const sentinel = `sentinel-${randomBytes(4).toString("hex")}`;
      for (const name of ["edge", "devGateway"] as const) {
        await stack.stop(name);
        stack.setServiceEnv(name, {
          EDGE_JOBS_LIMITS: JSON.stringify({ submissionWindowSeconds: sentinel }),
        });
        const boot = await stack.startExpectingExit(name, 30_000);
        expect(boot.exitCode, `${name}: the refused boot exits non-zero`).not.toBe(0);
        expect(boot.exitCode, `${name}: the process exited, it was not killed`).not.toBeNull();
        expect(boot.output, `${name}: the error names EDGE_JOBS_LIMITS`).toContain(
          "EDGE_JOBS_LIMITS",
        );
        expect(boot.output, `${name}: the refused value is not echoed`).not.toContain(sentinel);
      }

      for (const name of ["edge", "devGateway"] as const) {
        stack.setServiceEnv(name, { EDGE_JOBS_LIMITS: JSON.stringify(tuned) });
        await stack.start(name);
      }

      try {
        // The edge: the tuned per-app window admits three and refuses the fourth.
        await ensureDeploymentHeadroom(5);
        for (let i = 0; i < tuned.submissionAttemptsPerAppEnv; i++) {
          const reply = await submitInput(session, SHORT, newKey());
          expect(
            reply.status,
            `edge submission ${i + 1} under the tuned window: ${reply.text}`,
          ).toBe(202);
        }
        const edgeRefused = await submitInput(session, SHORT, newKey());
        expect(edgeRefused.status, `the fourth edge attempt: ${edgeRefused.text}`).toBe(429);
        expect(parseErrorCode(edgeRefused), "the fourth edge attempt's code").toBe("rate_limited");
        const edgeBucket = must(await readBucket(appBucketKey(appId)), "the tuned app bucket");
        expect(edgeBucket.count, "four attempts charged to the shared counter").toBe(4);
        expect(
          await appRecordCount(appId),
          "only the admitted edge attempts reached the store",
        ).toBe(3);

        // The dev gateway: the same tuned per-app limit, counted in its own
        // memory. The edge's shared deployment-wide row is untouched by it.
        const deploymentBefore = await readBucket(DEPLOYMENT_BUCKET_KEY);
        const minted = await bob.post(`/api/v1/apps/${apps.tuned.slug}/dev-tokens`, {
          origins: ["http://localhost:5199"],
        });
        expect(minted.status, "the dev token mint").toBe(201);
        const devToken = (minted.json() as { token: string }).token;
        const dev = stack.devClient(apps.tuned.slug, devToken, "http://localhost:5199");
        for (let i = 0; i < tuned.submissionAttemptsPerAppEnv; i++) {
          const reply = await submitInput(dev, SHORT, newKey());
          expect(
            reply.status,
            `dev submission ${i + 1} under the tuned window: ${reply.text}`,
          ).toBe(202);
        }
        const devRefused = await submitInput(dev, SHORT, newKey());
        expect(devRefused.status, `the fourth dev attempt: ${devRefused.text}`).toBe(429);
        expect(parseErrorCode(devRefused), "the fourth dev attempt's code").toBe("rate_limited");
        expect(
          await appRecordCount(appId),
          "the admitted dev attempts reached the store as real jobs",
        ).toBe(6);
        expect(
          await readBucket(DEPLOYMENT_BUCKET_KEY),
          "dev submissions never count toward the edge's deployment-wide window",
        ).toEqual(deploymentBefore);
        expect(
          await readBucket(`jobs:submit:app:dev:${appId}`),
          "the dev tier writes no shared counter row",
        ).toBeNull();

        // The tuned 20-second window rolls well before the default 60 would.
        await waitFor(
          stack,
          "the tuned 20-second app window to reset",
          { timeoutMs: (tuned.submissionWindowSeconds + 10) * 1_000 },
          async () => {
            const bucket = await readBucket(appBucketKey(appId));
            return bucket === null || bucket.resetAtPassed ? true : undefined;
          },
        );
        await ensureDeploymentHeadroom(1);
        const afterReset = await submitInput(session, SHORT, newKey());
        expect(
          afterReset.status,
          `the edge attempt after the tuned reset: ${afterReset.text}`,
        ).toBe(202);
      } finally {
        for (const name of ["edge", "devGateway"] as const) {
          stack.setServiceEnv(name, null);
          await stack.restart(name);
        }
      }
    },
  );
});

describe("unfinished capacity under contention", () => {
  test(
    "concurrent new work through the edge stops exactly at the per-app unfinished cap; the retained key recovers at full capacity; completion frees the slot; health stays ok",
    { timeout: 240_000 },
    async () => {
      const session = sessions.contend;
      const appId = apps.contend.app.id;

      stack.setServiceEnv("jobs", { JOBS_LIMITS: JSON.stringify({ unfinishedPerAppEnv: 3 }) });
      await stack.restart("jobs");
      await ensureDeploymentHeadroom(10);

      const LONG: DiagnosticJobInput = { steps: 6, stepDelayMs: 1000 };
      const attemptKeys = Array.from({ length: 7 }, () => newKey());
      const replies = await Promise.all(
        attemptKeys.map(async (key) => ({ key, reply: await submitInput(session, LONG, key) })),
      );
      const accepted = replies.filter(({ reply }) => reply.status === 202);
      const refused = replies.filter(({ reply }) => reply.status === 429);
      expect(accepted.length, "exactly the per-app cap of three submissions are accepted").toBe(3);
      expect(refused.length, "the other four concurrent submissions are refused").toBe(4);
      for (const [attempt, { reply }] of replies.entries()) {
        expect(
          [202, 429],
          `attempt ${attempt + 1} is either accepted or capacity-refused: ${reply.status} ${reply.text}`,
        ).toContain(reply.status);
        if (reply.status === 429) {
          expect(parseErrorCode(reply), `attempt ${attempt + 1}'s error code`).toBe(
            "jobs_capacity_exceeded",
          );
        }
      }
      const acceptedByKey = new Map(
        accepted.map(({ key, reply }) => [key, parseAccepted(reply)] as const),
      );
      expect(
        new Set([...acceptedByKey.values()].map((a) => a.jobId)).size,
        "the three acceptances name distinct jobs",
      ).toBe(3);
      expect(await appRecordCount(appId), "the store holds exactly the three accepted jobs").toBe(
        3,
      );

      // At full capacity the retained key still recovers, and different bytes
      // on the same key conflict — neither creates a job.
      const recoverKey = must(accepted[0], "an accepted attempt").key;
      const recoverAccepted = must(
        acceptedByKey.get(recoverKey),
        "the accepted job of the replayed key",
      );
      const fullReplay = await submitInput(session, LONG, recoverKey);
      expect(fullReplay.status, `the identical replay at full capacity: ${fullReplay.text}`).toBe(
        202,
      );
      expect(
        parseAccepted(fullReplay).jobId,
        "the recovery answers the original job's reference",
      ).toBe(recoverAccepted.jobId);
      const conflict = await submitInput(session, { steps: 5, stepDelayMs: 1000 }, recoverKey);
      expect(conflict.status, `the same key with different bytes: ${conflict.text}`).toBe(409);
      expect(parseErrorCode(conflict), "the conflict's error code").toBe("idempotency_conflict");
      expect(await appRecordCount(appId), "the replay and the conflict created nothing").toBe(3);

      const atCap = await healthOf("jobs");
      expect(check(atCap, JOBS_CAPACITY_CHECK).status, "jobs_capacity at the unfinished cap").toBe(
        "ok",
      );
      expect(check(atCap, JOBS_WORKER_CHECK).status, "jobs_worker at the unfinished cap").toBe(
        "ok",
      );

      for (const acceptedJob of acceptedByKey.values()) {
        await pollSnapshot(session.api, acceptedJob.jobId, (s) => s.status === "succeeded", 90_000);
      }

      // Completion released the unfinished slot, and the capacity refusal
      // claimed no key: its retry is a NEW acceptance — the tenth and last
      // charged attempt on this app's window.
      const releasedKey = must(refused[0], "a capacity-refused attempt").key;
      const released = await submitInput(session, LONG, releasedKey);
      expect(
        released.status,
        `the refused key's retry after completion freed a slot: ${released.text}`,
      ).toBe(202);
      const releasedAccepted = parseAccepted(released);
      for (const acceptedJob of acceptedByKey.values()) {
        expect(
          releasedAccepted.jobId,
          "the refusal claimed no key — the retry is not a replay of the completed jobs",
        ).not.toBe(acceptedJob.jobId);
      }
      expect(
        await appRecordCount(appId),
        "the store holds the three completed jobs plus the retry",
      ).toBe(4);
    },
  );
});

describe("lowered limits and closed intake", () => {
  test(
    "lowering limits below occupancy evicts nothing: records stay readable and replayable, new work is refused",
    { timeout: 240_000 },
    async () => {
      const session = sessions.lowered;
      const appId = apps.lowered.app.id;

      // Back to the operator defaults for this scenario's baseline.
      stack.setServiceEnv("jobs", null);
      await stack.restart("jobs");
      await ensureDeploymentHeadroom(8);

      const keys = [newKey(), newKey(), newKey()];
      const jobIds: string[] = [];
      for (const key of keys) {
        const reply = await submitInput(session, SHORT, key);
        expect(reply.status, `the short job's submission: ${reply.text}`).toBe(202);
        jobIds.push(parseAccepted(reply).jobId);
      }
      const results: string[] = [];
      for (const jobId of jobIds) {
        await pollSnapshot(session.api, jobId, (s) => s.status === "succeeded", 60_000);
        const result = await session.api("GET", resultPath(jobId));
        expect(result.status, `the result read of ${jobId}`).toBe(200);
        results.push(result.text);
      }

      // Lower both per-app caps below the occupancy the app already has.
      stack.setServiceEnv("jobs", {
        JOBS_LIMITS: JSON.stringify({ retainedPerAppEnv: 2, unfinishedPerAppEnv: 1 }),
      });
      await stack.restart("jobs");

      const refused = await submitInput(session, SHORT, newKey());
      expect(refused.status, `new work over the lowered caps: ${refused.text}`).toBe(429);
      expect(parseErrorCode(refused), "the lowered-capacity error code").toBe(
        "jobs_capacity_exceeded",
      );

      const l1Replay = await submitInput(session, SHORT, must(keys[0], "the first lowered key"));
      expect(
        l1Replay.status,
        `the retained key recovers under the lowered limits: ${l1Replay.text}`,
      ).toBe(202);
      expect(
        parseAccepted(l1Replay).jobId,
        "the recovery answers the original job's reference",
      ).toBe(must(jobIds[0], "the first lowered job's id"));

      for (const [i, jobId] of jobIds.entries()) {
        const snapshot = await session.api("GET", statusPath(jobId));
        expect(snapshot.status, `the status read of retained job ${i + 1}`).toBe(200);
        expect(
          JobSnapshotSchema.parse(snapshot.json()).status,
          `retained job ${i + 1}'s status`,
        ).toBe("succeeded");
        const result = await session.api("GET", resultPath(jobId));
        expect(result.status, `the result read of retained job ${i + 1}`).toBe(200);
        expect(
          result.text,
          `retained job ${i + 1}'s result bytes are unchanged under the lowered limits`,
        ).toBe(must(results[i], `retained job ${i + 1}'s recorded result`));
      }
      expect(await appRecordCount(appId), "the lowered limits evicted nothing").toBe(3);

      const body = await healthOf("jobs");
      expect(
        check(body, JOBS_CAPACITY_CHECK).status,
        "only server-wide retained saturation degrades the capacity check",
      ).toBe("ok");
      expect(check(body, JOBS_WORKER_CHECK).status, "jobs_worker under the lowered limits").toBe(
        "ok",
      );

      loweredKeys = keys;
      loweredJobIds = jobIds;
    },
  );

  test(
    "a closed intake refuses new work but keeps retained-key recovery and reads",
    { timeout: 180_000 },
    async () => {
      const session = sessions.lowered;
      const appId = apps.lowered.app.id;

      stack.setServiceEnv("jobs", { JOBS_ACCEPTING: "false" });
      await stack.restart("jobs");
      // The closed posture reads degraded until the boot pass delivers fresh
      // drain evidence; the refusals below are only honest once the apply
      // landed.
      await waitFor(
        stack,
        "the closed intake posture to be applied with fresh drain evidence",
        { timeoutMs: 120_000 },
        async () => {
          const intake = check(await healthOf("jobs"), JOBS_INTAKE_CHECK);
          return intake.status === "ok" &&
            intake.metrics?.unfinishedServer !== undefined &&
            intake.metrics?.retainedServer !== undefined
            ? intake
            : undefined;
        },
      );
      await ensureDeploymentHeadroom(2);

      const refused = await submitInput(session, SHORT, newKey());
      expect(refused.status, `new work against a closed intake: ${refused.text}`).toBe(503);
      expect(parseErrorCode(refused), "the closed-intake error code").toBe("jobs_disabled");

      const l2Replay = await submitInput(
        session,
        SHORT,
        must(loweredKeys[1], "the second lowered key"),
      );
      expect(
        l2Replay.status,
        `the retained key recovers while the intake is closed: ${l2Replay.text}`,
      ).toBe(202);
      expect(
        parseAccepted(l2Replay).jobId,
        "the recovery answers the original job's reference",
      ).toBe(must(loweredJobIds[1], "the second lowered job's id"));

      const l3Snapshot = await session.api(
        "GET",
        statusPath(must(loweredJobIds[2], "the third lowered job's id")),
      );
      expect(l3Snapshot.status, "the status read while the intake is closed").toBe(200);

      expect(
        await appRecordCount(appId),
        "the closed intake created nothing and evicted nothing",
      ).toBe(3);

      // Reopen — leave the stack on its defaults for the next scenario.
      stack.setServiceEnv("jobs", null);
      await stack.restart("jobs");
    },
  );
});

describe("retained saturation and physical release", () => {
  test(
    "completion does not release retained capacity; saturation degrades jobs_capacity while reads and recovery continue; physical removal admits new work again",
    { timeout: 360_000 },
    async () => {
      const session = sessions.retained;

      // Cap the SERVER-wide retained storage at exactly what the store holds
      // now plus this scenario's two jobs.
      const cap = (await storeRecordCount()) + 2;
      stack.setServiceEnv("jobs", { JOBS_LIMITS: JSON.stringify({ retainedPerServer: cap }) });
      await stack.restart("jobs");
      await ensureDeploymentHeadroom(6);

      const e1 = newKey();
      const e2 = newKey();
      const eJobIds: string[] = [];
      for (const key of [e1, e2]) {
        const reply = await submitInput(session, SHORT, key);
        expect(reply.status, `the saturated-cap scenario's submission: ${reply.text}`).toBe(202);
        eJobIds.push(parseAccepted(reply).jobId);
      }
      for (const jobId of eJobIds) {
        await pollSnapshot(session.api, jobId, (s) => s.status === "succeeded", 60_000);
      }
      // Completion released the unfinished allowance, but the terminal records
      // now fill the retained cap: nothing unfinished remains store-wide.
      expect(await storeUnfinishedCount(), "unfinished occupancy is zero store-wide").toBe(0);

      const e3 = newKey();
      const refused = await submitInput(session, SHORT, e3);
      expect(refused.status, `new work at retained saturation: ${refused.text}`).toBe(429);
      expect(parseErrorCode(refused), "the saturation error code").toBe("jobs_capacity_exceeded");

      // The harness's restart waits for an ok body, and a saturated store
      // answers degraded — bring the process to its listener and wait for the
      // capacity check's own degraded reading instead.
      await stack.stop("jobs");
      await stack.start("jobs", { until: "listener" });
      const saturated = await waitFor(
        stack,
        "the boot cleanup pass to measure the saturated store",
        { timeoutMs: 60_000 },
        async () => {
          const body = await healthOf("jobs");
          const capacity = check(body, JOBS_CAPACITY_CHECK);
          return capacity.status === "degraded" && (capacity.metrics?.retainedServer ?? 0) >= cap
            ? body
            : undefined;
        },
      );
      expect(
        check(saturated, JOBS_WORKER_CHECK).status,
        "jobs_worker in the same saturated body",
      ).toBe("ok");

      // Saturation binds NEW work only: reads and retained-key recovery
      // continue.
      const e1JobId = must(eJobIds[0], "the first E job's id");
      const e1Snapshot = await session.api("GET", statusPath(e1JobId));
      expect(e1Snapshot.status, "the status read while saturated").toBe(200);
      expect(JobSnapshotSchema.parse(e1Snapshot.json()).status, "the saturated read's status").toBe(
        "succeeded",
      );
      const e1Result = await session.api("GET", resultPath(e1JobId));
      expect(e1Result.status, "the result read while saturated").toBe(200);
      const e1Replay = await submitInput(session, SHORT, e1);
      expect(e1Replay.status, `the retained key recovers while saturated: ${e1Replay.text}`).toBe(
        202,
      );
      expect(
        parseAccepted(e1Replay).jobId,
        "the recovery answers the original job's reference",
      ).toBe(e1JobId);

      // Physical release: stand in for the thirty days passing — the cleanup
      // loop itself is real, and its next pass does the removal.
      await jobsDb.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
            SET created_at = now() - interval '32 days',
                terminal_at = now() - interval '31 days'
          WHERE job_id = ANY($1::text[])`,
        [eJobIds],
      );
      await waitFor(
        stack,
        "the cleanup loop to physically remove the aged-out records",
        { timeoutMs: 150_000 },
        async () => {
          const res = await jobsDb.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = ANY($1::text[])`,
            [eJobIds],
          );
          return (res.rows[0]?.n ?? 0) === 0 ? true : undefined;
        },
      );

      // The capacity refusal claimed no key: with retained capacity released,
      // the refused key is a new acceptance.
      const e3Retry = await submitInput(session, SHORT, e3);
      expect(
        e3Retry.status,
        `the refused key's retry after the physical release: ${e3Retry.text}`,
      ).toBe(202);

      await waitFor(
        stack,
        "the capacity check to read ok again after the release",
        { timeoutMs: 150_000 },
        async () => {
          const body = await healthOf("jobs");
          return check(body, JOBS_CAPACITY_CHECK).status === "ok" ? body : undefined;
        },
      );

      // Leave the stack on its defaults.
      stack.setServiceEnv("jobs", null);
      await stack.restart("jobs");
    },
  );
});

describe("operational evidence", () => {
  test(
    "throttle and capacity refusals and recoveries are visible in exported telemetry, and no retry key reaches any log or telemetry payload",
    { timeout: 120_000 },
    async () => {
      // A service flushes its last export batch at shutdown — stop the
      // exporters before scanning the capture.
      await stack.stop("edge");
      await stack.stop("devGateway");
      await stack.stop("jobs");
      const capture = must(stack.telemetry, "the stack's telemetry capture");

      const hasSubmissionPoint = (outcome: string): boolean =>
        capture.payloads.some(
          (p) =>
            p.signal === "metrics" &&
            metricHasDataPoint(p.body, INSTR_JOBS_SUBMISSIONS, ATTR_OUTCOME, outcome),
        );
      expect(
        hasSubmissionPoint("rate_limited"),
        "the edge exported the throttle refusals on the submissions counter",
      ).toBe(true);
      expect(
        hasSubmissionPoint("server_refused"),
        "the edge exported the forwarded refusals on the submissions counter",
      ).toBe(true);

      const submitSpanCarries = (outcome: string): boolean =>
        capture.payloads.some(
          (p) =>
            p.signal === "traces" && spanOutcomesIn(p.body, SPAN_JOBS_SUBMIT).includes(outcome),
        );
      for (const outcome of ["capacity_exceeded", "recovered", "intake_closed"] as const) {
        expect(
          submitSpanCarries(outcome),
          `the jobs receiver exported a ${outcome} submit span`,
        ).toBe(true);
      }

      // The privacy scan: no retry key in any exported payload or service log.
      expect(usedKeys.size, "the suite sent idempotency keys to scan for").toBeGreaterThan(0);
      // Whole log files, every start appended — not a tail that could have
      // rotated an early leak out of view.
      const logTails = (["edge", "devGateway", "jobs", "portal", "egress"] as const).map(
        (name) => ({
          name,
          tail: readFileSync(path.join(stack.logDir, `${name}.log`), "utf8"),
        }),
      );
      // The scan is not vacuous: the refusals the suite drove are in these
      // logs as bounded events, without the keys that caused them.
      const logOf = (name: string): string =>
        must(
          logTails.find((l) => l.name === name),
          name,
        ).tail;
      expect(logOf("jobs"), "the jobs log carries the capacity refusal events").toContain(
        "jobs.admission.capacity_refused",
      );
      expect(logOf("edge"), "the edge log carries the suppressed-refusal summary").toContain(
        "edge.jobs_submit.refusal_ledger_suppressed",
      );
      for (const key of usedKeys) {
        for (const payload of capture.payloads) {
          expect(
            payload.body.includes(key),
            `a telemetry payload leaked the retry key ${key}`,
          ).toBe(false);
        }
        for (const { name, tail } of logTails) {
          expect(tail.includes(key), `the ${name} log leaked the retry key ${key}`).toBe(false);
        }
      }

      expect(capture.dropped, "the capture dropped no telemetry payload").toBe(0);
    },
  );
});
