import { z } from "zod";

/**
 * Auth-facing wire shapes (M3). Two distinct surfaces share this file:
 * the edge's `/_api/me` (what untrusted app code may learn about the user)
 * and the portal's `/api/v1` auth endpoints (CLI/SPA consumers).
 */

/**
 * `GET /_api/me` on an app host (architecture §4.2, A.6): static apps can't
 * read auth headers, so this is how an app learns who is logged in.
 * Deliberately minimal — no email, no groups: hosted apps are untrusted code
 * and don't get the user's directory profile.
 */
export const MeResponseSchema = z.object({
  user: z.object({
    /** IdP subject (Entra object id) — stable, safe to key app data on. */
    id: z.string(),
    displayName: z.string(),
  }),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** `GET /api/v1/me` on the portal — the authenticated actor, echoed. */
export const PortalMeResponseSchema = z.object({
  sub: z.string(),
  /** How the actor was established: `oidc` or `dev-token`. */
  via: z.string(),
  name: z.string().optional(),
  email: z.string().optional(),
});
export type PortalMeResponse = z.infer<typeof PortalMeResponseSchema>;

/**
 * `GET /api/v1/auth/config` (public): how the CLI discovers the IdP — its
 * only configuration is the portal URL.
 */
export const AuthConfigResponseSchema = z.object({
  issuer: z.url(),
  cliClientId: z.string().min(1),
  /** Expected token audience — part of what the CLI binds cached tokens to. */
  audience: z.string().min(1).optional(),
});
export type AuthConfigResponse = z.infer<typeof AuthConfigResponseSchema>;
