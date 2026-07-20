import { Agent, request } from "undici";

/**
 * Managed-identity AAD token acquisition for Blob reads (issue #15).
 *
 * The edge is dependency-minimal (project plan §1, §6), so it does NOT take
 * `@azure/identity` into the trusted path — on Container Apps the user-assigned
 * identity's token endpoint is reachable over a documented HTTP call, which we
 * make ourselves over undici (already a dep). The resulting bearer token
 * authorizes read-only Blob access (Storage Blob Data Reader); the edge holds no
 * standing credential and cannot write or delete a single bundle.
 */

/** Default AAD resource/audience for Azure Storage (trailing slash is the audience). */
const STORAGE_RESOURCE = "https://storage.azure.com/";
/** App Service / Container Apps managed-identity token endpoint api-version. */
const DEFAULT_API_VERSION = "2019-08-01";
/** Refresh this long before hard expiry to absorb clock drift / propagation. */
const DEFAULT_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 10_000;

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

/** Injectable transport for tests (no network). Defaults to an undici Agent. */
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
  /** Injectable transport for tests; when set, no owned Agent is created. */
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
  readonly #dispatcher: Agent | null;

  #cached: { token: string; expiresAtMs: number } | null = null;
  /** Single-flight: concurrent refreshes await one fetch. */
  #inFlight: Promise<string> | null = null;

  constructor(opts: ManagedIdentityTokenProviderOptions) {
    const resource = opts.resource ?? STORAGE_RESOURCE;
    const apiVersion = opts.apiVersion ?? DEFAULT_API_VERSION;
    const endpoint = new URL(opts.identityEndpoint);
    endpoint.searchParams.set("api-version", apiVersion);
    endpoint.searchParams.set("resource", resource);
    endpoint.searchParams.set("client_id", opts.clientId);
    this.#url = endpoint.toString();
    this.#header = opts.identityHeader;
    this.#skewMs = opts.skewMs ?? DEFAULT_SKEW_MS;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#now = opts.now ?? Date.now;

    if (opts.fetchToken) {
      this.#fetchToken = opts.fetchToken;
      this.#dispatcher = null;
    } else {
      // The identity endpoint is a different origin than blob — its own Agent,
      // never the blob Pool.
      const dispatcher = new Agent({
        headersTimeout: this.#timeoutMs,
        bodyTimeout: this.#timeoutMs,
      });
      this.#dispatcher = dispatcher;
      this.#fetchToken = async (url, headers, signal) => {
        const res = await request(url, { method: "GET", headers, signal, dispatcher });
        return { status: res.statusCode, body: await res.body.text() };
      };
    }
  }

  async getToken(): Promise<string> {
    const cached = this.#cached;
    if (cached && this.#now() < cached.expiresAtMs - this.#skewMs) {
      return cached.token;
    }
    // Coalesce concurrent refreshes; clear on settle so a failure never poisons
    // the cache and the next caller retries.
    if (!this.#inFlight) {
      this.#inFlight = this.#refresh().finally(() => {
        this.#inFlight = null;
      });
    }
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
    await this.#dispatcher?.close();
  }
}
