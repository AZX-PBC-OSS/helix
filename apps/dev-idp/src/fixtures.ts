/**
 * Fixture identities and OAuth clients for the local dev IdP (project plan §3,
 * Entra row: the platform speaks generic OIDC; locally that issuer is this
 * package). Shapes mirror what Entra will provide — GUID subjects, a `groups`
 * claim — so nothing downstream special-cases dev.
 */

export interface FixtureUser {
  /**
   * The subject claim. The first three are readable GUIDs, which is convenient
   * but NOT what Entra sends: Entra's `sub` is pairwise per client id, 32 random
   * bytes base64url, and resolves to nobody. `dana` below carries that shape on
   * purpose — see the note on the fixture list.
   */
  sub: string;
  email: string;
  /**
   * Optional, because a real tenant need not send a `name` claim — and a user
   * who has none is the case where the captured display half falls back to the
   * address rather than to the opaque subject.
   */
  name?: string;
  groups: string[];
}

/** Group ids referenced by app visibility rules in dev. */
export const GROUP_ENG_TEAM = "eng-team";
export const GROUP_PLATFORM_ADMINS = "platform-admin";

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
  {
    /*
     * The Entra-shaped user, and the reason this fixture exists.
     *
     * The three above are convenient in a way real life is not: readable GUID
     * subjects and a `name` claim on every login. That combination means the
     * local stack never reproduces what a deployment actually shows — a
     * 43-character pairwise `sub` that resolves to nobody, and a tenant that
     * sends no name — so the whole class of "the id is unattributable" bug is
     * invisible until it reaches Entra. This user makes both reproducible: the
     * captured display half has to fall back to the address, and every screen
     * that renders a principal has to cope with an opaque one.
     *
     * Additive on purpose — the other three keep their ids so existing
     * assertions and dev muscle memory are untouched.
     */
    sub: "VKn3n7f8eM3JdjdHi6CSFsRTRIBtt1Nob_iPGjKAmPA",
    email: "dana@azx.dev",
    groups: [GROUP_ENG_TEAM],
  },
];

/** Look a fixture up by sub or email (the picker uses emails). */
export function findFixtureUser(id: string): FixtureUser | undefined {
  return FIXTURE_USERS.find((u) => u.sub === id || u.email === id);
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

/** Every scope the dev IdP knows; grants are auto-approved with all of them. */
export const ALL_SCOPES = "openid profile email groups offline_access";
