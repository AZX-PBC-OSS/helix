import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import {
  HealthStatusSchema,
  IDEMPOTENCY_KEY_HEADER,
  INSTRUCTION_HEADER,
  JOBS_DATABASE_CHECK,
  JobErrorMessages,
} from "@azx-pbc/shared";
import { deriveJobsInstructionKey, mintJobsInstruction } from "@azx-pbc/shared/jobsSigning";
import { JOBS_SIGNING_VECTOR_ROOTS } from "@azx-pbc/shared/jobsSigningVectors";

import { migrateJobsStorage } from "./migrate.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The production composition, as a real process: `src/server.ts` booted with
 * real configuration, a real store and its real role split — the health-first
 * contract of the done-when, verified against the running entry point rather
 * than a test-assembled graph.
 *
 * Legs, in order against one scratch store:
 *   1. invalid configuration is an explicit startup error (exit, key named);
 *   2. storage down at boot: the listener still comes up, `/health` answers
 *      200 with an error body, and the bounded probes keep running (visible
 *      in the body's own probe count) — `OTEL_SDK_DISABLED=1` pins the
 *      telemetry-disabled branch of that same path;
 *   3. recovery: booted against an unmigrated store the service reports the
 *      schema answer, then — with no restart — becomes healthy after the
 *      migration command runs;
 *   4. SIGTERM drains and exits promptly: startup's resources (probe timer,
 *      pool) release on the normal shutdown path, which a stalled close
 *      cannot fake (it would eat the shutdown grace instead).
 *
 * The instruction legs (the last describe block) present real signed
 * instructions to the running process: acceptance, durable replay refusal
 * across a receiver restart, and a fresh token with the same retry identity.
 *
 * Telemetry is inert on every leg: `NODE_ENV=test` and no OTLP endpoint are
 * the platform's default state (ADR-0037), plus the explicit flag in leg 2.
 */

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_boot_srv_${randomUUID().replaceAll("-", "")}`;

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

/**
 * The child's base environment: the developer's ambient variables, minus every
 * knob the legs construct deliberately. `JOBS_*`, `PORT`, `HOST`,
 * `SHUTDOWN_GRACE_MS` and the OTLP endpoint keys are scrubbed so a developer
 * running `dev:jobs` with exported vars — or a CI variant with its own
 * `PORT` — cannot satisfy (or crash) a leg's config premise from outside;
 * the suite must pass on a checkout where the README's dev flow has been
 * used, not only on a pristine one. `NODE_ENV=test` is set by `childEnv`.
 */
function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("JOBS_") || key === "PORT" || key === "HOST") continue;
    if (key === "NODE_ENV" || key === "SHUTDOWN_GRACE_MS") continue;
    if (key.startsWith("OTEL_EXPORTER_OTLP") || key === "OTEL_SDK_DISABLED") continue;
    env[key] = value;
  }
  return env;
}

function childEnv(
  dsn: string,
  port: number,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  return {
    ...baseEnv(),
    NODE_ENV: "test",
    JOBS_SERVER_ID: "jobs",
    JOBS_DATABASE_URL: dsn,
    // The receiver roots the instruction legs verify against — the corpus's
    // own public roots for the `jobs` server (test data, never deployed).
    JOBS_EDGE_TO_JOBS_SECRET: vectorRoot("edge-to-jobs.jobs"),
    JOBS_PORTAL_TO_JOBS_SECRET: vectorRoot("portal-to-jobs.jobs"),
    JOBS_PORT: String(port),
    SHUTDOWN_GRACE_MS: "2500",
    ...extra,
  };
}

interface HealthBody {
  status: "ok" | "degraded" | "error";
  service: string;
  uptime: number;
  checks?: Array<{
    name: string;
    status: "ok" | "degraded" | "error";
    detail?: string;
    lastSuccessAt?: string;
    metrics?: Record<string, number>;
  }>;
}

async function pollHealth(port: number, timeoutMs: number): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs;
  let lastRefusal: unknown;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        return (await res.json()) as HealthBody;
      }
    } catch (error) {
      // The listener is not up yet; keep the refusal so a timeout names it.
      lastRefusal = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`no health answer on :${port} within ${timeoutMs}ms`, {
        cause: lastRefusal,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function eventually(
  predicate: () => Promise<boolean> | boolean,
  budgetMs: number,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the condition did not hold within the budget");
}

/**
 * Reserve a port by binding it and handing it over — the connections-lane's
 * ephemeral-port discipline. Nothing hardcoded, so parallel workers cannot
 * collide with each other or with a stale listener from an interrupted run.
 */
async function reservePort(): Promise<number> {
  const provisional = createServer();
  await new Promise<void>((resolve) => provisional.listen(0, "127.0.0.1", resolve));
  const port = (provisional.address() as { port: number }).port;
  await new Promise<void>((resolve) => provisional.close(() => resolve()));
  return port;
}

/**
 * Spawn the production entry point and wait until its listener answers. On a
 * boot failure the child's own output is the only evidence there is (the test
 * logger is silent), so it rides the error.
 */
async function bootServer(port: number, env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: PACKAGE_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout?.on("data", (chunk: string) => output.push(chunk));
  child.stderr?.on("data", (chunk: string) => output.push(chunk));
  try {
    await pollHealth(port, 30_000);
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

function stopServer(child: ChildProcess): Promise<{ exitCode: number | null; elapsedMs: number }> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("the child did not exit within 10s of SIGTERM"));
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code, elapsedMs: Date.now() - startedAt });
    });
    child.kill("SIGTERM");
  });
}

const ENV_LOCAL = path.join(PACKAGE_DIR, ".env.local");
const ENV_LOCAL_PARKED = `${ENV_LOCAL}.boot-suite-parked`;
let parkedEnvLocal = false;

beforeAll(async () => {
  // A developer's `.env.local` — the override file this very service loads at
  // boot — would silently substitute its store for every leg's fixture DSN.
  // Park it for the suite's duration and put it back afterwards; the override
  // leg below writes and removes its own copy inside that window.
  if (existsSync(ENV_LOCAL)) {
    renameSync(ENV_LOCAL, ENV_LOCAL_PARKED);
    parkedEnvLocal = true;
  }
  // The scratch store is created by the provisioning itself (create-if-missing),
  // inside the serialized application — the real role split, no test superuser.
  await applyRolesProvisioning(SCRATCH_DB);
}, 60_000);

afterAll(async () => {
  if (parkedEnvLocal) {
    renameSync(ENV_LOCAL_PARKED, ENV_LOCAL);
  }
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

describe("the suite's own environment hygiene", () => {
  test("the spawned children's base environment is hermetic — ambient knobs cannot reach a leg", () => {
    // Every leg builds its child's environment on baseEnv (:70): an ambient
    // JOBS_*/PORT/HOST/… reaching a child would satisfy (or crash) a leg's
    // config premise from outside the suite — a developer following the
    // README's dev flow with exported vars would watch legs fail for a reason
    // nobody wrote down. The scrub is the seam that makes the suite hermetic;
    // pin it, so dropping it goes red in any environment, not only on a
    // machine that happens to export the variable.
    vi.stubEnv("JOBS_DATABASE_URL", "postgresql://ambient/ambient");
    vi.stubEnv("JOBS_PORT", "1");
    vi.stubEnv("JOBS_FUTURE_KNOB", "x"); // the prefix rule, not a key list
    vi.stubEnv("PORT", "1");
    vi.stubEnv("HOST", "192.0.2.1");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SHUTDOWN_GRACE_MS", "1");
    vi.stubEnv("OTEL_SDK_DISABLED", "1");
    vi.stubEnv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318");
    vi.stubEnv("HELIX_BOOT_SUITE_SENTINEL", "kept");
    try {
      const env = baseEnv();
      for (const key of [
        "JOBS_DATABASE_URL",
        "JOBS_PORT",
        "JOBS_FUTURE_KNOB",
        "PORT",
        "HOST",
        "NODE_ENV",
        "SHUTDOWN_GRACE_MS",
        "OTEL_SDK_DISABLED",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
      ]) {
        expect(env, key).not.toHaveProperty(key);
      }
      // Everything else rides through — the child still needs the ambient base.
      expect(env.HELIX_BOOT_SUITE_SENTINEL).toBe("kept");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("the production boot path", () => {
  test("invalid configuration is an explicit startup error, with the key named", () => {
    const run = spawnSync("node", ["--import", "tsx", "src/server.ts"], {
      cwd: PACKAGE_DIR,
      env: { ...baseEnv(), NODE_ENV: "test", JOBS_SERVER_ID: "jobs" },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(run.status).not.toBe(0);
    expect(`${run.stderr}${run.stdout}`).toContain("JOBS_DATABASE_URL is required");

    const badId = spawnSync("node", ["--import", "tsx", "src/server.ts"], {
      cwd: PACKAGE_DIR,
      env: {
        ...baseEnv(),
        NODE_ENV: "test",
        JOBS_SERVER_ID: "Not A Server",
        JOBS_DATABASE_URL: RUNTIME_DSN,
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(badId.status).not.toBe(0);
    expect(`${badId.stderr}${badId.stdout}`).toContain("JOBS_SERVER_ID");

    // The receiver roots are credentials too: a boot without one is explicit,
    // not a service that fails its first instruction.
    const missingRoot = spawnSync("node", ["--import", "tsx", "src/server.ts"], {
      cwd: PACKAGE_DIR,
      env: {
        ...baseEnv(),
        NODE_ENV: "test",
        JOBS_SERVER_ID: "jobs",
        JOBS_DATABASE_URL: RUNTIME_DSN,
        JOBS_PORTAL_TO_JOBS_SECRET: vectorRoot("portal-to-jobs.jobs"),
      },
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(missingRoot.status).not.toBe(0);
    expect(`${missingRoot.stderr}${missingRoot.stdout}`).toContain("JOBS_EDGE_TO_JOBS_SECRET");
  });

  test(
    "with the store down the listener still serves, /health answers 200 with the outage, and the probes continue",
    { timeout: 60_000 },
    async () => {
      const port = await reservePort();
      const child = await bootServer(
        port,
        childEnv(`postgresql://helix_jobs:helix_jobs@127.0.0.1:${DEAD_PORT}/none`, port, {
          OTEL_SDK_DISABLED: "1",
        }),
      );
      try {
        // The outage is observable — not a race with the first probe: the
        // body must carry the store's refusal, not just "not verified yet".
        await eventually(async () => {
          const body = await pollHealth(port, 10_000);
          return body.checks?.[0]?.detail?.includes("did not answer") === true;
        }, 30_000);
        const body = await pollHealth(port, 10_000);
        // Always 200, error in the body — and telemetry disabled (the flag
        // branch) changes none of it.
        expect(body.service).toBe("helix-jobs");
        expect(body.status).toBe("error");
        expect(body.checks?.[0]?.name).toBe(JOBS_DATABASE_CHECK);
        expect(body.checks?.[0]?.status).toBe("error");
        expect(body.checks?.[0]?.detail).toMatch(/did not answer/);

        // The bounded retries continue while the store is down: the body's
        // own probe count climbs between two reads.
        const probesBefore = body.checks?.[0]?.metrics?.probes ?? 0;
        await new Promise((r) => setTimeout(r, 3_000));
        const later = await pollHealth(port, 10_000);
        expect(later.checks?.[0]?.metrics?.probes ?? 0).toBeGreaterThan(probesBefore);
        expect(later.status).toBe("error");
      } finally {
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
      }
    },
  );

  test(
    "booted against an unmigrated store it reports the schema answer, then recovers when the migration lands",
    { timeout: 120_000 },
    async () => {
      const port = await reservePort();
      const child = await bootServer(port, childEnv(RUNTIME_DSN, port));
      try {
        await eventually(async () => {
          const body = await pollHealth(port, 10_000);
          return body.checks?.[0]?.detail?.includes("runner schema is not installed") === true;
        }, 30_000);

        // The operator's move, under the migration identity. No restart.
        await migrateJobsStorage(MIGRATE_DSN);

        await eventually(async () => {
          const body = await pollHealth(port, 10_000);
          return HealthStatusSchema.parse(body).status === "ok";
        }, 60_000);
        const recovered = await pollHealth(port, 10_000);
        expect(recovered.checks?.[0]?.status).toBe("ok");
        expect(recovered.checks?.[0]?.lastSuccessAt).toEqual(expect.any(String));
      } finally {
        // Normal shutdown releases what startup acquired: the exit is prompt —
        // a stalled close would eat the 2500 ms grace instead.
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        expect(exit.elapsedMs).toBeLessThan(2_000);
      }
    },
  );

  test(
    "a .env.local entry overrides the inherited environment, as the loader's contract states",
    { timeout: 90_000 },
    async () => {
      const envLocalPath = fileURLToPath(new URL("../.env.local", import.meta.url));
      const prior = existsSync(envLocalPath) ? readFileSync(envLocalPath, "utf8") : null;
      const port = await reservePort();
      let child: ChildProcess | undefined;
      try {
        // The loader's contract — and the edge loader's, which this one
        // mirrors — is that .env.local values WIN over the inherited
        // environment. The inherited DSN is the valid scratch store; the file
        // points the service at a dead port. Under the contract the health
        // body must name the dead store; the inherited DSN winning is the
        // inverted, silent behaviour.
        writeFileSync(
          envLocalPath,
          `JOBS_DATABASE_URL=postgresql://helix_jobs:dotenv@127.0.0.1:${DEAD_PORT}/none\n`,
        );
        child = await bootServer(port, childEnv(RUNTIME_DSN, port));
        await eventually(async () => {
          const body = await pollHealth(port, 10_000);
          return body.checks?.[0]?.detail?.includes("did not answer") === true;
        }, 30_000);
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        child = undefined;
      } finally {
        if (child && child.exitCode === null) child.kill("SIGKILL");
        if (prior === null) rmSync(envLocalPath, { force: true });
        else writeFileSync(envLocalPath, prior);
      }
    },
  );

  test(
    "a blank JOBS_PORT does not boot the service onto an OS-assigned port",
    { timeout: 60_000 },
    async () => {
      const port = await reservePort();
      const output: string[] = [];
      // An empty value is not nullish, so it used to win the ?? chain and
      // Number("") was 0 — an OS-assigned port. The pinned contract is the
      // explicit-failure arm: a port key that is set but unusable is a boot
      // error naming the key (deliberately stricter than the blank-means-
      // unset interval knobs — the operator pointed the knob at nothing, and
      // an empty pointing strands the service). Silently serving on a random
      // port is the regression this leg exists to catch.
      const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
        cwd: PACKAGE_DIR,
        env: {
          ...childEnv(`postgresql://helix_jobs:helix_jobs@127.0.0.1:${DEAD_PORT}/none`, port),
          JOBS_PORT: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: string) => output.push(chunk));
      child.stderr?.on("data", (chunk: string) => output.push(chunk));

      const servesFallback = async (): Promise<boolean> => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          return res.ok;
        } catch {
          return false;
        }
      };

      let exited: number | null = null;
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (await servesFallback()) break;
        if (child.exitCode !== null) {
          exited = child.exitCode;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      if (exited !== null) {
        // The explicit-failure arm: the exit must name the knob.
        expect(output.join("")).toContain("JOBS_PORT");
        expect(exited).not.toBe(0);
        return;
      }
      const served = await servesFallback();
      if (served) {
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
      } else {
        child.kill("SIGKILL");
      }
      expect(
        served,
        `a blank JOBS_PORT must not boot onto an OS-assigned random port — child output: ${output.join("").slice(-2_000) || "<none>"}`,
      ).toBe(true);
    },
  );

  test(
    "a listen failure exits 1 promptly — the failed-partial-initialization exit releases startup's pool",
    { timeout: 60_000 },
    async () => {
      const port = await reservePort();
      // Hold the port so the child's listen fails after storage.start() has
      // already acquired the pool — the fourth exit (failed partial
      // initialization), distinct from the config-error and SIGTERM exits.
      // A dropped release in the catch shows up as the pool's clients holding
      // the event loop (a hang, or a late exit 0 after the reaper); a dropped
      // exit(1) shows up as a silent exit 0 on a boot that never served.
      const occupier = createServer();
      await new Promise<void>((resolve) => occupier.listen(port, "0.0.0.0", resolve));
      const output: string[] = [];
      const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
        cwd: PACKAGE_DIR,
        env: childEnv(`postgresql://helix_jobs:helix_jobs@127.0.0.1:${DEAD_PORT}/none`, port),
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: string) => output.push(chunk));
      child.stderr?.on("data", (chunk: string) => output.push(chunk));
      try {
        const startedAt = Date.now();
        const exit = await new Promise<{ code: number | null; elapsedMs: number }>(
          (resolve, reject) => {
            const guard = setTimeout(() => {
              reject(
                new Error(
                  `the child neither served nor exited within 30s of the occupied port — output: ${output.join("").slice(-2_000) || "<none>"}`,
                ),
              );
            }, 30_000);
            child.once("exit", (code) => {
              clearTimeout(guard);
              resolve({ code, elapsedMs: Date.now() - startedAt });
            });
          },
        );
        expect(exit.code, `output: ${output.join("").slice(-2_000) || "<none>"}`).toBe(1);
        expect(exit.elapsedMs).toBeLessThan(20_000); // a stalled release would eat this
      } finally {
        occupier.close();
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  );
});

