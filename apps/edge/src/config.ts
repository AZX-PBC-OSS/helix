import { z } from "zod";

/**
 * Edge configuration, resolved once at boot from the environment (project plan
 * §3: config selects implementations per environment). Everything the request
 * path needs is parsed and validated here so handlers never read process.env.
 */
export interface BlobConfig {
  accountName: string;
  /** Decoded shared key (the connection string carries it base64-encoded). */
  accountKey: Buffer;
  /** Blob endpoint origin + account path, no trailing slash. */
  endpoint: string;
  container: string;
}

export interface EdgeConfig {
  /** Apps are served on `<slug>.<baseDomain>` (architecture §4.1). */
  baseDomain: string;
  databaseUrl: string;
  blob: BlobConfig;
  /**
   * M2 dev-only bypass (project plan §4 M2): app content is only served when
   * this is set. M3 replaces the flag with real sessions; the default stays
   * fail-closed so a production edge without auth config serves nothing.
   */
  allowUnauthenticated: boolean;
  /** Full projection reload interval — the LISTEN/NOTIFY safety net. */
  reconcileIntervalMs: number;
}

const ConnectionStringSchema = z.object({
  accountName: z.string().min(1),
  accountKey: z.string().base64().min(1),
  blobEndpoint: z.url(),
});

/**
 * Parse an Azure storage connection string (`Key=Value;…`). Values may contain
 * `=` (the base64 account key does), so split each pair on the first `=` only.
 */
export function parseConnectionString(connectionString: string): {
  accountName: string;
  accountKey: Buffer;
  blobEndpoint: string;
} {
  const pairs = new Map<string, string>();
  for (const part of connectionString.split(";")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    pairs.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }

  const protocol = pairs.get("DefaultEndpointsProtocol") ?? "https";
  const suffix = pairs.get("EndpointSuffix") ?? "core.windows.net";
  const accountName = pairs.get("AccountName");
  const parsed = ConnectionStringSchema.parse({
    accountName,
    accountKey: pairs.get("AccountKey"),
    // An explicit BlobEndpoint (Azurite) wins; otherwise derive the Azure one.
    blobEndpoint:
      pairs.get("BlobEndpoint") ?? `${protocol}://${accountName ?? ""}.blob.${suffix}`,
  });

  return {
    accountName: parsed.accountName,
    accountKey: Buffer.from(parsed.accountKey, "base64"),
    blobEndpoint: parsed.blobEndpoint.replace(/\/+$/, ""),
  };
}

/** Load and validate the edge config from the environment; throws on gaps. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EdgeConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required (registry projection reads Postgres)");
  }
  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is required (asset serving reads Blob)");
  }
  const { accountName, accountKey, blobEndpoint } = parseConnectionString(connectionString);

  return {
    baseDomain: (env.EDGE_BASE_DOMAIN ?? "localtest.me").toLowerCase(),
    databaseUrl,
    blob: {
      accountName,
      accountKey,
      endpoint: blobEndpoint,
      container: env.BLOB_CONTAINER ?? "app-bundles",
    },
    allowUnauthenticated: env.EDGE_DEV_ALLOW_UNAUTHENTICATED === "true",
    reconcileIntervalMs: Number(env.EDGE_RECONCILE_INTERVAL_MS ?? 60_000),
  };
}
