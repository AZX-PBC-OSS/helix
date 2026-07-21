import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBurnStore } from "./burn.js";

/**
 * The Postgres burn under the real `helix_egress` role (ADR-0013 Step 1,
 * issue #3) — this is the implementation that makes the one-time guarantee hold
 * across replicas. Asserts the atomic insert-or-refuse and the sweep, both under
 * the least-privilege role (its first write grant: INSERT/DELETE on
 * `instruction_jti`, migration 20260721215912). Skips when the role isn't
 * provisioned (CI without db-init) — same fail-soft stance as the other
 * integration tests.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";
function egressUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = "helix_egress";
  u.password = "helix_egress";
  return u.toString();
}

async function available(): Promise<boolean> {
  const pool = new Pool({ connectionString: egressUrl(), max: 1 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

let ok = false;
let store: PgBurnStore;
const jtis: string[] = [];

beforeAll(async () => {
  ok = await available();
  if (ok) store = new PgBurnStore(egressUrl());
});

afterAll(async () => {
  if (jtis.length) {
    const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
    await owner.query(`DELETE FROM instruction_jti WHERE jti = ANY($1)`, [jtis]);
    await owner.end();
  }
  await store?.close();
});

describe("PgBurnStore (helix_egress)", () => {
  it("admits a fresh jti and refuses a replay atomically", async () => {
    if (!ok) return; // role not provisioned — skip
    const jti = randomUUID();
    jtis.push(jti);
    expect(await store.burn(jti)).toBe(true);
    expect(await store.burn(jti)).toBe(false);
  });

  it("admits distinct jtis independently", async () => {
    if (!ok) return;
    const a = randomUUID();
    const b = randomUUID();
    jtis.push(a, b);
    expect(await store.burn(a)).toBe(true);
    expect(await store.burn(b)).toBe(true);
  });

  it("sweep deletes expired rows, freeing the jti", async () => {
    if (!ok) return;
    // Insert an already-expired row as the owner (egress only inserts now()+ttl).
    const jti = randomUUID();
    jtis.push(jti);
    const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
    await owner.query(
      `INSERT INTO instruction_jti (jti, "expiresAt") VALUES ($1, now() - interval '1 minute')`,
      [jti],
    );
    await owner.end();
    await store.sweep(); // runs as helix_egress (DELETE grant)
    // Row is gone, so the jti is admissible again.
    expect(await store.burn(jti)).toBe(true);
  });
});
