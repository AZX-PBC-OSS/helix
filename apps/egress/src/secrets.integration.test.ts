import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@helix/secret-store";
import { PgSecretResolver } from "./secrets.js";

/**
 * The capability gate on secret resolution (secrets design §4), asserted against
 * the real cluster. A `platform` secret (the LLM vendor key) is reachable ONLY by
 * an `llm` instruction — never by a `fetch` instruction naming the same
 * connection, which is the control that stops an app from injecting the platform
 * key via a manifest fetch binding. `app`/`global` resolution is unchanged for
 * `fetch` and invisible to `llm`.
 *
 * Inserts run as the owner (the portal's job); resolution runs through
 * `PgSecretResolver` under the `helix_egress` role. Skips when the role isn't
 * provisioned (CI without db-init) — same fail-soft stance as role-split.
 */

const OWNER_URL = process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";
function egressUrl(): string {
  const u = new URL(OWNER_URL);
  u.username = "helix_egress";
  u.password = "helix_egress";
  return u.toString();
}

const store = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });
const appId = randomUUID();
const otherAppId = randomUUID();
const ids: string[] = [];

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

async function seed(): Promise<void> {
  const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    // The app-scoped secret needs a real owning app (FK on app_secrets.appId).
    await owner.query(
      `INSERT INTO apps (id, slug, "displayName", "visibilityMode", "updatedAt")
       VALUES ($1, $2, 'Egress Resolver Test', 'private', now())`,
      [appId, `egress-res-${appId.slice(0, 8)}`],
    );
    const rows: Array<[string, string | null, string, { kind: string; name?: string }]> = [
      ["platform", null, "anthropic", { kind: "header", name: "x-api-key" }],
      ["app", appId, "stripe", { kind: "header-bearer" }],
    ];
    for (const [scope, owningApp, name, injection] of rows) {
      const id = randomUUID();
      ids.push(id);
      const material = await store.seal(`secret-for-${scope}-${name}`);
      await owner.query(
        `INSERT INTO app_secrets (id, scope, "appId", name, material, injection, "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, 'test')`,
        [id, scope, owningApp, name, material, JSON.stringify(injection)],
      );
    }
  } finally {
    await owner.end();
  }
}

async function cleanup(): Promise<void> {
  if (ids.length === 0) return;
  const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    await owner.query(`DELETE FROM app_secrets WHERE id = ANY($1::uuid[])`, [ids]);
    await owner.query(`DELETE FROM apps WHERE id = $1`, [appId]);
  } finally {
    await owner.end();
  }
}

let provisioned = false;
beforeAll(async () => {
  provisioned = await available();
  if (provisioned) await seed();
});
afterAll(async () => {
  if (provisioned) await cleanup();
});

describe("PgSecretResolver capability gate", () => {
  it("resolves a platform secret for llm but never for fetch", async () => {
    if (!provisioned) return;
    const resolver = new PgSecretResolver(egressUrl(), store, { max: 1 });
    try {
      const viaLlm = await resolver.resolve(appId, "anthropic", "llm");
      expect(viaLlm?.value).toBe("secret-for-platform-anthropic");
      expect(viaLlm?.injection).toEqual({ kind: "header", name: "x-api-key", template: "{}" });

      // The platform key is unreachable on the fetch path, even by name.
      expect(await resolver.resolve(appId, "anthropic", "fetch")).toBeNull();
      // …and from a different app, too — platform is name-scoped, not app-scoped,
      // but still only via llm.
      expect(await resolver.resolve(otherAppId, "anthropic", "fetch")).toBeNull();
    } finally {
      await resolver.close();
    }
  });

  it("resolves an app secret for fetch but not via the llm (platform-only) path", async () => {
    if (!provisioned) return;
    const resolver = new PgSecretResolver(egressUrl(), store, { max: 1 });
    try {
      const viaFetch = await resolver.resolve(appId, "stripe", "fetch");
      expect(viaFetch?.value).toBe("secret-for-app-stripe");

      // llm only ever consults platform scope — an app secret named here is invisible.
      expect(await resolver.resolve(appId, "stripe", "llm")).toBeNull();
    } finally {
      await resolver.close();
    }
  });
});
