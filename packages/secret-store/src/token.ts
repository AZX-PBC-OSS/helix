/**
 * Acquire Key Vault tokens through the Container Apps managed-identity endpoint
 * (ADR-0006). Use global fetch and AbortSignal to keep this package free of runtime
 * dependencies for egress. The transport mirrors apps/edge/src/blob/token.ts
 * with a Key Vault audience instead of Storage.
 *
 * The portal supplies DefaultAzureCredential through GetVaultToken, supporting
 * both managed identity and operator az login credentials.
 */

/** AAD resource/audience for Azure Key Vault. No trailing slash, unlike Storage. */
const VAULT_RESOURCE = "https://vault.azure.net";
/** App Service / Container Apps managed-identity token endpoint api-version. */
const DEFAULT_API_VERSION = "2019-08-01";
/** Refresh this long before hard expiry to absorb clock drift / propagation. */
const DEFAULT_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The credential seam: anything that can produce a bearer token for the Key Vault
 * data plane. Keeps `KeyVaultSecretStore` free of any opinion about *how* the
 * process authenticates (managed identity, `az login`, a test stub).
 */
export type GetVaultToken = () => Promise<string>;

export interface TokenProvider {
  /** A currently-valid bearer token, fetched or served from cache. */
  getToken(): Promise<string>;
  close(): Promise<void>;
}

/** Result of a raw token-endpoint fetch — the injectable seam's contract. */
export interface TokenFetchResult {
  status: number;
  body: string;
}

/** Injectable transport for tests (no network). Defaults to global `fetch`. */
export type FetchToken = (
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
) => Promise<TokenFetchResult>;

export interface ManagedIdentityTokenProviderOptions {
  identityEndpoint: string;
  identityHeader: string;
  /** User-assigned MI client_id — required to disambiguate the identity. */
  clientId: string;
  resource?: string;
  apiVersion?: string;
  skewMs?: number;
  timeoutMs?: number;
  /** Injectable clock (house convention, e.g. loginThrottle). */
  now?: () => number;
  /** Injectable transport for tests. */
  fetchToken?: FetchToken;
}

export class TokenError extends Error {}

/**
 * Parse the managed-identity token response. `expires_on` is epoch **seconds**
 * in the App Service / Container Apps shape and may arrive as a numeric string.
 */
function parseExpiresOn(value: unknown): number {
  const seconds = typeof value === "string" ? Number(value) : value;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) {
    throw new TokenError(`managed-identity token response has invalid expires_on: ${value}`);
  }
  return seconds * 1000;
}

export class ManagedIdentityTokenProvider implements TokenProvider {
  readonly #url: string;
  readonly #header: string;
  readonly #skewMs: number;
  readonly #timeoutMs: number;
  readonly #now: () => number;
  readonly #fetchToken: FetchToken;

  #cached: { token: string; expiresAtMs: number } | null = null;
  /** Single-flight: concurrent refreshes await one fetch. */
  #inFlight: Promise<string> | null = null;

  constructor(opts: ManagedIdentityTokenProviderOptions) {
    const endpoint = new URL(opts.identityEndpoint);
    endpoint.searchParams.set("api-version", opts.apiVersion ?? DEFAULT_API_VERSION);
    endpoint.searchParams.set("resource", opts.resource ?? VAULT_RESOURCE);
    endpoint.searchParams.set("client_id", opts.clientId);
    this.#url = endpoint.toString();
    this.#header = opts.identityHeader;
    this.#skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = opts.now ?? Date.now;
    this.#fetchToken =
      opts.fetchToken ??
      (async (url, headers, signal) => {
        const res = await fetch(url, { method: "GET", headers, signal });
        return { status: res.status, body: await res.text() };
      });
  }

  async getToken(): Promise<string> {
    const cached = this.#cached;
    if (cached && this.#now() < cached.expiresAtMs - this.#skewMs) {
      return cached.token;
    }
    // Coalesce concurrent refreshes; clear on settle so a failure never poisons
    // the cache and the next caller retries.
    this.#inFlight ??= this.#refresh().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #refresh(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let result: TokenFetchResult;
    try {
      result = await this.#fetchToken(
        this.#url,
        { "X-IDENTITY-HEADER": this.#header },
        controller.signal,
      );
    } catch (err) {
      throw new TokenError("managed-identity token request failed", { cause: err });
    } finally {
      clearTimeout(timer);
    }

    if (result.status !== 200) {
      throw new TokenError(`managed-identity token endpoint returned ${result.status}`);
    }
    let parsed: { access_token?: unknown; expires_on?: unknown };
    try {
      parsed = JSON.parse(result.body) as typeof parsed;
    } catch (err) {
      throw new TokenError("managed-identity token response was not JSON", { cause: err });
    }
    const token = parsed.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new TokenError("managed-identity token response missing access_token");
    }
    this.#cached = { token, expiresAtMs: parseExpiresOn(parsed.expires_on) };
    return token;
  }

  async close(): Promise<void> {
    // Nothing owned: global `fetch` has no dispatcher of ours to close. Present so
    // callers can treat this like the edge's provider and close it unconditionally.
  }
}

/**
 * Build a token provider from the ambient Container Apps managed-identity env
 * (`IDENTITY_ENDPOINT` / `IDENTITY_HEADER` are injected by the platform;
 * `AZURE_CLIENT_ID` selects the user-assigned identity). Returns `null` when the
 * process is not running under a managed identity, so callers can decide whether
 * that is fatal.
 */
export function managedIdentityTokenProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<
    Omit<ManagedIdentityTokenProviderOptions, "identityEndpoint" | "identityHeader" | "clientId">
  > = {},
): ManagedIdentityTokenProvider | null {
  const identityEndpoint = env.IDENTITY_ENDPOINT;
  const identityHeader = env.IDENTITY_HEADER;
  const clientId = env.AZURE_CLIENT_ID;
  if (!identityEndpoint || !identityHeader || !clientId) return null;
  return new ManagedIdentityTokenProvider({
    identityEndpoint,
    identityHeader,
    clientId,
    ...overrides,
  });
}
