import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore, KeyVaultSecretStore } from "@azx-pbc/secret-store";
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
    const rows: Array<[string, string | null, string, Record<string, unknown>]> = [
      ["platform", null, "anthropic", { kind: "header", name: "x-api-key" }],
      ["app", appId, "stripe", { kind: "header-bearer" }],
      // An hmac-timestamp row whose stored recipe OMITS `authHeader`. That is the
      // regression guard for shipping this kind without a migration: the column is
      // schemaless JSON, so the safety argument rests entirely on the zod default
      // materialising on the read path for rows written before the field existed.
      [
        "app",
        appId,
        "signed",
        { kind: "hmac-timestamp", timestampHeader: "x-date", template: "Sig={signature}" },
      ],
    ];
    for (const [scope, owningApp, name, injection] of rows) {
      const id = randomUUID();
      ids.push(id);
      // An hmac recipe requires a credential blob; egress validates the pairing on
      // read, so the seeded material has to be well-formed for that row.
      const material = await store.seal(
        injection["kind"] === "hmac-timestamp"
          ? JSON.stringify({ credential: "pub-abc", key: `secret-for-${scope}-${name}` })
          : `secret-for-${scope}-${name}`,
      );
      await owner.query(
        `INSERT INTO app_secrets (id, scope, "appId", name, material, injection, "createdBy")
         VALUES ($1, $2, $3, $4, $5, $6, 'test')`,
        [id, scope, owningApp, name, material, JSON.stringify(injection)],
      );
    }
    // A dev-tier app secret sharing the 'stripe' connection name — env isolation
    // (dev-mode §6): a dev fetch must resolve THIS, and a prod fetch must never
    // see it. The per-env unique index allows the same (appId, name) in both tiers.
    const devId = randomUUID();
    ids.push(devId);
    await owner.query(
      `INSERT INTO app_secrets (id, scope, "appId", env, name, material, injection, "createdBy")
       VALUES ($1, 'app', $2, 'dev', 'stripe', $3, $4, 'test')`,
      [
        devId,
        appId,
        await store.seal("secret-for-app-stripe-DEV"),
        JSON.stringify({ kind: "header-bearer" }),
      ],
    );
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

describe("PgSecretResolver recipe round-trip", () => {
  /**
   * The no-migration safety argument, exercised against the real column under the
   * real `helix_egress` role: a row stored without `authHeader` (as every row
   * written before this kind existed would be) must come back with the zod default
   * applied, not fail to parse.
   */
  it("materialises the authHeader default for a row that omits it", async () => {
    if (!provisioned) return;
    const resolver = new PgSecretResolver(egressUrl(), store, { max: 1 });
    try {
      const resolved = await resolver.resolve(appId, "signed", "fetch", "prod");
      expect(resolved?.injection).toEqual({
        kind: "hmac-timestamp",
        timestampHeader: "x-date",
        authHeader: "authorization",
        template: "Sig={signature}",
      });
      // The blob comes back verbatim; egress parses it at injection time.
      expect(JSON.parse(resolved?.value ?? "{}")).toEqual({
        credential: "pub-abc",
        key: "secret-for-app-signed",
      });
    } finally {
      await resolver.close();
    }
  });
});

describe("PgSecretResolver capability gate", () => {
  it("resolves a platform secret for llm but never for fetch", async () => {
    if (!provisioned) return;
    const resolver = new PgSecretResolver(egressUrl(), store, { max: 1 });
    try {
      const viaLlm = await resolver.resolve(appId, "anthropic", "llm", "prod");
      expect(viaLlm?.value).toBe("secret-for-platform-anthropic");
      expect(viaLlm?.injection).toEqual({ kind: "header", name: "x-api-key", template: "{}" });

      // The platform key is unreachable on the fetch path, even by name.
      expect(await resolver.resolve(appId, "anthropic", "fetch", "prod")).toBeNull();
      // …and from a different app, too — platform is name-scoped, not app-scoped,
      // but still only via llm.
      expect(await resolver.resolve(otherAppId, "anthropic", "fetch", "prod")).toBeNull();
    } finally {
      await resolver.close();
    }
  });

  it("resolves an app secret for fetch but not via the llm (platform-only) path", async () => {
    if (!provisioned) return;
    const resolver = new PgSecretResolver(egressUrl(), store, { max: 1 });
    try {
      const viaFetch = await resolver.resolve(appId, "stripe", "fetch", "prod");
      expect(viaFetch?.value).toBe("secret-for-app-stripe");

      // llm only ever consults platform scope — an app secret named here is invisible.
      expect(await resolver.resolve(appId, "stripe", "llm", "prod")).toBeNull();
    } finally {
      await resolver.close();
    }
  });

  it("env-scopes connection secrets: a dev fetch and a prod fetch resolve different tiers", async () => {
    if (!provisioned) return;
    const resolver = new PgSecretResolver(egressUrl(), store, { max: 1 });
    try {
      // Same app + connection name, two tiers → two distinct secrets. If env were
      // ignored, both calls would return the same row; that they diverge proves
      // egress resolves the secret within the tier the attested instruction names
      // (dev-mode §6) — a dev fetch can never inject a prod credential, or vice-versa.
      expect((await resolver.resolve(appId, "stripe", "fetch", "prod"))?.value).toBe(
        "secret-for-app-stripe",
      );
      expect((await resolver.resolve(appId, "stripe", "fetch", "dev"))?.value).toBe(
        "secret-for-app-stripe-DEV",
      );
    } finally {
      await resolver.close();
    }
  });
});

