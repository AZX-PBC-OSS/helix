import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  AppSchema,
  DevTokenMintResponseSchema,
  HealthStatusSchema,
  INSTRUCTION_HEADER,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
  JOBS_SERVER_NAME,
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  ManifestUpdateResultSchema,
  type App,
  type HealthStatus,
  type JobAccepted,
  type JobSnapshot,
} from "@azx-pbc/shared";
import { deriveJobsInstructionKey, mintJobsInstruction } from "@azx-pbc/shared/jobsSigning";

import { DIAGNOSTIC_PROGRESS_LABEL, type DiagnosticJobInput } from "./diagnostics.js";
import { JOBS_APP_LIFECYCLE_QUALIFIED, JOBS_JOB_RECORD_QUALIFIED } from "./policy.js";
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
 * Job lifecycle and cancellation for the non-production `jobs:diagnostic`
 * type, through the REAL running platform (dev IdP, portal, egress, jobs,
 * edge — all child processes). Owner cancellation of queued and running work,
 * the acknowledged cancellation's 60-second terminal bound, cancellation
 * intent surviving a jobs crash, fenced late completions, retry/deadline
 * outcomes, the loss of observation access leaving accepted work running, and
 * the portal's own archive/unarchive transitions closing and opening
 * generations across both environments.
 *
 * Accepted work and execution are read from the jobs store
 * (`jobs.job_record`), never inferred from a reply: a StoreWatcher samples the
 * watched records every 100 ms while each scenario runs, and the pure
 * assertion helpers prove from those histories that terminal outcomes are
 * final, queued cancelled work never starts, and cancelled work never turns
 * into a retry. Every scenario gets its own app, because the per-app
 * two-running-jobs allowance is what keeps scenarios from interfering.
 */

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let bob: PortalClient;
let jobsDb: Pool;

interface AppUnderTest {
  readonly app: App;
  readonly slug: string;
}

/** One key per scenario: every scenario submits against its own app. */
type ScenarioKey =
  | "queued"
  | "winner"
  | "fence"
  | "crashIntent"
  | "retries"
  | "crashCancel"
  | "deadline"
  | "access"
  | "l1"
  | "l2"
  | "l3";

const SCENARIOS: readonly ScenarioKey[] = [
  "queued",
  "winner",
  "fence",
  "crashIntent",
  "retries",
  "crashCancel",
  "deadline",
  "access",
  "l1",
  "l2",
  "l3",
];

const apps = {} as Record<ScenarioKey, AppUnderTest>;
const sessions = {} as Record<ScenarioKey, AppSession>;

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`the suite never produced ${what}`);
  return value;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  stack = await startRealStack({ label: "lifecycle", diagnostics: true });

  bob = await stack.portalAs("bob@azx.dev");

  for (const key of SCENARIOS) {
    apps[key] = await createDiagnosticApp(key);
  }

  // The jobs service admits an app's work only after the portal delivered
  // that app's lifecycle state to it — wait once, after all the apps exist.
  const passesBefore = (await lifecycleDeliveryReading()).passes;
  await waitForLifecycleDelivery(passesBefore);

  for (const key of SCENARIOS) {
    sessions[key] = await stack.appSession(apps[key].slug, "bob@azx.dev");
  }

  jobsDb = new Pool({ connectionString: stack.jobsOwnerDsn, max: 3 });
}, 420_000);

afterAll(async () => {
  await jobsDb?.end();
  if (stack) await stack.close();
}, 120_000);

// ── small drivers over the harness clients ───────────────────────────────────

const SUBMIT_PATH = "/_api/jobs/jobs/types/diagnostic";
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;
const resultPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}/result`;

/** Either client kind — the app-host session and the dev-gateway client expose the same `api` seam over the same `/_api/jobs/...` paths. */
type ApiClient = AppSession | DevClient;
type ApiFn = AppSession["api"] | DevClient["api"];

/** One submission attempt — the exact bytes and key a retry of this submit would reuse. */
function submitDiagnosticOnce(
  client: ApiClient,
  input: DiagnosticJobInput,
  key: string,
): Promise<HttpReply> {
  return client.api("POST", SUBMIT_PATH, {
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(input),
  });
}

/**
 * Submit until the acceptance commits: a retryable status keeps polling (the
 * same key and bytes every time — the keyed-retry rule), anything else
 * non-202 fails loudly quoting the status and body. The retried statuses are
 * 503 (jobs unavailable / closed-generation refusal) unless the caller lists
 * more — every listed status carries its reason at the call site.
 */
async function submitDiagnostic(
  client: ApiClient,
  input: DiagnosticJobInput,
  opts: { retryOn?: readonly number[] } = {},
): Promise<JobAccepted> {
  const retryOn = opts.retryOn ?? [503];
  const key = `lc-${randomUUID()}`;
  let last = "<none>";
  return waitFor(
    stack,
    () => `the diagnostic submission to be accepted — last answer: ${last}`,
    { timeoutMs: 60_000, pollMs: 500 },
    async () => {
      const res = await submitDiagnosticOnce(client, input, key);
      last = `${res.status} ${res.text.slice(0, 300)}`;
      if (retryOn.includes(res.status)) return undefined;
      if (res.status !== 202) {
        throw new Error(
          `the diagnostic submission was refused: ${res.status} ${res.text.slice(0, 400)}`,
        );
      }
      return JobAcceptedSchema.parse(res.json());
    },
  );
}

/**
 * ONE submission attempt — no retry — for the scenarios that must observe the
 * raw racing answer (or a refusal's body) exactly as it landed.
 */
async function submitOnce(
  client: ApiClient,
  input: DiagnosticJobInput,
): Promise<{ status: number; accepted?: JobAccepted; body: string }> {
  const res = await submitDiagnosticOnce(client, input, `lc-${randomUUID()}`);
  return {
    status: res.status,
    ...(res.status === 202 ? { accepted: JobAcceptedSchema.parse(res.json()) } : {}),
    body: res.text,
  };
}

/** One snapshot read, parsed against the wire schema. */
async function readSnapshot(api: ApiFn, jobId: string): Promise<JobSnapshot> {
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
  api: ApiFn,
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

/** The raw reply of the owner-cancellation DELETE. */
function cancel(client: ApiClient, jobId: string): Promise<HttpReply> {
  return client.api("DELETE", statusPath(jobId));
}

/** The raw reply of the result read. */
function readResult(client: ApiClient, jobId: string): Promise<HttpReply> {
  return client.api("GET", resultPath(jobId));
}

/**
 * The stateful 409 body (job_terminal and friends) after the wire-schema
 * parse: the job's own status is the fact the assertions need.
 */
function parseStatefulError(reply: HttpReply): { code: string; status: string } {
  const parsed = JobRequestErrorSchema.parse(reply.json());
  if (!("status" in parsed)) {
    throw new Error(`expected a job-state 409 body, got the bare error ${JSON.stringify(parsed)}`);
  }
  return { code: parsed.code, status: parsed.status };
}

interface JobRecordRow {
  status: string;
  attempt: number | null;
  progress: { step: number; of: number; label: string } | null;
  error_code: string | null;
  result: string | null;
  cancellation_requested: boolean;
  generation: string;
  created_at: Date;
  runner_job_id: string | null;
}

/** One read of the job's wrapper record — the durable state the replies project. */
async function recordRow(jobId: string): Promise<JobRecordRow> {
  const res = await jobsDb.query<JobRecordRow>(
    `SELECT status, attempt, progress, error_code, result, cancellation_requested,
            generation, created_at, runner_job_id
       FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
    [jobId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`no job_record row for job ${jobId}`);
  return row;
}

