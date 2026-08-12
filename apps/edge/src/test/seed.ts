import { randomUUID } from "node:crypto";
import { Pool as PgPool } from "pg";
import { Pool as UndiciPool } from "undici";
import { parseConnectionString, type AzureBlobConfig } from "../config.js";
import { signRequest } from "../blob/signing.js";

/**
 * Integration-test seeding against the dev container's real services: raw SQL
 * into the test database (deliberately NOT importing portal code — packages
 * stay decoupled; these inserts mirror what the portal writes) and signed PUTs
 * into Azurite (which double as an end-to-end proof of the SharedKey signer).
 */

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";

const TEST_CONTAINER = "app-bundles-test";

export function testBlobConfig(): AzureBlobConfig {
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!cs) throw new Error("AZURE_STORAGE_CONNECTION_STRING is required for integration tests");
  const { accountName, accountKey, blobEndpoint } = parseConnectionString(cs);
  return {
    provider: "azure",
    endpoint: blobEndpoint,
    container: TEST_CONTAINER,
    // The seeder writes to Azurite, which has no AAD — SharedKey only.
    auth: { mode: "shared-key", accountName, accountKey },
  };
}

/** A unique, valid DNS-label slug per call (parallel-safe across test files). */
export function uniqueSlug(prefix = "e"): string {
  return `${prefix}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export interface SeededApp {
  appId: string;
  slug: string;
  versionId: string;
  blobPrefix: string;
}

/**
 * Insert an app with one version into the test DB. `live: true` points the
 * app's currentVersionId at it (the M1 promote shape).
 */
export async function seedApp(
  pool: PgPool,
  opts: {
    slug?: string;
    live?: boolean;
    archived?: boolean;
    visibilityMode?: "internal" | "group" | "password" | "public";
    visibilityGroupId?: string;
  } = {},
): Promise<SeededApp> {
  const appId = randomUUID();
  const versionId = randomUUID();
  const slug = opts.slug ?? uniqueSlug();
  const blobPrefix = `apps/${appId}/1/`;

  await pool.query(
    `INSERT INTO apps (id, slug, "displayName", "visibilityMode", "visibilityGroupId", "archivedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $2, $3::"VisibilityMode", $4, $5, now(), now())`,
    [
      appId,
      slug,
      opts.visibilityMode ?? "internal",
      opts.visibilityGroupId ?? null,
      opts.archived ? new Date() : null,
    ],
  );
  await pool.query(
    `INSERT INTO versions (id, "appId", number, "blobPrefix", status, "createdAt")
     VALUES ($1, $2, 1, $3, $4, now())`,
    [versionId, appId, blobPrefix, opts.live ? "live" : "preview"],
  );
  if (opts.live) {
    await pool.query(`UPDATE apps SET "currentVersionId" = $1 WHERE id = $2`, [versionId, appId]);
  }
  return { appId, slug, versionId, blobPrefix };
}

export async function deleteApp(pool: PgPool, appId: string): Promise<void> {
  await pool.query(`DELETE FROM apps WHERE id = $1`, [appId]); // versions cascade
}

/**
 * Insert an already-redeemed session row (the post-handoff state), returning
 * the cookie token. Mirrors what /_auth/complete writes; integration tests
 * use it to start from "logged in" without driving the IdP.
 */
export async function seedSession(
  pool: PgPool,
  opts: {
    appId: string;
    tokenHash: string;
    userOid?: string;
    displayName?: string;
    groups?: string[];
    /** Offsets from now, in ms. */
    refreshDueInMs?: number;
    expiresInMs?: number;
  },
): Promise<{ sessionId: string }> {
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO sessions (id, "tokenHash", "appId", "userOid", "displayName", groups,
                           "activatedAt", "refreshDueAt", "expiresAt")
     VALUES ($1, $2, $3, $4, $5, $6, now(),
             now() + make_interval(secs => $7), now() + make_interval(secs => $8))`,
    [
      sessionId,
      opts.tokenHash,
      opts.appId,
      opts.userOid ?? "user-oid-1",
      opts.displayName ?? "Test User",
      JSON.stringify(opts.groups ?? []),
      (opts.refreshDueInMs ?? 60 * 60 * 1000) / 1000,
      (opts.expiresInMs ?? 8 * 60 * 60 * 1000) / 1000,
    ],
  );
  return { sessionId };
}

/** Signed PUTs into Azurite for seeding (and proving the signer end to end). */
export class TestBlobWriter {
  #config: AzureBlobConfig;
  #pool: UndiciPool;
  #basePath: string;
  #containerReady: Promise<void> | null = null;

  #accountName: string;
  #accountKey: Buffer;

  constructor(config: AzureBlobConfig = testBlobConfig()) {
    if (config.auth.mode !== "shared-key") {
      throw new Error(
        "TestBlobWriter seeds Azurite over SharedKey; managed-identity is not supported",
      );
    }
    this.#config = config;
    this.#accountName = config.auth.accountName;
    this.#accountKey = config.auth.accountKey;
    const endpoint = new URL(config.endpoint);
    this.#pool = new UndiciPool(endpoint.origin);
    this.#basePath = endpoint.pathname.replace(/\/+$/, "");
  }

  async #request(
    method: "PUT",
    path: string,
    query: string,
    body: Buffer | null,
    headers?: { contentType?: string; extraXms?: Record<string, string> },
  ): Promise<number> {
    const url = new URL(`${path}${query}`, this.#config.endpoint);
    const signed = signRequest({
      method,
      url,
      accountName: this.#accountName,
      accountKey: this.#accountKey,
      headers: {
        contentLength: body && body.length > 0 ? String(body.length) : undefined,
        contentType: headers?.contentType,
        extraXms: headers?.extraXms,
      },
    });
    const res = await this.#pool.request({
      method,
      path: `${path}${query}`,
      headers: signed,
      body: body ?? undefined,
    });
    await res.body.dump();
    return res.statusCode;
  }

  async #ensureContainer(): Promise<void> {
    this.#containerReady ??= (async () => {
      const status = await this.#request(
        "PUT",
        `${this.#basePath}/${this.#config.container}`,
        "?restype=container",
        null,
      );
      if (status !== 201 && status !== 409) {
        throw new Error(`could not create test container (HTTP ${status})`);
      }
    })();
    await this.#containerReady;
  }

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    await this.#ensureContainer();
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const encodedKey = key.split("/").map(encodeURIComponent).join("/");
    const status = await this.#request(
      "PUT",
      `${this.#basePath}/${this.#config.container}/${encodedKey}`,
      "",
      buf,
      { contentType, extraXms: { "x-ms-blob-type": "BlockBlob" } },
    );
    if (status !== 201) {
      throw new Error(`blob seed PUT failed for ${key} (HTTP ${status})`);
    }
  }

  async close(): Promise<void> {
    await this.#pool.close();
  }
}
