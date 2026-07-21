import { z } from "zod";

import { DEFAULT_STATEMENT_TIMEOUT_MS } from "./db/pool.js";

/**
 * Edge configuration, resolved once at boot from the environment (project plan
 * §3: config selects implementations per environment). Everything the request
 * path needs is parsed and validated here so handlers never read process.env.
 */
/**
 * How the edge authenticates *itself* to Blob Storage. Two modes, and the
 * credential material lives inside the discriminant so it is *structurally*
 * impossible for the managed-identity path to carry an account key (issue #15):
 *
 * - `shared-key`: the hand-rolled SharedKey HMAC signer. Dev/Azurite only —
 *   Azurite has no AAD. Refused in production by {@link loadConfig}.
 * - `managed-identity`: an AAD bearer token fetched at runtime from the
 *   Container Apps identity endpoint (Storage Blob Data Reader). No standing
 *   credential on the most-exposed plane; the edge can only read.
 */
export type AzureBlobAuth =
  | {
      mode: "shared-key";
      accountName: string;
      /** Decoded shared key (the connection string carries it base64-encoded). */
      accountKey: Buffer;
    }
  | {
      mode: "managed-identity";
      /** User-assigned MI client_id (AZURE_CLIENT_ID) — disambiguates the token request. */
      clientId: string;
      /** Container Apps-injected token endpoint (IDENTITY_ENDPOINT). */
      identityEndpoint: string;
      /** Container Apps-injected shared header value (IDENTITY_HEADER). */
      identityHeader: string;
    };

export interface AzureBlobConfig {
  provider: "azure";
  /** Blob endpoint origin + account path, no trailing slash. */
  endpoint: string;
  container: string;
  auth: AzureBlobAuth;
}

/**
 * Discriminated union over blob storage providers. Azure-only in v0
 * (architecture §8 — providers stay behind internal seams): a new provider is
 * a new member here plus a {@link ../blob/client.js BlobReader} implementation
 * selected in `createBlobReader`; nothing downstream of the interface changes.
 */
export type BlobConfig = AzureBlobConfig;

/**
 * How the edge authenticates *itself* to the IdP's token endpoint (the
 * confidential code exchange). Entra offers two forms: a shared `secret`, or —
 * when a tenant policy blocks symmetric secrets — a `certificate`
 * (private_key_jwt). The portal/SPA/CLI are public clients and never need this.
 */
export type AuthClientCredential =
  | { kind: "secret"; clientSecret: string }
  | { kind: "certificate"; privateKeyPem: string; certificatePem: string };

/**
 * OIDC + session configuration for app-user auth (architecture §4.2,
 * Appendix A). Provider-generic on purpose: locally the issuer is
 * apps/dev-idp; the Entra swap is env-only.
 */
export interface AuthConfig {
  issuerUrl: string;
  clientId: string;
  /** Client authentication toward the IdP: shared secret or certificate. */
  credential: AuthClientCredential;
  /** ID-token claim carrying group ids (Entra and dev-idp: `groups`). */
  groupsClaim: string;
  scopes: string;
  /** Permit a plain-http issuer — local dev-idp only. */
  allowInsecureIdp: boolean;
  /** ≥32 bytes; HKDF-derived into the handoff + flow-cookie keys. */
  secret: Buffer;
  /** Hard session cap (Appendix A.4: hours, not weeks). */
  sessionTtlMs: number;
  /** Silent re-auth (prompt=none) due after this much of the session. */
  refreshAfterMs: number;
  handoffTtlSec: number;
  clockToleranceSec: number;
}

