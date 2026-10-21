import { randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";

import { INSTRUCTION_HEADER } from "@azx-pbc/shared";
import { deriveJobsInstructionKey, mintJobsInstruction } from "@azx-pbc/shared/jobsSigning";

import { TEST_DATABASE_URL } from "../test/seed.js";
import {
  FakeBlobReader,
  FakeOidcClient,
  FakeRegistry,
  FakeSessionStore,
  FakeUsageStore,
  registryEntry,
} from "../test/fakes.js";
import { testAuthConfig, testEdgeConfig, testDevGatewayConfig } from "../test/config.js";
import { buildApp } from "../app.js";
import { buildDevGateway } from "../devGateway/app.js";
import { PgJobsCallbackBurnStore } from "../jobs/burns.js";
import { FakeEgress } from "./jobsCallbackFixtures.js";
import { deriveInstructionKey } from "./instruction.js";
import { ROUTE_JOBS_FETCH } from "@azx-pbc/shared/telemetry";

/**
 * The signed callback receiver joined to the REAL burn store — the route the
 * receiver suites drive against the store's interface, here against the
 * store's pg implementation over the real migration's table, grants and
 * env-literal RLS (`jobs/burns.integration.test.ts` pins the store alone).
 * The join is the property neither file can pin by itself:
 *
 * - a callback that verifies and passes the tier check dispatches, and the
 *   nonce it presented is burned in the database — the SAME token presented
 *   again, or after a receiver restart, is refused 401 before anything runs;
 * - the two tiers are separate nonce spaces through their own routes: a
 *   token misrouted to the other tier's receiver is refused WITHOUT spending
 *   its nonce, which its own receiver then still accepts — and a replay
 *   across the two receivers' shared database is impossible by tier.
 *
 * Its own scratch database, cloned by the production `prisma migrate deploy`
 * (the burns suite's pattern); fail-soft only when the cluster or the runtime
 * roles are not reachable at all.
 */

const JOIN_DB = `helix_edge_jobs_callback_join_${randomUUID().replaceAll("-", "")}`;

function urlFor(database: string, role?: string): string {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role;
    url.password = role;
  }
  return url.toString();
}

const EDGE_DSN = urlFor(JOIN_DB, "helix_edge");
const DEV_DSN = urlFor(JOIN_DB, "helix_dev");

const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SERVER_ID = "jobs";
const TARGET = "https://api.github.com/users/octocat";
const PLATFORM_HOST = "helix-jobs-callback.internal";
const ROOTS = {
  edgeToJobs: randomBytes(32).toString("base64"),
  jobsToEdge: randomBytes(32).toString("base64"),
};
const CALLBACK_KEY = deriveJobsInstructionKey(ROOTS.jobsToEdge, "jobsToEdge");

let ok = false;

beforeAll(async () => {
  try {
    const reachable = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    await reachable.query("SELECT 1");
    await reachable.end();
  } catch {
    return;
  }
  const adminUrl = urlFor("helix");
  execSync(`psql "${adminUrl}" -c "DROP DATABASE IF EXISTS ${JOIN_DB} WITH (FORCE)"`, {
    stdio: "pipe",
  });
  execSync(`psql "${adminUrl}" -c "CREATE DATABASE ${JOIN_DB}"`, { stdio: "pipe" });
  execSync("pnpm --filter @azx-pbc/portal exec prisma migrate deploy", {
    stdio: "pipe",
    env: { ...process.env, DATABASE_URL: urlFor(JOIN_DB) },
  });
  const probe = new Pool({ connectionString: EDGE_DSN, max: 1 });
  try {
    await probe.query("SELECT 1");
    ok = true;
  } catch {
    ok = false;
  } finally {
    await probe.end();
  }
}, 120_000);

