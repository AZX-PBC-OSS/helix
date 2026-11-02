import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, describe, expect, test } from "vitest";

import { applyRolesProvisioning } from "./provisionDatabases.js";

/**
 * The fact the roles-provisioning lock stands on: Postgres advisory locks
 * contend only within one database. The provisioning serializes concurrent
 * applications by taking its lock on a dedicated connection to `postgres` —
 * correct only while a lock held there blocks another session on `postgres`
 * but never one on the test database. A Postgres major or a backend swap
 * that changed that scoping would silence the serialization without any
 * other signal; this pin turns the change into a red test instead.
 *
 * The probe key is deliberately not the provisioning's — this test must
 * never contend with a real application of the roles file.
 */
const PROBE_KEY = 918273646;

/**
 * The provisioning's own lock key (module-private in
 * `provisionDatabases.ts`, repeated here the way the probe key above is):
 * the serialization pin below must contend with the helper's real lock, so
 * it holds the real key — a probe key would prove nothing about the helper.
 */
const PROVISIONING_LOCK_KEY = 918273645;

function poolOn(database: string): Pool {
  const url = new URL(
    process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test",
  );
  url.pathname = `/${database}`;
  return new Pool({ connectionString: url.toString(), max: 1 });
}

describe("the roles-provisioning lock's advisory-key scoping", () => {
  const pools = {
    holder: poolOn("postgres"),
    sameDb: poolOn("postgres"),
    otherDb: poolOn("helix_test"),
  };

  afterAll(async () => {
    for (const pool of Object.values(pools)) await pool.end();
  });

  test("a lock held on postgres contends a same-database session but not a cross-database one", async () => {
    await pools.holder.query("SELECT pg_advisory_lock($1)", [PROBE_KEY]);
    try {
      const sameDb = await pools.sameDb.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS ok",
        [PROBE_KEY],
      );
      expect(sameDb.rows[0]?.ok).toBe(false);

      const crossDatabase = await pools.otherDb.query<{ ok: boolean }>(
        "SELECT pg_try_advisory_lock($1) AS ok",
        [PROBE_KEY],
      );
      expect(crossDatabase.rows[0]?.ok).toBe(true);
      await pools.otherDb.query("SELECT pg_advisory_unlock($1)", [PROBE_KEY]);
    } finally {
      await pools.holder.query("SELECT pg_advisory_unlock($1)", [PROBE_KEY]);
    }
  });

  test(
    "a holder of the agreed lock in the agreed database blocks the application until release",
    { timeout: 60_000 },
    async () => {
      // The helper's reason to exist: concurrent applications of the roles
      // file serialize on one advisory lock. A client already holding that
      // key on `postgres` must hold up the whole application — the helper
      // blocks in pg_advisory_lock before it launches psql, so "not yet
      // applied" after the window is deterministic on any cluster. A helper
      // regressed to another database or another key runs its psql under the
      // held lock and turns this red. The window bounds the regression side
      // only: a cluster so slow that ~20 provisioning statements exceed it
      // would be failing every timed leg in the suite anyway.
      const blocker = poolOn("postgres");
      const scratchDb = `helix_jobs_lockpin_${randomUUID().replaceAll("-", "")}`;
      try {
        await blocker.query("SELECT pg_advisory_lock($1)", [PROVISIONING_LOCK_KEY]);
        let applied = false;
        let failed: unknown;
        const run = applyRolesProvisioning(scratchDb).then(
          () => {
            applied = true;
          },
          (error: unknown) => {
            failed = error;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(applied, "the provisioning ran while another holder kept the lock").toBe(false);
        await blocker.query("SELECT pg_advisory_unlock($1)", [PROVISIONING_LOCK_KEY]);
        await run;
        if (failed) throw failed;
        expect(applied).toBe(true);
      } finally {
        // The lock is session-scoped: ending the connection releases it even
        // when an assertion failed above. The scratch store the application
        // created goes with it either way.
        await blocker.end();
        const owner = poolOn("postgres");
        try {
          await owner.query(`DROP DATABASE IF EXISTS "${scratchDb}" WITH (FORCE)`);
        } finally {
          await owner.end();
        }
      }
    },
  );

  test(
    "a database name that is not a bare identifier never reaches the shell",
    { timeout: 30_000 },
    async () => {
      // The helper builds its psql command by shell concatenation with the
      // jobsDb parameter interpolated in. Every current caller passes a
      // compile-time constant, but the layer must be correct in isolation: a
      // caller someday passing a name derived from input must fail at the
      // helper's own validation, not execute in a shell. The payload is
      // shaped so the mangled psql fails fast (an unrecognized option, not a
      // stdin read) — the marker proves whether injected shell syntax ran.
      const marker = "/tmp/opencode/provision-injection-marker";
      rmSync(marker, { force: true });
      await expect(
        applyRolesProvisioning(`x --not-a-real-flag; touch ${marker}`),
      ).rejects.toThrow();
      expect(existsSync(marker), "the hostile database name reached the shell").toBe(false);
    },
  );

  test("the identifier screen refuses every shell-significant shape, naming the input", async () => {
    // The injection probe above pins one payload end to end; this pins the
    // screen's allow-list itself. A loosened identifier rule that admits a
    // different metacharacter class — command substitution, a backtick, a
    // newline that starts a second shell command, a quote that escapes a
    // value — stays green under that probe and red here. Each refusal must
    // be the screen's own: an error that does not name the input does not
    // identify the occurrence.
    const hostile = [
      "x`touch /tmp/opencode/bt-marker`",
      "x$(touch /tmp/opencode/cs-marker)",
      "x${JOBS_DB}",
      "x\nrm x",
      "x'; drop database helix_test",
      "x y",
      "x--flag",
      "x/slash",
      // The identifier-shape boundaries: nothing to apply a name to at all,
      // and a digit first — the screen is stricter than SQL's
      // quoted-identifier rules on purpose (fail closed).
      "",
      "9db",
    ];
    for (const name of hostile) {
      await expect(applyRolesProvisioning(name)).rejects.toThrow(
        `the jobs database name is not a bare lowercase identifier: ${name}`,
      );
    }
  });
});
