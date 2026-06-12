import * as oidc from "openid-client";
import type { StoredTokens } from "./tokenStore.js";

/**
 * OIDC device-authorization flow (RFC 8628) for `azx login`: print the
 * verification URL + code, poll until the user approves in a browser. The
 * issuer comes from the portal's /api/v1/auth/config, so this is IdP-generic
 * (dev-idp locally; Entra later, env-only).
 */

export const DEVICE_SCOPES = "openid profile email offline_access";

async function discover(issuer: string, clientId: string): Promise<oidc.Configuration> {
  const url = new URL(issuer);
  return oidc.discovery(
    url,
    clientId,
    undefined,
    undefined,
    // The local dev IdP is plain http on localhost; real issuers are https.
    url.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
}

function toStoredTokens(tokens: oidc.TokenEndpointResponse, clientId: string): StoredTokens {
  if (!tokens.access_token) throw new Error("token response carried no access token");
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1000,
    clientId,
  };
}

export async function runDeviceLogin(opts: {
  issuer: string;
  clientId: string;
  log: (msg: string) => void;
}): Promise<StoredTokens> {
  const config = await discover(opts.issuer, opts.clientId);
  const handle = await oidc.initiateDeviceAuthorization(config, { scope: DEVICE_SCOPES });

  opts.log("To sign in, open this URL in a browser:");
  opts.log(`  ${handle.verification_uri_complete ?? handle.verification_uri}`);
  opts.log(`and confirm the code: ${handle.user_code}`);
  opts.log("Waiting for approval…");

  // Polls per the server's interval; handles authorization_pending/slow_down.
  const tokens = await oidc.pollDeviceAuthorizationGrant(config, handle);
  return toStoredTokens(tokens, opts.clientId);
}

/** Silent renewal with the stored refresh token. Throws if the IdP refuses. */
export async function refreshGrant(
  issuer: string,
  clientId: string,
  refreshToken: string,
): Promise<StoredTokens> {
  const config = await discover(issuer, clientId);
  const tokens = await oidc.refreshTokenGrant(config, refreshToken);
  const stored = toStoredTokens(tokens, clientId);
  // Some IdPs rotate refresh tokens; keep the old one if no new one came.
  return { ...stored, refreshToken: stored.refreshToken ?? refreshToken };
}