/** Every wrapper record for one app, newest last — the store-side view of an app's work. */
async function appRecordRows(appId: string): Promise<Array<JobRecordRow & { job_id: string }>> {
  const res = await jobsDb.query<JobRecordRow & { job_id: string }>(
    `SELECT job_id, status, attempt, progress, error_code, result, cancellation_requested,
            generation, created_at, runner_job_id
       FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE app_id = $1`,
    [appId],
  );
  return res.rows;
}

/** The app's applied lifecycle row in the jobs store — `generation` is the bigint-as-text the wire form carries. */
async function appliedLifecycle(appId: string): Promise<{ generation: string; archived: boolean }> {
  const res = await jobsDb.query<{ generation: string; archived: boolean }>(
    `SELECT generation, archived FROM ${JOBS_APP_LIFECYCLE_QUALIFIED} WHERE app_id = $1`,
    [appId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`no app_lifecycle row for app ${appId}`);
  return row;
}

/** A comparable fingerprint of a record row, for proving nothing moved. */
function recordFingerprint(row: JobRecordRow): string {
  return JSON.stringify([
    row.status,
    row.attempt,
    row.progress,
    row.error_code,
    row.result,
    row.cancellation_requested,
    row.generation,
  ]);
}

// ── the store watcher and its assertion helpers ──────────────────────────────

interface ProgressShape {
  step: number;
  of: number;
  label: string;
}

interface StoreSample {
  at: number;
  status: string;
  attempt: number | null;
  progress: ProgressShape | null;
  errorCode: string | null;
  hasResult: boolean;
  cancellationRequested: boolean;
}

type StoreHistory = StoreSample[];

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "expired"]);
const WATCH_INTERVAL_MS = 100;

/**
 * Samples the watched jobs' wrapper records while a scenario runs, through
 * the owner pool. The database stays up through every deliberate service
 * crash, so a failed read is a harness fault: the loop keeps sampling, and
 * `stop()` rethrows the first failure rather than return histories with a
 * silent gap.
 */
class StoreWatcher {
  private readonly histories = new Map<string, StoreHistory>();
  private stopped = false;
  private firstError: unknown = undefined;
  private readonly loop: Promise<void>;

  constructor(jobIds: () => string[]) {
    this.loop = (async () => {
      while (!this.stopped) {
        await this.tick(jobIds());
        if (!this.stopped) await sleep(WATCH_INTERVAL_MS);
      }
    })();
  }

  private async tick(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      const rows = await jobsDb.query<{
        job_id: string;
        status: string;
        attempt: number | null;
        progress: ProgressShape | null;
        error_code: string | null;
        has_result: boolean;
        cancellation_requested: boolean;
      }>(
        `SELECT job_id, status, attempt, progress, error_code,
                result IS NOT NULL AS has_result, cancellation_requested
           FROM ${JOBS_JOB_RECORD_QUALIFIED}
          WHERE job_id = ANY($1::text[])`,
        [ids],
      );
      const at = Date.now();
      for (const row of rows.rows) {
        const history = this.histories.get(row.job_id) ?? [];
        history.push({
          at,
          status: row.status,
          attempt: row.attempt,
          progress: row.progress,
          errorCode: row.error_code,
          hasResult: row.has_result,
          cancellationRequested: row.cancellation_requested,
        });
        this.histories.set(row.job_id, history);
      }
    } catch (error) {
      this.firstError ??= error;
    }
  }

  async stop(): Promise<ReadonlyMap<string, StoreHistory>> {
    this.stopped = true;
    await this.loop;
    if (this.firstError !== undefined) {
      throw new Error("the store watcher's read failed", { cause: this.firstError });
    }
    return this.histories;
  }
}

const quoteSample = (s: StoreSample): string => JSON.stringify(s);
const quoteTail = (history: StoreHistory, n = 10): string =>
  history.slice(-n).map(quoteSample).join(", ");

/**
 * After the first terminal sample, every later sample is the same terminal
 * state — no status change, no attempt or progress movement, no late result.
 */
function assertTerminalIsFinal(jobId: string, history: StoreHistory): void {
  if (history.length === 0) {
    throw new Error(`job ${jobId}: the store watcher recorded no samples`);
  }
  const firstIdx = history.findIndex((s) => TERMINAL_STATUSES.has(s.status));
  if (firstIdx === -1) {
    throw new Error(
      `job ${jobId}: the watcher never observed a terminal status — last samples: ${quoteTail(history)}`,
    );
  }
  const first = must(history[firstIdx], "the first terminal sample");
  for (let i = firstIdx + 1; i < history.length; i++) {
    const s = must(history[i], `the sample after the terminal outcome at index ${i}`);
    const same =
      s.status === first.status &&
      s.attempt === first.attempt &&
      JSON.stringify(s.progress) === JSON.stringify(first.progress) &&
      s.errorCode === first.errorCode &&
      s.hasResult === first.hasResult;
    if (!same) {
      throw new Error(
        `job ${jobId}: the state changed after the first terminal outcome — ` +
          `first terminal sample ${quoteSample(first)}, later sample ${quoteSample(s)}`,
      );
    }
  }
}

/**
 * Once queued work carries the cancellation intent, its attempt never
 * appears. Requires the watcher to have seen the job queued under intent, so
 * a scenario that expects that shape cannot pass vacuously.
 */
function assertQueuedCancelNeverStarts(jobId: string, history: StoreHistory): void {
  const firstIdx = history.findIndex((s) => s.cancellationRequested && s.attempt === null);
  if (firstIdx === -1) {
    throw new Error(
      `job ${jobId}: the watcher never observed the queued cancellation intent — last samples: ${quoteTail(history)}`,
    );
  }
  for (let i = firstIdx + 1; i < history.length; i++) {
    const s = must(history[i], `the sample after the queued intent at index ${i}`);
    if (s.attempt !== null) {
      throw new Error(
        `job ${jobId}: queued cancelled work started executing — ` +
          `intent sample ${quoteSample(must(history[firstIdx], "the first intent sample"))}, ` +
          `offending sample ${quoteSample(s)}`,
      );
    }
  }
}

/**
 * From the first sample carrying the cancellation intent, no later sample
 * shows a higher attempt: work under intent never starts a new attempt,
 * whether the intent found it queued (no attempt yet) or running.
 */
function assertNoAttemptAfterIntent(jobId: string, history: StoreHistory): void {
  const firstIdx = history.findIndex((s) => s.cancellationRequested);
  const first = history[firstIdx];
  if (first === undefined) {
    throw new Error(
      `job ${jobId}: the watcher never observed the cancellation intent — last samples: ${quoteTail(history)}`,
    );
  }
  const bound = first.attempt ?? 0;
  for (const s of history.slice(firstIdx + 1)) {
    if ((s.attempt ?? 0) > bound) {
      throw new Error(
        `job ${jobId}: work under cancellation intent started another attempt — ` +
          `first intent sample ${quoteSample(first)}, offending sample ${quoteSample(s)}`,
      );
    }
  }
}

// ── setup helpers ────────────────────────────────────────────────────────────