describe("signed instructions through the running process", () => {
  const slow = { timeout: 180_000 };
  /** The instruction legs' app — the identity the submissions and the lifecycle delivery share. */
  const LIFECYCLE_APP = "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f";

  /** Mint one submit instruction against the child's own roots, right now. */
  async function mintSubmit(idempotencyKey: string | null): Promise<string> {
    const key = deriveJobsInstructionKey(vectorRoot("edge-to-jobs.jobs"), "edgeToJobs");
    return mintJobsInstruction(
      {
        operation: "submit",
        server: "jobs",
        identity: {
          appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
          env: "prod",
          ownerKind: "user",
          ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
          allowedTypes: ["jobs:fetch"],
        },
        type: "jobs:fetch",
        generation: "1",
        idempotencyKey,
        body: new TextEncoder().encode('{"url":"https://example.com/data.json"}'),
        iatS: Math.floor(Date.now() / 1000) - 1,
      },
      key,
    );
  }

  async function submit(port: number, token: string): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`http://127.0.0.1:${port}/internal/jobs/v1/jobs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [INSTRUCTION_HEADER]: token,
        [IDEMPOTENCY_KEY_HEADER]: "retry-key-1",
      },
      body: '{"url":"https://example.com/data.json"}',
    });
    return { status: res.status, body: await res.json() };
  }

  interface AcceptedBody {
    server: string;
    jobId: string;
    status: string;
  }

  /**
   * Deliver the app's open generation through the real lifecycle route — the
   * portal's half of the assembly the submission gate is judged against. An
   * app whose generation was never delivered answers every submission with
   * the retryable unseen refusal (ADR-0007), so the instruction legs open
   * generation 1 the same way the portal's sender does: a separately signed
   * instruction, applied before it is acknowledged.
   */
  async function deliverOpenGeneration(port: number): Promise<void> {
    const body = '{"generation":"1","archived":false}';
    const token = await mintJobsInstruction(
      {
        operation: "lifecycle",
        server: "jobs",
        appId: LIFECYCLE_APP,
        body: new TextEncoder().encode(body),
        iatS: Math.floor(Date.now() / 1000) - 1,
      },
      deriveJobsInstructionKey(vectorRoot("portal-to-jobs.jobs"), "portalToJobs"),
    );
    const res = await fetch(
      `http://127.0.0.1:${port}/internal/jobs/v1/lifecycle/${LIFECYCLE_APP}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", [INSTRUCTION_HEADER]: token },
        body,
      },
    );
    expect(res.status).toBe(200);
  }

  /**
   * Submit with fresh instructions (the same retry identity) until the
   * acceptance commits — the client's own recovery loop over the retryable
   * answers. The 503s on the way are real: the runner's supervised start
   * converges in the background after the store verifies, and each refused
   * attempt's instruction was consumed by the burn, so every try mints a
   * fresh token. A bounded budget fails the leg naming the last answer.
   */
  async function submitUntilAccepted(port: number): Promise<{ body: AcceptedBody; token: string }> {
    const deadline = Date.now() + 60_000;
    let last: { status: number; body: unknown } | null = null;
    let token: string;
    while (Date.now() < deadline) {
      token = await mintSubmit("retry-key-1");
      last = await submit(port, token);
      if (last.status === 202) return { body: last.body as AcceptedBody, token };
      if (last.status !== 503) break; // a refusal that is not retryable ends the loop
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(
      `the submission never committed within its budget — last answer: ${JSON.stringify(last)}`,
    );
  }

  test(
    "a valid instruction reaches its operation; its replay is refused across a receiver restart; a fresh token carrying the same retry identity recovers the same job",
    slow,
    async () => {
      const port = await reservePort();
      // The scratch store migrates first: the leg needs a READY receiver —
      // the boot/recovery legs above cover the unhealthy paths.
      await migrateJobsStorage(MIGRATE_DSN);
      let child = await bootServer(port, childEnv(RUNTIME_DSN, port));
      let accepted: AcceptedBody;
      let acceptedToken: string;
      try {
        await eventually(async () => {
          const body = await pollHealth(port, 10_000);
          return HealthStatusSchema.parse(body).status === "ok";
        }, 30_000);

        // The portal's delivery opens the app's generation; the acceptance
        // gate refuses every submission before it with the retryable
        // unseen answer.
        await deliverOpenGeneration(port);

        // Accepted: the operation is served — the acceptance transaction
        // commits the wrapper record and the runner enqueue together, and
        // the answer is the job's durable reference.
        const result = await submitUntilAccepted(port);
        accepted = result.body;
        acceptedToken = result.token;
        expect(accepted.server).toBe("jobs");
        expect(accepted.status).toBe("queued");
        expect(typeof accepted.jobId).toBe("string");

        // The transport replay — the same token, re-presented — is refused.
        const replay = await submit(port, acceptedToken);
        expect(replay.status).toBe(401);
        expect(replay.body).toEqual({
          code: "unauthorized",
          message: JobErrorMessages.unauthorized,
        });
      } finally {
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
      }

      // A restarted receiver against the same durable store still refuses
      // the replay: the burn outlives the process. And a fresh token
      // carrying the same legitimate retry identity RECOVERS the original
      // job — the lost-reply path of the retry-identity contract, across a
      // restart, with the same reference and no second job.
      const restartedPort = await reservePort();
      child = await bootServer(restartedPort, childEnv(RUNTIME_DSN, restartedPort));
      try {
        await eventually(async () => {
          const body = await pollHealth(restartedPort, 10_000);
          return HealthStatusSchema.parse(body).status === "ok";
        }, 30_000);
        const replayAfterRestart = await submit(restartedPort, acceptedToken);
        expect(replayAfterRestart.status).toBe(401);

        const recovered = await submit(restartedPort, await mintSubmit("retry-key-1"));
        expect(recovered.status).toBe(202);
        expect(recovered.body).toEqual(accepted);
      } finally {
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
      }
    },
  );

  test(
    "a submission for a generation the portal has not delivered is answered by the retryable unseen refusal until the delivery opens it",
    slow,
    async () => {
      // The unseen half of criterion 19 end to end: the client's recovery loop
      // keys on the 503 — "uncertainty, not nonacceptance" — so the running
      // process must answer a real signed submit for an undelivered generation
      // with 503 `jobs_unavailable` (never a final 403/400 that would teach the
      // client to give up or fix the wrong thing), the same retry identity must
      // be claimable again after the refusal, and the portal's delivery must
      // open the generation so the next identical submission commits. The
      // acceptance gate's unseen verdict and the route's retryable mapping are
      // pinned separately against the real store and the memory double; this
      // leg drives their composition through the real receiver and process.
      // The app id is this leg's own — the shared scratch store's deliveries
      // for the other legs' app must not open this gate early.
      const unseenApp = randomUUID();
      const mintForUnseenApp = (idempotencyKey: string): Promise<string> =>
        mintJobsInstruction(
          {
            operation: "submit",
            server: "jobs",
            identity: {
              appId: unseenApp,
              env: "prod",
              ownerKind: "user",
              ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
              allowedTypes: ["jobs:fetch"],
            },
            type: "jobs:fetch",
            generation: "1",
            idempotencyKey,
            body: new TextEncoder().encode('{"url":"https://example.com/data.json"}'),
            iatS: Math.floor(Date.now() / 1000) - 1,
          },
          deriveJobsInstructionKey(vectorRoot("edge-to-jobs.jobs"), "edgeToJobs"),
        );
      const submitUnseenApp = async (token: string): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(`http://127.0.0.1:${port}/internal/jobs/v1/jobs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INSTRUCTION_HEADER]: token,
            [IDEMPOTENCY_KEY_HEADER]: "unseen-app-key",
          },
          body: '{"url":"https://example.com/data.json"}',
        });
        return { status: res.status, body: await res.json() };
      };

      const port = await reservePort();
      await migrateJobsStorage(MIGRATE_DSN); // idempotent on the shared scratch store
      const child = await bootServer(port, childEnv(RUNTIME_DSN, port));
      try {
        await eventually(async () => {
          const body = await pollHealth(port, 10_000);
          return HealthStatusSchema.parse(body).status === "ok";
        }, 30_000);

        // The app is not known to this server: the retryable answer, twice —
        // each with a fresh token (every refusal consumed the nonce) and the
        // same retry identity, which must stay unclaimed.
        const first = await submitUnseenApp(await mintForUnseenApp("unseen-app-key"));
        expect(first.status).toBe(503);
        expect(first.body).toEqual({
          code: "jobs_unavailable",
          message: JobErrorMessages.jobs_unavailable,
        });
        const second = await submitUnseenApp(await mintForUnseenApp("unseen-app-key"));
        expect(second.status).toBe(503);
        expect(second.body).toEqual({
          code: "jobs_unavailable",
          message: JobErrorMessages.jobs_unavailable,
        });

        // The portal's delivery opens the generation for THIS app; the next
        // identical submission under the same retry identity commits — the
        // refusals claimed nothing.
        const body = '{"generation":"1","archived":false}';
        const delivery = await fetch(
          `http://127.0.0.1:${port}/internal/jobs/v1/lifecycle/${unseenApp}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [INSTRUCTION_HEADER]: await mintJobsInstruction(
                {
                  operation: "lifecycle",
                  server: "jobs",
                  appId: unseenApp,
                  body: new TextEncoder().encode(body),
                  iatS: Math.floor(Date.now() / 1000) - 1,
                },
                deriveJobsInstructionKey(vectorRoot("portal-to-jobs.jobs"), "portalToJobs"),
              ),
            },
            body,
          },
        );
        expect(delivery.status).toBe(200);

        const accepted = await submitUnseenApp(await mintForUnseenApp("unseen-app-key"));
        expect(accepted.status).toBe(202);
        expect(accepted.body).toMatchObject({ server: "jobs", status: "queued" });
      } finally {
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
      }
    },
  );

  test(
    "a JOBS_LIMITS override reaches the running process's admission store — the capacity refusal is a real 429 through the signed route",
    slow,
    async () => {
      // The route mapping is pinned against the admission double and the
      // store's refusal against real Postgres; this leg drives their
      // composition — the deployment's override resolved at boot and wired
      // into the real store behind the real receiver, answering a real
      // signed submission with the fixed 429 envelope. A boot that passed
      // the platform defaults where the override resolved would fail here.
      //
      // The bound is the RETAINED per-app/environment cap, deliberately:
      // retained occupancy moves only on physical deletion, which no seam in
      // this process performs inside a seconds-long window (the cleanup
      // loop's record horizon is 30 days) — so the saturated-cap premise is
      // structural and survives worker registration landing in this same
      // booted process, where an unfinished cap's occupancy could drain
      // between the two submissions and turn the second answer into a 202.
      // The unfinished cap itself is pinned by the store-level legs, which
      // construct their own worker-less store.
      const port = await reservePort();
      await migrateJobsStorage(MIGRATE_DSN); // idempotent on the shared scratch store
      const capApp = randomUUID(); // a fresh app: its per-app occupancy starts at zero
      const identity = {
        appId: capApp,
        env: "prod",
        ownerKind: "user",
        ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
        allowedTypes: ["jobs:fetch"],
      } as const;
      const mintFor = (idempotencyKey: string): Promise<string> =>
        mintJobsInstruction(
          {
            operation: "submit",
            server: "jobs",
            identity,
            type: "jobs:fetch",
            generation: "1",
            idempotencyKey,
            body: new TextEncoder().encode('{"url":"https://example.com/data.json"}'),
            iatS: Math.floor(Date.now() / 1000) - 1,
          },
          deriveJobsInstructionKey(vectorRoot("edge-to-jobs.jobs"), "edgeToJobs"),
        );
      const submitCapApp = async (
        token: string,
        idempotencyKey: string,
      ): Promise<{ status: number; body: unknown }> => {
        const res = await fetch(`http://127.0.0.1:${port}/internal/jobs/v1/jobs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [INSTRUCTION_HEADER]: token,
            [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
          },
          body: '{"url":"https://example.com/data.json"}',
        });
        return { status: res.status, body: await res.json() };
      };
      const child = await bootServer(
        port,
        childEnv(RUNTIME_DSN, port, {
          JOBS_LIMITS: JSON.stringify({ retainedPerAppEnv: 1 }),
        }),
      );
      try {
        await eventually(async () => {
          const body = await pollHealth(port, 10_000);
          return HealthStatusSchema.parse(body).status === "ok";
        }, 30_000);

        // The portal's delivery opens the fresh app's generation through the
        // real lifecycle route.
        const delivery = '{"generation":"1","archived":false}';
        const delivered = await fetch(
          `http://127.0.0.1:${port}/internal/jobs/v1/lifecycle/${capApp}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [INSTRUCTION_HEADER]: await mintJobsInstruction(
                {
                  operation: "lifecycle",
                  server: "jobs",
                  appId: capApp,
                  body: new TextEncoder().encode(delivery),
                  iatS: Math.floor(Date.now() / 1000) - 1,
                },
                deriveJobsInstructionKey(vectorRoot("portal-to-jobs.jobs"), "portalToJobs"),
              ),
            },
            body: delivery,
          },
        );
        expect(delivered.status).toBe(200);

        // The first submission is accepted (the client's own retry loop over
        // the 503s of the runner's convergence, the same retry identity);
        // the second — the app's retained cap now full at one, the first
        // job's record still stored — is the 429.
        const deadline = Date.now() + 60_000;
        let first: { status: number; body: unknown } | null = null;
        while (Date.now() < deadline) {
          first = await submitCapApp(await mintFor("capacity-leg-first"), "capacity-leg-first");
          if (first.status !== 503) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        expect(first?.status, JSON.stringify(first)).toBe(202);
        const second = await submitCapApp(
          await mintFor("capacity-leg-second"),
          "capacity-leg-second",
        );
        expect(second.status).toBe(429);
        expect(second.body).toEqual({
          code: "jobs_capacity_exceeded",
          message: JobErrorMessages.jobs_capacity_exceeded,
        });
      } finally {
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
      }
    },
  );

  test("a forged instruction is refused by the running process", slow, async () => {
    const port = await reservePort();
    const child = await bootServer(port, childEnv(RUNTIME_DSN, port));
    try {
      await eventually(async () => {
        const body = await pollHealth(port, 10_000);
        return HealthStatusSchema.parse(body).status === "ok";
      }, 30_000);
      // Signed under neither receiver root: a valid shape over the wrong key.
      const forged = await mintJobsInstruction(
        {
          operation: "submit",
          server: "jobs",
          identity: {
            appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
            env: "prod",
            ownerKind: "user",
            ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
            allowedTypes: ["jobs:fetch"],
          },
          type: "jobs:fetch",
          generation: "1",
          idempotencyKey: "retry-key-1",
          body: new TextEncoder().encode('{"url":"https://example.com/data.json"}'),
          iatS: Math.floor(Date.now() / 1000) - 1,
        },
        deriveJobsInstructionKey(vectorRoot("portal-to-jobs.jobs"), "edgeToJobs"),
      );
      const res = await submit(port, forged);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        code: "unauthorized",
        message: JobErrorMessages.unauthorized,
      });
    } finally {
      const exit = await stopServer(child);
      expect(exit.exitCode).toBe(0);
    }
  });

  test(
    "a lifecycle delivery is applied before it is acknowledged, and a stale redelivery after a restart acknowledges the highest applied generation",
    slow,
    async () => {
      const port = await reservePort();

      /** Mint one lifecycle instruction against the child's own portal root, right now. */
      const mintLifecycle = async (body: string): Promise<string> =>
        mintJobsInstruction(
          {
            operation: "lifecycle",
            server: "jobs",
            appId: LIFECYCLE_APP,
            body: new TextEncoder().encode(body),
            iatS: Math.floor(Date.now() / 1000) - 1,
          },
          deriveJobsInstructionKey(vectorRoot("portal-to-jobs.jobs"), "portalToJobs"),
        );

      const deliver = async (port: number, body: string) => {
        const res = await fetch(
          `http://127.0.0.1:${port}/internal/jobs/v1/lifecycle/${LIFECYCLE_APP}`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              [INSTRUCTION_HEADER]: await mintLifecycle(body),
            },
            body,
          },
        );
        return { status: res.status, body: (await res.json()) as unknown };
      };

      await migrateJobsStorage(MIGRATE_DSN); // idempotent on the shared scratch store
      let child = await bootServer(port, childEnv(RUNTIME_DSN, port));
      try {
        await eventually(async () => {
          const body = await pollHealth(port, 10_000);
          return HealthStatusSchema.parse(body).status === "ok";
        }, 30_000);

        // The archive delivery (generation 3): applied durably, acknowledged
        // with the generation actually applied.
        const archived = await deliver(port, '{"generation":"3","archived":true}');
        expect(archived.status).toBe(200);
        expect(archived.body).toEqual({ appliedGeneration: "3" });
      } finally {
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
      }

      // A restarted receiver against the same durable store: the older
      // unarchive (generation 2) delivered late is a no-op that still
      // acknowledges the highest applied generation — the closed generation
      // it was delivered for cannot be reopened by its own out-of-order
      // redelivery.
      const restartedPort = await reservePort();
      child = await bootServer(restartedPort, childEnv(RUNTIME_DSN, restartedPort));
      try {
        await eventually(async () => {
          const body = await pollHealth(restartedPort, 10_000);
          return HealthStatusSchema.parse(body).status === "ok";
        }, 30_000);
        const stale = await deliver(restartedPort, '{"generation":"2","archived":false}');
        expect(stale.status).toBe(200);
        expect(stale.body).toEqual({ appliedGeneration: "3" });

        // And a repeat of the newest delivery is acknowledged identically.
        const repeat = await deliver(restartedPort, '{"generation":"3","archived":true}');
        expect(repeat.status).toBe(200);
        expect(repeat.body).toEqual({ appliedGeneration: "3" });
      } finally {
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
      }
    },
  );
});
