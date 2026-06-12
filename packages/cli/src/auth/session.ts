import { AuthConfigResponseSchema, type AuthConfigResponse } from "@helix/shared";
import { refreshGrant } from "./deviceFlow.js";
import { defaultTokenPath, readTokens, writeTokens, type StoredTokens } from "./tokenStore.js";

/**
 * Token acquisition for every authenticated CLI call. Precedence:
 * `AZX_TOKEN`/`--token` (static — the dev-token/CI path) wins outright;
 * otherwise the cache for the portal's issuer, silently refreshed when
 * within a minute of expiry. `undefined` means "not logged in" — the caller
 * turns that into a friendly "run `azx login`" error. No flow is ever
 * auto-launched: agents and CI run headless.
 */

export type TokenProvider = () => Promise<string | undefined>;

/** Refresh when the access token has less than this long to live. */
const REFRESH_MARGIN_MS = 60_000;

export interface SessionDeps {
  getAuthConfig(portalUrl: string): Promise<AuthConfigResponse>;
  refresh(issuer: string, clientId: string, refreshToken: string): Promise<StoredTokens>;
  storePath: string;
}

export async function fetchAuthConfig(portalUrl: string): Promise<AuthConfigResponse> {
  const res = await fetch(`${portalUrl.replace(/\/+$/, "")}/api/v1/auth/config`);
  if (!res.ok) {
    throw new Error(
      `portal has no OIDC configured (GET /api/v1/auth/config → ${res.status}); ` +
        "use AZX_TOKEN / --token instead",
    );
  }
  return AuthConfigResponseSchema.parse(await res.json());
}

const defaultDeps: SessionDeps = {
  getAuthConfig: fetchAuthConfig,
  refresh: refreshGrant,
  storePath: defaultTokenPath(),
};

export function makeTokenProvider(
  opts: { portalUrl: string; staticToken?: string },
  deps: SessionDeps = defaultDeps,
): TokenProvider {
  return async function getAccessToken(): Promise<string | undefined> {
    if (opts.staticToken) return opts.staticToken;

    const { issuer, cliClientId } = await deps.getAuthConfig(opts.portalUrl);
    const stored = await readTokens(issuer, deps.storePath);
    if (!stored) return undefined;

    if (stored.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return stored.accessToken;
    }
    if (!stored.refreshToken) return undefined;

    try {
      const renewed = await deps.refresh(
        issuer,
        stored.clientId || cliClientId,
        stored.refreshToken,
      );
      await writeTokens(issuer, renewed, deps.storePath);
      return renewed.accessToken;
    } catch {
      // Refresh refused (revoked/expired) — logged out, not an error.
      return undefined;
    }
  };
}