/**
 * Save an app's capabilities with exactly the jobs types given (and no fetch
 * origins) — the SPA capability editor's save body for these choices. The
 * jobs capability block is present only while it names at least one type (the
 * wire contract refuses an empty one), so a revocation is the block's
 * omission and a re-grant is the block's return. A jobs type is a baseline
 * grant, so both apply directly with no pending approval.
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
async function createDiagnosticApp(purpose: string): Promise<AppUnderTest> {
  // The slug is a lowercase DNS label; the scenario keys are camelCase.
  const slug = `lc-${purpose.toLowerCase()}-${randomBytes(3).toString("hex")}`;
  const app = await createLiveApp(stack, bob, {
    slug,
    files: {
      "index.html":
        '<!doctype html><html><head><meta charset="utf-8"><title>lifecycle cancellation</title></head>' +
        `<body><p>lifecycle-${purpose}</p></body></html>`,
    },
  });
  await saveCapabilities(slug, [JOBS_DIAGNOSTIC_QUALIFIED_TYPE]);
  return { app, slug };
}

// ── lifecycle-delivery waits (the admission gate's precondition) ─────────────

/** One read of any service's `/health` body, parsed against the shared contract. */
async function healthBody(url: string): Promise<HealthStatus> {
  const res = await stack.request(url);
  expect(res.status, `the /health read of ${url}`).toBe(200);
  return HealthStatusSchema.parse(res.json());
}

const jobsHealthUrl = (): string => `http://localhost:${stack.ports.jobs}/health`;

/** The portal `/health` body's lifecycle-delivery check — the metrics record and the check's own graded status. */
async function deliveryCheckReading(): Promise<{
  status: string;
  metrics: Record<string, number>;
}> {
  const body = await healthBody(`${stack.portalUrl}/health`);
  const check = body.checks?.find((c) => c.name === JOBS_LIFECYCLE_DELIVERY_CHECK);
  return { status: check?.status ?? "missing", metrics: check?.metrics ?? {} };
}

/** The portal `/health` body's lifecycle-delivery reading: pass count and whether every configured target is synchronized. */
async function lifecycleDeliveryReading(): Promise<{ passes: number; synchronized: boolean }> {
  const { metrics } = await deliveryCheckReading();
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

/** Wait until the job runs with at least one reported step. */
async function pollUntilRunning(api: ApiFn, jobId: string, minStep: number): Promise<JobSnapshot> {
  return pollSnapshot(
    api,
    jobId,
    (s) => s.status === "running" && (s.progress?.step ?? 0) >= minStep,
    60_000,
  );
}

// ── the suite ────────────────────────────────────────────────────────────────

describe("owner cancellation", () => {
  test(
    "cancelling queued work before it starts: acknowledged, harmless to repeat, and it never executes",
    { timeout: 240_000 },
    async () => {
      const session = sessions.queued;
      const LONG: DiagnosticJobInput = { steps: 20, stepDelayMs: 1000 };

      // A and B fill the app's two-running allowance; C must stay queued.
      const a = await submitDiagnostic(session, LONG);
      const b = await submitDiagnostic(session, LONG);
      await Promise.all([
        pollUntilRunning(session.api, a.jobId, 1),
        pollUntilRunning(session.api, b.jobId, 1),
      ]);
      const c = await submitDiagnostic(session, LONG);
      const cQueued = await readSnapshot(session.api, c.jobId);
      expect(cQueued.status).toBe("queued");
      expect(cQueued.attempt).toBeNull();
      expect(cQueued.progress).toBeNull();

      const watcher = new StoreWatcher(() => [a.jobId, b.jobId, c.jobId]);
      let aFinal: JobSnapshot | undefined;
      let histories: ReadonlyMap<string, StoreHistory> | undefined;
      try {
        // The queued job's cancellation: acknowledged, and harmless to repeat
        // while the intent is pending.
        const firstDelete = await cancel(session, c.jobId);
        expect(firstDelete.status, "the cancellation of the queued job").toBe(202);
        const ack = JobCancellationAcceptedSchema.parse(firstDelete.json());
        expect(ack.cancellationRequested).toBe(true);
        expect(ack.jobId).toBe(c.jobId);
        const secondDelete = await cancel(session, c.jobId);
        if (secondDelete.status === 202) {
          expect(
            JobCancellationAcceptedSchema.parse(secondDelete.json()).cancellationRequested,
          ).toBe(true);
        } else {
          expect(secondDelete.status, "a repeat cancellation after settlement").toBe(409);
          const settled = parseStatefulError(secondDelete);
          expect(settled.code).toBe("job_terminal");
          expect(settled.status).toBe("cancelled");
        }

        // A and B are cancelled while still running, their acknowledged
        // DELETEs landing back to back: the queued job's terminal projection
        // rides the recovery sweeper's cadence, and polling C to terminal
        // first would leave the 20-second LONG jobs no running window left to
        // cancel.
        const aAckAt = Date.now();
        const aDelete = await cancel(session, a.jobId);
        expect(aDelete.status, `the cancellation of running job ${a.jobId}`).toBe(202);
        expect(JobCancellationAcceptedSchema.parse(aDelete.json()).cancellationRequested).toBe(
          true,
        );
        const bAckAt = Date.now();
        const bDelete = await cancel(session, b.jobId);
        expect(bDelete.status, `the cancellation of running job ${b.jobId}`).toBe(202);
        expect(JobCancellationAcceptedSchema.parse(bDelete.json()).cancellationRequested).toBe(
          true,
        );

        // Each reaches its terminal outcome inside the spec's 60-second bound
        // from its acknowledgement.
        aFinal = await pollSnapshot(session.api, a.jobId, (s) => s.status === "cancelled", 90_000);
        expect(Date.now() - aAckAt, `job ${a.jobId}: the 60-second terminal bound`).toBeLessThan(
          60_000,
        );
        await pollSnapshot(session.api, b.jobId, (s) => s.status === "cancelled", 90_000);
        expect(Date.now() - bAckAt, `job ${b.jobId}: the 60-second terminal bound`).toBeLessThan(
          60_000,
        );

        // The queued job's terminal outcome: no attempt, no progress.
        const cFinal = await pollSnapshot(
          session.api,
          c.jobId,
          (s) => s.status === "cancelled",
          90_000,
        );
        expect(cFinal.attempt, "the queued job never executed an attempt").toBeNull();
        expect(cFinal.progress).toBeNull();
        expect(cFinal.error?.code).toBe("cancelled");
        expect(cFinal.cancellationRequested).toBe(true);

        // With both slots free, the runner would have claimed C if it could.
        await sleep(5_000);
        expect((await readSnapshot(session.api, c.jobId)).status).toBe("cancelled");
      } finally {
        histories = await watcher.stop();
      }

      const cRow = await recordRow(c.jobId);
      expect(cRow.status, "the queued job's final record status").toBe("cancelled");
      expect(cRow.attempt).toBeNull();
      const cHistory = must(histories?.get(c.jobId), "job C's store history");
      assertQueuedCancelNeverStarts(c.jobId, cHistory);
      for (const job of [a, b, c]) {
        assertTerminalIsFinal(
          job.jobId,
          must(histories?.get(job.jobId), `job ${job.jobId}'s store history`),
        );
      }

      // A terminal job is not cancellable: the stateful 409 keeps its outcome,
      // and a snapshot read afterwards is unchanged.
      const again = await cancel(session, a.jobId);
      expect(again.status).toBe(409);
      const terminal = parseStatefulError(again);
      expect(terminal.code).toBe("job_terminal");
      expect(terminal.status).toBe("cancelled");
      expect(await readSnapshot(session.api, a.jobId)).toEqual(
        must(aFinal, "job A's terminal snapshot"),
      );
    },
  );

  test(
    "a completion that wins the race keeps its result; a later cancellation is a 409 that changes nothing",
    { timeout: 120_000 },
    async () => {
      const session = sessions.winner;
      const accepted = await submitDiagnostic(session, { steps: 1 });
      const jobId = accepted.jobId;

      const final = await pollSnapshot(session.api, jobId, (s) => s.status === "succeeded", 60_000);
      expect(final.error).toBeNull();

      const del = await cancel(session, jobId);
      expect(del.status, "the cancellation of a succeeded job").toBe(409);
      const terminal = parseStatefulError(del);
      expect(terminal.code).toBe("job_terminal");
      expect(terminal.status).toBe("succeeded");

      // The result survived the refused cancellation.
      const result = await readResult(session, jobId);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.text)).toEqual({ completedSteps: 1, attempt: 1 });

      expect((await readSnapshot(session.api, jobId)).status).toBe("succeeded");
    },
  );

  test(
    "a late completion after cancellation is fenced across the real stack",
    { timeout: 240_000 },
    async () => {
      const session = sessions.fence;
      // ignoreAbort keeps the attempt running past the abort, so the handler's
      // natural end lands AFTER the cancellation — the fence's whole point.
      const submittedAt = Date.now();
      const accepted = await submitDiagnostic(session, {
        steps: 6,
        stepDelayMs: 1000,
        ignoreAbort: true,
      });
      const jobId = accepted.jobId;
      await pollUntilRunning(session.api, jobId, 1);

      const watcher = new StoreWatcher(() => [jobId]);
      let histories: ReadonlyMap<string, StoreHistory> | undefined;
      try {
        const ackAt = Date.now();
        const del = await cancel(session, jobId);
        expect(del.status).toBe(202);
        expect(JobCancellationAcceptedSchema.parse(del.json()).cancellationRequested).toBe(true);

        await pollSnapshot(session.api, jobId, (s) => s.status === "cancelled", 90_000);
        expect(Date.now() - ackAt, "the 60-second terminal bound").toBeLessThan(60_000);

        // Let the handler run past its natural end (6 steps × 1000 ms, plus
        // slack): the completion must never land.
        const naturalEnd = submittedAt + 6_000 + 4_000;
        if (Date.now() < naturalEnd) await sleep(naturalEnd - Date.now());

        expect((await readSnapshot(session.api, jobId)).status).toBe("cancelled");

        const result = await readResult(session, jobId);
        expect(result.status, "the result read of the cancelled job").toBe(409);
        const terminal = parseStatefulError(result);
        expect(terminal.code).toBe("job_terminal");
        expect(terminal.status).toBe("cancelled");

        const row = await recordRow(jobId);
        expect(row.result, "no result was ever stored for the cancelled job").toBeNull();
      } finally {
        histories = await watcher.stop();
      }
      assertTerminalIsFinal(jobId, must(histories?.get(jobId), "the job's store history"));
    },
  );

  test(
    "an acknowledged cancellation survives a jobs crash and never becomes a retry",
    { timeout: 300_000 },
    async () => {
      const session = sessions.crashIntent;
      // ignoreAbort keeps the attempt alive after the abort, so the crash
      // lands while the intent is recorded but the job is still active.
      const accepted = await submitDiagnostic(session, {
        steps: 20,
        stepDelayMs: 1000,
        ignoreAbort: true,
      });
      const jobId = accepted.jobId;
      await pollUntilRunning(session.api, jobId, 2);

      const watcher = new StoreWatcher(() => [jobId]);
      let histories: ReadonlyMap<string, StoreHistory> | undefined;
      try {
        const del = await cancel(session, jobId);
        expect(del.status).toBe(202);
        expect(JobCancellationAcceptedSchema.parse(del.json()).cancellationRequested).toBe(true);

        const intentRow = await recordRow(jobId);
        expect(intentRow.cancellation_requested, "the intent is durable before the crash").toBe(
          true,
        );

        await stack.crash("jobs");
        await stack.start("jobs");

        const final = await pollSnapshot(
          session.api,
          jobId,
          (s) => s.status === "cancelled",
          90_000,
        );
        expect(final.attempt, "the interrupted attempt was never resumed").toBe(1);

        // Two pg-boss heartbeat windows: any restart-driven retry or late
        // completion would have to show by now.
        await sleep(20_000);
      } finally {
        histories = await watcher.stop();
      }

      const row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.attempt).toBe(1);
      const history = must(histories?.get(jobId), "the job's store history");
      assertNoAttemptAfterIntent(jobId, history);
      assertTerminalIsFinal(jobId, history);
    },
  );
});