export interface EdgeConfig {
  /** Apps are served on `<slug>.<baseDomain>` (architecture §4.1). */
  baseDomain: string;
  databaseUrl: string;
  blob: BlobConfig;
  /**
   * Auth is fail-closed in two layers: with `auth: null` and the dev bypass
   * unset, app hosts serve nothing; the bypass itself is refused in
   * production builds.
   */
  auth: AuthConfig | null;
  /**
   * Dev-only bypass: serve app content without sessions. Pre-M3 meaning
   * ("serve at all") narrows to "skip the session gate" once auth lands.
   */
  allowUnauthenticated: boolean;
  /**
   * Scheme for externally built URLs (redirect targets, cookie origins). The
   * platform is **HTTPS-only** — always `https`. Dev terminates TLS at the
   * edge (mkcert); prod terminates at ingress and the edge speaks plain HTTP
   * behind it, but the *public* origin is https either way.
   */
  publicScheme: "https";
  /** Public port for built URLs; scheme-default ports are omitted. */
  publicPort: number;
  /**
   * Edge-terminated TLS (mkcert in dev). **Required outside production** — the
   * platform is HTTPS-only (`__Host-` cookies need Secure; app crypto APIs
   * like `crypto.randomUUID`/SubtleCrypto need a secure context). In
   * production this is null: ingress owns the cert and the edge runs plain
   * HTTP behind it.
   */
  tls: { certFile: string; keyFile: string } | null;
  /** Full projection reload interval — the LISTEN/NOTIFY safety net. */
  reconcileIntervalMs: number;
  /**
   * Per-query `statement_timeout` (ms) applied to every edge Postgres pool so a
   * slow/stuck query can't pin a pooled connection and exhaust the pool — a DoS
   * the exposed plane must resist (ADR-0002 ISSUE-05 / issue #12). `0` disables.
   */
  statementTimeoutMs: number;
  /**
   * LLM gateway vendor settings (architecture §6.1, M4). Always present with
   * defaults; whether the capability is *enabled* is gated separately by egress
   * being configured (`EDGE_EGRESS_URL` + `HELIX_INSTRUCTION_SECRET`) — the
   * vendor key is a `platform` secret egress resolves, never held by the edge
   * (ADR-0008). This block only names the vendor endpoint/version/connection.
   */
  llm: {
    /** Vendor origin (no path), e.g. `https://api.anthropic.com`. */
    endpoint: string;
    /** `anthropic-version` header value. */
    anthropicVersion: string;
    /**
     * Name of the `platform`-scoped secret holding the vendor key, resolved by
     * egress on the `llm` path. When set (with egress + instruction key), the LLM
     * call routes through egress and the edge never holds the key. The key value
     * lives in the secret store, never in edge config.
     */
    connection: string;
  };
  /**
   * Per-IP rate limit for the anonymous tier on `public` apps (app-data design
   * §7). Caps every anonymous `/_api/*` gateway call, keyed per IP+app within a
   * fixed window — the anonymous writer/visitor has no per-user budget to
   * charge, so this is the only per-source cap on an open public surface.
   * Authenticated callers are never limited here (they answer to per-app
   * budgets). `max: 0` disables the limiter.
   */
  anonRateLimit: { max: number; windowMs: number };
  /**
   * Fetch-proxy wiring (M4.5). The edge is the policy plane: it authorizes a
   * `/_api/fetch` call and hands a signed attested instruction to `azx-egress`.
   * The capability is enabled only when BOTH `egressUrl` and `instructionSecret`
   * are present — otherwise `/_api/fetch` 503s (fail-closed, like the LLM key).
   */
  fetch: {
    /** Internal URL of the egress service; null disables the capability. */
    egressUrl: string | null;
    /** Shared with azx-egress; HKDF-derived into the instruction signing key. */
    instructionSecret: Buffer | null;
    /** Edge-side timeout for the egress round-trip. */
    timeoutMs: number;
    /**
     * Per-direction body-size cap, enforced with a byte counter on the request
     * re-stream to egress and the response re-stream to the app (issue #8).
     * Mirrors egress's `EGRESS_MAX_BODY_BYTES` so both hops cap independently.
     */
    maxBodyBytes: number;
  };
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
    blobEndpoint: pairs.get("BlobEndpoint") ?? `${protocol}://${accountName ?? ""}.blob.${suffix}`,
  });

  return {
    accountName: parsed.accountName,
    accountKey: Buffer.from(parsed.accountKey, "base64"),
    blobEndpoint: parsed.blobEndpoint.replace(/\/+$/, ""),
  };
}

/**
 * Resolve the blob provider + auth from the environment (issue #15). Managed
 * identity is preferred; the SharedKey/account-key path is a dev/Azurite
 * fallback refused in production. See the {@link AzureBlobAuth} discriminant.
 */
