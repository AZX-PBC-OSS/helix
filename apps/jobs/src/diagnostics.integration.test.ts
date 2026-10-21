import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  HealthStatusSchema,
  IDEMPOTENCY_KEY_HEADER,
  INSTRUCTION_HEADER,
  JOBS_CAPACITY_DEFAULTS,
  JOBS_DIAGNOSTIC_QUALIFIED_TYPE,
  JobSnapshotSchema,
  type JobSnapshot,
} from "@azx-pbc/shared";
import { deriveJobsInstructionKey, mintJobsInstruction } from "@azx-pbc/shared/jobsSigning";
import { JOBS_SIGNING_VECTOR_ROOTS } from "@azx-pbc/shared/jobsSigningVectors";

import { DIAGNOSTIC_PROGRESS_LABEL } from "./diagnostics.js";
import { migrateJobsStorage } from "./migrate.js";
import { JOBS_JOB_RECORD_QUALIFIED } from "./policy.js";
import { SESSION_COOKIE } from "../../edge/src/auth/cookies.js";
import { InMemoryCounterStore } from "../../edge/src/gateway/counterStore.js";
import { JobsSubmissionThrottle } from "../../edge/src/gateway/jobsThrottle.js";
import { HttpJobsForwarder } from "../../edge/src/jobs/forwarder.js";
import { hashSessionToken, newSessionToken } from "../../edge/src/auth/sessions.js";
import type { FakeSessionStore } from "../../edge/src/test/fakes.js";
import {
  buildJobsEdgeApp,
  JOBS_APP_ID,
  JOBS_HOST,
  JOBS_ORIGIN,
} from "../../edge/src/test/jobsGateway.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The diagnostic type through every real path at once: the real `src/server.ts`
 * process (spawned as a child, diagnostics enabled), a real scratch Postgres
 * store under the real role split, real pg-boss, and the real edge app
 * forwarding over its real signed hop — driven only through the app-facing
 * `/_api/jobs/*` routes.
 *
 * Legs 1–5 share one child + edge: durable incremental progress and the stored
 * result; retry exhaustion (attempts_exhausted, the previous attempt's
 * attribution visible while the retry waits); owner cancellation of running
 * work; fenced late completion under `ignoreAbort`; and worker interruption
 * (SIGKILL) recovering under the type's attempt policy on a replacement child.
 * The production legs prove the non-production boundary itself: a production
 * process refuses to boot with diagnostics on, and a running production
 * process refuses the diagnostic type (and guessed spellings, and
 * client-supplied enable attempts) at its own admission gate.
 */

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_diag_e2e_${randomUUID().replaceAll("-", "")}`;

/** The corpus's public roots are compile-time known; this narrows the index for `noUncheckedIndexedAccess`. */
function vectorRoot(keyId: string): string {
  const entry = JOBS_SIGNING_VECTOR_ROOTS[keyId];
  if (!entry) throw new Error(`no such vector root: ${keyId}`);
  return entry.root;
}

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

/** The runtime and migration DSNs of the scratch store — the real role split. */
const RUNTIME_DSN = urlFor(SCRATCH_DB, "helix_jobs");
const MIGRATE_DSN = urlFor(SCRATCH_DB, "helix_jobs_migrate");

/** A port bound by no test service; a refused loopback connect is the outage. */
const DEAD_PORT = 59999;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── child-process plumbing ───────────────────────────────────────────────────

/**
 * Every spawned child, so the suite's teardown kills whatever is still alive
 * on both the success and the failure paths.
 */
const CHILDREN = new Set<ChildProcess>();

function track(child: ChildProcess): ChildProcess {
  CHILDREN.add(child);
  child.once("exit", () => CHILDREN.delete(child));
  return child;
}

async function killAllChildren(): Promise<void> {
  for (const child of CHILDREN) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && CHILDREN.size > 0) {
    for (const child of [...CHILDREN]) {
      if (child.exitCode !== null) CHILDREN.delete(child);
    }
    if (CHILDREN.size > 0) await sleep(100);
  }
  for (const child of CHILDREN) {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  CHILDREN.clear();
}

/**
 * The child's base environment: the developer's ambient variables, minus every
 * knob the legs construct deliberately — the boot suite's scrub. `HELIX_STACK_ENV=1`
 * (set on every child below) makes the composition skip the developer's own
 * `.env.local`, which is left untouched.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("JOBS_") || key === "PORT" || key === "HOST") continue;
    if (key === "NODE_ENV" || key === "SHUTDOWN_GRACE_MS") continue;
    if (key.startsWith("OTEL_EXPORTER_OTLP") || key === "OTEL_SDK_DISABLED") continue;
    if (key === "HELIX_STACK_ENV") continue;
    env[key] = value;
  }
  env.JOBS_ACCEPTING = "true";
  return env;
}

function childEnv(port: number, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    NODE_ENV: "test",
    JOBS_SERVER_ID: "jobs",
    JOBS_DATABASE_URL: RUNTIME_DSN,
    JOBS_EDGE_TO_JOBS_SECRET: vectorRoot("edge-to-jobs.jobs"),
    JOBS_PORTAL_TO_JOBS_SECRET: vectorRoot("portal-to-jobs.jobs"),
    JOBS_JOBS_TO_EDGE_SECRET: vectorRoot("jobs-to-edge.jobs"),
    JOBS_EDGE_PROD_URL: `http://127.0.0.1:${DEAD_PORT}`,
    JOBS_EDGE_DEV_URL: `http://127.0.0.1:${DEAD_PORT}`,
    JOBS_PORT: String(port),
    SHUTDOWN_GRACE_MS: "2500",
    HELIX_STACK_ENV: "1",
    OTEL_SDK_DISABLED: "1",
    ...extra,
  };
}

