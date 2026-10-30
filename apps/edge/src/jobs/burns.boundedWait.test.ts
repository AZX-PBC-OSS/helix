import { createServer, type Server, type Socket } from "node:net";

import { describe, expect, test } from "vitest";

import { PgJobsCallbackBurnStore } from "./burns.js";

/**
 * A burn rides the callback's request path, so a caller waiting for a free
 * connection must be bounded — the store's own policy ("a slow store denies
 * retryably instead of parking the callback", burns.ts). A zero statement
 * ceiling is a legal value on that surface — the pool docs bless `0` as
 * "disables the statement timeout", and `EDGE_STATEMENT_TIMEOUT_MS` reaches
 * both edge processes as a bare Number() — but as a connect wait, zero reads
 * as NO timer in pg-pool and the pg client alike. A stalled database would
 * park the callback forever: the exact silent hang the policy says cannot
 * happen.
 *
 * Whatever the remedy — refuse a non-positive ceiling at construction (the
 * jobs plane's requirePositiveMs answer) or bound the connect wait at a
 * positive floor while leaving the statement ceiling at zero — a burn against a
 * stalled database must ANSWER, denied, within a bounded window. The window
 * here is deliberately generous (wider than the pool's 10 s default): the
 * attack is an unbounded wait, not latency.
 */

const ANSWER_WINDOW_MS = 12_000;

const LOG = { warn: () => {} };

/** Accepts connections and never writes a byte — a database stalled mid-handshake. */
async function startStallServer(): Promise<{ server: Server; port: number; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the stall server has no port");
  }
  return { server, port: address.port, sockets };
}

async function stopStallServer(stall: { server: Server; sockets: Set<Socket> }): Promise<void> {
  for (const socket of stall.sockets) socket.destroy();
  await new Promise<void>((resolve) => stall.server.close(() => resolve()));
}

describe("a burn's wait on a stalled database is bounded", () => {
  test(
    "a positive ceiling bounds the wait — the stall really stalls and the ceiling really bounds",
    {
      timeout: 10_000,
    },
    async () => {
      const stall = await startStallServer();
      try {
        const burns = new PgJobsCallbackBurnStore({
          databaseUrl: `postgresql://helix_edge:unused@127.0.0.1:${stall.port}/none`,
          env: "prod",
          statementTimeoutMs: 250,
          log: LOG,
        });
        try {
          const verdict = await Promise.race([
            burns.burn("ceiling-250").then(
              () => "answered" as const,
              () => "answered" as const,
            ),
            new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000)),
          ]);
          expect(verdict).toBe("answered");
        } finally {
          await burns.stop();
        }
      } finally {
        await stopStallServer(stall);
      }
    },
  );

  test("a zero ceiling must not unbound the callback's wait", { timeout: 20_000 }, async () => {
    const stall = await startStallServer();
    let burns: PgJobsCallbackBurnStore;
    try {
      try {
        burns = new PgJobsCallbackBurnStore({
          databaseUrl: `postgresql://helix_edge:unused@127.0.0.1:${stall.port}/none`,
          env: "prod",
          statementTimeoutMs: 0,
          log: LOG,
        });
      } catch {
        // A construction-time refusal is a valid remedy: the bound moved to
        // the earliest stage that can catch it, and the callback path cannot
        // hang at runtime.
        return;
      }
      try {
        const verdict = await Promise.race([
          burns.burn("ceiling-zero").then(
            () => "answered" as const,
            () => "answered" as const,
          ),
          new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), ANSWER_WINDOW_MS)),
        ]);
        // Release whatever the hang still holds before asserting.
        for (const socket of stall.sockets) socket.destroy();
        await burns.stop();
        expect(verdict).toBe("answered");
      } finally {
        await burns.stop();
      }
    } finally {
      await stopStallServer(stall);
    }
  });
});
