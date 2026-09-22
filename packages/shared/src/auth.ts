import { z } from "zod";

/**
 * Auth-facing wire shapes (M3). Two distinct surfaces share this file:
 * the edge's `/_api/me` (what untrusted app code may learn about the user)
 * and the portal's `/api/v1` auth endpoints (CLI/SPA consumers).
 */

/**
 * `GET /_api/me` on an app host (architecture §4.2, A.6): static apps can't
 * read auth headers, so this is how an app learns who is logged in.
 *
 * Still deliberately narrow — **no groups**: an app that could read the caller's
 * group ids could reimplement the visibility check the edge already made for it,
 * badly, which is the vibe-coded-auth failure mode A.6 exists to prevent. The
 * address is different in kind: it is the display half of the identity (see
 * `apps/edge/src/auth/identity.ts`), it is what an app needs to address, label or
 * de-duplicate a person, and an app that wanted to ship it somewhere must already
 * name that destination in its CSP or its fetch-proxy connections. Withholding it
 * bought a boundary the platform enforces elsewhere.
 */
export const MeResponseSchema = z.object({
  user: z.object({
    /**
     * The principal id — Entra's `oid` claim (the directory object id), stable
     * for the life of the user object and identical across every app
     * registration in the tenant (ADR-0048): safe to key app data on, and the
     * user scope partitions on exactly this value. Opaque by design — never
     * render it; `displayName` and `email` are the half fit to display.
     */
    id: z.string(),
    displayName: z.string(),
    /**
     * The captured address claim, or `null` when there isn't one — **nullable,
     * not optional, and the difference is the contract**. A missing key would
     * conflate "this platform doesn't send emails" with "we have no address for
     * this person", and the second is routine: shared-password sessions are a
     * `Guest` with no directory profile at all, and an issuer that sends no
     * `email` and a non-addressable `preferred_username` yields null too
     * (`captureEmail`). Apps must handle null; sending it explicitly is what
     * makes them.
     *
     * Never a delivery target or an identity key — `id` is the only thing safe
     * to join on. Entra addresses are reassignable and B2B guests carry their
     * home-tenant address.
     */
    email: z.string().nullable(),
  }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `GET /api/v1/me` on the portal — the authenticated actor, echoed. */
export const PortalMeResponseSchema = z.object({
  /**
   * The canonical principal id — Entra's `oid` claim from the access token
   * (ADR-0048). This is what `App.ownerId` stores and what ownership compares;
   * `sub` below is the display/audit half, never a join key.
   *
   * **Optional, not required**, for the same cross-version reason as the
   * defaulted fields below: this schema parses `PortalClient.me()` in the
   * *published* CLI, which routinely talks to portals older than itself, and
   * portals are customer-deployed and version independently (ADR-0028). An
   * older portal has no `oid` to echo — pre-ADR-0048 it has no such concept —
   * and nothing in the CLI keys on it. A current portal always sends it (the
   * dev-token actor gets a fixed synthetic value).
   */
  oid: z.string().optional(),
  sub: z.string(),
  /** How the actor was established: `oidc` or `dev-token`. */
  via: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
  /**
   * Whether the actor holds the `platform-admin` role. Computed server-side from
   * the actor's group/role claim — the raw ids never cross to the browser. Drives
   * admin nav + route gating in the SPA (and `helix whoami`).
   *
   * **Defaulted, not required**, for the same reason as
   * {@link canSearchDirectory} below: this schema parses `PortalClient.me()` in
   * the *published* CLI, which routinely talks to portals older than itself. The
   * polarity is the cautious one — a portal that never sent the field is not
   * telling us the caller is an admin.
   */
  isAdmin: z.boolean().default(false),
  /**
   * Whether this caller may run a tenant-wide group search (ADR-0040 decision
   * 11). Computed server-side from the deployment's `PORTAL_DIRECTORY_SEARCH`
   * tier and the actor's admin-ness. A caller who *may* search learns nothing
   * else; one who may not gets {@link searchRestriction} alongside.
   *
   * Sent so the group picker can **avoid issuing a search it is not allowed to
   * make**, rather than firing one and interpreting the 403. That matters
   * because a refused search is not a broken directory: the caller's own groups
   * and their app's stored groups still resolve to names, so the picker stays
   * useful and must not fall back to the "directory unavailable" banner. Server
   * enforcement is independent of this hint (`GET /api/v1/directory/groups`
   * refuses on its own).
   *
   * **Defaults to `true` when absent, and the polarity is the whole point.** The
   * CLI bundles this schema (ADR-0032) and portals are customer-deployed and
   * version independently (ADR-0028), so a new CLI against an older portal is
   * routine — and it was a hard break while this was required: `helix whoami`
   * failed outright, and `helix login` failed at its final "greet the actor"
   * step, which runs *after* the tokens are written, so a login that genuinely
   * succeeded reported an error. A portal old enough to omit this has no tier
   * enforcement at all and therefore behaves exactly like `everyone`, so `true`
   * describes the portal actually being talked to. Defaulting to `false` would
   * instead tell a client that search is unavailable where it works.
   */
  canSearchDirectory: z.boolean().default(true),
  /**
   * Why search was refused, when it was — **present only when
   * {@link canSearchDirectory} is false**, and never `everyone`, which by
   * construction refuses nobody.
   *
   * Exists because "restricted" and "restricted *to platform admins*" are
   * different sentences and only one of them is true under the `none` tier. The
   * picker has to be able to say which, and telling a platform admin that search
   * is "limited to platform admins" while refusing them sends them off to audit
   * a `PORTAL_ADMIN_GROUP_ID` that is perfectly correct.
   *
   * This is a deliberate, bounded narrowing of decision 11's "the browser learns
   * the answer, never the tier": a *permitted* caller still learns nothing, and a
   * refused one learns only which rule refused them — which they can already
   * infer from the 403 they would get by asking. The admin group id still never
   * crosses.
   */
  searchRestriction: z.enum(["admins", "none"]).optional(),
});
export type PortalMeResponse = z.infer<typeof PortalMeResponseSchema>;

/**
 * `GET /api/v1/auth/config` (public): how the CLI and the portal SPA discover
 * the IdP — their only configuration is the portal URL.
 */
export const AuthConfigResponseSchema = z.object({
  issuer: z.url(),
  cliClientId: z.string().min(1),
  /** Public client the portal SPA uses for code+PKCE in the browser. */
  webClientId: z.string().min(1).optional(),
  /** Expected token audience — part of what the CLI binds cached tokens to. */
  audience: z.string().min(1).optional(),
  /**
   * Whether this deployment permits `public` (anonymous) apps. Drives the SPA's
   * visibility UI — it hides the public option when false. Absent = forbidden
   * (older portal / dev-token-only where this endpoint 404s — open surfaces are
   * opt-in). Server-side enforcement is independent of this hint (portal routes
   * + edge serving).
   */
  allowPublicApps: z.boolean().optional(),
  /** Whether this deployment permits `password` (shared-passphrase) apps. Same shape as {@link allowPublicApps}. */
  allowPasswordApps: z.boolean().optional(),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponseSchema>;

/**
 * The delegated API scope a client (SPA/CLI) must request so its access token is
 * audienced to the portal API. Entra derives a token's `aud` from the requested
 * resource scope — asking for only `openid profile email` yields a token
 * audienced to Microsoft Graph, which the portal rejects. So request the App ID
 * URI scope `api://<client-id>/access`.
 *
 * Note the scope is always the `api://…` App ID URI form, but the resulting v2
 * access token carries `aud` = the bare client-id GUID — so `PORTAL_OIDC_AUDIENCE`
 * (what the portal verifies) is that GUID, while the scope we request here is
 * `api://<that GUID>/access`. We accept either form of `audience` and normalize:
 * a bare GUID gets the `api://` prefix; an already-`api://` value is used as-is.
 *
 * Returns null for the local dev IdP (audience `urn:helix:portal`), which forces
 * the audience via resource indicators and exposes no such scope — so the
 * clients keep requesting plain OIDC scopes there, unchanged.
 */
export function portalApiScope(audience: string | undefined): string | null {
  if (!audience || audience.startsWith("urn:")) return null;
  const appIdUri = audience.startsWith("api://") ? audience : `api://${audience}`;
  return `${appIdUri.replace(/\/+$/, "")}/access`;
}
