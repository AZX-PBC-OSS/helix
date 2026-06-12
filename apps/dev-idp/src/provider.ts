import { generateKeyPairSync, randomUUID } from "node:crypto";
import Provider, { type Configuration, type KoaContextWithOIDC } from "oidc-provider";
import {
  ALL_SCOPES,
  CLI_CLIENT_ID,
  EDGE_CLIENT_ID,
  EDGE_CLIENT_SECRET_DEFAULT,
  PORTAL_AUDIENCE,
  findFixtureUser,
} from "./fixtures.js";

export interface DevIdpOptions {
  /** Edge confidential-client secret (default: the well-known dev value). */
  edgeClientSecret?: string;
  /** Redirect URIs registered for the edge client. */
  edgeRedirectUris?: string[];
}

/** Per-boot RSA keypair; consumers re-fetch JWKS on unknown `kid`. */
function bootJwks(): { keys: object[] } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = privateKey.export({ format: "jwk" }) as Record<string, unknown>;
  return { keys: [{ ...jwk, alg: "RS256", use: "sig", kid: `dev-idp-${randomUUID()}` }] };
}

/**
 * Build the oidc-provider instance for a given issuer. The issuer is plain
 * construction-time metadata, so callers can bind a port first and construct
 * with the real URL (see start.ts) — that is what makes ephemeral-port test
 * instances possible.
 */
export function buildProvider(issuer: string, opts: DevIdpOptions = {}): Provider {
  const configuration: Configuration = {
    clients: [
      {
        client_id: CLI_CLIENT_ID,
        token_endpoint_auth_method: "none",
        grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
        response_types: [],
        redirect_uris: [],
      },
      {
        client_id: EDGE_CLIENT_ID,
        client_secret: opts.edgeClientSecret ?? EDGE_CLIENT_SECRET_DEFAULT,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: opts.edgeRedirectUris ?? [
          "https://auth.localtest.me:8080/callback",
          "http://auth.localtest.me:8080/callback",
        ],
      },
    ],

    // Scope → claim mapping. With `conformIdTokenClaims: false` below these
    // land in the ID token itself (Entra-style), which the edge depends on —
    // it never calls userinfo.
    claims: {
      openid: ["sub"],
      profile: ["name"],
      email: ["email"],
      groups: ["groups"],
    },
    conformIdTokenClaims: false,

    async findAccount(_ctx, id) {
      const user = findFixtureUser(id);
      if (!user) return undefined;
      return {
        accountId: user.sub,
        claims: () => ({
          sub: user.sub,
          email: user.email,
          name: user.name,
          groups: user.groups,
        }),
      };
    },

    features: {
      devInteractions: { enabled: false },
      deviceFlow: { enabled: true },
      // Portal access tokens: JWTs with a stable audience the portal can
      // verify statelessly over JWKS. Entra equivalent: App ID URI audience.
      resourceIndicators: {
        enabled: true,
        defaultResource: () => PORTAL_AUDIENCE,
        getResourceServerInfo: () => ({
          scope: ALL_SCOPES,
          audience: PORTAL_AUDIENCE,
          accessTokenFormat: "jwt",
        }),
        useGrantedResource: () => true,
      },
    },

    // Actor attribution: the portal reads email/name from the access token.
    async extraTokenClaims(_ctx, token) {
      const user = "accountId" in token ? findFixtureUser(token.accountId ?? "") : undefined;
      if (!user) return {};
      return { email: user.email, name: user.name, groups: user.groups };
    },

    // Dev IdP: consent is always auto-granted, so the only interaction that
    // ever renders is the login picker (interactions.ts).
    async loadExistingGrant(ctx: KoaContextWithOIDC) {
      const existingId =
        ctx.oidc.result?.consent?.grantId ??
        ctx.oidc.session?.grantIdFor(ctx.oidc.client?.clientId ?? "");
      if (existingId) {
        return ctx.oidc.provider.Grant.find(existingId);
      }
      const accountId = ctx.oidc.session?.accountId;
      const clientId = ctx.oidc.client?.clientId;
      if (!accountId || !clientId) return undefined;
      const grant = new ctx.oidc.provider.Grant({ accountId, clientId });
      grant.addOIDCScope(ALL_SCOPES);
      grant.addResourceScope(PORTAL_AUDIENCE, ALL_SCOPES);
      await grant.save();
      return grant;
    },

    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },

    pkce: { required: () => true },
    jwks: bootJwks(),
    cookies: { keys: ["dev-idp-insecure-cookie-key"] },
  };

  return new Provider(issuer, configuration);
}
