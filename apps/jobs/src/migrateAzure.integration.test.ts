import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { checkJobsStorageCompatibility, PGBOSS_SCHEMA_VERSION } from "./compat.js";
import { JOBS_RUNTIME_ROLE } from "./policy.js";
import { readMigrateDsn } from "../scripts/migrate-azure.js";
import { applyRolesProvisioning } from "../../portal/src/test/provisionDatabases.js";

/**
 * The Azure migration entry point (`scripts/migrate-azure.ts` — what
 * infra/azure/modules/jobs-migrate-job.bicep runs). Its two hops are real
 * network boundaries — the Container Apps managed-identity endpoint and the
 * Key Vault data plane — so both are stubbed by one local HTTP server, and
 * everything behind them is real: the script resolves the migration DSN
 * through those hops, then runs the package's own migration command against
 * a real scratch store provisioned through the platform's role file (no test
 * superuser, the real role split).
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const PACKAGE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCRATCH_DB = `helix_jobs_azure_${randomUUID().replaceAll("-", "")}`;
/** The refusal leg's own store — the happy path migrates the first one. */
const REFUSED_DB = `helix_jobs_azure_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

const MIGRATE_DSN = urlFor(SCRATCH_DB, "helix_jobs_migrate");

interface StubVault {
  identityUrl: string;
  vaultUrl: string;
  /** The token the identity endpoint mints; the vault GET asserts it arrived. */
  mintedToken: string;
  /** The value the vault secret GET answers with (undefined → an empty value). */
  secretValue: string | undefined;
  secretStatus: number;
  tokenStatus: number;
  /** When set, the secret GET answers 200 with this raw body — a vault fault that no longer parses. */
  rawSecretBody: string | undefined;
  /** When set, the secret GET never answers — the bounded-wait leg. */
  hangSecretRead: boolean;
  /** When set, the identity endpoint never answers — the first hop's bounded-wait leg. */
  hangIdentityRead: boolean;
  /** The Authorization header of the last vault secret GET. */
  lastAuthHeader: string | string[] | undefined;
  lastIdentityHeader: string | string[] | undefined;
  /** The request URL of the last vault secret GET (path + query). */
  lastSecretUrl: string | undefined;
  server: Server;
}

function startStubVault(): Promise<StubVault> {
  const stub: StubVault = {
    identityUrl: "",
    vaultUrl: "",
    mintedToken: "stub-mi-token-0f31",
    secretValue: MIGRATE_DSN,
    secretStatus: 200,
    tokenStatus: 200,
    hangSecretRead: false,
    hangIdentityRead: false,
    rawSecretBody: undefined,
    lastAuthHeader: undefined,
    lastIdentityHeader: undefined,
    lastSecretUrl: undefined,
    server: createServer(() => {}),
  };
  stub.server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    if (req.url?.startsWith("/identity")) {
      stub.lastIdentityHeader = req.headers["x-identity-header"];
      if (stub.hangIdentityRead) return; // never answers — the first hop's bounded-wait leg
      if (stub.tokenStatus !== 200) {
        res.statusCode = stub.tokenStatus;
        res.end("identity endpoint refused");
        return;
      }
      // The App Service / Container Apps shape: epoch-seconds `expires_on`.
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: stub.mintedToken,
          expires_on: String(Math.floor(Date.now() / 1000) + 3600),
        }),
      );
      return;
    }
    if (req.url?.startsWith("/vault/secrets/jobs-migrate-database-url")) {
      stub.lastAuthHeader = req.headers.authorization;
      stub.lastSecretUrl = req.url;
      if (stub.hangSecretRead) return; // never answers — the bounded-wait leg
      if (stub.rawSecretBody !== undefined) {
        res.setHeader("content-type", "application/json");
        res.end(stub.rawSecretBody);
        return;
      }
      if (stub.secretStatus !== 200) {
        res.statusCode = stub.secretStatus;
        res.end("vault refused");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ value: stub.secretValue ?? "" }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  return new Promise((resolve) => {
    stub.server.listen(0, "127.0.0.1", () => {
      const port = (stub.server.address() as AddressInfo).port;
      stub.identityUrl = `http://127.0.0.1:${port}/identity`;
      stub.vaultUrl = `http://127.0.0.1:${port}/vault/`;
      resolve(stub);
    });
  });
}

