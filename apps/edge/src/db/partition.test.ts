import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";

import { withPartition } from "./partition.js";

const APP_ID = "11111111-1111-4111-8111-111111111111";

/** Records the SQL it is handed; an EventEmitter so `'error'` behaves like pg's. */
class FakeClient extends EventEmitter {
  readonly queries: Array<{ sql: string; values?: unknown[] }> = [];
  released = 0;
  releaseArg: unknown = "not-called";
  release = (err?: unknown): void => {
    this.released += 1;
    this.releaseArg = err;
  };
  query = (sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> => {
    this.queries.push(values === undefined ? { sql } : { sql, values });
    return Promise.resolve({ rows: [] });
  };
}

function fakePool(client: FakeClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

const sqlOf = (client: FakeClient): string[] => client.queries.map((q) => q.sql);

describe("withPartition", () => {
  it("wraps the callback in a transaction with the app + env GUCs", async () => {
    const client = new FakeClient();
    const result = await withPartition(fakePool(client), APP_ID, null, "prod", async () => "value");
    expect(result).toBe("value");
    expect(sqlOf(client)).toEqual([
      "BEGIN",
      "SELECT set_config('app.app_id', $1, true), set_config('app.env', $2, true)",
      "COMMIT",
    ]);
    // Server-derived values, parameterized — never interpolated into the SQL.
    expect(client.queries[1]?.values).toEqual([APP_ID, "prod"]);
  });

  it("adds the user_oid GUC only when the caller is user-scoped", async () => {
    const client = new FakeClient();
    await withPartition(fakePool(client), APP_ID, "user-oid", "dev", async () => null);
    expect(client.queries[1]?.sql).toContain("set_config('app.user_oid', $3, true)");
    expect(client.queries[1]?.values).toEqual([APP_ID, "dev", "user-oid"]);
  });

  it("rolls back and rethrows when the callback fails, never committing", async () => {
    const client = new FakeClient();
    await expect(
      withPartition(fakePool(client), APP_ID, null, "prod", async () => {
        throw new Error("callback exploded");
      }),
    ).rejects.toThrow("callback exploded");
    expect(sqlOf(client)).toContain("ROLLBACK");
    expect(sqlOf(client)).not.toContain("COMMIT");
    expect(client.released).toBe(1);
  });

  // The property that must survive composing withPooledClient: pg-pool strips a
  // checked-out client's 'error' listener, and pg emits synchronously on a socket
  // death, so an unguarded transaction would kill the process. This asserts the
  // guard is present for the whole time the caller holds the client.
  it("holds an error listener for the duration of the checkout", async () => {
    const client = new FakeClient();
    let listenersInside = -1;
    await withPartition(fakePool(client), APP_ID, null, "prod", async (c) => {
      listenersInside = (c as unknown as FakeClient).listenerCount("error");
      expect(() =>
        (c as unknown as FakeClient).emit("error", new Error("socket died")),
      ).not.toThrow();
      return null;
    });
    expect(listenersInside).toBe(1);
    expect(client.listenerCount("error")).toBe(0); // and it doesn't leak past release
  });

  it("passes the client through so the callback runs on the same transaction", async () => {
    const client = new FakeClient();
    let seen: PoolClient | null = null;
    await withPartition(fakePool(client), APP_ID, null, "prod", async (c) => {
      seen = c;
      return null;
    });
    expect(seen).toBe(client);
  });
});
