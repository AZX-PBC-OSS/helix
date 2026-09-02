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

/**
 * Config shared by the two processes that run the gateway machinery — the edge
 * and the dev-gateway. These are the only fields the reusable `/_api/*`
 * handlers, the registry projection, and CORS/TLS setup read. Everything a
 * *data plane* needs beyond this (a database role, blob custody, sessions) is
 * added by the per-process config that extends this base. Splitting it this way
 * is what lets {@link DevGatewayConfig} *structurally omit* `databaseUrl`/`blob`:
 * the dev-gateway process cannot even name the `helix_edge` pool or the blob
 * account, so the isolation thesis (dev-mode design §5.3) is a type property,
 * not a wiring convention.
 */
export interface GatewayConfig {
  /** Apps are served on `<slug>.<baseDomain>` (architecture §4.1). */
  baseDomain: string;
  /**
   * Edge-terminated TLS (mkcert in dev). **Required outside production** — the
   * platform is HTTPS-only (`__Host-` cookies need Secure; app crypto APIs
   * like `crypto.randomUUID`/SubtleCrypto need a secure context). In
   * production this is null: ingress owns the cert and the process runs plain
   * HTTP behind it.
   */
  tls: { certFile: string; keyFile: string } | null;
  /** Full projection reload interval — the LISTEN/NOTIFY safety net. */
  reconcileIntervalMs: number;
  /**
   * Per-query `statement_timeout` (ms) applied to every Postgres pool so a
   * slow/stuck query can't pin a pooled connection and exhaust the pool — a DoS
   * the exposed plane must resist (ADR-0002 ISSUE-05 / issue #12). `0` disables.
   */
  statementTimeoutMs: number;
  /**
   * Fastify `trustProxy` — how `req.ip` is derived behind a proxy, which is the
   * rate-limit / login-throttle key. Default `false` (the socket peer). Behind
   * Container Apps' Envoy ingress that peer is the ingress, collapsing all
   * clients into one bucket, so per-client limits need EDGE_TRUST_PROXY set to
   * the **address** of the trusted ingress: a CIDR/IP list (the ACA
   * infrastructure subnet — `infra/azure` passes `appsSubnetPrefix`), one of
   * proxy-addr's presets (`loopback`/`linklocal`/`uniquelocal`), or
   * `"true"`/`"false"`. A hop **count** is no longer accepted — see
   * {@link parseTrustProxy}. A too-trusting value makes X-Forwarded-For
   * spoofable, so it is opt-in — verify the value against the live ingress
   * before relying on per-client limits (issue #13). The dev-gateway inherits
   * this residual (dev-mode design §5.4).
   */
  trustProxy: boolean | string;
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
    /**
     * OpenAI-compatible upstream for the `gpt-*`/`o*` model families (M4.5+). An
     * **OpenAI-compatible base URL**: `https://api.openai.com` for OpenAI direct
     * today, a Warden URL later — same code path. Symmetric with Anthropic above:
     * always named (defaults `connection` `openai`, `endpoint` api.openai.com) and
     * wired whenever egress is up. Enabling it is just seeding that `platform`
     * secret — no dedicated toggle. Absent the secret, a `gpt-*` call 502s at
     * egress, exactly as an unseeded Anthropic key would.
     */
    openai: {
      /** OpenAI-compatible origin (no path), e.g. `https://api.openai.com`. */
      endpoint: string;
      /** Name of the `platform`-scoped secret holding the OpenAI key. */
      connection: string;
    };
  };
  /**
   * Fetch-proxy wiring (M4.5). The policy plane authorizes a `/_api/fetch` call
   * and hands a signed attested instruction to `helix-egress`. The capability is
   * enabled only when BOTH `egressUrl` and `instructionSecret` are present —
   * otherwise `/_api/fetch` 503s (fail-closed, like the LLM key).
   */
  fetch: {
    /** Internal URL of the egress service; null disables the capability. */
    egressUrl: string | null;
    /** Shared with helix-egress; HKDF-derived into the instruction signing key. */
    instructionSecret: Buffer | null;
    /** Timeout for the egress round-trip. */
    timeoutMs: number;
    /**
     * Per-direction body-size cap, enforced with a byte counter on the request
     * re-stream to egress and the response re-stream to the app (issue #8).
     * Mirrors egress's `EGRESS_MAX_BODY_BYTES` so both hops cap independently.
     */
    maxBodyBytes: number;
  };
}

/**
 * Edge (data/policy plane) config: the gateway base plus everything the edge
 * uniquely needs — its least-privilege database role, blob custody, app-user
 * sessions, and the open-surface toggles. Resolved by {@link loadConfig}.
 */