let stub: StubVault;

/** The job's environment, pointed at the stubs. */
function jobEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return {
    AZURE_CLIENT_ID: "the-jobs-migrate-identity-client-id",
    IDENTITY_ENDPOINT: stub.identityUrl,
    IDENTITY_HEADER: "the-aca-identity-header",
    PLATFORM_VAULT_URL: stub.vaultUrl,
    ...overrides,
  };
}

interface ChildRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run the script the job's command runs it — as a child process. ASYNC spawn
 * on purpose: the stub identity/vault endpoints live in THIS worker, and a
 * synchronous spawn would block its event loop so the stub could never answer
 * the child's requests (observed: the child's token fetch hung to its own
 * 10 s bound and died there).
 */
function runAzureScript(env: NodeJS.ProcessEnv): Promise<ChildRun> {
  return runAzureScriptWithHandle(env).promise;
}

/** The same run, with the parent's process handle left available to the test. */
function runAzureScriptWithHandle(env: NodeJS.ProcessEnv): {
  promise: Promise<ChildRun>;
  child: ReturnType<typeof spawn>;
} {
  const child = spawn("node", ["--import", "tsx", "scripts/migrate-azure.ts"], {
    cwd: PACKAGE_DIR,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const promise = new Promise<ChildRun>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (status, signal) =>
      resolve({
        status: status ?? (signal ? -1 : 1),
        stdout,
        stderr: signal ? `${stderr}\nkilled by ${signal}` : stderr,
      }),
    );
  });
  return { promise, child };
}

/**
 * The OS pid of the script's migration child, polled for — the parent resolves
 * its DSN through the stub first, so the child appears a moment after spawn.
 * A poll timeout throws rather than killing blind.
 */
