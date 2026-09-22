import { createHmac } from "node:crypto";

/**
 * Fixture identities and OAuth clients for the local dev IdP (project plan §3,
 * Entra row: the platform speaks generic OIDC; locally that issuer is this
 * package). Shapes mirror what Entra provides — a stable per-user `oid`, a
 * pairwise `sub` per client id, GUID object ids, a `groups` claim — so nothing
 * downstream special-cases dev (ADR-0048 decision 7).
 */

export interface FixtureUser {
  /**
   * The `oid` claim — the directory object id (ADR-0048). Stable for the life
   * of the user object and **identical in every token, for every client, in
   * both planes**: the edge session stores it as `OidcIdentity.oid`, the
   * portal persists it as `App.ownerId`, and the cross-plane correlation tests
   * pin it as the one value that must agree. Readable GUIDs on purpose —
   * Entra's `oid` is a GUID too, and a fixture IdP nobody can eyeball throws
   * away the one advantage fixtures have.
   */
  oid: string;
  email: string;
  /**
   * Optional, because a real tenant need not send a `name` claim — and a user
   * who has none is the case where the captured display half falls back to the
   * address rather than to anything readable.
   */
  name?: string;
  groups: string[];
}

/** Group ids referenced by app visibility rules in dev. */
export const GROUP_ENG_TEAM = "eng-team";
export const GROUP_PLATFORM_ADMINS = "platform-admin";

export const FIXTURE_USERS: FixtureUser[] = [
  {
    oid: "6b9f4d31-8e2a-4c07-9b5d-111111111111",
    email: "alice@azx.dev",
    name: "Alice Anders",
    groups: [GROUP_ENG_TEAM, GROUP_PLATFORM_ADMINS],
  },
  {
    oid: "6b9f4d31-8e2a-4c07-9b5d-222222222222",
    email: "bob@azx.dev",
    name: "Bob Builder",
    groups: [GROUP_ENG_TEAM],
  },
  {
    // No groups — exists so group-visibility denial paths have a subject.
    oid: "6b9f4d31-8e2a-4c07-9b5d-333333333333",
    email: "mallory@azx.dev",
    name: "Mallory Moor",
    groups: [],
  },
  {
    /*
     * The no-name user, and the reason this fixture exists.
     *
     * The three above are convenient in a way real life is not: a `name`
     * claim on every login. A tenant that sends none is a real shape, and a
     * user without one is the case where every screen that renders a
     * principal has to fall back to the address. This user makes that
     * reproducible.
     *
     * Before ADR-0048 she also carried the "43-character opaque `sub`" half
     * of the lesson; pairwise subjects (see {@link pairwiseSub}) made that
     * universal, so the missing name is what remains distinctive here.
     */
    oid: "6b9f4d31-8e2a-4c07-9b5d-444444444444",
    email: "dana@azx.dev",
    groups: [GROUP_ENG_TEAM],
  },
];

/** Look a fixture up by oid or email (the picker uses emails). */
export function findFixtureUser(id: string): FixtureUser | undefined {
  return FIXTURE_USERS.find((u) => u.oid === id || u.email === id);
}

/** Audience of portal API access tokens (Entra later: the App ID URI). */
export const PORTAL_AUDIENCE = "urn:helix:portal";

/** Public client for the `helix` CLI — device-code + refresh grants. */
export const CLI_CLIENT_ID = "azx-cli";

/** Confidential client for the edge auth service — code + PKCE + nonce. */
export const EDGE_CLIENT_ID = "helix-edge";
export const EDGE_CLIENT_SECRET_DEFAULT = "edge-dev-secret";

/** Public client for the portal SPA — code + PKCE in the browser. */
export const WEB_CLIENT_ID = "azx-portal-web";

/**
 * The subject this IdP presents for (client, user): HMAC-SHA256 over a fixed
 * fixture key, base64url — Entra's shape, 43 opaque characters.
 *
 * **Pairwise per client id**, exactly as Entra issues it (ADR-0048): the same
 * human is a *different* `sub` to the edge's registration than to the
 * portal's, which is the whole point — until that is true locally, the
 * production failure (two planes that can never agree on a principal) cannot
 * be reproduced, only described. The stable cross-client identity is the
 * `oid` claim, never this value.
 *
 * Deterministic on purpose: the key is a constant, so two boots of the IdP,
 * cached tokens and pinned tests all agree on a (client, user) pair's sub.
 * Exported because the account id oidc-provider carries *is* this value (see
 * provider.ts), and the consumers' correlation tests pin the derivation.
 */
const PAIRWISE_SUB_KEY = "dev-idp-pairwise-sub-v1";

export function pairwiseSub(clientId: string, user: FixtureUser): string {
  return createHmac("sha256", PAIRWISE_SUB_KEY)
    .update(`${clientId}:${user.oid}`)
    .digest("base64url");
}

/**
 * Reverse the derivation: which fixture user does this account id belong to?
 * oidc-provider's account id — in the session, the code, the refresh token
 * and the access token — is the pairwise sub minted at login, so `findAccount`
 * and `extraTokenClaims` resolve users through this. The set is closed (four
 * fixtures × three clients), so a scan is the honest implementation, and an
 * HMAC over distinct inputs cannot collide within it.
 */
export function fixtureUserForAccountId(accountId: string): FixtureUser | undefined {
  for (const clientId of [CLI_CLIENT_ID, EDGE_CLIENT_ID, WEB_CLIENT_ID]) {
    for (const user of FIXTURE_USERS) {
      if (pairwiseSub(clientId, user) === accountId) return user;
    }
  }
  return undefined;
}

/** Every scope the dev IdP knows; grants are auto-approved with all of them. */
export const ALL_SCOPES = "openid profile email groups offline_access";
