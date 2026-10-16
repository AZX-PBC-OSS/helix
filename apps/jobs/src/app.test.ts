import { describe, expect, test } from "vitest";

import {
  HealthStatusSchema,
  JOBS_DATABASE_CHECK,
  JOBS_WORKER_CHECK,
  JobErrorMessages,
} from "@azx-pbc/shared";

import { buildApp } from "./app.js";
import type { JobsStorageCompatibility } from "./compat.js";
import { loadJobsConfig } from "./config.js";
import type { JobsRunnerSnapshot } from "./runner.js";
import { JobsStorage } from "./storage.js";
import { makeReceiver, MemoryAdmission, MemoryLifecycle } from "./test/instructions.js";

/**
 * The listener's health contract and the unmatched-route behaviour, through
 * the real composition (`buildApp`) with the storage lifecycle driven by an
 * injected probe: the always-200 body, the honest roll-up, and the 503 the
 * service answers for its operations while the store is unusable. The signed
 * routes' own behavior is `operations.test.ts`; these legs only need the
 * receiver seam present.
 */

const CONFIG = loadJobsConfig({
  JOBS_SERVER_ID: "jobs",
  JOBS_DATABASE_URL: "postgresql://helix_jobs:pw@db:5432/helix_jobs_test",
  JOBS_EDGE_TO_JOBS_SECRET: "uFEfLTTVeHJK0+P/dQEWv8ccOyFrkZw7InR0I52V4/0=",
  JOBS_PORTAL_TO_JOBS_SECRET: "jUwQKa33JNljh0jULeithrh3JOL8dUmxPJknzGCjQBA=",
});

const COMPATIBLE: JobsStorageCompatibility = { kind: "compatible", schemaVersion: 45 };

