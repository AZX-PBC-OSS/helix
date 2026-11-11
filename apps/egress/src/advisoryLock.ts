import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { discardPooledClient, withPooledClient } from "./pool.js";

export function serviceOAuthLockKey(secretId: string, env: string): string {
  return createHash("sha256")
    .update(`service-oauth\0${secretId}\0${env}`)
    .digest()
    .readBigInt64BE()
    .toString();
}

/** A thrown setup/reset/unlock or dead session destroys the checkout exactly once. */
export async function withAdvisoryLock<T>(
  pool: Pool,
  key: string,
  fn: (client: PoolClient, alive: () => boolean) => Promise<T>,
): Promise<T> {
  return withPooledClient(pool, async (client) => {
    let live = true;
    const lost = () => {
      live = false;
    };
    client.on("error", lost);
    try {
      try {
        await client.query("SELECT set_config('lock_timeout', '5000', false)");
        await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
      } catch (error) {
        discardPooledClient(client, error);
        throw error;
      }
      try {
        return await fn(client, () => live);
      } finally {
        await unlockSession(client, key);
      }
    } finally {
      client.removeListener("error", lost);
    }
  });
}

export async function unlockSession(client: PoolClient, key: string): Promise<void> {
  try {
    const unlocked = await client.query<{ unlocked: boolean }>(
      "SELECT pg_advisory_unlock($1::bigint) AS unlocked",
      [key],
    );
    if (!unlocked.rows[0]?.unlocked) throw new Error("advisory lock lost");
    await client.query("RESET lock_timeout");
  } catch (error) {
    discardPooledClient(client, error);
    throw error;
  }
}