async function pollForChildPid(parentPid: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const out = await new Promise<string>((resolve) => {
      const probe = spawn("pgrep", ["-P", String(parentPid)]);
      let found = "";
      probe.stdout.on("data", (chunk: Buffer) => (found += chunk.toString()));
      probe.on("close", () => resolve(found.trim()));
    });
    const pid = Number(out.split("\n")[0]);
    if (Number.isInteger(pid) && pid > 0) return pid;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no migration child appeared under pid ${parentPid} within ${timeoutMs} ms`);
}

/** The structured events a run printed, parsed defensively from its output. */
function eventNamed(output: string, name: string): Record<string, unknown> | undefined {
  return output
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .find((parsed) => parsed?.event === name);
}

beforeAll(async () => {
  stub = await startStubVault();
  // The scratch stores are created by the provisioning itself (the file's
  // create-if-missing), inside the serialized application.
  await applyRolesProvisioning(SCRATCH_DB);
  await applyRolesProvisioning(REFUSED_DB);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => stub.server.close(() => resolve()));
  const pool = new Pool({ connectionString: urlFor("postgres"), max: 1 });
  await pool.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
  await pool.query(`DROP DATABASE IF EXISTS "${REFUSED_DB}" WITH (FORCE)`);
  await pool.end();
}, 30_000);

describe("resolving the migration DSN through the job's two hops", () => {
  test("mints a managed-identity token and reads the DSN with it", async () => {
    const dsn = await readMigrateDsn(jobEnv({}));
    expect(dsn).toBe(MIGRATE_DSN);
    // The token handoff is real: the vault GET carried the bearer token the
    // identity endpoint minted, sent with the ACA identity header.
    expect(stub.lastIdentityHeader).toBe("the-aca-identity-header");
    expect(stub.lastAuthHeader).toBe(`Bearer ${stub.mintedToken}`);
  });

  test("a missing vault URL fails, naming the variable", async () => {
    await expect(readMigrateDsn(jobEnv({ PLATFORM_VAULT_URL: undefined }))).rejects.toThrow(
      /PLATFORM_VAULT_URL is required/,
    );
  });

  test("outside a managed identity the DSN is unreadable, naming the identity env", async () => {
    await expect(readMigrateDsn(jobEnv({ IDENTITY_ENDPOINT: undefined }))).rejects.toThrow(
      /not running under a managed identity.*IDENTITY_ENDPOINT.*IDENTITY_HEADER.*AZURE_CLIENT_ID/s,
    );
  });

  test("a vault refusal surfaces the status and never the secret", async () => {
    stub.secretStatus = 403;
    const marker = "secret-value-leak-marker-4e7a";
    stub.secretValue = marker;
    try {
      await expect(readMigrateDsn(jobEnv({}))).rejects.toThrow(
        /Key Vault GET jobs-migrate-database-url failed: 403/,
      );
      await expect(readMigrateDsn(jobEnv({}))).rejects.not.toThrow(/leak-marker/);
    } finally {
      stub.secretStatus = 200;
      stub.secretValue = MIGRATE_DSN;
    }
  });

  test("an empty secret value is refused, not handed to the migration", async () => {
    stub.secretValue = "";
    try {
      await expect(readMigrateDsn(jobEnv({}))).rejects.toThrow(/exists but has no value/);
    } finally {
      stub.secretValue = MIGRATE_DSN;
    }
  });

  test("an identity-endpoint failure is bounded and reported", async () => {
    stub.tokenStatus = 500;
    try {
      await expect(readMigrateDsn(jobEnv({}))).rejects.toThrow(
        /managed-identity token endpoint returned 500/,
      );
    } finally {
      stub.tokenStatus = 200;
    }
  });

  test("a hung vault read is bounded, and the bound names the operation", async () => {
    // A hanging vault (private-DNS blackhole, wedged endpoint) must fail the
    // run, not strand the job to its replica timeout — with the wait's
    // operation named, not a bare abort.
    stub.hangSecretRead = true;
    try {
      await expect(readMigrateDsn(jobEnv({}), { secretReadTimeoutMs: 250 })).rejects.toThrow(
        /reading the migration DSN from the vault timed out.*250 ms/s,
      );
    } finally {
      stub.hangSecretRead = false;
    }
  });

  test(
    "the job's default read bound is the production one — 30 s, named on expiry",
    { timeout: 60_000 },
    async () => {
      // The job template passes no read bound (its env is exactly the vault
      // URL and the identity), so production always runs on the default —
      // this leg proves the DEFAULT bounds the wait and names it. The
      // mechanism leg above pins the option; without this leg the option's
      // bound would be tested and the production path's never.
      stub.hangSecretRead = true;
      try {
        await expect(readMigrateDsn(jobEnv({}))).rejects.toThrow(
          /reading the migration DSN from the vault timed out or failed after 30000 ms/,
        );
      } finally {
        stub.hangSecretRead = false;
      }
    },
  );

  test(
    "a hung identity endpoint is bounded, and the failure names the operation",
    { timeout: 30_000 },
    async () => {
      // The first hop's wait must be bounded too: the provider aborts its
      // token request on its own bound, and the failure must name the
      // operation — a wedged identity endpoint (missing route, dead sidecar)
      // strands the job no better than a wedged vault would.
      stub.hangIdentityRead = true;
      try {
        await expect(readMigrateDsn(jobEnv({}))).rejects.toThrow(
          /managed-identity token request failed/,
        );
      } finally {
        stub.hangIdentityRead = false;
      }
    },
  );

  test("a vault URL without a trailing slash resolves the same secret", async () => {
    // Vault URIs and operator-supplied values vary in the trailing slash; the
    // entry must keep the secrets path relative to the vault URI either way,
    // so the read resolves identically against the slash-less form.
    const dsn = await readMigrateDsn(
      jobEnv({ PLATFORM_VAULT_URL: stub.vaultUrl.replace(/\/$/, "") }),
    );
    expect(dsn).toBe(MIGRATE_DSN);
    expect(stub.lastAuthHeader).toBe(`Bearer ${stub.mintedToken}`);
  });

  test("a malformed success body fails the run and never echoes its content", async () => {
    // A vault fault can answer 200 with a body that no longer parses (a
    // truncated read). The run must fail loudly — never resolve a value for
    // the migration — and the parse failure's own message must not carry the
    // body's credential material into the job log.
    const marker = "leaked-pw-marker-3b9c";
    stub.rawSecretBody = `{"value": "postgresql://helix_jobs_migrate:${marker}@db:5432/helix_jobs_x`;
    try {
      const outcome = await readMigrateDsn(jobEnv({})).then(
        (dsn) => `resolved ${dsn}`,
        (err: unknown) => err,
      );
      expect(outcome, "a malformed 200 body must fail the read, not resolve").toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).not.toContain(marker);
    } finally {
      stub.rawSecretBody = undefined;
    }
  });

  test("an unquoted-value success body fails the run and never echoes its credential", async () => {
    // The second realistic mangle shape — the value's quotes lost, not the
    // body truncated. V8's "Unexpected token" message embeds a snippet of the
    // body's head, which ends before the credential begins (the scheme +
    // username push it past the snippet window); the no-echo containment
    // rests on that message shape, so a V8 change that starts quoting the
    // error region — where the credential can sit — must go red here.
    const marker = "leaked-pw-marker-2d8e";
    stub.rawSecretBody = `{"value": postgresql://helix_jobs_migrate:${marker}@db:5432/helix_jobs_x}`;
    try {
      const outcome = await readMigrateDsn(jobEnv({})).then(
        (dsn) => `resolved ${dsn}`,
        (err: unknown) => err,
      );
      expect(outcome, "a mangled 200 body must fail the read, not resolve").toBeInstanceOf(Error);
      expect(String((outcome as Error).message)).not.toContain(marker);
    } finally {
      stub.rawSecretBody = undefined;
    }
  });

  test("the vault secret GET carries the api-version the data plane requires", async () => {
    // The stub answers a secret GET regardless of its query, but the real
    // Key Vault data plane refuses a request without api-version — a dropped
    // param would stay green here and fail only against Azure. The request
    // shape is the read's observable contract with that plane.
    await readMigrateDsn(jobEnv({}));
    const query = new URL(stub.lastSecretUrl ?? "/", "http://stub.invalid").searchParams;
    expect(query.get("api-version"), "the vault GET must carry an api-version").toMatch(
      /^\d+\.\d+$/,
    );
  });
});