async function reservePort(): Promise<number> {
  const provisional = createServer();
  await new Promise<void>((resolve) => provisional.listen(0, "127.0.0.1", resolve));
  const port = (provisional.address() as { port: number }).port;
  await new Promise<void>((resolve) => provisional.close(() => resolve()));
  return port;
}

interface HealthBody {
  status: "ok" | "degraded" | "error";
  service: string;
  uptime: number;
}

async function pollHealth(port: number, timeoutMs: number): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs;
  let lastRefusal: unknown;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return (await res.json()) as HealthBody;
    } catch (error) {
      lastRefusal = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`no health answer on :${port} within ${timeoutMs}ms`, { cause: lastRefusal });
    }
    await sleep(100);
  }
}

/** Spawn the real entry point (tracked) and wait until its listener answers. */
async function bootServer(port: number, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = track(
    spawn("node", ["--import", "tsx", "src/server.ts"], {
      cwd: PACKAGE_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const output: string[] = [];
  child.stdout?.on("data", (chunk: string) => output.push(chunk));
  child.stderr?.on("data", (chunk: string) => output.push(chunk));
  try {
    await pollHealth(port, 60_000);
  } catch (error) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", resolve));
    throw new Error(
      `the child never served :${port} — child output: ${output.join("").slice(-4_000) || "<none>"}`,
      { cause: error },
    );
  }
  return child;
}

/** SIGTERM, then SIGKILL after a bound — teardown never waits forever. */
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", resolve)),
    sleep(10_000).then(() => undefined),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

/** Wait for a child's exit, failing the caller if it outlives the bound. */
async function waitExit(child: ChildProcess, boundMs: number): Promise<number | null> {
  const exited = await Promise.race([
    new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
    }),
    sleep(boundMs).then(() => {
      child.kill("SIGKILL");
      return null;
    }),
  ]);
  return exited;
}

// ── edge-side helpers ────────────────────────────────────────────────────────

function edgeThrottle(): JobsSubmissionThrottle {
  // The edge's in-memory submission windows default to a handful of attempts;
  // these legs submit (and retry 503s) across several tests, so the harness
  // gets the same buckets with the platform's attempt caps raised.
  return new JobsSubmissionThrottle(new InMemoryCounterStore(), {
    ...JOBS_CAPACITY_DEFAULTS,
    submissionAttemptsPerAppEnv: 1_000,
    submissionAttemptsDeployment: 100_000,
  });
}

