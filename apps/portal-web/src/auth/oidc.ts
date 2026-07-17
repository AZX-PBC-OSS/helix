import * as oidc from "openid-client";
import { portalApiScope, type AuthConfigResponse } from "@azx-pbc/shared";

/**
 * Browser-side OIDC code+PKCE against the issuer the portal advertises at
 * /api/v1/auth/config (locally the dev IdP, later Entra — config-only swap).
 * The access token must be audienced to the portal API: against the dev IdP
 * that comes free (resource indicators); against Entra we request the API
 * scope ({@link portalApiScope}) so the token's `aud` is the portal, not Graph.
 */

const FLOW_KEY = "azx.portal.oidcFlow";

interface PendingFlow {
  verifier: string;
  state: string;
  /** In-app path to return to after the callback. */
  returnTo: string;
}

function redirectUri(): string {
  return `${window.location.origin}/auth/callback`;
}

async function discover(config: AuthConfigResponse): Promise<oidc.Configuration> {
  const issuer = new URL(config.issuer);
  if (!config.webClientId) {
    throw new Error("portal did not advertise a web client id (webClientId)");
  }
  return oidc.discovery(issuer, config.webClientId, undefined, undefined, {
    // openid-client refuses plain-http issuers unless explicitly allowed; the
    // local dev IdP is http. Keyed off the issuer scheme, not a build flag, so
    // an https issuer (Entra) never gets the escape hatch.
    ...(issuer.protocol === "http:" ? { execute: [oidc.allowInsecureRequests] } : {}),
  });
}

/** Kick off login: stash PKCE state, full-page redirect to the IdP. */
export async function beginLogin(config: AuthConfigResponse, returnTo: string): Promise<void> {
  const discovered = await discover(config);
  const verifier = oidc.randomPKCECodeVerifier();
  const challenge = await oidc.calculatePKCECodeChallenge(verifier);
  const state = oidc.randomState();
  const flow: PendingFlow = { verifier, state, returnTo };
  sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
  const apiScope = portalApiScope(config.audience);
  const scope = ["openid", "profile", "email", apiScope].filter(Boolean).join(" ");
  const url = oidc.buildAuthorizationUrl(discovered, {
    redirect_uri: redirectUri(),
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  window.location.assign(url.href);
}

export interface CompletedLogin {
  accessToken: string;
  expiresIn?: number;
  returnTo: string;
}

/** Finish login on /auth/callback: exchange the code, return the token. */
export async function completeLogin(config: AuthConfigResponse): Promise<CompletedLogin> {
  const raw = sessionStorage.getItem(FLOW_KEY);
  if (!raw) {
    throw new Error("no login in progress (PKCE state missing)");
  }
  sessionStorage.removeItem(FLOW_KEY);
  const flow = JSON.parse(raw) as PendingFlow;
  const discovered = await discover(config);
  const tokens = await oidc.authorizationCodeGrant(discovered, new URL(window.location.href), {
    pkceCodeVerifier: flow.verifier,
    expectedState: flow.state,
  });
  return {
    accessToken: tokens.access_token,
    ...(tokens.expires_in !== undefined ? { expiresIn: tokens.expires_in } : {}),
    returnTo: flow.returnTo,
  };
}