describe("the job's process entry", () => {
  test(
    "the script migrates the scratch store through the real migration command",
    { timeout: 120_000 },
    async () => {
      const run = await runAzureScript(jobEnv({}));
      expect(run.status, `${run.stderr}\n${run.stdout}`).toBe(0);

      const started = eventNamed(run.stdout, "jobs_storage_migration_started");
      expect(started).toMatchObject({ store: `helix_jobs_migrate@db:5432/${SCRATCH_DB}` });
      const applied = eventNamed(run.stdout, "jobs_storage_migration_applied");
      expect(applied).toMatchObject({
        schemaVersionBefore: null,
        schemaVersion: PGBOSS_SCHEMA_VERSION,
        queueExisted: false,
        queuePolicyRepairs: [],
      });
      expect(typeof applied?.durationMs).toBe("number");

      // The outcome is the store a runtime can rely on, verified through the
      // runtime role — the same probe service boot runs.
      const pool = new Pool({ connectionString: urlFor(SCRATCH_DB, JOBS_RUNTIME_ROLE), max: 1 });
      try {
        await expect(checkJobsStorageCompatibility(pool)).resolves.toEqual({
          kind: "compatible",
          schemaVersion: PGBOSS_SCHEMA_VERSION,
        });
      } finally {
        await pool.end();
      }
    },
  );

  test(
    "a vault refusal migrates nothing and never echoes the DSN's credential",
    { timeout: 120_000 },
    async () => {
      const password = "leaked-pw-marker-9f2a7b";
      const marked = new URL(urlFor(REFUSED_DB, "helix_jobs_migrate"));
      marked.password = password;
      stub.secretValue = marked.toString();
      stub.secretStatus = 403;
      try {
        const run = await runAzureScript(jobEnv({}));
        expect(run.status, run.stderr).toBe(1);
        const output = `${run.stdout}${run.stderr}`;
        expect(output).toContain("Key Vault GET jobs-migrate-database-url failed: 403");
        expect(output).not.toContain(password);
        expect(output).not.toContain("jobs_storage_migration_started");
      } finally {
        stub.secretStatus = 200;
        stub.secretValue = MIGRATE_DSN;
      }
      // The refused run left the store unmigrated.
      const pool = new Pool({ connectionString: urlFor(REFUSED_DB, JOBS_RUNTIME_ROLE), max: 1 });
      try {
        await expect(checkJobsStorageCompatibility(pool)).resolves.toEqual({
          kind: "schema_missing",
        });
      } finally {
        await pool.end();
      }
    },
  );

  test(
    "a failing migration command exits 1, and the job log never carries the credential",
    { timeout: 120_000 },
    async () => {
      // The vault answers, but the DSN it holds authenticates against
      // nothing — the failure is the migration child's, and the job log is
      // child + parent output verbatim.
      const password = "leaked-pw-marker-6c4d21";
      const unauthenticatable = new URL(urlFor(REFUSED_DB, "helix_jobs_migrate"));
      unauthenticatable.password = password;
      stub.secretValue = unauthenticatable.toString();
      try {
        const run = await runAzureScript(jobEnv({}));
        expect(run.status, run.stderr).toBe(1);
        const output = `${run.stdout}${run.stderr}`;
        // The parent names the child's outcome — the message-only contract,
        // no stack frame.
        expect(output).toContain("migrate-azure failed: the migration command exited 1");
        // No false success, and the composite log never carries the DSN's
        // credential.
        expect(eventNamed(output, "jobs_storage_migration_applied")).toBeUndefined();
        expect(output).not.toContain(password);
      } finally {
        stub.secretValue = MIGRATE_DSN;
      }
    },
  );

  test(
    "importing the azure entry runs nothing — the command only starts as the process entry",
    { timeout: 60_000 },
    async () => {
      // The guard that keeps `readMigrateDsn` importable for the in-process
      // legs is itself load-bearing: a bare import must not execute the job.
      // If the guard broke, this child — which imports the module with NO job
      // env — would run main(), fail on the missing vault URL, and exit 1
      // loudly instead of exiting 0 silently.
      const moduleUrl = pathToFileURL(path.join(PACKAGE_DIR, "scripts/migrate-azure.ts")).href;
      const run = await new Promise<ChildRun>((resolve, reject) => {
        const child = spawn(
          "node",
          [
            "--import",
            "tsx",
            "--eval",
            `import(${JSON.stringify(moduleUrl)}).then(() => console.log("import-ok"))`,
          ],
          { cwd: PACKAGE_DIR, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (status) => resolve({ status: status ?? 1, stdout, stderr }));
      });
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe("import-ok");
      expect(run.stderr, "a bare import must produce no output").toBe("");
    },
  );

  test(
    "a migration command killed by a signal is reported, not mistaken for an exit code",
    { timeout: 120_000 },
    async () => {
      // A DSN whose connect hangs (non-routable host) keeps the migration
      // child alive for the whole window, so the kill lands mid-run: the
      // parent must report the child's death BY SIGNAL — a signal is not a
      // numeric exit status — and exit non-zero itself.
      const password = "leaked-pw-marker-1d7e3f";
      const blackhole = new URL(urlFor(REFUSED_DB, "helix_jobs_migrate"));
      blackhole.hostname = "10.255.255.1";
      blackhole.password = password;
      stub.secretValue = blackhole.toString();
      const { child, promise } = runAzureScriptWithHandle(jobEnv({}));
      try {
        const migrationPid = await pollForChildPid(child.pid!, 20_000);
        process.kill(migrationPid, "SIGKILL");
        const run = await promise;
        expect(run.status, run.stderr).toBe(1);
        const output = `${run.stdout}${run.stderr}`;
        expect(output).toContain("the migration command was killed by SIGKILL");
        expect(eventNamed(output, "jobs_storage_migration_applied")).toBeUndefined();
        expect(output).not.toContain(password);
      } finally {
        stub.secretValue = MIGRATE_DSN;
        child.kill("SIGKILL"); // a poll timeout must not strand the parent
      }
    },
  );
});
