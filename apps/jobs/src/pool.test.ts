import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { createJobsPool, withJobsClient } from "./pool.js";

/**
 * The pooled-client discipline itself (`src/pool.ts`) — the shared mechanism
 * every jobs store's pool rides. The stores' own suites pin their sinks'
 * warnings through their public seams (the burn, probe, lifecycle and
 * acceptance paths); the legs here are the module's own contracts those
 * tests cannot see: the per-query ceiling actually applied server-side, a
 * reporting sink that throws without crashing the process or masking the
 * real error, and a per-checkout listener that leaves no trace behind it.
 * Every death is a real one — the test's own backend, terminated by pid.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

interface SinkCall {
  err: unknown;
  phase: "idle" | "checked-out";
}

/** A control connection for terminating one of the test's own backends. */
const control = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });

afterAll(async () => {
  await control.end();
});

async function terminateBackend(pid: number | undefined): Promise<void> {
  expect(pid, "the checkout never reported its own backend pid").toBeTruthy();
  await control.query(`SELECT pg_terminate_backend($1)`, [pid]);
}

describe("createJobsPool", () => {
  test("the per-query ceiling is applied server-side, not just passed", async () => {
    // Every store hands its statementTimeoutMs here and silently relies on
    // the pool applying it; an option dropped on the way would weaken every
    // store's per-query bound at once, with no failing test anywhere.
    const pool = createJobsPool({
      databaseUrl: TEST_DATABASE_URL,
      statementTimeoutMs: 1234,
      onClientError: () => {},
    });
    try {
      await expect(
        withJobsClient(pool, (client) =>
          client.query<{ t: string }>(`SELECT current_setting('statement_timeout') AS t`),
        ),
      ).resolves.toMatchObject({ rows: [{ t: "1234ms" }] });
    } finally {
      await pool.end();
    }
  });
});

describe("withJobsClient", () => {
  test("a reporting sink that throws never crashes the process and never masks the real error", async () => {
    // The sink runs on the socket's error path — inside the emit, where no
    // try/catch of the caller's is on the stack. A sink that throws (a
    // broken logger) must be absorbed there: the failure the caller sees is
    // the connection's own, and the process lives to serve the next call.
    const sink: Array<SinkCall> = [];
    const pool = createJobsPool({
      databaseUrl: TEST_DATABASE_URL,
      statementTimeoutMs: 10_000,
      onClientError: (err, phase) => {
        sink.push({ err, phase });
        throw new Error("the reporting sink itself is broken");
      },
    });
    try {
      await expect(
        withJobsClient(pool, async (client) => {
          const self = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
          await terminateBackend(self.rows[0]?.pid);
          // Give the death time to land between queries — pg delivers a
          // FATAL that arrives while a query is ACTIVE to that query's own
          // rejection without emitting, and this leg is about the emit path
          // the sink rides. Bounded, never a fixed sleep past it.
          const reportedBy = Date.now() + 5_000;
          while (Date.now() < reportedBy && sink.length === 0) {
            await new Promise((r) => setTimeout(r, 25));
          }
          return client.query(`SELECT 1`);
        }),
      ).rejects.toThrow(/connection/i); // pg's death, never the sink's throw

      // The death emitted at least once (the FATAL packet and the socket
      // close each surface), every emit rode the checked-out window, and
      // every sink throw was absorbed — how many echoes pg produces for one
      // death is its own detail.
      expect(sink.length).toBeGreaterThanOrEqual(1);
      expect(sink.every((c) => c.phase === "checked-out")).toBe(true);

      // The process survived the throw on the error path: the pool answers.
      await expect(
        withJobsClient(pool, (client) => client.query(`SELECT 1`)),
      ).resolves.toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  test("a finished checkout leaves no listener behind — an idle death reports idle, once", async () => {
    // The per-checkout listener is removed BEFORE the release: left behind,
    // it would accumulate on the long-lived pooled client and mis-report a
    // later idle death as checked-out — twice for one socket, on every
    // checkout that ever touched the client.
    const sink: Array<SinkCall> = [];
    const pool = createJobsPool({
      databaseUrl: TEST_DATABASE_URL,
      statementTimeoutMs: 10_000,
      onClientError: (err, phase) => {
        sink.push({ err, phase });
      },
    });
    try {
      // One checkout that ends well: the client parks in the pool, idle.
      const pid = await withJobsClient(pool, async (client) => {
        const self = await client.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
        return self.rows[0]?.pid;
      });

      // Its death while idle belongs to the pool's own listener.
      await terminateBackend(pid);
      const reportedBy = Date.now() + 10_000;
      while (Date.now() < reportedBy && sink.length === 0) {
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(sink.map((c) => c.phase)).toEqual(["idle"]);

      // The pool discarded the dead client and still serves.
      await expect(
        withJobsClient(pool, (client) => client.query(`SELECT 1`)),
      ).resolves.toBeTruthy();
    } finally {
      await pool.end();
    }
  });

  test("every exit returns the client — resolve, reject and destroy leave the pool and its listeners where they started", async () => {
    // The resource-lifetime loop: the bracket checks a client out and must
    // return it on every exit. The exits park the client differently — a
    // resolved fn and a normally-rejected fn return a LIVE client to the
    // idle set, a mid-checkout connection death destroys its client — and a
    // release that got any of that backwards would churn healthy clients on
    // ordinary errors or park dead ones. Repeating the two parking exits
    // past any leak's growth and measuring the reused client's listeners,
    // then the destroy exit against the pool's size, is what makes the
    // one-call-per-exit blind spot red.
    const sink: Array<SinkCall> = [];
    const pool = createJobsPool({
      databaseUrl: TEST_DATABASE_URL,
      statementTimeoutMs: 10_000,
      onClientError: (err, phase) => {
        sink.push({ err, phase });
      },
    });
    try {
      let captured: PoolClient | undefined;
      const bothParkingExits = async (label: string): Promise<void> => {
        await withJobsClient(pool, (client) => {
          captured ??= client;
          return client.query(`SELECT 1`);
        });
        await expect(
          withJobsClient(pool, async () => {
            throw new Error(`${label} refused`);
          }),
        ).rejects.toThrow(new RegExp(`${label} refused`));
      };

      await bothParkingExits("baseline");
      const client = captured as PoolClient;
      const listenersAtRest = client.listenerCount("error");
      expect(listenersAtRest).toBeGreaterThanOrEqual(0);

      for (let i = 0; i < 10; i += 1) {
        await bothParkingExits(`pass-${i}`);
      }
      // The same client was handed out every time and came back identical:
      // no per-checkout listener accumulated on either parking exit, and no
      // second client was opened behind a stranded checkout.
      expect(pool.totalCount).toBe(1);
      expect(client.listenerCount("error")).toBe(listenersAtRest);

      // The death exit destroys its client: the pool replaces it, still at
      // one client, and still serves.
      await expect(
        withJobsClient(pool, async (dying) => {
          const self = await dying.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
          await terminateBackend(self.rows[0]?.pid);
          const reportedBy = Date.now() + 5_000;
          while (Date.now() < reportedBy && sink.length === 0) {
            await new Promise((r) => setTimeout(r, 25));
          }
          return dying.query(`SELECT 1`);
        }),
      ).rejects.toThrow(/connection/i);
      expect(sink.some((c) => c.phase === "checked-out")).toBe(true);
      await expect(withJobsClient(pool, (fresh) => fresh.query(`SELECT 1`))).resolves.toBeTruthy();
      expect(pool.totalCount).toBe(1);
    } finally {
      await pool.end();
    }
  });
});