/**
 * The custody seam across two processes, under Key Vault (ADR-0006).
 *
 * The one thing `SecretStore` exists to guarantee is that the `material` the
 * portal writes is byte-identical to what egress reads back — the two run in
 * different containers under different identities and never share memory. The
 * unit tests exercise one store instance; this exercises *two*, over one vault,
 * with the real `app_secrets` row and the real `helix_egress` role in between.
 * A dev-envelope store cannot catch a divergence here because both sides derive
 * the same key from the same file.
 */
describe("PgSecretResolver over Key Vault custody", () => {
  /** An in-memory vault shared by the two store instances, as Azure would be. */
  function sharedVault() {
    const values = new Map<string, string>(); // "name/version" → plaintext
    let n = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const [, name = "", version] = url.pathname.split("/").filter(Boolean);
      const method = init?.method ?? "GET";
      if (method === "PUT") {
        n += 1;
        const v = n.toString(16).padStart(32, "0");
        values.set(`${name}/${v}`, (JSON.parse(String(init?.body)) as { value: string }).value);
        return new Response(JSON.stringify({ id: `https://kv.example/secrets/${name}/${v}` }), {
          status: 200,
        });
      }
      const value = values.get(`${name}/${version ?? ""}`);
      if (value === undefined) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ value }), { status: 200 });
    };
    return { fetchImpl, values };
  }

  it("a secret sealed by the portal store opens in the egress store, through the DB", async () => {
    if (!provisioned) return;
    const vault = sharedVault();
    const opts = {
      vaultUrl: "https://kv.example",
      getToken: async () => "tok",
      fetchImpl: vault.fetchImpl,
    };
    // Two independent instances, as in production: the control plane seals, the
    // mechanism plane opens. Separate caches, no shared in-process state.
    //
    // What this proves is `material` **portability** — that a token written by one
    // process is readable by another with nothing but the vault between them, which the
    // dev envelope cannot demonstrate because both sides derive the same key from the
    // same file. What it explicitly does NOT prove is identity separation: both stores
    // share one stub `getToken` and the fake vault ignores the authorization header, so
    // a broken managed-identity selection, a missing RBAC assignment, or an accidental
    // edge grant would all pass here. Those need a post-deploy smoke test against the
    // three real managed identities.
    const portalSide = new KeyVaultSecretStore(opts);
    const egressSide = new KeyVaultSecretStore(opts);

    const id = randomUUID();
    ids.push(id);
    const material = await portalSide.seal("sk_live_crossseam");
    // The DB column holds a *reference*, not the credential: a stolen backup is
    // inert without the vault and an identity RBAC admits to it.
    expect(material).toMatch(/^kv:hx-[0-9a-f]{32}\/[0-9a-f]+$/);
    expect(material).not.toContain("sk_live_crossseam");

    const owner = new Pool({ connectionString: OWNER_URL, max: 1 });
    try {
      await owner.query(
        `INSERT INTO app_secrets (id, scope, "appId", name, material, injection, "createdBy")
         VALUES ($1, 'app', $2, 'kv-conn', $3, $4, 'test')`,
        [id, appId, material, JSON.stringify({ kind: "header-bearer" })],
      );
    } finally {
      await owner.end();
    }

    const resolver = new PgSecretResolver(egressUrl(), egressSide, { max: 1 });
    try {
      const resolved = await resolver.resolve(appId, "kv-conn", "fetch", "prod");
      expect(resolved?.value).toBe("sk_live_crossseam");
      expect(resolved?.injection).toEqual({ kind: "header-bearer" });
    } finally {
      await resolver.close();
    }
  });
});