export function loadBlobConfig(env: NodeJS.ProcessEnv): BlobConfig {
  const container = env.BLOB_CONTAINER ?? "app-bundles";
  const blobEndpoint = env.AZURE_STORAGE_BLOB_ENDPOINT;
  const clientId = env.AZURE_CLIENT_ID;
  const connectionString = env.AZURE_STORAGE_CONNECTION_STRING;
  const isProduction = env.NODE_ENV === "production";

  // Managed identity: present endpoint + client_id select it, and it wins over
  // any connection string so a stale account-key secret can't be a fallback.
  if (present(blobEndpoint) && present(clientId)) {
    const identityEndpoint = env.IDENTITY_ENDPOINT;
    const identityHeader = env.IDENTITY_HEADER;
    if (!present(identityEndpoint) || !present(identityHeader)) {
      throw new Error(
        "Managed-identity blob auth needs IDENTITY_ENDPOINT and IDENTITY_HEADER " +
          "(injected by Container Apps when the user-assigned identity is attached)",
      );
    }
    return {
      provider: "azure",
      endpoint: blobEndpoint.replace(/\/+$/, ""),
      container,
      auth: { mode: "managed-identity", clientId, identityEndpoint, identityHeader },
    };
  }

  // SharedKey (dev/Azurite): the full-RW account key must never be used in prod.
  if (present(connectionString)) {
    if (isProduction) {
      throw new Error(
        "SharedKey/account-key blob auth is refused in production; configure a " +
          "managed identity (AZURE_STORAGE_BLOB_ENDPOINT + AZURE_CLIENT_ID)",
      );
    }
    const {
      accountName,
      accountKey,
      blobEndpoint: endpoint,
    } = parseConnectionString(connectionString);
    return {
      provider: "azure",
      endpoint,
      container,
      auth: { mode: "shared-key", accountName, accountKey },
    };
  }

  throw new Error(
    "Blob auth requires AZURE_STORAGE_CONNECTION_STRING (dev/Azurite) or " +
      "AZURE_STORAGE_BLOB_ENDPOINT + AZURE_CLIENT_ID (managed identity)",
  );
}

const AuthEnvSchema = z.object({
  issuerUrl: z.url(),
  clientId: z.string().min(1),
  secret: z.base64().min(1),
});

const present = (v: string | undefined): v is string => v !== undefined && v !== "";

/**
 * Accept a PEM credential as raw PEM (`-----BEGIN…`) or, since env files dislike
 * multiline values, as base64-encoded PEM. Either way we hand PEM to the OIDC
 * client; a value that is neither is a config error.
 */
function decodePem(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-----BEGIN")) return trimmed;
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (!decoded.includes("-----BEGIN")) {
    throw new Error(`${name} must be PEM or base64-encoded PEM`);
  }
  return decoded;
}

/**
 * Pick the IdP client credential from the env: a shared secret, or a
 * certificate pair (private_key_jwt — for tenants whose policy blocks symmetric
 * secrets). Exactly one form must be supplied.
 */
function loadClientCredential(env: NodeJS.ProcessEnv): AuthClientCredential {
  const clientSecret = present(env.EDGE_OIDC_CLIENT_SECRET)
    ? env.EDGE_OIDC_CLIENT_SECRET
    : undefined;
  const privateKey = present(env.EDGE_OIDC_CLIENT_PRIVATE_KEY)
    ? env.EDGE_OIDC_CLIENT_PRIVATE_KEY
    : undefined;
  const certificate = present(env.EDGE_OIDC_CLIENT_CERTIFICATE)
    ? env.EDGE_OIDC_CLIENT_CERTIFICATE
    : undefined;

  const hasSecret = clientSecret !== undefined;
  const hasCert = privateKey !== undefined || certificate !== undefined;
  if (hasSecret && hasCert) {
    throw new Error(
      "Set either EDGE_OIDC_CLIENT_SECRET or the certificate pair " +
        "(EDGE_OIDC_CLIENT_PRIVATE_KEY + EDGE_OIDC_CLIENT_CERTIFICATE), not both",
    );
  }
  if (hasSecret) return { kind: "secret", clientSecret };
  if (hasCert) {
    if (privateKey === undefined || certificate === undefined) {
      throw new Error(
        "Certificate auth needs both EDGE_OIDC_CLIENT_PRIVATE_KEY and EDGE_OIDC_CLIENT_CERTIFICATE",
      );
    }
    return {
      kind: "certificate",
      privateKeyPem: decodePem(privateKey, "EDGE_OIDC_CLIENT_PRIVATE_KEY"),
      certificatePem: decodePem(certificate, "EDGE_OIDC_CLIENT_CERTIFICATE"),
    };
  }
  throw new Error(
    "Auth config needs a client credential: set EDGE_OIDC_CLIENT_SECRET, or " +
      "EDGE_OIDC_CLIENT_PRIVATE_KEY + EDGE_OIDC_CLIENT_CERTIFICATE (certificate auth)",
  );
}

