import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { HealthStatusSchema, JOBS_DATABASE_CHECK } from "@azx-pbc/shared";

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
 * Telemetry is inert on every leg: `NODE_ENV=test` and no OTLP endpoint are
 * the platform's default state (ADR-0037), plus the explicit flag in leg 2.
 */

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const SCRATCH_DB = `helix_jobs_boot_srv_${randomUUID().replaceAll("-", "")}`;

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
