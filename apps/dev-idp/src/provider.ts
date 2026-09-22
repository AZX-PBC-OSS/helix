import { generateKeyPairSync, randomUUID } from "node:crypto";
import Provider, { type Configuration, type KoaContextWithOIDC } from "oidc-provider";
import {
  ALL_SCOPES,
  CLI_CLIENT_ID,
  EDGE_CLIENT_ID,
  EDGE_CLIENT_SECRET_DEFAULT,
  FIXTURE_CLIENT_IDS,
  PORTAL_AUDIENCE,
  WEB_CLIENT_ID,
  fixtureUserForAccountId,
} from "./fixtures.js";

export interface DevIdpOptions {
  /** Edge confidential-client secret (default: the well-known dev value). */
  edgeClientSecret?: string;
  /** Redirect URIs registered for the edge client. */
  edgeRedirectUris?: string[];
  /** Redirect URIs registered for the portal SPA client. */
  webRedirectUris?: string[];
  /**
   * Omit the `oid` claim from every token. **Test-only** — never set by the
   * dev stack itself. Exists so the consumers' fail-closed suites can drive a
   * real login whose token lacks the claim: ADR-0048 decision 2 makes absence
   * a misconfiguration that refuses the login on both planes, and this is how
   * that refusal is exercised against a real issuer rather than a forged
   * token.
   */
  omitOidClaim?: boolean;
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
  const omitOidClaim = opts.omitOidClaim === true;
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
          "https://auth.local.helix.azxlabs.io:8080/callback",
          "http://auth.local.helix.azxlabs.io:8080/callback",
        ],
      },
      {
        // The portal SPA: public browser client, code + PKCE (forced below).
        // Redirects cover the Vite dev server and the portal-served bundle.
        client_id: WEB_CLIENT_ID,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        redirect_uris: opts.webRedirectUris ?? [
          "http://localhost:5173/auth/callback",
          "http://localhost:3001/auth/callback",
        ],
      },
    ],

    // oidc-provider denies browser CORS (token endpoint included) by default.
    // Only the SPA client does its code exchange from browser JS, so it is the
    // only client that gets CORS — the redirect-URI allowlist + PKCE remain
    // the actual security boundary for a public client.
    clientBasedCORS: (_ctx, _origin, client) => client?.clientId === WEB_CLIENT_ID,

    // Scope → claim mapping. With `conformIdTokenClaims: false` below these
    // land in the ID token itself (Entra-style), which the edge depends on —
    // it never calls userinfo. `oid` rides under `openid` because Entra emits
    // it unconditionally there (ADR-0048 decision 2: no claim configuration,
    // no scope, no consent needed to receive it).
    claims: {
      openid: ["sub", "oid"],
      profile: ["name"],
      email: ["email"],
      groups: ["groups"],
    },
    conformIdTokenClaims: false,

    // The account id is the **pairwise sub** minted for (client, user) at
    // login (interactions.ts / pairwiseSub) — oidc-provider presents the
    // account id as `sub` in the ID token and (for JWT access tokens) derives
    // it from the token's own accountId, so sub is per-client by construction
    // with no library subject_type machinery (which the public device-flow
    // client cannot use anyway). `findAccount` resolves that id back to the
    // fixture user; the stable cross-client identity is the `oid` claim.
    //
    // Known dev-only imperfection: a browser that logs into two clients shares
    // one IdP session, and the second client's silent login reuses the first
    // client's pairwise account id. Every consumer reads `oid` (correct) or
    // the email, so nothing observes it; the test suites use fresh cookie jars
    // per flow.
    async findAccount(_ctx, id) {
      const user = fixtureUserForAccountId(id);
      if (!user) return undefined;
      return {
        accountId: id,
        // `name` is spread in only when the fixture has one: a tenant that sends
        // no name claim is a real shape, and `name: undefined` would not
        // reproduce it faithfully.
        claims: () => ({
          sub: id,
          ...(omitOidClaim ? {} : { oid: user.oid }),
          email: user.email,
          ...(user.name === undefined ? {} : { name: user.name }),
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

    // Actor attribution + the stable identity half: the portal reads
    // email/name/oid from the access token. (`sub` needs no help — it is the
    // token's accountId, the pairwise value, per-client by construction.)
    async extraTokenClaims(_ctx, token) {
      const user =
        "accountId" in token ? fixtureUserForAccountId(token.accountId ?? "") : undefined;
      if (!user) return {};
      return {
        ...(omitOidClaim ? {} : { oid: user.oid }),
        email: user.email,
        ...(user.name === undefined ? {} : { name: user.name }),
        groups: user.groups,
      };
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

  // Drift guard (fixtures.ts's FIXTURE_CLIENT_IDS docblock): a client
  // registered here but missing from the tuple would mint account ids the
  // reverse scan cannot resolve — every login through it fails with nothing
  // pointing at the cause. Fail at construction instead, where the fix is a
  // one-line edit away from the error.
  for (const client of configuration.clients ?? []) {
    if (!FIXTURE_CLIENT_IDS.includes(client.client_id as (typeof FIXTURE_CLIENT_IDS)[number])) {
      throw new Error(
        `client "${client.client_id}" is not in FIXTURE_CLIENT_IDS — add it there too, ` +
          "or the account-id reverse lookup cannot resolve its logins",
      );
    }
  }

  return new Provider(issuer, configuration);
}