export interface EdgeConfig extends GatewayConfig {
  /** helix_edge DSN — the registry projection + gateway stores connect on it. */
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
   * Whether this deployment permits `public` (anonymous, no-gate) apps. When
   * false, the edge refuses to serve a public app — assets 403, `/_api/*`
   * refuses the anonymous caller — even one already set that way; the owner
   * migrates it down to internal/group in the portal to restore service. The
   * flag polarity is "allow", defaulting off: a deployment must set
   * `EDGE_ALLOW_PUBLIC_APPS=true` to opt this surface in (the parse below is
   * `=== "true"`).
   */
  allowPublicApps: boolean;
  /**
   * Whether this deployment permits `password` (shared-passphrase) apps — the
   * other open surface. When false, the edge refuses to serve a password app
   * (assets 403, `/_api/*` and the `/_auth/login` challenge both dead). Same
   * "allow"/default-off polarity as {@link allowPublicApps}.
   */
  allowPasswordApps: boolean;
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
   * Per-IP rate limit for the anonymous tier on `public` apps (app-data design
   * §7). Caps every anonymous `/_api/*` gateway call, keyed per IP+app within a
   * fixed window — the anonymous writer/visitor has no per-user budget to
   * charge, so this is the only per-source cap on an open public surface.
   * Authenticated callers are never limited here (they answer to per-app
   * budgets). `max: 0` disables the limiter.
   */
  anonRateLimit: { max: number; windowMs: number };
}

/**
 * Dev-gateway config (dev-mode design §3, §5.4): the gateway base plus the
 * `helix_dev` DSN it runs on. It deliberately has NO `databaseUrl`/`blob`/`auth`
 * — the dev-gateway never opens the `helix_edge` pool, reads a blob, or runs the
 * session path, and the type makes that *unrepresentable* rather than merely
 * unused. Resolved by {@link loadDevGatewayConfig}, which requires
 * `EDGE_DEV_DATABASE_URL` and refuses any owner-DSN fallback.
 */
export interface DevGatewayConfig extends GatewayConfig {
  devGateway: {
    /** helix_dev DSN — required (no fallback); the env-literal RLS holds only as helix_dev. */
    databaseUrl: string;
    /** Per-plane opt-in (EDGE_ALLOW_DEV_MODE); the dev-gateway refuses to serve unless true. */
    allowDevMode: boolean;
    /** Port the dev-gateway listens on (its own process). */
    port: number;
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
    // The default is DEV-IDP SHAPED, deliberately: apps/dev-idp serves `groups` as a
    // real scope (see its ALL_SCOPES) and that is how group visibility is exercised
    // locally and in CI, neither of which sets this var. Entra has no `groups`
    // delegated permission — it emits group claims from the app registration — so an
    // Entra install MUST override this to "openid profile email". infra/azure hardcodes
    // that, so the mismatch only reaches a deployment that skips the template.
    scopes: env.EDGE_OIDC_SCOPES ?? "openid profile email groups",
    allowInsecureIdp,
    secret,
    sessionTtlMs: Number(env.EDGE_SESSION_TTL_MS ?? 8 * 60 * 60 * 1000),
    refreshAfterMs: Number(env.EDGE_SESSION_REFRESH_MS ?? 60 * 60 * 1000),
    handoffTtlSec: 30,
    clockToleranceSec: 5,
  };
}

/**
 * Parse EDGE_TRUST_PROXY into a Fastify `trustProxy` value. Unset/empty →
 * `false` (trust nothing — the socket peer is the client). `"true"`/`"false"` →
 * boolean; anything else → passed through verbatim (Fastify accepts a
 * comma-separated IP/CIDR allowlist plus the presets `loopback`, `linklocal`
 * and `uniquelocal`).
 *
 * A bare integer is **rejected**, with one exception below. It used to mean
 * "trust this many proxy hops", but that form trusts by position and so
 * structurally ignores the address it is handed — which is precisely
 * GHSA-3m5p-2c4r-xxw2: anyone who reached the origin directly is "hop 0" and
 * gets believed, making X-Forwarded-* spoofable. Fastify 5.12.1 removed it,
 * compiling a number to a predicate that trusts nothing, and dropped `number`
 * from the option's type.
 *
 * The exception is `0`, which is read as `false`. It was never a trust
 * decision: Fastify branches on `if (trustProxy)`, so a numeric `0` was falsy
 * and behaved exactly like unset. Rejecting it would turn a safe no-op into a
 * boot failure for no security gain — see the note on the check itself.
 *
 * We throw rather than coerce because every symptom of the silent form is a
 * quiet one: `req.ip` collapses to the ingress address, and with it the anon
 * rate limiter (`gateway/ipRateLimiter.ts`), the shared-password login throttle
 * (`auth/routes/passwordLogin.ts`) and the collection audit hash
 * (`gateway/data-handler.ts`) all degrade to a single bucket per app while
 * still reading green — the failure mode issue #13 exists to prevent. Naming
 * the trusted address instead validates the immediate peer, which is strictly
 * stronger than the hop count it replaces, and yields the same `req.ip` behind
 * a single ingress hop.
 *
 * `"auto"` is rejected too. It is the `infra/azure` `edgeTrustProxy` sentinel,
 * resolved to the ACA infrastructure subnet by the template — reaching the
 * container it means the deployment did not resolve it, and Fastify would fail
 * on it later and less legibly (proxy-addr rejects it as an IP address).
 */
