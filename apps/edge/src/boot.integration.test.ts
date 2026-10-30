import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { HealthStatusSchema, JOBS_REACHABILITY_CHECK, type HealthStatus } from "@azx-pbc/shared";

/**
 * The edge package's boot path, as real child processes — the one layer no
 * other suite reaches. Every app-level test hands the health handler its own
 * `jobsReachability` getter, and the reachability integration suite
 * hand-wires its own loop beside the real `buildApp`; what nothing covers is
 * the production composition itself: `server.ts` constructing the loop only
 * when jobs servers are configured, passing the getter, starting it with the
 * listener, and releasing it on shutdown — the same four wiring points in the
 * dev-gateway's `server.ts`, the second entry point of the same seam. A
 * dropped construction or getter would otherwise vanish silently: the edge
 * would serve `/health` with no `jobs_reachability` check at all while jobs
 * servers are configured, with every gate green.
 *
 * The shape is the jobs service's boot suite (`apps/jobs/src/
 * boot.integration.test.ts`): spawn the real `src/server.ts`, poll the served
 * `/health`, and read the body through the shared contract. The children are
 * self-contained — a generated TLS pair (TLS is unconditional outside
 * production), the migrated `helix_test` store, and each leg's own
 * `EDGE_JOBS_CONFIG` naming loopback fakes — so the legs run anywhere the
 * suite's Postgres does. Telemetry is inert (`NODE_ENV=test`, no OTLP
 * endpoint): the platform's default state.
 */

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

/** The dev-gateway child connects as its own least-privilege role on the test store. */
function urlAs(url: string, role: string): string {
  const parsed = new URL(url);
  parsed.username = role;
  parsed.password = role;
  return parsed.toString();
}

interface HealthBody {
  status: "ok" | "degraded" | "error";
  service: string;
  uptime: number;
  checks?: Array<{
    name: string;
    status: "ok" | "degraded" | "error";
    detail?: string;
  }>;
}

/**
 * The children's base environment: the developer's ambient variables, minus
 * every knob a leg constructs deliberately. The `EDGE_*` family is scrubbed
 * whole — the devcontainer and CI both export `EDGE_OIDC_*`/`EDGE_AUTH_SECRET`
 * (an IdP dependency the legs must not inherit) and `EDGE_TLS_*` (whose
 * mkcert files are a per-checkout artifact), and any exported
 * `EDGE_JOBS_CONFIG` would silently satisfy a leg's premise from outside.
 * `DATABASE_URL`/`TEST_DATABASE_URL` and the Azurite connection string pass
 * through, as the jobs boot suite's does.
 */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("EDGE_") || key === "PORT" || key === "HOST") continue;
    if (key === "NODE_ENV" || key === "SHUTDOWN_GRACE_MS") continue;
    if (key.startsWith("OTEL_EXPORTER_OTLP") || key === "OTEL_SDK_DISABLED") continue;
    // The stack-authoritative flag: the legs construct it deliberately (the
    // resolved-stack leg sets it, the other legs need its absence), so an
    // ambient value must not decide between them.
    if (key === "HELIX_STACK_ENV") continue;
    env[key] = value;
  }
  return { ...env, NODE_ENV: "test", ...extra };
}

/** A loopback server answering the jobs service's health contract, status ok. */
class FakeJobsHealthServer {
  readonly #server: Server;
  readonly #sessions = new Set<import("node:net").Socket>();