/** A storage lifecycle in the wanted state, without a cluster. */
async function storageIn(state: "pending" | "ready" | "unavailable"): Promise<JobsStorage> {
  const storage = new JobsStorage({
    databaseUrl: CONFIG.databaseUrl,
    statementTimeoutMs: CONFIG.statementTimeoutMs,
    check: async () => (state === "ready" ? COMPATIBLE : { kind: "schema_missing" }),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  if (state !== "pending") {
    // The state must come from a completed probe, not a test's say-so.
    storage.start();
    await new Promise((resolve) => setImmediate(resolve));
  }
  return storage;
}

/** The full deps: the storage state under test plus the receiver seam. The
 * worker's supervision state is the leg's to set — the health body reads it
 * per request like the storage snapshot. */
async function depsWith(storage: JobsStorage, worker: JobsRunnerSnapshot = RUNNING_WORKER) {
  return {
    storage,
    instructions: makeReceiver().auth,
    lifecycle: new MemoryLifecycle(),
    admission: new MemoryAdmission(),
    worker: () => worker,
  };
}

/** The supervision state of a serving composition: the runner up, worker on it. */
const RUNNING_WORKER: JobsRunnerSnapshot = { started: true, workerRegistered: true };

describe("GET /health", () => {
  test("answers 200 with a schema-valid body while readiness is still unknown", async () => {
    const storage = await storageIn("pending");
    const app = buildApp(await depsWith(storage));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");

    const body = HealthStatusSchema.parse(res.json());
    expect(body.service).toBe("helix-jobs");
    // Unknown readiness never appears healthy: the roll-up is error before any
    // probe has answered.
    expect(body.status).toBe("error");
    expect(body.checks).toEqual([
      {
        name: JOBS_DATABASE_CHECK,
        status: "error",
        detail: expect.stringMatching(/never been verified/),
        metrics: { probes: 0 },
      },
      { name: JOBS_WORKER_CHECK, status: "ok" },
    ]);
    await app.close();
    await storage.stop();
  });

  test("a verified store reports ok, with the check named for the alert rules", async () => {
    const storage = await storageIn("ready");
    const app = buildApp(await depsWith(storage));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);

    const body = HealthStatusSchema.parse(res.json());
    expect(body.status).toBe("ok");
    expect(body.checks?.[0]?.name).toBe(JOBS_DATABASE_CHECK);
    expect(body.checks?.[0]?.status).toBe("ok");
    expect(body.checks?.[0]?.lastSuccessAt).toEqual(expect.any(String));
    expect(body.checks?.[1]?.name).toBe(JOBS_WORKER_CHECK);
    expect(body.checks?.[1]?.status).toBe("ok");
    await app.close();
    await storage.stop();
  });

  test("a started runner with no worker registered reports error — a listener without execution is not healthy", async () => {
    const storage = await storageIn("ready");
    const app = buildApp(await depsWith(storage, { started: true, workerRegistered: false }));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = HealthStatusSchema.parse(res.json());
    expect(body.status).toBe("error");
    expect(body.checks?.[1]?.name).toBe(JOBS_WORKER_CHECK);
    expect(body.checks?.[1]?.status).toBe("error");
    expect(body.checks?.[1]?.detail).toMatch(/no worker is registered/);
    await app.close();
    await storage.stop();
  });

  test("an unusable store reports error in the body — and still answers 200", async () => {
    const storage = await storageIn("unavailable");
    const app = buildApp(await depsWith(storage));
    const res = await app.inject({ method: "GET", url: "/health" });
    // The status code does not carry the degradation; a non-200 would let a
    // liveness probe restart a replica that is serving correctly.
    expect(res.statusCode).toBe(200);

    const body = HealthStatusSchema.parse(res.json());
    expect(body.status).toBe("error");
    expect(body.checks?.[0]?.detail).toMatch(/runner schema is not installed/);
    await app.close();
    await storage.stop();
  });

  test("HEAD /health answers like GET", async () => {
    const storage = await storageIn("ready");
    const app = buildApp(await depsWith(storage));
    const res = await app.inject({ method: "HEAD", url: "/health" });
    expect(res.statusCode).toBe(200);
    await app.close();
    await storage.stop();
  });

  test("/health and the 503 gate read the supervisor's CURRENT snapshot on every request", async () => {
    // One app, one storage lifecycle whose store degrades and recovers under
    // it: each request must answer the readiness as of THAT request. A handler
    // (or a buildApp refactor) that captured the snapshot at composition time
    // would keep reporting the boot state — health frozen at ok or at error —
    // which is the silent-wrong-answer direction this contract forbids.
    let verdict: JobsStorageCompatibility = COMPATIBLE;
    const storage = new JobsStorage({
      databaseUrl: CONFIG.databaseUrl,
      statementTimeoutMs: CONFIG.statementTimeoutMs,
      check: async () => verdict,
      readyIntervalMs: 5,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    storage.start();
    const app = buildApp(await depsWith(storage));
    try {
      const eventuallyState = async (state: "ready" | "unavailable"): Promise<void> => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline && storage.snapshot().state !== state) {
          await new Promise((r) => setTimeout(r, 10));
        }
        expect(storage.snapshot().state, `the store never became ${state}`).toBe(state);
      };

      await eventuallyState("ready");
      expect((await app.inject({ method: "GET", url: "/health" })).json().status).toBe("ok");
      expect((await app.inject({ method: "GET", url: "/no/such/route" })).statusCode).toBe(404);

      verdict = { kind: "unreachable", message: "connect ECONNREFUSED" };
      await eventuallyState("unavailable");
      const dead = await app.inject({ method: "GET", url: "/health" });
      expect(dead.json().status).toBe("error");
      expect(dead.json().checks?.[0]?.detail).toMatch(/did not answer/);
      const gated = await app.inject({ method: "GET", url: "/no/such/route" });
      expect(gated.statusCode).toBe(503);
      expect(gated.json().code).toBe("jobs_unavailable");

      verdict = COMPATIBLE;
      await eventuallyState("ready");
      expect((await app.inject({ method: "GET", url: "/health" })).json().status).toBe("ok");
      expect((await app.inject({ method: "GET", url: "/no/such/route" })).statusCode).toBe(404);
    } finally {
      await app.close();
      await storage.stop();
    }
  });
});

describe("unmatched routes", () => {
  test("while the store is unusable, an unmatched request answers 503 with the protocol's unavailable error", async () => {
    // The signed operation routes now exist (operations.test.ts); the gate
    // covers what is left unmatched, which is the operation surface's
    // fallback while any route has not landed.
    for (const state of ["pending", "unavailable"] as const) {
      const storage = await storageIn(state);
      const app = buildApp(await depsWith(storage));
      const res = await app.inject({ method: "POST", url: "/internal/jobs/v1/not-a-route" });
      expect(res.statusCode, `storage ${state}`).toBe(503);
      expect(res.headers["cache-control"], `storage ${state}`).toBe("no-store");
      expect(res.json(), `storage ${state}`).toEqual({
        code: "jobs_unavailable",
        message: JobErrorMessages.jobs_unavailable,
      });
      await app.close();
      await storage.stop();
    }
  });

  test("on a ready service an unknown route is a 404, not an availability statement", async () => {
    const storage = await storageIn("ready");
    const app = buildApp(await depsWith(storage));
    const res = await app.inject({ method: "GET", url: "/no/such/route" });
    expect(res.statusCode).toBe(404);
    await app.close();
    await storage.stop();
  });

  test("an inbound x-helix-request-id is never adopted — the request id stays self-minted", async () => {
    // The wiring is `requestIdOptions({ trustInbound: false })`: unauthenticated
    // metadata carries no authority, so a caller's header must not become the
    // correlation id. Egress is the one service that adopts a valid id — a
    // copy-paste of that posture here would let a jobs caller forge
    // correlations, so an exact match on the forged value is the red line.
    const forged = "11111111-2222-3333-4444-555555555555";
    const storage = await storageIn("ready");
    const app = buildApp(await depsWith(storage));
    const reqIds: string[] = [];
    app.addHook("onResponse", async (req) => {
      reqIds.push(req.id);
    });
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-helix-request-id": forged },
    });
    expect(res.statusCode).toBe(200);
    expect(reqIds).toHaveLength(1); // the hook observed the request...
    expect(reqIds[0]).not.toBe(forged); // ...under a self-minted id, never the caller's
    await app.close();
    await storage.stop();
  });
});