function parseTrustProxy(raw: string | undefined): boolean | string {
  if (!raw) return false;
  const v = raw.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^\d+$/.test(v)) {
    // `0` is the one count that never claimed any trust: Fastify's
    // `buildRequest` branches on `if (trustProxy)`, so a numeric 0 was falsy and
    // resolved `req.ip` from the socket peer, exactly like unset. Throwing on it
    // would buy nothing and cost an outage — a deployment whose pipeline still
    // exports it gets a container that will not boot, and under Container Apps'
    // `activeRevisionsMode: 'Single'` that surfaces as a rollout which silently
    // never takes. `infra/azure` catches a stale count before the container, but
    // a customer-run install applies its own IaC (ADR-0028) and never sees that
    // guard. So keep `0` meaning what it has always meant; only a count of 1 or
    // more ever asserted trust, and that is the form worth refusing.
    if (Number(v) === 0) return false;
    throw new Error(
      `EDGE_TRUST_PROXY no longer accepts a proxy hop count (got ${JSON.stringify(v)}). ` +
        `Name the trusted proxy's address instead: a CIDR/IP list such as the ACA ` +
        `infrastructure subnet ("10.0.2.0/23"), or a proxy-addr preset such as "uniquelocal". ` +
        `In infra/azure this is the edgeTrustProxy param (HELIX_EDGE_TRUST_PROXY), which ` +
        `rejects a hop count at deploy time — unset it to trust the ACA subnet.`,
    );
  }
  if (v === "auto") {
    throw new Error(
      `EDGE_TRUST_PROXY does not accept "auto" — that is the infra/azure edgeTrustProxy ` +
        `sentinel, which main.bicep resolves to the ACA infrastructure subnet before it ` +
        `reaches the container. Pass the resolved CIDR, or leave EDGE_TRUST_PROXY unset to ` +
        `trust nothing (the socket peer is the client).`,
    );
  }
  return v;
}

/**
 * Parse a millisecond duration that must be a positive, finite number, throwing
 * rather than letting a typo through.
 *
 * A bare `Number()` here is not harmless: `Number("abc")` is `NaN`, and every
 * comparison against `NaN` is false, so a mistyped value silently disables
 * whatever the duration gates. For the reconcile interval specifically, `NaN`
 * reaches `setTimeout`, which coerces it to ~0 ms — a DB hot loop from every
 * replica, with `/health` reading green throughout because the loads keep
 * succeeding. Note `??` only catches `undefined`/`null`, so an empty-string env
 * var (`Number("") === 0`) needs the same guard.
 */