afterAll(async () => {
  if (!ok) return;
  const admin = new Pool({ connectionString: urlFor("helix"), max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${JOIN_DB}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}, 30_000);

function callbackJobsConfig() {
  return {
    servers: {
      [SERVER_ID]: {
        server: SERVER_ID,
        endpoint: "https://jobs.internal.helix",
        edgeToJobsKey: deriveJobsInstructionKey(ROOTS.edgeToJobs, "edgeToJobs"),
        jobsToEdgeKey: new Uint8Array(CALLBACK_KEY),
      },
    },
    timeoutMs: 30_000,
    refuseDiagnosticTypes: false,
  };
}

function receiverRegistry() {
  return new FakeRegistry([
    registryEntry({
      appId: APP_ID,
      slug: "demo",
      blobPrefix: "apps/a/1/",
      visibilityMode: "internal",
      fetch: {
        connections: new Map([["https://api.github.com", { kind: "keyless" }]]),
        requestsPerDay: null,
        shim: false,
      },
      jobsGeneration: "1",
    }),
  ]);
}

function buildProdReceiver(burns: PgJobsCallbackBurnStore): FastifyInstance {
  return buildApp({
    config: testEdgeConfig({
      auth: testAuthConfig(),
      fetch: {
        egressUrl: "http://egress.internal",
        instructionSecret: randomBytes(32),
        timeoutMs: 30_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
      jobs: callbackJobsConfig(),
    }),
    registry: receiverRegistry(),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    egress: new FakeEgress(),
    usage: new FakeUsageStore(),
    instructionKey: deriveInstructionKey(randomBytes(32)),
    jobsCallbackBurns: burns,
  });
}

function buildDevReceiver(burns: PgJobsCallbackBurnStore): FastifyInstance {
  return buildDevGateway({
    config: testDevGatewayConfig({
      fetch: {
        egressUrl: "http://egress.internal",
        instructionSecret: randomBytes(32),
        timeoutMs: 30_000,
        maxBodyBytes: 10 * 1024 * 1024,
      },
      jobs: callbackJobsConfig(),
    }),
    registry: receiverRegistry(),
    devTokens: {
      async resolve() {
        return null;
      },
      async originAllowed() {
        return false;
      },
      async close() {},
    },
    appData: null,
    usage: new FakeUsageStore(),
    llmProvider: null,
    egress: new FakeEgress(),
    instructionKey: deriveInstructionKey(randomBytes(32)),
    jobsForwarder: null,
    jobsCallbackBurns: burns,
    portal: null,
  });
}

async function mintToken(env: "prod" | "dev", iatS = Math.floor(Date.now() / 1_000)) {
  const body = Buffer.from(JSON.stringify({ url: TARGET }), "utf8");
  const token = await mintJobsInstruction(
    {
      operation: "fetch",
      server: SERVER_ID,
      identity: {
        appId: APP_ID,
        env,
        ownerKind: "user",
        ownerOid: "oid-triggering-user",
        type: `${SERVER_ID}:fetch`,
      },
      jobId: "job-123",
      generation: "1",
      body,
      iatS,
    },
    new Uint8Array(CALLBACK_KEY),
  );
  return { token, body };
}

async function present(
  app: FastifyInstance,
  token: string,
  body: Buffer,
): Promise<{ status: number; code?: string }> {
  const res = await app.inject({
    method: "POST",
    url: ROUTE_JOBS_FETCH,
    headers: {
      host: PLATFORM_HOST,
      [INSTRUCTION_HEADER]: token,
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
  let code: string | undefined;
  try {
    code = (res.json() as { code?: string }).code;
  } catch {
    code = undefined;
  }
  return { status: res.statusCode, code };
}

describe("the callback receiver against the real burn store (real roles, real migration)", () => {
  test("a verifying callback dispatches and its nonce is burned in the database; the replay is refused", async () => {
    if (!ok) return;
    const burns = new PgJobsCallbackBurnStore({
      databaseUrl: EDGE_DSN,
      env: "prod",
      statementTimeoutMs: 10_000,
      log: { warn: () => {} },
    });
    burns.start();
    const app = buildProdReceiver(burns);
    try {
      const { token, body } = await mintToken("prod");
      const first = await present(app, token, body);
      expect(first.status).toBe(200);

      // The burn row exists as the ROLE sees it — the RLS scope is part of
      // the answer.
      const probe = new Pool({ connectionString: EDGE_DSN, max: 1 });
      try {
        const rows = await probe.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM jobs_callback_jti WHERE "env" = 'prod'`,
        );
        expect(rows.rows[0]?.n).toBe(1);
      } finally {
        await probe.end();
      }

      const replay = await present(app, token, body);
      expect(replay.status).toBe(401);
      expect(replay.code).toBe("unauthorized");
    } finally {
      await app.close();
      await burns.stop();
    }
  });

  test("a receiver restart refuses the same nonce — the burn is the database's, not the process's", async () => {
    if (!ok) return;
    const first = new PgJobsCallbackBurnStore({
      databaseUrl: EDGE_DSN,
      env: "prod",
      statementTimeoutMs: 10_000,
      log: { warn: () => {} },
    });
    first.start();
    const firstApp = buildProdReceiver(first);
    const { token, body } = await mintToken("prod");
    expect((await present(firstApp, token, body)).status).toBe(200);
    await firstApp.close();
    await first.stop();

    // A brand-new store instance and a brand-new app — the restart/replica.
    const second = new PgJobsCallbackBurnStore({
      databaseUrl: EDGE_DSN,
      env: "prod",
      statementTimeoutMs: 10_000,
      log: { warn: () => {} },
    });
    second.start();
    const secondApp = buildProdReceiver(second);
    try {
      const replay = await present(secondApp, token, body);
      expect(replay.status).toBe(401);
      expect(replay.code).toBe("unauthorized");
    } finally {
      await secondApp.close();
      await second.stop();
    }
  });

  test("the tiers are separate nonce spaces through their routes: a misrouted token is refused unspent", async () => {
    if (!ok) return;
    const prodBurns = new PgJobsCallbackBurnStore({
      databaseUrl: EDGE_DSN,
      env: "prod",
      statementTimeoutMs: 10_000,
      log: { warn: () => {} },
    });
    prodBurns.start();
    const devBurns = new PgJobsCallbackBurnStore({
      databaseUrl: DEV_DSN,
      env: "dev",
      statementTimeoutMs: 10_000,
      log: { warn: () => {} },
    });
    devBurns.start();
    const prodApp = buildProdReceiver(prodBurns);
    const devApp = buildDevReceiver(devBurns);
    try {
      // One token, one server root, signed for the dev tier.
      const { token, body } = await mintToken("dev");

      // Misrouted to the production edge: refused 403, and the nonce is NOT
      // spent (the tier refusal precedes the burn).
      const misrouted = await present(prodApp, token, body);
      expect(misrouted.status).toBe(403);
      expect(misrouted.code).toBe("forbidden");

      // Its own receiver accepts it — the refusal spent nothing.
      const own = await present(devApp, token, body);
      expect(own.status).toBe(200);

      // And the replay is refused at its own receiver (the dev nonce space).
      const replay = await present(devApp, token, body);
      expect(replay.status).toBe(401);
    } finally {
      await devApp.close();
      await prodApp.close();
      await prodBurns.stop();
      await devBurns.stop();
    }
  });
});
