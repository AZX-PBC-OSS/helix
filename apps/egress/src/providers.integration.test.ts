import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LiveProviders, type ProvidersLogger } from "./providerListener.js";

/**
 * The LISTEN/NOTIFY loop end to end, against the real test database (migrated
 * by vitest.globalSetup.ts, so the connection_substrate trigger and the
 * `helix_egress` grants are present — ADR-0011's channel, ADR-0006 part 2's
 * role split). Seeding runs as the table owner (the portal's job); the
 * listener runs under `helix_egress`, whose ONLY provider grant is SELECT.
 * Skips when the role isn't provisioned (CI without db-init) — same fail-soft
 * stance as the other integration suites.
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

const QUIET: ProvidersLogger = { info() {}, warn() {}, error() {} };

interface Line {
  level: "info" | "warn" | "error";
  fields: Record<string, unknown>;
  msg: string;
}
function recorder(): { lines: Line[]; log: ProvidersLogger } {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (fields, msg) => lines.push({ level: "info", fields, msg }),
      warn: (fields, msg) => lines.push({ level: "warn", fields, msg }),
      error: (fields, msg) => lines.push({ level: "error", fields, msg }),
    },
  };
}

/** Poll until `check` passes — NOTIFY delivery is fast but asynchronous. */
async function eventually(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Insert one provider row as the owner; registers it for afterAll cleanup. */
async function seedProvider(): Promise<{ id: string; ref: string }> {
  const id = randomUUID();
  const ref = `it-provider-${id.replace(/-/g, "").slice(0, 12)}`;
  const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    await owner.query(
      `INSERT INTO connection_providers (id, ref, kind, "displayName", "authorizeEndpoint",
         "tokenEndpoint", "requestedScopes", "apiOrigins", "tokenPlacement", env,
         "clientIdMaterial", "clientSecretMaterial", revision, "createdAt", "updatedAt")
       VALUES ($1, $2, 'rest-delegated', 'integration fixture', 'https://vendor.example/authorize',
         'https://vendor.example/token', '[]'::jsonb, '["https://app.example.com"]'::jsonb,
         '{"kind":"header-bearer"}'::jsonb, 'prod', 'sealed-client-id', 'sealed-client-secret',
         1, now(), now())`,
      [id, ref],
    );
  } finally {
    await owner.end();
  }
  return { id, ref };
}

/** One owner-connection statement (the portal's job — egress never writes). */
async function asOwner(sql: string, values: unknown[] = []): Promise<void> {
  const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    await owner.query(sql, values);
  } finally {
    await owner.end();
  }
}

const seeded: string[] = [];
let ok = false;

beforeAll(async () => {
  ok = await available();
});

afterAll(async () => {
  if (!ok || seeded.length === 0) return;
  const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    await owner.query(`DELETE FROM connection_providers WHERE id = ANY($1::uuid[])`, [seeded]);
  } finally {
    await owner.end();
  }
});

/** The number of open TCP resources the process holds (sockets, wraps). */
const tcpSockets = (): number =>
  process.getActiveResourcesInfo().filter((t) => t.startsWith("TCP")).length;