function requirePositiveMs(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive number of milliseconds (got ${JSON.stringify(raw)})`,
    );
  }
  return value;
}

/**
 * Parse the config the gateway machinery shares across the edge and the
 * dev-gateway (see {@link GatewayConfig}). Neither the helix_edge DSN nor blob
 * custody appears here — those are edge-only and live in {@link loadConfig} — so
 * the dev-gateway loader can reuse this without being forced to supply env it
 * never uses. The HTTPS-only TLS rule applies to both processes (both terminate
 * TLS in dev, both run HTTP behind ingress in prod).
 */
function loadGatewayConfig(env: NodeJS.ProcessEnv): GatewayConfig {
  const certFile = env.EDGE_TLS_CERT_FILE;
  const keyFile = env.EDGE_TLS_KEY_FILE;
  if ((certFile && !keyFile) || (!certFile && keyFile)) {
    throw new Error("EDGE_TLS_CERT_FILE and EDGE_TLS_KEY_FILE must be set together");
  }
  const tls = certFile && keyFile ? { certFile, keyFile } : null;

  // HTTPS-only platform: outside production the process must terminate TLS
  // itself (mkcert). `__Host-` cookies require Secure, and hosted apps' crypto
  // APIs (`crypto.randomUUID`, SubtleCrypto) only exist in a secure context — so
  // a plain-HTTP dev process is never allowed. Production opts out only by being
  // production: ingress owns the cert and the process runs HTTP behind it.
  if (!tls && env.NODE_ENV !== "production") {
    throw new Error(
      "TLS is required for local dev (the platform is HTTPS-only): set " +
        "EDGE_TLS_CERT_FILE and EDGE_TLS_KEY_FILE. Re-run .devcontainer/post-create.sh " +
        "to generate the mkcert certs for *.local.helix.azxlabs.io.",
    );
  }

  return {
    baseDomain: (env.EDGE_BASE_DOMAIN ?? "local.helix.azxlabs.io").toLowerCase(),
    tls,
    reconcileIntervalMs: requirePositiveMs(
      env.EDGE_RECONCILE_INTERVAL_MS,
      60_000,
      "EDGE_RECONCILE_INTERVAL_MS",
    ),
    statementTimeoutMs: Number(env.EDGE_STATEMENT_TIMEOUT_MS ?? DEFAULT_STATEMENT_TIMEOUT_MS),
    trustProxy: parseTrustProxy(env.EDGE_TRUST_PROXY),
    llm: {
      endpoint: (env.EDGE_LLM_ENDPOINT ?? "https://api.anthropic.com").replace(/\/+$/, ""),
      anthropicVersion: env.EDGE_LLM_ANTHROPIC_VERSION ?? "2023-06-01",
      connection: env.EDGE_LLM_ANTHROPIC_CONNECTION ?? "anthropic",
      openai: {
        endpoint: (env.EDGE_LLM_OPENAI_ENDPOINT ?? "https://api.openai.com").replace(/\/+$/, ""),
        connection: env.EDGE_LLM_OPENAI_CONNECTION ?? "openai",
      },
    },
    fetch: {
      egressUrl: env.EDGE_EGRESS_URL || null,
      instructionSecret: loadInstructionSecret(env),
      timeoutMs: Number(env.EDGE_FETCH_TIMEOUT_MS ?? 30_000),
      maxBodyBytes: Number(env.EDGE_FETCH_MAX_BODY_BYTES ?? 10 * 1024 * 1024),
    },
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

  return {
    ...loadGatewayConfig(env),
    databaseUrl,
    blob,
    auth: loadAuthConfig(env),
    allowUnauthenticated,
    // "Allow" polarity, default off: a mode is permitted only when explicitly
    // set to "true". This is the opt-in platform default (see the field docs on
    // EdgeConfig); a deployment opts a surface back in per environment.
    allowPublicApps: env.EDGE_ALLOW_PUBLIC_APPS === "true",
    allowPasswordApps: env.EDGE_ALLOW_PASSWORD_APPS === "true",
    publicScheme: "https",
    publicPort: Number(env.EDGE_PUBLIC_PORT ?? env.EDGE_PORT ?? env.PORT ?? 8080),
    anonRateLimit: {
      max: Number(env.EDGE_ANON_RATE_LIMIT ?? 60),
      windowMs: Number(env.EDGE_ANON_RATE_WINDOW_MS ?? 60_000),
    },
  };
}

/**
 * Load and validate the dev-gateway config (dev-mode design §3, §5.4). Unlike
 * {@link loadConfig} it reads NO edge-only env: no `EDGE_DATABASE_URL`, no blob
 * config, no auth. The one DSN it needs — `EDGE_DEV_DATABASE_URL` (the helix_dev
 * role) — is **required, with no owner-DSN fallback**: the env-literal RLS that
 * pins the dev tier to `env='dev'` only holds when the process actually connects
 * as `helix_dev` (dev-mode §5.3), so an owner fallback would silently defeat the
 * whole isolation. The returned {@link DevGatewayConfig} structurally lacks the
 * helix_edge DSN and blob custody, so the process can't hold either.
 */
export function loadDevGatewayConfig(env: NodeJS.ProcessEnv = process.env): DevGatewayConfig {
  const databaseUrl = env.EDGE_DEV_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "EDGE_DEV_DATABASE_URL (the least-privilege helix_dev role DSN) is required to run the " +
        "dev-gateway. There is deliberately no DATABASE_URL/owner fallback — the env-literal RLS " +
        "isolating the dev tier only holds when the process connects as helix_dev (dev-mode §5.3).",
    );
  }
  return {
    ...loadGatewayConfig(env),
    devGateway: {
      databaseUrl,
      allowDevMode: env.EDGE_ALLOW_DEV_MODE === "true",
      port: Number(env.EDGE_DEV_GATEWAY_PORT ?? 8082),
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
