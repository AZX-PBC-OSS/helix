/**
 * Fixture identities and OAuth clients for the local dev IdP (project plan §3,
 * Entra row: the platform speaks generic OIDC; locally that issuer is this
 * package). Shapes mirror what Entra will provide — GUID subjects, a `groups`
 * claim — so nothing downstream special-cases dev.
 */

export interface FixtureUser {
  /** Stable GUID, like an Entra object id. */
  sub: string;
  email: string;
  name: string;
  groups: string[];
}

/** Group ids referenced by app visibility rules in dev. */
export const GROUP_ENG_TEAM = "eng-team";
export const GROUP_PLATFORM_ADMINS = "platform-admins";

export const FIXTURE_USERS: FixtureUser[] = [
  {
    sub: "5f0d5d2a-9d3f-4b1e-8c5a-111111111111",
    email: "alice@azx.dev",
    name: "Alice Anders",
    groups: [GROUP_ENG_TEAM, GROUP_PLATFORM_ADMINS],
  },
  {
    sub: "5f0d5d2a-9d3f-4b1e-8c5a-222222222222",
    email: "bob@azx.dev",
    name: "Bob Builder",
    groups: [GROUP_ENG_TEAM],
  },
  {
    // No groups — exists so group-visibility denial paths have a subject.
    sub: "5f0d5d2a-9d3f-4b1e-8c5a-333333333333",
    email: "mallory@azx.dev",
    name: "Mallory Moor",
    groups: [],
  },
];

/** Look a fixture up by sub or email (the picker uses emails). */
export function findFixtureUser(id: string): FixtureUser | undefined {
  return FIXTURE_USERS.find((u) => u.sub === id || u.email === id);
}

/** Audience of portal API access tokens (Entra later: the App ID URI). */
export const PORTAL_AUDIENCE = "urn:helix:portal";

/** Public client for the `azx` CLI — device-code + refresh grants. */
export const CLI_CLIENT_ID = "azx-cli";

/** Confidential client for the edge auth service — code + PKCE + nonce. */
export const EDGE_CLIENT_ID = "helix-edge";
export const EDGE_CLIENT_SECRET_DEFAULT = "edge-dev-secret";

/** Public client for the portal SPA — code + PKCE in the browser. */
export const WEB_CLIENT_ID = "azx-portal-web";

/** Every scope the dev IdP knows; grants are auto-approved with all of them. */
export const ALL_SCOPES = "openid profile email groups offline_access";