describe("the provider LISTEN/NOTIFY loop (helix_egress)", () => {
  it("reflects a seeded mutation within one debounced reconcile, and a delete", async () => {
    if (!ok) return; // role not provisioned — skip
    const { id, ref } = await seedProvider();
    seeded.push(id);
    const listener = new LiveProviders({
      databaseUrl: egressUrl(),
      reconcileIntervalMs: 60_000,
      log: QUIET,
    });
    try {
      await listener.start();
      expect(listener.isLoaded()).toBe(true);
      const row = listener.getByRef(ref, "prod");
      expect(row?.id).toBe(id);
      expect(row?.revision).toBe(1);
      // The id lookup — exchange's (T-0019) and renewal's (T-0021) key — serves
      // the same parsed row, sealed material included for the vault open.
      expect(listener.get(id)?.clientSecretMaterial).toBe("sealed-client-secret");

      // A sensitive edit through a DIFFERENT connection (the owner's): the
      // statement trigger fires NOTIFY on commit, the listener debounces, and
      // one reconcile later the cache serves the new revision — no restart.
      await asOwner(
        `UPDATE connection_providers SET revision = 2, "displayName" = 'edited' WHERE id = $1`,
        [id],
      );
      await eventually(() => listener.getByRef(ref, "prod")?.revision === 2);
      expect(listener.getByRef(ref, "prod")?.displayName).toBe("edited");
      // Revision keying: the entry the cache held before the edit is a stale
      // snapshot a consumer may still be reading — it is never mutated.
      expect(row?.revision).toBe(1);
      expect(row?.displayName).toBe("integration fixture");

      // Deletion (hard DELETE — ADR-0004's dangle semantics) also arrives, and
      // resolution fails closed immediately after the reconcile.
      await asOwner(`DELETE FROM connection_providers WHERE id = $1`, [id]);
      await eventually(() => listener.getByRef(ref, "prod") === undefined);
      expect(listener.get(id)).toBeUndefined();
      seeded.splice(seeded.indexOf(id), 1);
    } finally {
      await listener.stop();
    }
  });

  it("reconciles on reconnect after an injected connection failure (self-heal)", async () => {
    if (!ok) return;
    const { id, ref } = await seedProvider();
    seeded.push(id);
    const { lines, log } = recorder();
    const appName = `providers-it-${randomUUID().slice(0, 8)}`;
    // A long initial backoff makes the mutation-while-down window deterministic:
    // nothing reconciles until ~2s after the drop, so the only load that can
    // observe the mid-test mutation is the reconnect reconcile (the 60s
    // reconcile poll cannot fire within the test).
    const listener = new LiveProviders({
      databaseUrl: egressUrl(),
      reconcileIntervalMs: 60_000,
      backoffInitialMs: 2_000,
      applicationName: appName,
      log,
    });
    try {
      await listener.start();
      expect(listener.getByRef(ref, "prod")?.revision).toBe(1);

      // Inject the connection failure: terminate the listener's backend (found
      // by its application_name in pg_stat_activity). The client errors, logs,
      // and schedules a backoff reconnect — no crash, no dead silence.
      const found = await asOwnerRows<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()`,
        [appName],
      );
      const pid = found[0]?.pid;
      expect(pid).toBeDefined();
      await asOwner(`SELECT pg_terminate_backend($1)`, [pid]);
      await eventually(() => lines.some((l) => l.fields.event === "providers.listen_down"));
      const down = lines.find((l) => l.fields.event === "providers.listen_down");
      expect(down?.level).toBe("warn");
      expect(down?.fields.err).toBeDefined();

      // Mutate WHILE the listener is down: the NOTIFY is delivered to nobody
      // and is gone. The next reconcile must converge on current state anyway
      // (ADR-0011 §Consequences) — this is the missed-notification self-heal
      // and the reconnect half of reconcile-before-trusting-notifications.
      await asOwner(
        `UPDATE connection_providers SET revision = 2, "displayName" = 'edited while down'
          WHERE id = $1`,
        [id],
      );
      await eventually(() => listener.getByRef(ref, "prod")?.revision === 2);
      expect(listener.getByRef(ref, "prod")?.displayName).toBe("edited while down");

      // Recovery: the live listener again — a further mutation rides NOTIFY.
      await asOwner(
        `UPDATE connection_providers SET revision = 3, "displayName" = 'edited after recovery'
          WHERE id = $1`,
        [id],
      );
      await eventually(() => listener.getByRef(ref, "prod")?.revision === 3);
      expect(listener.getByRef(ref, "prod")?.displayName).toBe("edited after recovery");
    } finally {
      await listener.stop();
    }
  });

  it("releases the dedicated client on shutdown — start/stop cycles return to baseline", async () => {
    if (!ok) return;
    const opts = {
      databaseUrl: egressUrl(),
      reconcileIntervalMs: 60_000,
      log: QUIET,
    };
    // A warm-up cycle first: it proves the loop works AND settles the
    // measurement (an earlier suite's lazily-released socket must not poison
    // the baseline).
    const warm = new LiveProviders(opts);
    await warm.start();
    await warm.stop();
    await new Promise((r) => setTimeout(r, 100));
    const baseline = tcpSockets();

    for (const cycle of [1, 2, 3]) {
      const listener = new LiveProviders({
        ...opts,
        applicationName: `providers-handles-${cycle}`,
      });
      await listener.start();
      // Sanity: the measurement is not vacuous — a started listener holds at
      // least the dedicated client's socket.
      expect(tcpSockets()).toBeGreaterThan(baseline);
      await listener.stop();
      await new Promise((r) => setTimeout(r, 100));
      expect(tcpSockets()).toBe(baseline);
    }
  });
});

/** Owner-connection query returning rows (for pg_stat_activity lookups). */
async function asOwnerRows<T extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> {
  const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    return (await owner.query<T>(sql, values)).rows;
  } finally {
    await owner.end();
  }
}