/**
 * Parse the auth block. All-or-nothing: no auth env at all returns null (the
 * edge boots fail-closed and app hosts serve nothing without the dev bypass);
 * a partial block is a config error worth failing loudly on. The IdP client
 * credential is a shared secret or a certificate — see {@link loadClientCredential}.
 */
function loadAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  const base = [env.EDGE_OIDC_ISSUER, env.EDGE_OIDC_CLIENT_ID, env.EDGE_AUTH_SECRET].filter(
    present,
  );
  const anyCredential =
    present(env.EDGE_OIDC_CLIENT_SECRET) ||
    present(env.EDGE_OIDC_CLIENT_PRIVATE_KEY) ||
    present(env.EDGE_OIDC_CLIENT_CERTIFICATE);
  if (base.length === 0 && !anyCredential) return null;
  if (base.length < 3) {
    throw new Error(
      "Partial auth config: EDGE_OIDC_ISSUER, EDGE_OIDC_CLIENT_ID and " +
        "EDGE_AUTH_SECRET must all be set together",
    );
  }

  const credential = loadClientCredential(env);
  const parsed = AuthEnvSchema.parse({
    issuerUrl: env.EDGE_OIDC_ISSUER,
    clientId: env.EDGE_OIDC_CLIENT_ID,
    secret: env.EDGE_AUTH_SECRET,
  });
  const secret = Buffer.from(parsed.secret, "base64");
  if (secret.length < 32) {
    throw new Error("EDGE_AUTH_SECRET must decode to at least 32 bytes");
  }
  const allowInsecureIdp = env.EDGE_OIDC_ALLOW_INSECURE === "true";
  if (new URL(parsed.issuerUrl).protocol !== "https:" && !allowInsecureIdp) {
    throw new Error("EDGE_OIDC_ISSUER must be https (or set EDGE_OIDC_ALLOW_INSECURE=true in dev)");
  }

  return {
    issuerUrl: parsed.issuerUrl.replace(/\/+$/, ""),
    clientId: parsed.clientId,
    credential,
    groupsClaim: env.EDGE_OIDC_GROUPS_CLAIM ?? "groups",
    scopes: env.EDGE_OIDC_SCOPES ?? "openid profile email groups",
    allowInsecureIdp,
    secret,
    sessionTtlMs: Number(env.EDGE_SESSION_TTL_MS ?? 8 * 60 * 60 * 1000),
    refreshAfterMs: Number(env.EDGE_SESSION_REFRESH_MS ?? 60 * 60 * 1000),
    handoffTtlSec: 30,
    clockToleranceSec: 5,
  };
}