  constructor() {
    this.#server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "helix-jobs", uptime: 1 }));
    });
    this.#server.on("connection", (socket) => {
      this.#sessions.add(socket);
      socket.on("close", () => this.#sessions.delete(socket));
    });
  }

  get endpoint(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.#server.listen(0, "127.0.0.1", () => resolve(undefined)));
  }

  async stop(): Promise<void> {
    for (const socket of this.#sessions) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

/** The `EDGE_JOBS_CONFIG` document — fresh, distinct roots per server per direction. */
function jobsConfigDocument(servers: Array<{ name: string; endpoint: string }>): string {
  const entries: Record<
    string,
    { endpoint: string; edgeToJobsRoot: string; jobsToEdgeRoot: string }
  > = {};
  for (const { name, endpoint } of servers) {
    entries[name] = {
      endpoint,
      edgeToJobsRoot: randomBytes(32).toString("base64"),
      jobsToEdgeRoot: randomBytes(32).toString("base64"),
    };
  }
  return JSON.stringify({ servers: entries });
}

/**
 * Reserve a port by binding it and handing it over — the connections-lane's
 * ephemeral-port discipline (nothing hardcoded, so parallel workers cannot
 * collide).
 */
async function reservePort(): Promise<number> {
  const { createServer: reserve } = await import("node:net");
  const provisional = reserve();
  await new Promise<void>((resolve) => provisional.listen(0, "127.0.0.1", resolve));
  const port = (provisional.address() as { port: number }).port;
  await new Promise<void>((resolve) => provisional.close(() => resolve()));
  return port;
}

/**
 * GET https://127.0.0.1:{port}/health — the child terminates its own TLS with
 * the leg's generated pair, so the read skips verification (a self-signed
 * cert is exactly what a boot test's own trust anchor would be).
 */
function getHealth(port: number): Promise<{ statusCode: number; body: HealthBody }> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      { host: "127.0.0.1", port, path: "/health", rejectUnauthorized: false, timeout: 2_000 },
      (res) => {
        let raw = "";
        res.on("data", (chunk: string) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(raw) as HealthBody });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("the health read timed out")));
    req.on("error", reject);
  });
}