function edgeForwarder(jobsPort: number): HttpJobsForwarder {
  return new HttpJobsForwarder(
    [
      {
        server: "jobs",
        endpoint: `http://127.0.0.1:${jobsPort}`,
        edgeToJobsKey: deriveJobsInstructionKey(vectorRoot("edge-to-jobs.jobs"), "edgeToJobs"),
      },
    ],
    { timeoutMs: 10_000 },
  );
}

/** The portal's half of the admission gate: open generation 1 for the app. */
async function deliverOpenGeneration(jobsPort: number): Promise<void> {
  const body = '{"generation":"1","archived":false}';
  const token = await mintJobsInstruction(
    {
      operation: "lifecycle",
      server: "jobs",
      appId: JOBS_APP_ID,
      body: new TextEncoder().encode(body),
      iatS: Math.floor(Date.now() / 1000) - 1,
    },
    deriveJobsInstructionKey(vectorRoot("portal-to-jobs.jobs"), "portalToJobs"),
  );
  const res = await fetch(
    `http://127.0.0.1:${jobsPort}/internal/jobs/v1/lifecycle/${JOBS_APP_ID}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", [INSTRUCTION_HEADER]: token },
      body,
    },
  );
  expect(res.status).toBe(200);
}

/**
 * A session for the harness app with refresh bounds that fit this suite's own
 * runtime — `seedJobsSession`'s 60-second refresh window cannot survive the
 * multi-minute legs (the gate 401s refresh-due requests mid-leg).
 */
async function seedSession(sessions: FakeSessionStore, oid: string): Promise<string> {
  const id = randomUUID();
  await sessions.createPending({
    id,
    appId: JOBS_APP_ID,
    user: { oid, displayName: oid, name: null, email: null, kind: "user", groups: [] },
    refreshDueAt: new Date(Date.now() + 3_600_000),
    expiresAt: new Date(Date.now() + 8 * 3_600_000),
  });
  const token = newSessionToken();
  await sessions.redeem(id, JOBS_APP_ID, hashSessionToken(token));
  return token;
}

function jsonOf(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// ── module-scoped store setup/teardown ───────────────────────────────────────

beforeAll(async () => {
  // The scratch store is created by the provisioning itself (create-if-missing),
  // inside the serialized application — the real role split, no test superuser.
  await applyRolesProvisioning(SCRATCH_DB);
  await migrateJobsStorage(MIGRATE_DSN);
}, 120_000);

afterAll(async () => {
  await killAllChildren();
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 60_000);

describe("diagnostic jobs through the running services (shared child, edge, signed hop)", () => {
  const slow = { timeout: 180_000 };
  const POLL_MS = 150;

  let port: number;
  let child: ChildProcess;
  let forwarder: HttpJobsForwarder;
  let edge: ReturnType<typeof buildJobsEdgeApp>["app"];
  let sessions: ReturnType<typeof buildJobsEdgeApp>["sessions"];
  let token: string;

  beforeAll(async () => {
    port = await reservePort();
    child = await bootServer(port, childEnv(port, { JOBS_DIAGNOSTICS: "true" }));
    await eventuallyHealthy();
    forwarder = edgeForwarder(port);
    const harness = buildJobsEdgeApp(forwarder, {
      jobs: { types: [JOBS_DIAGNOSTIC_QUALIFIED_TYPE] },
      jobsSubmissionThrottle: edgeThrottle(),
    });
    edge = harness.app;
    sessions = harness.sessions;
    token = await seedSession(sessions, "alice");
    await deliverOpenGeneration(port);
  }, 120_000);

  afterAll(async () => {
    await edge?.close();
    await forwarder?.close();
    if (child) await stopServer(child);
  }, 60_000);

  async function eventuallyHealthy(): Promise<void> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const body = await pollHealth(port, 10_000);
      if (HealthStatusSchema.parse(body).status === "ok") return;
      if (Date.now() > deadline) {
        throw new Error(`the jobs child never reached ok health: ${JSON.stringify(body)}`);
      }
      await sleep(500);
    }
  }

  /** One snapshot read through the edge (the parsed body, whatever the status). */
  async function readSnapshot(
    jobId: string,
  ): Promise<{ status: number; snapshot: JobSnapshot | null; body: unknown }> {
    const res = await edge.inject({
      method: "GET",
      url: `/_api/jobs/jobs/${jobId}`,
      headers: { host: JOBS_HOST.host, cookie: `${SESSION_COOKIE}=${token}` },
    });
    const body = jsonOf(res.body);
    const verdict = JobSnapshotSchema.safeParse(body);
    return {
      status: res.statusCode,
      snapshot: res.statusCode === 200 && verdict.success ? verdict.data : null,
      body,
    };
  }

  /**
   * Poll the snapshot through the edge until the predicate holds, recording
   * every distinct (status, attempt, progress, error) seen; throws naming the
   * last snapshot when the budget runs out.
   */
  async function pollUntil(
    jobId: string,
    predicate: (s: JobSnapshot) => boolean,
    budgetMs: number,
  ): Promise<{ matched: JobSnapshot; observed: JobSnapshot[] }> {
    const deadline = Date.now() + budgetMs;
    const observed: JobSnapshot[] = [];
    const seen = new Set<string>();
    let last: JobSnapshot | null = null;
    let lastAnswer = "<none>";
    while (Date.now() < deadline) {
      const { status, snapshot, body } = await readSnapshot(jobId);
      lastAnswer = `${status} ${JSON.stringify(body)?.slice(0, 300) ?? ""}`;
      if (snapshot) {
        last = snapshot;
        const key = `${snapshot.status}:${snapshot.attempt}:${snapshot.progress?.step ?? "-"}:${snapshot.error?.code ?? "-"}`;
        if (!seen.has(key)) {
          seen.add(key);
          observed.push(snapshot);
        }
        if (predicate(snapshot)) return { matched: snapshot, observed };
      }
      await sleep(POLL_MS);
    }
    throw new Error(
      `the snapshot never matched within ${budgetMs}ms — last snapshot: ${JSON.stringify(last)}, ` +
        `last answer: ${lastAnswer}, observed: ${JSON.stringify(observed)}`,
    );
  }

  /** Submit a diagnostic job through the edge until the acceptance commits (the 503s of the runner's convergence are retryable). */
  async function submitDiagnostic(input: object, idempotencyKey: string): Promise<string> {
    const deadline = Date.now() + 60_000;
    let last: unknown = null;
    let fresh = true;
    while (Date.now() < deadline) {
      const res = await edge.inject({
        method: "POST",
        url: "/_api/jobs/jobs/types/diagnostic",
        headers: {
          host: JOBS_HOST.host,
          "sec-fetch-mode": "cors",
          "content-type": "application/json",
          origin: JOBS_ORIGIN,
          cookie: `${SESSION_COOKIE}=${token}`,
          [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
        },
        payload: JSON.stringify(input),
      });
      const body = jsonOf(res.body) as { server?: string; jobId?: string; status?: string } | null;
      if (res.statusCode === 202) {
        expect(body).toMatchObject({ server: "jobs", jobId: expect.any(String) });
        if (fresh) expect(body?.status).toBe("queued");
        return body?.jobId as string;
      }
      last = { status: res.statusCode, body };
      if (res.statusCode !== 503) break;
      fresh = false;
      await sleep(500);
    }
    throw new Error(`the submission never committed — last answer: ${JSON.stringify(last)}`);
  }

  async function readResult(jobId: string): Promise<{ status: number; body: unknown }> {
    const res = await edge.inject({
      method: "GET",
      url: `/_api/jobs/jobs/${jobId}/result`,
      headers: { host: JOBS_HOST.host, cookie: `${SESSION_COOKIE}=${token}` },
    });
    return { status: res.statusCode, body: jsonOf(res.body) };
  }

  async function cancelThroughEdge(jobId: string): Promise<{ status: number; body: unknown }> {
    const res = await edge.inject({
      method: "DELETE",
      url: `/_api/jobs/jobs/${jobId}`,
      headers: {
        host: JOBS_HOST.host,
        origin: JOBS_ORIGIN,
        cookie: `${SESSION_COOKIE}=${token}`,
      },
    });
    return { status: res.statusCode, body: jsonOf(res.body) };
  }

  /** Wait until the job runs with at least one reported step. */
  async function pollUntilRunning(jobId: string, minStep: number): Promise<JobSnapshot> {
    const { matched } = await pollUntil(
      jobId,
      (s) => s.status === "running" && (s.progress?.step ?? 0) >= minStep,
      60_000,
    );
    return matched;
  }

  test(
    "progress is durably observable while running, and the result is stored and served exactly",
    slow,
    async () => {
      const jobId = await submitDiagnostic({ steps: 3, stepDelayMs: 300 }, "diag-leg-progress");
      const { matched: final, observed } = await pollUntil(
        jobId,
        (s) => s.status === "succeeded",
        60_000,
      );

      // Durable incremental progress was publicly observable mid-flight.
      const progressSteps = observed.filter(
        (s) => s.status === "running" && s.progress !== null && s.progress.of === 3,
      );
      expect(progressSteps.length).toBeGreaterThanOrEqual(1);
      const seenProgress = progressSteps.find(
        (s) =>
          s.progress !== null &&
          s.progress.step >= 1 &&
          s.progress.step <= 3 &&
          s.progress.label === DIAGNOSTIC_PROGRESS_LABEL,
      );
      expect(seenProgress).toBeDefined();

      expect(final.attempt).toBe(1);
      expect(final.progress).toEqual({ step: 3, of: 3, label: DIAGNOSTIC_PROGRESS_LABEL });
      expect(final.error).toBeNull();

      const result = await readResult(jobId);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ completedSteps: 3, attempt: 1 });
    },
  );

  test(
    "a failure on every attempt exhausts the policy's attempts, keeping the failed attempt's attribution visible while the retry waits",
    slow,
    async () => {
      const jobId = await submitDiagnostic(
        { steps: 2, failAtStep: 2, stepDelayMs: 200 },
        "diag-leg-exhaust",
      );

      // While the job is in flight, watch the store as the runtime role for
      // the between-attempts state (the public snapshot is the preferred
      // evidence; the store is the timing-proof fallback).
      let storeSawQueuedAttribution = false;
      let watching = true;
      const watcher = (async () => {
        const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
        try {
          while (watching) {
            const { rows } = await pool.query<{
              status: string;
              attempt: number | null;
              error_code: string | null;
              progress: { step: number; of: number; label: string } | null;
            }>(
              `SELECT status, attempt, error_code, progress
                 FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
              [jobId],
            );
            const row = rows[0];
            if (
              row?.status === "queued" &&
              row.error_code === "upstream_error" &&
              (row.attempt === 1 || row.attempt === 2) &&
              row.progress?.step === 1 &&
              row.progress.of === 2
            ) {
              storeSawQueuedAttribution = true;
            }
            await sleep(100);
          }
        } finally {
          await pool.end();
        }
      })();

      let snapshotSawQueuedAttribution = false;
      let final: JobSnapshot;
      try {
        const poll = await pollUntil(
          jobId,
          (s) => {
            if (
              s.status === "queued" &&
              (s.attempt === 1 || s.attempt === 2) &&
              s.error?.code === "upstream_error" &&
              s.progress?.step === 1 &&
              s.progress.of === 2
            ) {
              snapshotSawQueuedAttribution = true;
            }
            return s.status === "failed";
          },
          120_000,
        );
        final = poll.matched;
      } finally {
        watching = false;
        await watcher;
      }

      expect(final.attempt).toBe(3);
      expect(final.error?.code).toBe("attempts_exhausted");
      expect(
        snapshotSawQueuedAttribution || storeSawQueuedAttribution,
        "the between-attempts queued state (the previous attempt's progress and error) was never observable",
      ).toBe(true);

      // Terminal with no result: the stateful refusal.
      const result = await readResult(jobId);
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({
        code: "job_terminal",
        status: "failed",
        error: { code: "attempts_exhausted" },
      });
    },
  );

  test(
    "an owner cancellation of running work is acknowledged as durable intent and reaches its terminal cancelled outcome inside the abort bound",
    slow,
    async () => {
      const jobId = await submitDiagnostic({ steps: 20, stepDelayMs: 1000 }, "diag-leg-cancel");
      await pollUntilRunning(jobId, 1);

      const deleteAt = Date.now();
      const cancelled = await cancelThroughEdge(jobId);
      expect(cancelled.status).toBe(202);
      expect(cancelled.body).toEqual({
        server: "jobs",
        jobId,
        cancellationRequested: true,
      });

      // The handler stops at the abort, so the terminal outcome must arrive
      // well inside the job's remaining run time (~19s of steps left here).
      const { matched: final } = await pollUntil(
        jobId,
        (s) => s.status === "cancelled",
        Math.max(1_000, deleteAt + 15_000 - Date.now()),
      );
      expect(final.error?.code).toBe("cancelled");
      expect(Date.now() - deleteAt).toBeLessThan(15_000);
    },
  );

  test(
    "a late completion after cancellation is fenced — the record stays cancelled and no result is stored",
    slow,
    async () => {
      const submittedAt = Date.now();
      const jobId = await submitDiagnostic(
        { steps: 4, stepDelayMs: 1000, ignoreAbort: true },
        "diag-leg-fence",
      );
      await pollUntilRunning(jobId, 1);

      const cancelled = await cancelThroughEdge(jobId);
      expect(cancelled.status).toBe(202);
      const { matched } = await pollUntil(jobId, (s) => s.status === "cancelled", 60_000);
      expect(matched.error?.code).toBe("cancelled");

      // Let the handler run past its natural end (4 steps x 1000ms, plus
      // slack): the completion must never land.
      const remaining = submittedAt + 4_500 + 2_000 - Date.now();
      if (remaining > 0) await sleep(remaining);

      const after = await readSnapshot(jobId);
      expect(after.snapshot?.status).toBe("cancelled");

      const result = await readResult(jobId);
      expect(result.status).toBe(409);
      expect(result.body).not.toEqual({ completedSteps: 4, attempt: 1 });
      expect(result.body).toMatchObject({ code: "job_terminal", status: "cancelled" });

      // And the storage level: no result was ever written.
      const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      try {
        const { rows } = await pool.query<{ result: string | null }>(
          `SELECT result FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = $1`,
          [jobId],
        );
        expect(rows[0]?.result).toBeNull();
      } finally {
        await pool.end();
      }
    },
  );

  test(
    "a killed worker's job recovers on a replacement process under the type's attempt policy and succeeds with the resumed attempt's result",
    slow,
    async () => {
      const jobId = await submitDiagnostic({ steps: 8, stepDelayMs: 1000 }, "diag-leg-kill");
      const running = await pollUntilRunning(jobId, 2);
      expect(running.attempt).toBe(1);

      // No graceful drain: the claim dies with the process.
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      child = await bootServer(port, childEnv(port, { JOBS_DIAGNOSTICS: "true" }));

      // pg-boss detects the lost claim by heartbeat (a 10s cadence) and the
      // type's policy re-runs the work — the budget is the machinery's own.
      const { matched: final } = await pollUntil(jobId, (s) => s.status === "succeeded", 120_000);
      expect(final.attempt).toBeGreaterThan(1);
      expect(final.progress).toEqual({ step: 8, of: 8, label: DIAGNOSTIC_PROGRESS_LABEL });

      const result = await readResult(jobId);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ completedSteps: 8, attempt: final.attempt });
    },
  );
});

