import { createHash, randomBytes } from "node:crypto";
import { ALL_SCOPES, CLI_CLIENT_ID } from "./fixtures.js";

/**
 * Helpers for driving the dev IdP's browser-facing pages from tests (and the
 * other packages' integration suites): a minimal cookie jar, a generic
 * form-walker for oidc-provider's built-in device pages, and full-flow
 * drivers for device-code and auth-code logins.
 */

/** Cookie jar scoped per origin — just enough for oidc-provider's session. */
export class TestHttpSession {
  #cookies = new Map<string, Map<string, string>>();

  cookieHeader(origin: string): string | undefined {
    const jar = this.#cookies.get(origin);
    if (!jar || jar.size === 0) return undefined;
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  storeCookies(origin: string, res: Response): void {
    const jar = this.#cookies.get(origin) ?? new Map<string, string>();
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
    this.#cookies.set(origin, jar);
  }

  /** Single request, cookies applied/stored, redirects NOT followed. */
  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const origin = new URL(url).origin;
    const headers = new Headers(init.headers);
    const cookie = this.cookieHeader(origin);
    if (cookie) headers.set("cookie", cookie);
    const res = await fetch(url, { ...init, headers, redirect: "manual" });
    this.storeCookies(origin, res);
    return res;
  }

  /** GET, following same-or-cross-origin redirects (cookies per origin). */
  async follow(url: string, maxHops = 10): Promise<Response> {
    let current = url;
    for (let hop = 0; hop < maxHops; hop++) {
      const res = await this.request(current);
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) return res;
      await res.body?.cancel();
      current = new URL(location, current).toString();
    }
    throw new Error(`redirect loop following ${url}`);
  }
}

function parseForm(html: string, baseUrl: string): { action: string; fields: URLSearchParams } {
  const formMatch = /<form[^>]*>/i.exec(html);
  if (!formMatch) throw new Error(`no form in page:\n${html.slice(0, 500)}`);
  const actionMatch = /action="([^"]*)"/i.exec(formMatch[0]);
  const action = new URL(actionMatch?.[1] || baseUrl, baseUrl).toString();

  const fields = new URLSearchParams();
  for (const input of html.matchAll(/<input[^>]+>/gi)) {
    const name = /name="([^"]+)"/i.exec(input[0])?.[1];
    const value = /value="([^"]*)"/i.exec(input[0])?.[1] ?? "";
    const type = /type="([^"]+)"/i.exec(input[0])?.[1] ?? "text";
    if (name && type !== "submit") fields.set(name, value);
  }
  return { action, fields };
}

/**
 * Drive oidc-provider's built-in /device pages (code entry + confirm) and the
 * picker login until the flow reports success. `verificationUriComplete`
 * carries the user_code; `userEmail` picks the fixture identity.
 */
export async function approveDeviceFlow(
  session: TestHttpSession,
  verificationUriComplete: string,
  userEmail: string,
): Promise<void> {
  let res = await session.follow(verificationUriComplete);

  for (let step = 0; step < 6; step++) {
    const url = res.url || verificationUriComplete;
    const html = await res.text();

    if (/\/interaction\//.test(url)) {
      // The login picker — complete it via the deterministic ?user= hook.
      const withUser = new URL(url);
      withUser.searchParams.set("user", userEmail);
      res = await session.follow(withUser.toString());
      continue;
    }
    if (/sign[- ]?in completed|success/i.test(html)) {
      return;
    }
    // A built-in device page (code entry or confirm) — submit its form.
    const { action, fields } = parseForm(html, url);
    fields.set("confirm", "yes");
    res = await session.request(action, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = new URL(res.headers.get("location") ?? "/", action).toString();
      await res.body?.cancel();
      res = await session.follow(location);
    }
  }
  throw new Error("device flow did not reach success");
}

export interface DeviceFlowTokens {
  accessToken: string;
  idToken?: string;
  refreshToken?: string;
}

/** Full device-code login as the CLI client; returns the raw tokens. */
export async function runDeviceFlow(issuer: string, userEmail: string): Promise<DeviceFlowTokens> {
  const init = await fetch(`${issuer}/device/auth`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLI_CLIENT_ID, scope: ALL_SCOPES }).toString(),
  });
  if (!init.ok) throw new Error(`device_authorization failed: ${init.status}`);
  const grant = (await init.json()) as {
    device_code: string;
    verification_uri_complete: string;
  };

  await approveDeviceFlow(new TestHttpSession(), grant.verification_uri_complete, userEmail);

  const tokenRes = await fetch(`${issuer}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: grant.device_code,
      client_id: CLI_CLIENT_ID,
    }).toString(),
  });
  const body = (await tokenRes.json()) as Record<string, string>;
  if (!tokenRes.ok || !body.access_token) {
    throw new Error(`device token exchange failed: ${tokenRes.status} ${JSON.stringify(body)}`);
  }
  return {
    accessToken: body.access_token,
    idToken: body.id_token,
    refreshToken: body.refresh_token,
  };
}

export interface AuthCodeResult {
  idToken: string;
  accessToken: string;
  /** Claims of the ID token (decoded, not verified — tests inspect these). */
  idTokenClaims: Record<string, unknown>;
}

/** Decode a JWT payload without verification (test inspection only). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const payload = jwt.split(".")[1];
  if (!payload) throw new Error("not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
}

/**
 * Full authorization-code + PKCE login as a confidential client, completing
 * the picker via `?user=`. Captures the code from the redirect Location (the
 * redirect URI is never fetched), then exchanges it on the back channel.
 */
export async function runAuthCodeFlow(opts: {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userEmail: string;
  scope?: string;
  nonce?: string;
}): Promise<AuthCodeResult> {
  const session = new TestHttpSession();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const nonce = opts.nonce ?? randomBytes(8).toString("hex");

  const authorize = new URL(`${opts.issuer}/auth`);
  authorize.search = new URLSearchParams({
    client_id: opts.clientId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: opts.scope ?? ALL_SCOPES,
    state: "test-state",
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  // /auth → interaction picker → ?user= → back to /auth/:uid → redirect_uri.
  let res = await session.follow(authorize.toString());
  if (!/\/interaction\//.test(res.url)) {
    throw new Error(`expected the login picker, got ${res.status} ${res.url}`);
  }
  const withUser = new URL(res.url);
  withUser.searchParams.set("user", opts.userEmail);

  // Follow until the next hop is the (unfetchable) redirect URI.
  let current = withUser.toString();
  let code: string | null = null;
  for (let hop = 0; hop < 10 && code === null; hop++) {
    res = await session.request(current);
    const location = res.headers.get("location");
    if (!location) throw new Error(`auth flow stalled at ${current} (${res.status})`);
    await res.body?.cancel();
    const next = new URL(location, current);
    if (next.toString().startsWith(opts.redirectUri)) {
      const err = next.searchParams.get("error");
      if (err) throw new Error(`authorize error: ${err}`);
      code = next.searchParams.get("code");
      break;
    }
    current = next.toString();
  }
  if (!code) throw new Error("no authorization code in redirect");

  const tokenRes = await fetch(`${opts.issuer}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: opts.redirectUri,
      code_verifier: verifier,
    }).toString(),
  });
  const body = (await tokenRes.json()) as Record<string, string>;
  if (!tokenRes.ok || !body.id_token || !body.access_token) {
    throw new Error(`code exchange failed: ${tokenRes.status} ${JSON.stringify(body)}`);
  }
  return {
    idToken: body.id_token,
    accessToken: body.access_token,
    idTokenClaims: decodeJwtPayload(body.id_token),
  };
}
