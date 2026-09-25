import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET } from "./modes.js";
import { ApiTokenReportSchema, type ApiTokenReport } from "./vendor.js";

/**
 * Drivers for the fixture's OAuth surface — the dev-idp `testing.ts` pattern:
 * thin fetch helpers a suite composes instead of hand-building every form
 * body. `startDevOAuthVendor` is the required surface; these remove the
 * boilerplate every consumer suite would otherwise repeat.
 */

/** A fresh RFC 7636 code_verifier. */
export function newCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/** The S256 `code_challenge` for a verifier (RFC 7636 §4.2). */
export function s256CodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export interface AuthorizationResult {
  /** Present when approved; absent with `error` when denied. */
  code?: string;
  error?: string;
  errorDescription?: string;
  state?: string;
  /** The redirect target the authorize endpoint sent the browser to. */
  redirectLocation: string;
}

/** Drive the authorize endpoint (no redirect followed — the code is in the Location). */
export async function requestAuthorizationCode(
  vendor: { issuer: string },
  opts: {
    redirectUri: string;
    clientId?: string;
    scope?: string;
    state?: string;
    /** Defaults to the S256 challenge of a fresh verifier. */
    challenge?: string;
  },
): Promise<AuthorizationResult> {
  const params = new URLSearchParams({
    client_id: opts.clientId ?? DEFAULT_CLIENT_ID,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    code_challenge: opts.challenge ?? s256CodeChallenge(newCodeVerifier()),
    code_challenge_method: "S256",
  });
  if (opts.scope !== undefined) params.set("scope", opts.scope);
  if (opts.state !== undefined) params.set("state", opts.state);

  const res = await fetch(`${vendor.issuer}/authorize?${params}`, { redirect: "manual" });
  await res.body?.cancel();
  const location = res.headers.get("location");
  if (res.status !== 302 || location === null) {
    throw new Error(`authorize did not redirect: ${res.status}`);
  }
  const target = new URL(location);
  return {
    code: target.searchParams.get("code") ?? undefined,
    error: target.searchParams.get("error") ?? undefined,
    errorDescription: target.searchParams.get("error_description") ?? undefined,
    state: target.searchParams.get("state") ?? undefined,
    redirectLocation: location,
  };
}

export interface TokenEndpointResult {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

async function tokenRequest(
  vendor: { issuer: string },
  form: URLSearchParams,
  auth: { clientId?: string; clientSecret?: string | null },
  signal?: AbortSignal,
): Promise<TokenEndpointResult> {
  // Defaults to the fixture's own well-known client; an explicit `null`
  // clientSecret drives the public-client (body client_id) presentation.
  const clientId = auth.clientId ?? DEFAULT_CLIENT_ID;
  const clientSecret = auth.clientSecret === undefined ? DEFAULT_CLIENT_SECRET : auth.clientSecret;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
  };
  if (clientSecret !== null) {
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    form.set("client_id", clientId);
  }
  const res = await fetch(`${vendor.issuer}/token`, {
    method: "POST",
    headers,
    body: form.toString(),
    signal,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, ok: res.ok, body };
}

/** Redeem an authorization code (form in; the fixture answers JSON). */
export function exchangeAuthorizationCode(
  vendor: { issuer: string },
  code: string,
  opts: { verifier: string; redirectUri: string; clientId?: string; clientSecret?: string | null },
  signal?: AbortSignal,
): Promise<TokenEndpointResult> {
  return tokenRequest(
    vendor,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: opts.redirectUri,
      code_verifier: opts.verifier,
    }),
    opts,
    signal,
  );
}

/** Refresh grant; the response's `refresh_token` key presence is the rotation signal. */
export function refreshAccessToken(
  vendor: { issuer: string },
  refreshToken: string,
  opts: { clientId?: string; clientSecret?: string | null; scope?: string } = {},
  signal?: AbortSignal,
): Promise<TokenEndpointResult> {
  const form = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
  if (opts.scope !== undefined) form.set("scope", opts.scope);
  return tokenRequest(vendor, form, opts, signal);
}

/**
 * Call the fake API destination (any path, any method) with the token in one
 * placement, and get the report of which header it arrived in.
 */
export async function callApiDestination(
  vendor: { issuer: string },
  opts: {
    path?: string;
    method?: string;
    bearerToken?: string;
    headerName?: string;
    headerToken?: string;
  } = {},
): Promise<{ status: number; report: ApiTokenReport }> {
  const headers: Record<string, string> = {};
  if (opts.bearerToken !== undefined) headers.authorization = `Bearer ${opts.bearerToken}`;
  if (opts.headerName !== undefined && opts.headerToken !== undefined) {
    headers[opts.headerName] = opts.headerToken;
  }
  const res = await fetch(`${vendor.issuer}${opts.path ?? "/api/echo"}`, {
    method: opts.method ?? "POST",
    headers,
  });
  return { status: res.status, report: ApiTokenReportSchema.parse(await res.json()) };
}