describe("the production jobs process and the diagnostic type", () => {
  const slow = { timeout: 180_000 };
  const PROD_OWNER = "prod-refuser";

  let port: number;
  let child: ChildProcess;
  let forwarder: HttpJobsForwarder;
  let edge: ReturnType<typeof buildJobsEdgeApp>["app"];
  let sessions: ReturnType<typeof buildJobsEdgeApp>["sessions"];
  let token: string;

  beforeAll(async () => {
    port = await reservePort();
    child = await bootServer(port, childEnv(port, { NODE_ENV: "production" }));
    forwarder = edgeForwarder(port);
    const harness = buildJobsEdgeApp(forwarder, {
      // A NON-production edge build with every guessed diagnostic-ish type
      // granted: the refusals below are the jobs service's own, never the
      // edge's diagnostic filter.
      jobs: {
        types: ["jobs:fetch", "jobs:diagnostic", "jobs:synthetic", "jobs:diagnostics"],
      },
      jobsSubmissionThrottle: edgeThrottle(),
    });
    edge = harness.app;
    sessions = harness.sessions;
    token = await seedSession(sessions, PROD_OWNER);
    await deliverOpenGeneration(port);
  }, 120_000);

  afterAll(async () => {
    await edge?.close();
    await forwarder?.close();
    if (child) await stopServer(child);
  }, 60_000);

  async function submitRefused(options: {
    localType: string;
    body: object;
    headers?: Record<string, string>;
  }): Promise<void> {
    const deadline = Date.now() + 60_000;
    let last: unknown = null;
    while (Date.now() < deadline) {
      const res = await edge.inject({
        method: "POST",
        url: `/_api/jobs/jobs/types/${options.localType}`,
        headers: {
          host: JOBS_HOST.host,
          "sec-fetch-mode": "cors",
          "content-type": "application/json",
          origin: JOBS_ORIGIN,
          cookie: `${SESSION_COOKIE}=${token}`,
          ...options.headers,
        },
        payload: JSON.stringify(options.body),
      });
      if (res.statusCode === 403) {
        expect(jsonOf(res.body)).toMatchObject({ code: "forbidden" });
        return;
      }
      last = { status: res.statusCode, body: jsonOf(res.body) };
      if (res.statusCode !== 503) break;
      await sleep(500);
    }
    throw new Error(`expected a 403 forbidden — last answer: ${JSON.stringify(last)}`);
  }

  test(
    "a production process refuses to boot with diagnostics enabled, naming the knob",
    { timeout: 60_000 },
    async () => {
      const bootPort = await reservePort();
      const bootChild = track(
        spawn("node", ["--import", "tsx", "src/server.ts"], {
          cwd: PACKAGE_DIR,
          env: childEnv(bootPort, { NODE_ENV: "production", JOBS_DIAGNOSTICS: "true" }),
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      const output: string[] = [];
      bootChild.stdout?.on("data", (chunk: string) => output.push(chunk));
      bootChild.stderr?.on("data", (chunk: string) => output.push(chunk));
      const code = await waitExit(bootChild, 15_000);
      expect(code, `output: ${output.join("").slice(-2_000) || "<none>"}`).not.toBe(0);
      expect(output.join("")).toContain("JOBS_DIAGNOSTICS");
    },
  );

  test(
    "a running production process refuses diagnostic submissions at its own admission gate — whatever the grant, the spelling, or the client's enable attempts say",
    slow,
    async () => {
      for (const localType of ["diagnostic", "synthetic", "diagnostics"]) {
        await submitRefused({ localType, body: { steps: 1 } });
      }
      // Client-supplied enable attempts change nothing: the headers are not
      // configuration, and the type is refused before any input is read.
      await submitRefused({
        localType: "diagnostic",
        body: { steps: 1, diagnostics: true },
        headers: { "x-helix-diagnostics": "1", "x-jobs-diagnostics": "true" },
      });

      const pool = new Pool({ connectionString: RUNTIME_DSN, max: 1 });
      try {
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${JOBS_JOB_RECORD_QUALIFIED}
            WHERE type = ANY($1::text[]) AND owner_oid = $2`,
          [["jobs:diagnostic", "jobs:synthetic", "jobs:diagnostics"], PROD_OWNER],
        );
        expect(rows[0]?.n).toBe(0);
      } finally {
        await pool.end();
      }
    },
  );
});