/** Load and validate the edge config from the environment; throws on gaps. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): EdgeConfig {
  // The edge connects as the least-privilege runtime role (app-data design
  // §2.1) — its grants are a tight union of the data-plane verbs, never the
  // owner. `EDGE_DATABASE_URL` (helix_edge) is required in production: the
  // `DATABASE_URL` fallback is the schema *owner*, which bypasses RLS even
  // under FORCE (a superuser/owner ignores row-level policies), silently
  // defeating the role split (ADR-0002). Outside production the owner-DSN
  // fallback stays as a convenience for setups without the role split, matching
  // the connection-string / dev-bypass prod-strict pattern elsewhere here.
  const databaseUrl = env.EDGE_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "EDGE_DATABASE_URL or DATABASE_URL is required (registry projection reads Postgres)",
    );
  }
  if (!env.EDGE_DATABASE_URL && env.NODE_ENV === "production") {
    throw new Error(
      "EDGE_DATABASE_URL (the least-privilege helix_edge role) is required in production; " +
        "refusing the DATABASE_URL fallback, which connects as the schema owner and bypasses " +
        "RLS, defeating the role split (ADR-0002).",
    );
  }
  // Azure is the only v0 provider. Two auth paths (issue #15):
  //   * managed-identity (prod): AZURE_STORAGE_BLOB_ENDPOINT + AZURE_CLIENT_ID,
  //     with the Container Apps-injected IDENTITY_ENDPOINT/IDENTITY_HEADER. The
  //     edge holds no standing Blob credential and can only read.
  //   * shared-key (dev/Azurite): AZURE_STORAGE_CONNECTION_STRING. Refused in
  //     production — the full-RW account key must never ride the exposed plane.
  // MI wins when both are set, so a prod image carrying a stale connection-string
  // secret can never silently fall back to the account key.
  const blob = loadBlobConfig(env);

  const allowUnauthenticated = env.EDGE_DEV_ALLOW_UNAUTHENTICATED === "true";
  if (allowUnauthenticated && env.NODE_ENV === "production") {
    throw new Error("EDGE_DEV_ALLOW_UNAUTHENTICATED is a dev bypass and is refused in production");
  }

  const certFile = env.EDGE_TLS_CERT_FILE;
  const keyFile = env.EDGE_TLS_KEY_FILE;
  if ((certFile && !keyFile) || (!certFile && keyFile)) {
    throw new Error("EDGE_TLS_CERT_FILE and EDGE_TLS_KEY_FILE must be set together");
  }
  const tls = certFile && keyFile ? { certFile, keyFile } : null;

  // HTTPS-only platform: outside production the edge must terminate TLS itself
  // (mkcert). `__Host-` cookies require Secure, and hosted apps' crypto APIs
  // (`crypto.randomUUID`, SubtleCrypto) only exist in a secure context — so a
  // plain-HTTP dev edge is never allowed. Production opts out only by being
  // production: ingress owns the cert and the edge runs HTTP behind it.
  if (!tls && env.NODE_ENV !== "production") {
    throw new Error(
      "TLS is required for local dev (the platform is HTTPS-only): set " +
        "EDGE_TLS_CERT_FILE and EDGE_TLS_KEY_FILE. Re-run .devcontainer/post-create.sh " +
        "to generate the mkcert certs for *.localtest.me.",
    );
  }

  return {
    baseDomain: (env.EDGE_BASE_DOMAIN ?? "localtest.me").toLowerCase(),
    databaseUrl,
    blob,
    auth: loadAuthConfig(env),
    allowUnauthenticated,
    publicScheme: "https",
    publicPort: Number(env.EDGE_PUBLIC_PORT ?? env.EDGE_PORT ?? env.PORT ?? 8080),
    tls,
    reconcileIntervalMs: Number(env.EDGE_RECONCILE_INTERVAL_MS ?? 60_000),
    statementTimeoutMs: Number(
      env.EDGE_STATEMENT_TIMEOUT_MS ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    ),
    llm: {
      endpoint: (env.EDGE_LLM_ENDPOINT ?? "https://api.anthropic.com").replace(/\/+$/, ""),
      anthropicVersion: env.EDGE_LLM_ANTHROPIC_VERSION ?? "2023-06-01",
      connection: env.EDGE_LLM_ANTHROPIC_CONNECTION ?? "anthropic",
    },
    anonRateLimit: {
      max: Number(env.EDGE_ANON_RATE_LIMIT ?? 60),
      windowMs: Number(env.EDGE_ANON_RATE_WINDOW_MS ?? 60_000),
    },
    fetch: {
      egressUrl: env.EDGE_EGRESS_URL || null,
      instructionSecret: loadInstructionSecret(env),
      timeoutMs: Number(env.EDGE_FETCH_TIMEOUT_MS ?? 30_000),
      maxBodyBytes: Number(env.EDGE_FETCH_MAX_BODY_BYTES ?? 10 * 1024 * 1024),
    },
  };
}

/** Parse the shared instruction secret; refuse a too-short one (would weaken the key). */
function loadInstructionSecret(env: NodeJS.ProcessEnv): Buffer | null {
  const raw = env.HELIX_INSTRUCTION_SECRET;
  if (!raw) return null;
  const buf = Buffer.from(raw);
  if (buf.byteLength < 32) {
    throw new Error("HELIX_INSTRUCTION_SECRET must be at least 32 bytes");
  }
  return buf;
}

/**
 * The externally visible origin for a given host label + base domain —
 * redirect targets and cookie URLs are always built from config, never from
 * request headers. Scheme-default ports are omitted.
 */
export function publicOrigin(config: EdgeConfig, hostLabelOrNull: string | null): string {
  const host = hostLabelOrNull ? `${hostLabelOrNull}.${config.baseDomain}` : config.baseDomain;
  // HTTPS-only: omit the port only when it is the https default (443).
  const port = config.publicPort === 443 ? "" : `:${config.publicPort}`;
  return `${config.publicScheme}://${host}${port}`;
}