async function pollHealth(port: number, timeoutMs: number): Promise<HealthBody> {
  const deadline = Date.now() + timeoutMs;
  let lastRefusal: unknown;
  for (;;) {
    try {
      const res = await getHealth(port);
      if (res.statusCode === 200) return res.body;
    } catch (error) {
      // The listener is not up yet; keep the refusal so a timeout names it.
      lastRefusal = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`no health answer on :${port} within ${timeoutMs}ms`, { cause: lastRefusal });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function eventually(predicate: () => Promise<boolean>, budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the condition did not hold within the budget");
}

/** The reachability check of the served body, and the body's own roll-up. */
async function servedCheck(port: number): Promise<{
  statusCode: number;
  body: HealthStatus;
  check?: { status: string; detail?: string };
}> {
  const res = await getHealth(port);
  const body = HealthStatusSchema.parse(res.body);
  return {
    statusCode: res.statusCode,
    body,
    check: body.checks?.find((c) => c.name === JOBS_REACHABILITY_CHECK),
  };
}

/**
 * Spawn a production entry point and wait until its listener answers. On a
 * boot failure the child's own output is the only evidence there is, so it
 * rides the error.
 */
async function bootServer(
  entry: string,
  port: number,
  env: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const child = spawn("node", ["--import", "tsx", entry], {
    cwd: PACKAGE_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output: string[] = [];
  child.stdout?.on("data", (chunk: string) => output.push(chunk));
  child.stderr?.on("data", (chunk: string) => output.push(chunk));
  try {
    await pollHealth(port, 90_000);
  } catch (error) {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    throw new Error(
      `the child never served :${port} — child output: ${output.join("").slice(-4_000) || "<none>"}`,
      { cause: error },
    );
  }
  return child;
}

/** SIGTERM and wait, bounded — the graceful-shutdown release path. */
async function stopServer(
  child: ChildProcess,
): Promise<{ exitCode: number | null; elapsedMs: number }> {
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
let certDir: string | null = null;

beforeAll(() => {
  // A developer's `.env.local` — the override file both entry points load at
  // boot, whose values WIN — would silently substitute its own configuration
  // for every leg's. Park it for the suite's duration and put it back after.
  // Self-heal first: a leftover parked file means a previous run was
  // hard-killed between park and restore, holding the developer's overrides
  // hostage. Restore it when `.env.local` is absent (the kill case); with
  // BOTH present the rename would clobber one of them, so refuse and let a
  // human pick rather than silently choosing.
  if (existsSync(ENV_LOCAL_PARKED)) {
    if (existsSync(ENV_LOCAL)) {
      throw new Error(
        `${ENV_LOCAL_PARKED} exists beside ${ENV_LOCAL} — a previous boot-suite run was ` +
          "killed between parking and restoring the override file. Delete or merge one of " +
          "the two, then re-run.",
      );
    }
    renameSync(ENV_LOCAL_PARKED, ENV_LOCAL);
  }
  if (existsSync(ENV_LOCAL)) {
    renameSync(ENV_LOCAL, ENV_LOCAL_PARKED);
    parkedEnvLocal = true;
  }

  // TLS is unconditional outside production (the platform is HTTPS-only), and
  // the checkout's mkcert pair is a per-checkout artifact the suite cannot
  // assume. The legs' own pair, generated fresh: the child serves it, the
  // poll skips verification of exactly it.
  certDir = mkdtempSync(path.join(tmpdir(), "helix-edge-boot-"));
  const certFile = path.join(certDir, "cert.pem");
  const keyFile = path.join(certDir, "key.pem");
  const gen = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      "/CN=boot-test",
    ],
    { encoding: "utf8" },
  );
  if (gen.status !== 0) {
    throw new Error(`openssl could not mint the boot suite's certificate: ${gen.stderr}`);
  }
});

afterAll(() => {
  if (parkedEnvLocal) renameSync(ENV_LOCAL_PARKED, ENV_LOCAL);
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

describe("the edge's boot path serves the jobs_reachability check", () => {
  test(
    "the real server.ts constructs, starts and serves the loop — ok, degraded, error — and releases on SIGTERM",
    // The budget arithmetic must close even on a cold tsx cache: boot
    // (poll 90s) + ok (15s) + two cadence-crossing waits (45s each) + the
    // SIGTERM bound (10s).
    { timeout: 330_000 }, // boot 90 + ok 15 + two cadence waits 90+90 + stop 10
    // — the budgets must close inside the test timeout even loaded.
    async () => {
      const jobs = new FakeJobsHealthServer();
      const jobsEu = new FakeJobsHealthServer();
      await Promise.all([jobs.start(), jobsEu.start()]);
      const port = await reservePort();
      const child = await bootServer(
        "src/server.ts",
        port,
        childEnv({
          EDGE_DATABASE_URL: TEST_DATABASE_URL,
          EDGE_PORT: String(port),
          EDGE_TLS_CERT_FILE: path.join(certDir!, "cert.pem"),
          EDGE_TLS_KEY_FILE: path.join(certDir!, "key.pem"),
          EDGE_JOBS_CONFIG: jobsConfigDocument([
            { name: "jobs", endpoint: jobs.endpoint },
            { name: "jobs-eu", endpoint: jobsEu.endpoint },
          ]),
          SHUTDOWN_GRACE_MS: "2500",
        }),
      );
      try {
        // The loop came up WITH the listener: both configured servers observed
        // reachable on the loop's own cadence — no request but these health
        // reads was ever made against the child.
        await eventually(async () => (await servedCheck(port)).check?.status === "ok", 15_000);
        const healthy = await servedCheck(port);
        expect(healthy.statusCode).toBe(200);
        expect(healthy.check?.status).toBe("ok");
        expect(healthy.body.status).toBe("ok");

        // One configured server dies under the running edge: the next pass
        // observes it, the check degrades naming it, and the body stays 200 —
        // evidence produced by the boot-wired loop, not by traffic.
        await jobsEu.stop();
        await eventually(
          async () => (await servedCheck(port)).check?.status === "degraded",
          90_000, // three cadences of slack: a loaded machine delays a pass
        );
        const degraded = await servedCheck(port);
        expect(degraded.statusCode).toBe(200);
        expect(degraded.check?.detail).toContain("jobs-eu");
        expect(degraded.body.status).toBe("degraded");

        // The last one too: the whole configured plane is down, and the check
        // the boot wiring serves stays degraded, naming every server.
        await jobs.stop();
        await eventually(
          async () =>
            /every configured jobs server is unreachable/.test(
              (await servedCheck(port)).check?.detail ?? "",
            ),
          90_000, // three cadences of slack: a loaded machine delays a pass
        );
        const down = await servedCheck(port);
        expect(down.statusCode).toBe(200); // always-200, in every state
        expect(down.check?.status).toBe("degraded");
        expect(down.body.status).toBe("degraded");

        // Normal shutdown releases what startup acquired — the probe loop's
        // timer among them (server.ts's onClose hook) — promptly.
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        expect(exit.elapsedMs).toBeLessThan(2_000);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await Promise.all([jobs.stop(), jobsEu.stop()].map((p) => p.catch(() => {})));
      }
    },
  );

  test(
    "a fully disabled install (no EDGE_JOBS_CONFIG) boots with no jobs dependency at all",
    // Boot (90s) + a read + exit (10s) — no cadence waits: the disabled
    // premise means no loop was ever started.
    { timeout: 150_000 }, // boot 90 + a read + stop 10.
    async () => {
      const port = await reservePort();
      // The env a configured leg carries, minus EDGE_JOBS_CONFIG: childEnv
      // scrubbed every EDGE_* var already, so the absent variable cannot be
      // satisfied from outside — the premise is the leg's own.
      const child = await bootServer(
        "src/server.ts",
        port,
        childEnv({
          EDGE_DATABASE_URL: TEST_DATABASE_URL,
          EDGE_PORT: String(port),
          EDGE_TLS_CERT_FILE: path.join(certDir!, "cert.pem"),
          EDGE_TLS_KEY_FILE: path.join(certDir!, "key.pem"),
          SHUTDOWN_GRACE_MS: "2500",
        }),
      );
      try {
        const res = await getHealth(port);
        expect(res.statusCode).toBe(200);
        const parsed = HealthStatusSchema.parse(res.body);
        // Criterion 8 through the real composition: no configured servers →
        // no loop, no getter, no jobs check on the served body at all.
        expect(parsed.checks?.some((c) => c.name === JOBS_REACHABILITY_CHECK)).toBe(false);
        expect(parsed.status).toBe("ok");

        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        expect(exit.elapsedMs).toBeLessThan(2_000);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  );

  test(
    "a resolved stack (HELIX_STACK_ENV) boots with the stack env authoritative — the file does not win",
    // Boot (90s) + ok (60s) + stop (10s).
    { timeout: 150_000 },
    async () => {
      const prior = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : null;
      const port = await reservePort();
      let child: ChildProcess | undefined;
      try {
        // The override file the developer convention lets WIN: a dead store,
        // so an edge that obeys it can never reach health. With the stack
        // flag set (what scripts/stack-env.mjs and the smoke driver boot a
        // resolved stack with), the file must be ignored whole — a resolved
        // stack obeying it would boot cross-wired into the developer's own
        // credentials and exit green. The observable flip: the service
        // reaches health against the ENV's store (the migrated test store),
        // not the file's dead one.
        writeFileSync(ENV_LOCAL, "EDGE_DATABASE_URL=postgresql://helix:dotenv@127.0.0.1:1/none\n");
        child = await bootServer(
          "src/server.ts",
          port,
          childEnv({
            EDGE_DATABASE_URL: TEST_DATABASE_URL,
            EDGE_PORT: String(port),
            EDGE_TLS_CERT_FILE: path.join(certDir!, "cert.pem"),
            EDGE_TLS_KEY_FILE: path.join(certDir!, "key.pem"),
            HELIX_STACK_ENV: "1",
            SHUTDOWN_GRACE_MS: "2500",
          }),
        );
        await eventually(async () => {
          const res = await getHealth(port);
          return res.statusCode === 200 && HealthStatusSchema.parse(res.body).status === "ok";
        }, 60_000);
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        child = undefined;
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (prior === null) rmSync(ENV_LOCAL, { force: true });
        else writeFileSync(ENV_LOCAL, prior);
      }
    },
  );

  test(
    "without the stack flag the developer-local file wins — the dev stack's override convention",
    // Refusal (20s): the planted file's bogus cert path refuses the boot.
    { timeout: 30_000 },
    async () => {
      const prior = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : null;
      const port = await reservePort();
      const output: string[] = [];
      try {
        // The flag-absent side of the skip the resolved-stack leg above pins:
        // the file that leg plants must be ignored under the flag is, without
        // it, the developer's documented override (loadDotEnvLocal's own
        // contract: its values WIN over the inherited environment). The
        // observable: the file's bogus TLS cert path wins over the ENV's real
        // mkcert pair and the HTTPS-only edge refuses to boot naming the
        // bogus path. A boot that never refused would mean the file did not
        // win — the dev stack's convention silently broken, the regression
        // the unconditional-skip drift would produce with every flag-set leg
        // still green.
        writeFileSync(ENV_LOCAL, "EDGE_TLS_CERT_FILE=/nonexistent/dev-stack-override.pem\n");
        const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
          cwd: PACKAGE_DIR,
          env: childEnv({
            EDGE_DATABASE_URL: TEST_DATABASE_URL,
            EDGE_PORT: String(port),
            EDGE_TLS_CERT_FILE: path.join(certDir!, "cert.pem"),
            EDGE_TLS_KEY_FILE: path.join(certDir!, "key.pem"),
            SHUTDOWN_GRACE_MS: "2500",
          }),
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout?.on("data", (chunk: string) => output.push(chunk));
        child.stderr?.on("data", (chunk: string) => output.push(chunk));

        let exited: number | null = null;
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (child.exitCode !== null) {
            exited = child.exitCode;
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        if (exited !== null) {
          // The file won: the boot refusal names the file's bogus value.
          expect(output.join("")).toContain("/nonexistent/dev-stack-override.pem");
          expect(exited).not.toBe(0);
          return;
        }
        child.kill("SIGKILL");
        expect(
          false,
          `the planted file must win the boot — child output: ${output.join("").slice(-2_000) || "<none>"}`,
        ).toBe(true);
      } finally {
        if (prior === null) rmSync(ENV_LOCAL, { force: true });
        else writeFileSync(ENV_LOCAL, prior);
      }
    },
  );
});

describe("the dev-gateway's boot path serves the jobs_reachability check", () => {
  test(
    "the second entry point of the same seam constructs, starts and serves the loop, and releases on SIGTERM",
    // Boot (90s) + ok (15s) + one cadence-crossing wait (45s) + exit (10s).
    { timeout: 240_000 }, // boot 90 + ok 15 + one cadence wait 90 + stop 10.
    async () => {
      const jobs = new FakeJobsHealthServer();
      await jobs.start();
      const port = await reservePort();
      const child = await bootServer(
        "src/devGateway/server.ts",
        port,
        childEnv({
          // The dev-gateway's loader hard-requires its own least-privilege DSN
          // (no owner fallback) — the test store, as the helix_dev role.
          EDGE_DEV_DATABASE_URL: urlAs(TEST_DATABASE_URL, "helix_dev"),
          EDGE_ALLOW_DEV_MODE: "true",
          EDGE_DEV_GATEWAY_PORT: String(port),
          EDGE_TLS_CERT_FILE: path.join(certDir!, "cert.pem"),
          EDGE_TLS_KEY_FILE: path.join(certDir!, "key.pem"),
          EDGE_JOBS_CONFIG: jobsConfigDocument([{ name: "jobs", endpoint: jobs.endpoint }]),
          SHUTDOWN_GRACE_MS: "2500",
        }),
      );
      try {
        // The same wiring, the second process: the check appears and reads ok
        // through the loop this entry point constructed and started itself.
        await eventually(async () => (await servedCheck(port)).check?.status === "ok", 15_000);
        const healthy = await servedCheck(port);
        expect(healthy.statusCode).toBe(200);
        expect(healthy.check?.status).toBe("ok");

        // Its only configured server dies: the next pass observes it, and one
        // all-down server is the whole configured plane — degraded, still 200.
        await jobs.stop();
        await eventually(
          async () => (await servedCheck(port)).check?.status === "degraded",
          90_000, // three cadences of slack: a loaded machine delays a pass
        );
        const down = await servedCheck(port);
        expect(down.statusCode).toBe(200);
        expect(down.check?.detail).toMatch(/every configured jobs server is unreachable/);

        // The dev-gateway's onClose releases the loop too.
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        expect(exit.elapsedMs).toBeLessThan(2_000);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await jobs.stop().catch(() => {});
      }
    },
  );

  test(
    "the dev-gateway on a fully disabled install (no EDGE_JOBS_CONFIG) carries no jobs dependency",
    { timeout: 150_000 }, // boot 90 + a read + stop 10.
    async () => {
      const port = await reservePort();
      const child = await bootServer(
        "src/devGateway/server.ts",
        port,
        childEnv({
          EDGE_DEV_DATABASE_URL: urlAs(TEST_DATABASE_URL, "helix_dev"),
          EDGE_ALLOW_DEV_MODE: "true",
          EDGE_DEV_GATEWAY_PORT: String(port),
          EDGE_TLS_CERT_FILE: path.join(certDir!, "cert.pem"),
          EDGE_TLS_KEY_FILE: path.join(certDir!, "key.pem"),
          SHUTDOWN_GRACE_MS: "2500",
        }),
      );
      try {
        const res = await getHealth(port);
        expect(res.statusCode).toBe(200);
        const parsed = HealthStatusSchema.parse(res.body);
        // The second entry point's guard: the disabled install reports no
        // jobs dependency either.
        expect(parsed.checks?.some((c) => c.name === JOBS_REACHABILITY_CHECK)).toBe(false);
        expect(parsed.status).toBe("ok");

        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        expect(exit.elapsedMs).toBeLessThan(2_000);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
  );

  test(
    "a resolved stack (HELIX_STACK_ENV) boots with the stack env authoritative — the file does not win",
    // Boot (90s) + ok (60s) + stop (10s).
    { timeout: 150_000 },
    async () => {
      const prior = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : null;
      const port = await reservePort();
      let child: ChildProcess | undefined;
      try {
        // The same planted file as the edge's leg, at this entry point's own
        // key: the dev-gateway's loader hard-requires its own DSN, so the
        // file's dead store would make it degrade forever — the flip is the
        // body reaching ok against the ENV's store, the second copy of the
        // stack-authoritative skip pinned through its real entry point.
        writeFileSync(
          ENV_LOCAL,
          "EDGE_DEV_DATABASE_URL=postgresql://dotenv:dotenv@127.0.0.1:1/none\n",
        );
        child = await bootServer(
          "src/devGateway/server.ts",
          port,
          childEnv({
            EDGE_DEV_DATABASE_URL: urlAs(TEST_DATABASE_URL, "helix_dev"),
            EDGE_ALLOW_DEV_MODE: "true",
            EDGE_DEV_GATEWAY_PORT: String(port),
            EDGE_TLS_CERT_FILE: path.join(certDir!, "cert.pem"),
            EDGE_TLS_KEY_FILE: path.join(certDir!, "key.pem"),
            HELIX_STACK_ENV: "1",
            SHUTDOWN_GRACE_MS: "2500",
          }),
        );
        await eventually(async () => {
          const res = await getHealth(port);
          return res.statusCode === 200 && HealthStatusSchema.parse(res.body).status === "ok";
        }, 60_000);
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        child = undefined;
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (prior === null) rmSync(ENV_LOCAL, { force: true });
        else writeFileSync(ENV_LOCAL, prior);
      }
    },
  );

  test(
    "without the stack flag the developer-local file wins — the dev-stack override convention",
    // Boot (90s) + degrade (bounded): the same planted file, flag absent —
    // the file's dead store WINS (the dev-gateway degrades forever on it), the
    // documented dev-stack convention the consolidation must not drift away.
    { timeout: 150_000 },
    async () => {
      const prior = existsSync(ENV_LOCAL) ? readFileSync(ENV_LOCAL, "utf8") : null;
      const port = await reservePort();
      let child: ChildProcess | undefined;
      try {
        writeFileSync(
          ENV_LOCAL,
          "EDGE_DEV_DATABASE_URL=postgresql://dotenv:dotenv@127.0.0.1:1/none\n",
        );
        child = await bootServer(
          "src/devGateway/server.ts",
          port,
          childEnv({
            EDGE_DEV_DATABASE_URL: urlAs(TEST_DATABASE_URL, "helix_dev"),
            EDGE_ALLOW_DEV_MODE: "true",
            EDGE_DEV_GATEWAY_PORT: String(port),
            EDGE_TLS_CERT_FILE: path.join(certDir!, "cert.pem"),
            EDGE_TLS_KEY_FILE: path.join(certDir!, "key.pem"),
            SHUTDOWN_GRACE_MS: "2500",
          }),
        );
        await eventually(async () => {
          const res = await getHealth(port);
          if (res.statusCode !== 200) return false;
          const body = HealthStatusSchema.parse(res.body);
          // The file's dead store won: the dev-gateway boots and its registry
          // projection never loads — the override convention, observable.
          return (
            body.status === "error" &&
            body.checks?.some((c) => c.name === "registry-projection" && c.status === "error") ===
              true
          );
        }, 60_000);
        const exit = await stopServer(child);
        expect(exit.exitCode).toBe(0);
        child = undefined;
      } finally {
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        if (prior === null) rmSync(ENV_LOCAL, { force: true });
        else writeFileSync(ENV_LOCAL, prior);
      }
    },
  );
});