describe("recovery, retries and deadlines", () => {
  test(
    "progress is attributed to its attempt, resets on retry, and exhaustion ends attempts_exhausted",
    { timeout: 180_000 },
    async () => {
      const session = sessions.retries;
      const accepted = await submitDiagnostic(session, {
        steps: 3,
        stepDelayMs: 400,
        failAtStep: 3,
      });
      const jobId = accepted.jobId;

      // Every 100 ms, so the between-attempt states are observed, not inferred.
      const observed: JobSnapshot[] = [];
      const final = await waitFor(
        stack,
        () =>
          `job ${jobId} to fail — ${observed.length} snapshots collected, last: ` +
          (observed.length === 0
            ? "<none>"
            : JSON.stringify(must(observed[observed.length - 1], "the last snapshot"))),
        { timeoutMs: 120_000, pollMs: 100 },
        async () => {
          const res = await session.api("GET", statusPath(jobId));
          if (res.status === 503) return undefined;
          expect(res.status, `status poll of job ${jobId}`).toBe(200);
          const s = JobSnapshotSchema.parse(res.json());
          observed.push(s);
          return s.status === "failed" ? s : undefined;
        },
      );

      expect(final.attempt, "the policy's three attempts all ran").toBe(3);
      expect(final.error?.code).toBe("attempts_exhausted");

      for (const [i, s] of observed.entries()) {
        if (i > 0) {
          const prev = must(observed[i - 1], `the sample before index ${i}`);
          expect(
            s.attempt ?? 0,
            `job ${jobId}: the attempt is non-decreasing (sample ${i})`,
          ).toBeGreaterThanOrEqual(prev.attempt ?? 0);
        }
        if (s.progress !== null) {
          expect(s.progress.of, `job ${jobId}: the progress total (sample ${i})`).toBe(3);
          expect(s.progress.label, `job ${jobId}: the progress label (sample ${i})`).toBe(
            DIAGNOSTIC_PROGRESS_LABEL,
          );
          expect(
            s.progress.step,
            `job ${jobId}: the progress step (sample ${i})`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            s.progress.step,
            `job ${jobId}: the progress step (sample ${i})`,
          ).toBeLessThanOrEqual(3);
        }
      }

      const runningWithProgress = observed.filter(
        (s) => s.status === "running" && s.progress !== null,
      );
      expect(
        new Set(runningWithProgress.map((s) => s.attempt)).size,
        "at least two distinct attempts were observed running with progress",
      ).toBeGreaterThanOrEqual(2);

      // The reset: some running sample of attempt n+1 reports a step strictly
      // lower than the highest step observed for attempt n.
      const highestStepByAttempt = new Map<number, number>();
      for (const s of runningWithProgress) {
        const attempt = must(s.attempt, "a running snapshot's attempt");
        const step = s.progress?.step ?? 0;
        const best = highestStepByAttempt.get(attempt);
        if (best === undefined || step > best) highestStepByAttempt.set(attempt, step);
      }
      let resetObserved = false;
      for (const s of runningWithProgress) {
        const attempt = must(s.attempt, "a running snapshot's attempt");
        const step = s.progress?.step ?? 0;
        for (const [prior, highest] of highestStepByAttempt) {
          if (prior < attempt && step < highest) resetObserved = true;
        }
      }
      expect(
        resetObserved,
        "a progress reset across the retry was never observable at 100 ms polling with 400 ms steps",
      ).toBe(true);

      const result = await readResult(session, jobId);
      expect(result.status, "the result read of the failed job").toBe(409);
      const terminal = parseStatefulError(result);
      expect(terminal.code).toBe("job_terminal");
      expect(terminal.status).toBe("failed");
    },
  );

  test(
    "cancellation during crash recovery ends cancelled and the interrupted attempt is never resumed",
    { timeout: 300_000 },
    async () => {
      const session = sessions.crashCancel;
      const accepted = await submitDiagnostic(session, { steps: 20, stepDelayMs: 1000 });
      const jobId = accepted.jobId;
      const running = await pollUntilRunning(session.api, jobId, 2);
      expect(running.attempt).toBe(1);

      const watcher = new StoreWatcher(() => [jobId]);
      let histories: ReadonlyMap<string, StoreHistory> | undefined;
      try {
        await stack.crash("jobs");
        await stack.start("jobs");

        // The forward answers 503 while the restarted jobs service is still
        // converging; the acknowledged cancellation is what records the intent.
        const ackAt = await waitFor(
          stack,
          `the cancellation DELETE of job ${jobId} to be accepted after the restart`,
          { timeoutMs: 30_000, pollMs: 500 },
          async () => {
            const res = await cancel(session, jobId);
            if (res.status === 503) return undefined;
            expect(res.status, `the cancellation of job ${jobId} after the restart`).toBe(202);
            return Date.now();
          },
        );

        await pollSnapshot(session.api, jobId, (s) => s.status === "cancelled", 90_000);
        expect(Date.now() - ackAt, "the 60-second terminal bound").toBeLessThan(60_000);

        await sleep(20_000);
      } finally {
        histories = await watcher.stop();
      }

      const history = must(histories?.get(jobId), "the job's store history");
      assertNoAttemptAfterIntent(jobId, history);
      assertTerminalIsFinal(jobId, history);

      const row = await recordRow(jobId);
      expect(row.status).toBe("cancelled");
      expect(row.progress?.step ?? 0, "the work never ran to completion").toBeLessThan(20);
    },
  );

  test(
    "an outage that outlasts the deadline ends the job timed out, never executed after recovery",
    { timeout: 300_000 },
    async () => {
      const session = sessions.deadline;
      const accepted = await submitDiagnostic(session, { steps: 20, stepDelayMs: 1000 });
      const jobId = accepted.jobId;
      await pollUntilRunning(session.api, jobId, 1);

      await stack.stop("jobs");

      // This UPDATE is the test's clock shift standing in for five minutes of
      // outage: the diagnostic deadline (300 s) runs from acceptance, and the
      // record's `created_at` IS the acceptance instant the start gate and the
      // recovery sweeper judge. Moving it back past the deadline consumes the
      // deadline the way the outage would — queue wait, execution and outage
      // all count — and it touches no other column.
      await jobsDb.query(
        `UPDATE ${JOBS_JOB_RECORD_QUALIFIED}
            SET created_at = created_at - interval '301 seconds'
          WHERE job_id = $1`,
        [jobId],
      );
      const before = await recordRow(jobId);

      const watcher = new StoreWatcher(() => [jobId]);
      let histories: ReadonlyMap<string, StoreHistory> | undefined;
      try {
        await stack.start("jobs");

        // The public status of a deadline overrun is `failed` with the
        // execution error `timeout` — the shared vocabulary reserves `expired`
        // for a lapsed result lifetime, never for timed-out work.
        const final = await pollSnapshot(session.api, jobId, (s) => s.status === "failed", 90_000);
        expect(final.error?.code).toBe("timeout");

        await sleep(15_000);
      } finally {
        histories = await watcher.stop();
      }

      const after = await recordRow(jobId);
      expect(after.attempt, "no attempt ran after recovery").toBe(before.attempt);
      expect(after.progress, "no progress landed after recovery").toEqual(before.progress);
      assertTerminalIsFinal(jobId, must(histories?.get(jobId), "the job's store history"));
    },
  );

  test(
    "losing observation access does not cancel accepted work",
    { timeout: 240_000 },
    async () => {
      const session = sessions.access;
      const slug = apps.access.slug;
      const accepted = await submitDiagnostic(session, { steps: 20, stepDelayMs: 1000 });
      const jobId = accepted.jobId;
      await pollUntilRunning(session.api, jobId, 1);

      // Removing the grant applies directly; once the edge's projection
      // reloads, every jobs route for the app answers the ungranted 403.
      await saveCapabilities(slug, []);

      const refused = await waitFor(
        stack,
        `the status read of job ${jobId} to be refused after the grant's revocation`,
        { timeoutMs: 30_000 },
        async () => {
          const res = await session.api("GET", statusPath(jobId));
          return res.status === 200 ? undefined : res;
        },
      );
      // Access went while the work was still executing.
      expect((await recordRow(jobId)).status, "the job at the moment access was lost").toBe(
        "running",
      );
      // The ungranted refusal carries the shared error and no job state.
      expect(refused.status, `the refused status read: ${refused.text}`).toBe(403);
      expect(JobRequestErrorSchema.parse(refused.json()).code).toBe("forbidden");
      expect(refused.text).not.toContain(DIAGNOSTIC_PROGRESS_LABEL);
      expect(refused.text).not.toContain('"progress"');

      const del = await cancel(session, jobId);
      expect(del.status, `the cancellation after the revocation: ${del.text}`).toBe(403);
      expect(JobRequestErrorSchema.parse(del.json()).code).toBe("forbidden");
      const submitAgain = await submitDiagnosticOnce(session, { steps: 1 }, `lc-${randomUUID()}`);
      expect(submitAgain.status, `a submission after the revocation: ${submitAgain.text}`).toBe(
        403,
      );
      expect(JobRequestErrorSchema.parse(submitAgain.json()).code).toBe("forbidden");

      // Execution continued: the record settles succeeded, with no
      // cancellation intent stamped behind the refused DELETE.
      await waitFor(
        stack,
        `the record of job ${jobId} to settle succeeded with no cancellation intent`,
        { timeoutMs: 60_000 },
        async () => {
          const row = await recordRow(jobId);
          return row.status === "succeeded" && !row.cancellation_requested ? row : undefined;
        },
      );

      await saveCapabilities(slug, [JOBS_DIAGNOSTIC_QUALIFIED_TYPE]);

      // The re-granted observation reads the truth the whole time: the job
      // that lost its access is the one that finished.
      const final = await waitFor(
        stack,
        `job ${jobId} to read succeeded after the re-grant`,
        { timeoutMs: 30_000 },
        async () => {
          const res = await session.api("GET", statusPath(jobId));
          if (res.status !== 200) return undefined;
          const s = JobSnapshotSchema.parse(res.json());
          return s.status === "succeeded" ? s : undefined;
        },
      );
      expect(final.attempt).toBe(1);
      expect(final.cancellationRequested).toBe(false);

      const result = await readResult(session, jobId);
      expect(result.status).toBe(200);
      expect(JSON.parse(result.text)).toEqual({ completedSteps: 20, attempt: 1 });
    },
  );
});

