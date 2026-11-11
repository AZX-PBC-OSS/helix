import { EventEmitter } from "node:events";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { withAdvisoryLock } from "./advisoryLock.js";

function fixture(fail?: string, unlocked = true) {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (sql: string) => {
      if (fail && sql.includes(fail)) throw new Error("query failed");
      return { rows: [{ unlocked }] };
    }),
    release: vi.fn(),
  });
  const pool = { connect: async () => client } as unknown as Pool;
  return { client, pool };
}
describe("session advisory lock lifecycle", () => {
  it("unlocks and resets timeout before releasing a healthy session", async () => {
    const { pool, client } = fixture();
    expect(await withAdvisoryLock(pool, "1", async (_c, alive) => alive())).toBe(true);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual([
      "SELECT set_config('lock_timeout', '5000', false)",
      "SELECT pg_advisory_lock($1::bigint)",
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
      "RESET lock_timeout",
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(client.listenerCount("error")).toBe(0);
  });
  it("reuses a healthy session after an application refusal", async () => {
    const { pool, client } = fixture();
    await expect(
      withAdvisoryLock(pool, "1", async () => {
        throw new Error("needs_attention");
      }),
    ).rejects.toThrow("needs_attention");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(client.query.mock.calls.map((c) => c[0])).toContain("RESET lock_timeout");
  });
  it.each(["set_config", "pg_advisory_lock", "pg_advisory_unlock", "RESET"])(
    "destroys exactly once when %s fails",
    async (fail) => {
      const { pool, client } = fixture(fail);
      await expect(withAdvisoryLock(pool, "1", async () => "result")).rejects.toThrow(
        "query failed",
      );
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(client.listenerCount("error")).toBe(0);
    },
  );
  it("destroys a session whose unlock reports false", async () => {
    const { pool, client } = fixture(undefined, false);
    await expect(withAdvisoryLock(pool, "1", async () => "result")).rejects.toThrow(
      "advisory lock lost",
    );
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
  it("marks session loss before publication and rejects an apparently successful callback", async () => {
    const { pool, client } = fixture();
    await expect(
      withAdvisoryLock(pool, "1", async (_c, alive) => {
        client.emit("error", new Error("session lost"));
        expect(alive()).toBe(false);
        return "stale-result";
      }),
    ).rejects.toThrow("session lost");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