/**
 * Work that fails at its last step on every attempt, so it stays unfinished
 * across the policy's three attempts (about a minute). That outlasts the
 * portal's 15 s delivery cadence, so an archive always finds it active; a
 * 20-step job that could succeed might finish before the delivery lands.
 */
const PERSISTENT: DiagnosticJobInput = { steps: 20, stepDelayMs: 1000, failAtStep: 20 };

// ── app lifecycle through the portal ─────────────────────────────────────────

describe("app lifecycle through the portal", () => {
  test(
    "archive cancels queued and running work in both environments, and unarchive admits only new work",
    { timeout: 600_000 },
    async () => {
      const { app, slug } = apps.l1;
      let session = sessions.l1;

      const minted = await bob.post(`/api/v1/apps/${slug}/dev-tokens`, {
        origins: ["http://localhost:5199"],
      });
      expect(minted.status, "the dev-token mint").toBe(201);
      const dev = stack.devClient(
        slug,
        DevTokenMintResponseSchema.parse(minted.json()).token,
        "http://localhost:5199",
      );

      const p1 = await submitDiagnostic(session, PERSISTENT);
      const p2 = await submitDiagnostic(session, PERSISTENT);
      await Promise.all([
        pollUntilRunning(session.api, p1.jobId, 1),
        pollUntilRunning(session.api, p2.jobId, 1),
      ]);
      const p3 = await submitDiagnostic(session, PERSISTENT);
      const p3Queued = await readSnapshot(session.api, p3.jobId);
      expect(p3Queued.status, "the third prod job stayed queued").toBe("queued");
      expect(p3Queued.attempt).toBeNull();
      const d1 = await submitDiagnostic(dev, PERSISTENT);
      await pollUntilRunning(dev.api, d1.jobId, 1);

      const g0 = Number((await appliedLifecycle(app.id)).generation);
      for (const job of [p1, p2, p3, d1]) {
        const row = await recordRow(job.jobId);
        expect(Number(row.generation), `job ${job.jobId}'s generation`).toBe(g0);
      }

      const watched = [p1.jobId, p2.jobId, p3.jobId, d1.jobId];
      const watcher = new StoreWatcher(() => watched);
      let histories: ReadonlyMap<string, StoreHistory> | undefined;
      try {
        const archiveAt = Date.now();
        const archived = await bob.post(`/api/v1/apps/${slug}/archive`);
        expect(archived.status, "the archive").toBe(200);
        expect(
          AppSchema.parse(archived.json()).archivedAt,
          "the archive's archivedAt",
        ).not.toBeNull();

        await waitFor(
          stack,
          "the edge to answer the archived app's host with 410",
          { timeoutMs: 30_000 },
          async () => {
            const res = await session.api("GET", statusPath(p1.jobId));
            return res.status === 410 ? true : undefined;
          },
        );

        let lastRows: string[] = [];
        await waitFor(
          stack,
          () =>
            `all four jobs' records to settle cancelled after the archive — last store samples: ${lastRows.join(", ") || "<none>"}`,
          { timeoutMs: 120_000, pollMs: 500 },
          async () => {
            const rows = await Promise.all(watched.map((id) => recordRow(id)));
            lastRows = watched.map((id, i) => {
              const r = rows[i];
              return r === undefined
                ? `${id}:<none>`
                : `${id.slice(0, 8)}:${r.status}/intent=${r.cancellation_requested}/attempt=${r.attempt}`;
            });
            return rows.every((r) => r.status === "cancelled") ? rows : undefined;
          },
        );
        const elapsed = Date.now() - archiveAt;
        expect(
          elapsed,
          "the archive-to-terminal elapsed (one 15 s delivery cadence plus the 60 s cancellation bound, with slack)",
        ).toBeLessThan(90_000);

        const p3Row = await recordRow(p3.jobId);
        expect(p3Row.attempt, "the queued job's final attempt").toBeNull();

        await waitFor(
          stack,
          "the jobs lifecycle-recovery check to report nothing outstanding",
          { timeoutMs: 45_000 },
          async () => {
            const body = await healthBody(jobsHealthUrl());
            const check = body.checks?.find((c) => c.name === JOBS_LIFECYCLE_RECOVERY_CHECK);
            if (!check) return undefined;
            return check.status === "ok" && (check.metrics?.outstanding ?? 0) === 0
              ? true
              : undefined;
          },
        );

        const unarchived = await bob.post(`/api/v1/apps/${slug}/unarchive`);
        expect(unarchived.status, "the unarchive").toBe(200);
        expect(
          AppSchema.parse(unarchived.json()).archivedAt,
          "the unarchive's archivedAt",
        ).toBeNull();

        // Before the jobs server knows the new generation, a submission is a
        // retryable 503 (criterion 52); the edge's projection may still answer
        // 410 for a moment. An acceptance is possible only once the unarchive
        // is applied, and then only under the new generation.
        const early = await submitOnce(session, { steps: 1 });
        expect(
          [202, 410, 503],
          `the submission right after the unarchive: ${early.body}`,
        ).toContain(early.status);
        if (early.accepted !== undefined) {
          expect(
            Number((await recordRow(early.accepted.jobId)).generation),
            "an early acceptance runs under the new generation",
          ).toBeGreaterThan(g0);
        } else if (early.status === 503) {
          // The 410 is the edge's archived-app page; the 503 is the jobs
          // gateway's retryable refusal in the shared error shape.
          expect(JobRequestErrorSchema.safeParse(JSON.parse(early.body)).success).toBe(true);
        }

        // Each submission attempt is charged against the per-app window, so
        // wait for the applied unarchive and the edge's projection rather
        // than spending attempts on retries.
        await waitFor(
          stack,
          "the jobs store to apply the unarchive",
          { timeoutMs: 60_000 },
          async () => {
            const applied = await appliedLifecycle(app.id);
            return Number(applied.generation) > g0 && !applied.archived ? true : undefined;
          },
        );
        const served = await waitFor(
          stack,
          "the edge to serve the unarchived app host again",
          { timeoutMs: 30_000 },
          async () => {
            const res = await session.navigate();
            return res.status === 410 ? undefined : res;
          },
        );
        // The harness client ignores Clear-Site-Data, so the session normally
        // survives; a fresh login covers a session the archive ended.
        if (served.status !== 200) {
          session = await stack.appSession(slug, "bob@azx.dev");
        }

        const n = await submitDiagnostic(session, { steps: 2, stepDelayMs: 200 });
        const nFinal = await pollSnapshot(
          session.api,
          n.jobId,
          (s) => s.status === "succeeded",
          60_000,
        );
        expect(nFinal.error).toBeNull();
        const nResult = await readResult(session, n.jobId);
        expect(nResult.status).toBe(200);
        expect(JSON.parse(nResult.text)).toEqual({ completedSteps: 2, attempt: 1 });

        const nRow = await recordRow(n.jobId);
        expect(
          Number(nRow.generation),
          "the new job's generation exceeds the archived one",
        ).toBeGreaterThan(g0);
        const appliedNow = await appliedLifecycle(app.id);
        expect(Number(nRow.generation), "the new job runs under the applied generation").toBe(
          Number(appliedNow.generation),
        );
        expect(appliedNow.archived, "the applied state after the unarchive").toBe(false);

        for (const [client, job] of [
          [session, p1],
          [session, p2],
          [session, p3],
        ] as const) {
          const s = await readSnapshot(client.api, job.jobId);
          expect(s.status, `job ${job.jobId}'s public snapshot`).toBe("cancelled");
          expect(s.cancellationRequested, `job ${job.jobId}'s public snapshot`).toBe(true);
        }
        const p3Public = await readSnapshot(session.api, p3.jobId);
        expect(p3Public.attempt, "the queued job's public attempt").toBeNull();
        const d1Public = await readSnapshot(dev.api, d1.jobId);
        expect(d1Public.status, "the dev job's public snapshot").toBe("cancelled");
        expect(d1Public.cancellationRequested).toBe(true);

        // Past any late revival window: a cancelled record that moves after
        // the unarchive would show in the histories below.
        await sleep(10_000);
      } finally {
        histories = await watcher.stop();
      }

      for (const job of [p1, p2, p3, d1]) {
        const history = must(histories?.get(job.jobId), `job ${job.jobId}'s store history`);
        assertTerminalIsFinal(job.jobId, history);
        assertNoAttemptAfterIntent(job.jobId, history);
      }
      assertQueuedCancelNeverStarts(
        p3.jobId,
        must(histories?.get(p3.jobId), "job P3's store history"),
      );
    },
  );

  test(
    "an immediate archive then unarchive, racing submissions and starts, cancels every pre-archive job and new work still runs",
    { timeout: 600_000 },
    async () => {
      const { app, slug } = apps.l2;
      const session = sessions.l2;
      const g0 = Number((await appliedLifecycle(app.id)).generation);

      // Four 8 s jobs, two running at a time: the queued pair starts around
      // the time the lifecycle change is delivered. Seven submissions in all (four
      // here, three racing) plus the final one stay inside the per-app
      // window of ten attempts a minute.
      const BODY: DiagnosticJobInput = { steps: 8, stepDelayMs: 1000 };
      const initial: JobAccepted[] = [];
      for (let i = 0; i < 4; i++) {
        initial.push(await submitDiagnostic(session, BODY));
      }
      await waitFor(
        stack,
        "one of the four pre-archive jobs to run",
        { timeoutMs: 60_000 },
        async () => {
          for (const job of initial) {
            const res = await session.api("GET", statusPath(job.jobId));
            if (res.status === 503) continue;
            expect(res.status, `the status poll of job ${job.jobId}`).toBe(200);
            if (JobSnapshotSchema.parse(res.json()).status === "running") return true;
          }
          return undefined;
        },
      );

      const watched: string[] = initial.map((j) => j.jobId);
      const watcher = new StoreWatcher(() => [...watched]);
      let histories: ReadonlyMap<string, StoreHistory> | undefined;
      let gFinalRead: number | undefined;
      try {
        // Handlers attach at birth: a racing rejection must never be
        // unhandled while the suite waits on the lifecycle changes.
        const archiveThenUnarchive = (async () => {
          const archived = await bob.post(`/api/v1/apps/${slug}/archive`);
          expect(archived.status, "the racing archive").toBe(200);
          const unarchived = await bob.post(`/api/v1/apps/${slug}/unarchive`);
          expect(unarchived.status, "the racing unarchive").toBe(200);
        })();
        const racing = [0, 1, 2].map(
          (): Promise<{ status: number; accepted?: JobAccepted; body: string }> =>
            submitOnce(session, BODY).then(
              (r) => r,
              (e: unknown) => ({
                status: 0,
                body: `the racing submission threw: ${e instanceof Error ? e.message : String(e)}`,
              }),
            ),
        );
        await archiveThenUnarchive;
        for (const r of await Promise.all(racing)) {
          expect(
            [202, 403, 410, 503],
            `a racing submission's answer was ${r.status}: ${r.body.slice(0, 300)} — ` +
              `anything else (in particular a 5xx other than 503) is a bug`,
          ).toContain(r.status);
          if (r.accepted) watched.push(r.accepted.jobId);
        }

        gFinalRead = await waitFor(
          stack,
          "the applied lifecycle to land at the unarchive's generation, unarchived",
          { timeoutMs: 60_000 },
          async () => {
            const applied = await appliedLifecycle(app.id);
            return Number(applied.generation) >= g0 + 2 && !applied.archived
              ? Number(applied.generation)
              : undefined;
          },
        );

        let lastTerminal: string[] = [];
        await waitFor(
          stack,
          () =>
            `every watched record to settle terminal — last store samples: ${lastTerminal.join(", ") || "<none>"}`,
          { timeoutMs: 120_000, pollMs: 500 },
          async () => {
            const rows = await Promise.all(watched.map((id) => recordRow(id)));
            lastTerminal = watched.map((id, i) => {
              const r = rows[i];
              return r === undefined
                ? `${id}:<none>`
                : `${id.slice(0, 8)}:${r.status}/gen=${r.generation}`;
            });
            return rows.every((r) => TERMINAL_STATUSES.has(r.status)) ? rows : undefined;
          },
        );
      } finally {
        histories = await watcher.stop();
      }

      const gFinalApplied = must(gFinalRead, "the applied unarchive generation");
      const settled = new Map<string, JobRecordRow>();
      for (const id of watched) settled.set(id, await recordRow(id));
      let cancelledCount = 0;
      for (const [id, row] of settled) {
        const generation = Number(row.generation);
        if (generation < gFinalApplied) {
          expect(
            ["succeeded", "cancelled"],
            `job ${id}'s outcome under the closed generation ${generation} (first terminal outcome wins)`,
          ).toContain(row.status);
          if (row.status === "cancelled") cancelledCount += 1;
        } else if (generation === gFinalApplied) {
          expect(row.status, `the job admitted under the new generation ${gFinalApplied}`).toBe(
            "succeeded",
          );
        } else {
          throw new Error(
            `job ${id} carries generation ${generation} beyond gFinal ${gFinalApplied}`,
          );
        }
      }
      if (cancelledCount === 0) {
        throw new Error(
          "no pre-archive job ended cancelled — the race was not exercised: every record under " +
            "the closed generation had already settled before the cancellation intent was delivered",
        );
      }

      for (const id of watched) {
        const history = must(histories?.get(id), `job ${id}'s store history`);
        assertTerminalIsFinal(id, history);
        // The intent helpers' precondition is an intent — only a cancelled
        // record carries one; a job that raced to `succeeded` under the
        // closed generation never does.
        if (must(settled.get(id), `job ${id}'s settled row`).status === "cancelled") {
          assertNoAttemptAfterIntent(id, history);
        }
      }

      const post = await submitDiagnostic(session, { steps: 1 });
      await pollSnapshot(session.api, post.jobId, (s) => s.status === "succeeded", 60_000);
      expect(Number((await recordRow(post.jobId)).generation), "the new work's generation").toBe(
        gFinalApplied,
      );

      // No revival: the pre-archive records never move again.
      const fingerprints = new Map<string, string>();
      for (const id of watched) {
        fingerprints.set(id, recordFingerprint(must(settled.get(id), `job ${id}'s settled row`)));
      }
      await sleep(10_000);
      for (const id of watched) {
        expect(
          recordFingerprint(await recordRow(id)),
          `job ${id}'s record moved after the unarchive (revival)`,
        ).toBe(must(fingerprints.get(id), `job ${id}'s earlier fingerprint`));
      }
    },
  );

  test(
    "lifecycle changes made while jobs is down survive a portal crash and are delivered on recovery; neither the old generation nor a late out-of-order archive changes anything",
    { timeout: 600_000 },
    async () => {
      const { app, slug } = apps.l3;
      const session = sessions.l3;

      const q1 = await submitDiagnostic(session, PERSISTENT);
      const q2 = await submitDiagnostic(session, PERSISTENT);
      await Promise.all([
        pollUntilRunning(session.api, q1.jobId, 1),
        pollUntilRunning(session.api, q2.jobId, 1),
      ]);
      const q3 = await submitDiagnostic(session, PERSISTENT);
      const q3Queued = await readSnapshot(session.api, q3.jobId);
      expect(q3Queued.status, "the third job stayed queued").toBe("queued");
      expect(q3Queued.attempt).toBeNull();

      const g0 = Number((await appliedLifecycle(app.id)).generation);
      const watched = [q1.jobId, q2.jobId, q3.jobId];
      for (const job of [q1, q2, q3]) {
        expect(
          Number((await recordRow(job.jobId)).generation),
          `job ${job.jobId}'s generation`,
        ).toBe(g0);
      }

      const watcher = new StoreWatcher(() => watched);
      let histories: ReadonlyMap<string, StoreHistory> | undefined;
      try {
        const f0 = (await deliveryCheckReading()).metrics.failedDeliveries ?? 0;

        await stack.crash("jobs");
        const archived = await bob.post(`/api/v1/apps/${slug}/archive`);
        expect(archived.status, "the archive while jobs is down").toBe(200);
        const unarchived = await bob.post(`/api/v1/apps/${slug}/unarchive`);
        expect(unarchived.status, "the unarchive while jobs is down").toBe(200);

        await waitFor(
          stack,
          "the delivery check to show the pending backlog (outstanding >= 2, failedDeliveries grew)",
          { timeoutMs: 45_000 },
          async () => {
            const { metrics } = await deliveryCheckReading();
            return (metrics.outstanding ?? 0) >= 2 && (metrics.failedDeliveries ?? 0) > f0
              ? true
              : undefined;
          },
        );

        // The sender crashes with both intents pending. The outbox is durable,
        // so the restarted portal still holds them and keeps delivering.
        await stack.crash("portal");
        await stack.start("portal");
        await waitFor(
          stack,
          "the restarted portal to report the same pending backlog (outstanding >= 2)",
          { timeoutMs: 45_000 },
          async () => {
            const { metrics } = await deliveryCheckReading();
            return (metrics.outstanding ?? 0) >= 2 ? true : undefined;
          },
        );

        const beforeRefused = await appRecordRows(app.id);
        expect(
          beforeRefused.map((r) => r.job_id).sort(),
          "the store before the refused submission",
        ).toEqual([...watched].sort());
        const refused = await submitOnce(session, { steps: 1 });
        expect(
          refused.status,
          `the submission while jobs is down: ${refused.body.slice(0, 200)}`,
        ).toBe(503);
        // A retryable refusal with the shared error shape — never a
        // fabricated acceptance.
        expect(JobRequestErrorSchema.parse(JSON.parse(refused.body)).code).toBe("jobs_unavailable");
        expect(
          (await appRecordRows(app.id)).map((r) => r.job_id).sort(),
          "no new record for the app appeared while jobs was down",
        ).toEqual([...watched].sort());

        await stack.start("jobs");

        await waitFor(
          stack,
          "the delivery backlog to drain after the restart",
          { timeoutMs: 60_000 },
          async () => {
            return (await deliveryCheckReading()).metrics.outstanding === 0 ? true : undefined;
          },
        );

        await waitFor(
          stack,
          "Q1, Q2 and Q3 to settle cancelled once the intents are delivered",
          { timeoutMs: 90_000, pollMs: 500 },
          async () => {
            const rows = await Promise.all(watched.map((id) => recordRow(id)));
            return rows.every((r) => r.status === "cancelled") ? rows : undefined;
          },
        );
        // Q3 may have started on the restarted worker before the delivery
        // landed: accepted work may run while archive delivery is pending
        // (criterion 50). What the delivery must guarantee is checked on the
        // store histories below — no attempt starts after the intent.

        const post = await submitDiagnostic(session, { steps: 1 });
        await pollSnapshot(session.api, post.jobId, (s) => s.status === "succeeded", 60_000);
        const postGeneration = Number((await recordRow(post.jobId)).generation);
        expect(postGeneration, "the new work runs under the applied generation").toBe(
          Number((await appliedLifecycle(app.id)).generation),
        );
        expect(
          postGeneration,
          "the applied generation opened past both transitions",
        ).toBeGreaterThanOrEqual(g0 + 2);

        // A late, out-of-order delivery: an archive older than the applied
        // unarchive, freshly signed with the portal's key as a delayed retry
        // would be. The receiver acknowledges its current watermark and
        // closes nothing: work running under the open generation finishes.
        const applied = await appliedLifecycle(app.id);
        const running = await submitDiagnostic(session, { steps: 3, stepDelayMs: 1000 });
        await pollUntilRunning(session.api, running.jobId, 1);
        const staleBody = Buffer.from(
          JSON.stringify({ generation: String(Number(applied.generation) - 1), archived: true }),
        );
        const roots = must(stack.jobsRoots, "the stack's jobs signing roots");
        const staleToken = await mintJobsInstruction(
          {
            operation: "lifecycle",
            server: JOBS_SERVER_NAME,
            appId: app.id,
            body: staleBody,
            iatS: Math.floor(Date.now() / 1000),
          },
          deriveJobsInstructionKey(roots.portalToJobs, "portalToJobs"),
        );
        const stale = await stack.request(
          `http://localhost:${stack.ports.jobs}/internal/jobs/v1/lifecycle/${app.id}`,
          {
            method: "POST",
            headers: { [INSTRUCTION_HEADER]: staleToken, "Content-Type": "application/json" },
            body: staleBody,
          },
        );
        expect(stale.status, `the out-of-order delivery: ${stale.text.slice(0, 200)}`).toBe(200);
        expect(
          (JSON.parse(stale.text) as { appliedGeneration?: unknown }).appliedGeneration,
          "the out-of-order delivery acknowledges the current watermark",
        ).toBe(applied.generation);
        expect(await appliedLifecycle(app.id), "the applied lifecycle is unchanged").toEqual(
          applied,
        );
        const finished = await pollSnapshot(
          session.api,
          running.jobId,
          (s) => TERMINAL_STATUSES.has(s.status),
          60_000,
        );
        expect(finished.status, "the open generation's running job is not cancelled").toBe(
          "succeeded",
        );
        expect(finished.cancellationRequested).toBe(false);

        // Past pg-boss's heartbeat-based lost-claim detection: any
        // restart-driven retry or late completion would have to show by now.
        await sleep(20_000);
      } finally {
        histories = await watcher.stop();
      }

      for (const job of [q1, q2, q3]) {
        const history = must(histories?.get(job.jobId), `job ${job.jobId}'s store history`);
        assertNoAttemptAfterIntent(job.jobId, history);
        assertTerminalIsFinal(job.jobId, history);
      }
      for (const job of [q1, q2]) {
        const row = await recordRow(job.jobId);
        expect(row.progress?.step ?? 0, `job ${job.jobId} never ran to completion`).toBeLessThan(
          20,
        );
      }
    },
  );
});
