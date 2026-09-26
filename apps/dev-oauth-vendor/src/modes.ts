import { z } from "zod";

/**
 * The fixture's mode vocabulary — the shared test surface every consumer
 * suite (portal callback, egress renewal, edge flow, browser lane) imports
 * rather than restating (I-02 ADR-0010 §Shared ground).
 *
 * These are test knobs, not claims about any real vendor's behavior. Nothing
 * here may be read as "vendors rotate refresh tokens" or "vendors use this
 * scope convention" — real-vendor facts belong to the Asana acceptance
 * exercise, which no fixture substitutes for (spec criterion 55).
 */

/**
 * Token-endpoint behavior. The mode is per-instance (chosen at
 * `startDevOAuthVendor` or via `setModes`), never a module-level variable, so
 * concurrently running suites cannot leak state into each other.
 *
 * - `rotating` — a refresh grant retires the presented refresh token and
 *   issues a replacement, which the response carries as `refresh_token`.
 * - `non-rotating` — a refresh grant succeeds and omits `refresh_token`; the
 *   presented token stays valid (the retain-on-omission semantics criterion
 *   35 gives the caller).
 * - `hang` — every token request stalls until the caller gives up (the
 *   response is never written while the client is listening), to exercise
 *   timeout handling.
 * - `consumed-then-drop` — the presented grant (refresh token or
 *   authorization code) is consumed and a standard `invalid_grant` error is
 *   returned: nothing usable comes back, and the grant is gone on retry.
 */
export const TOKEN_MODES = ["rotating", "non-rotating", "hang", "consumed-then-drop"] as const;
export const TokenModeSchema = z.enum(TOKEN_MODES);
export type TokenMode = (typeof TOKEN_MODES)[number];

/** Authorize-endpoint behavior: complete the code flow, or refuse it. */
export const AUTHORIZE_MODES = ["approve", "deny"] as const;
export const AuthorizeModeSchema = z.enum(AUTHORIZE_MODES);
export type AuthorizeMode = (typeof AUTHORIZE_MODES)[number];

/** Per-instance mode state, read at request time. */
export const VendorModesSchema = z.object({
  tokenMode: TokenModeSchema,
  authorizeMode: AuthorizeModeSchema,
});
export type VendorModes = z.infer<typeof VendorModesSchema>;

/**
 * The popup journeys the real-browser lane (I-02 ADR-0010 part 2) drives
 * against the fixture — spec criterion 53's list. Suites import this list so
 * a journey added to the fixture's contract is visibly missing from any lane
 * that has not covered it yet.
 */
export const JOURNEYS = [
  "popup-consent-success",
  "popup-blocked",
  "consent-denied",
  "consent-cancelled",
  "consent-timeout",
  "lost-completion-signaling",
  "safe-completion-notification",
] as const;
export type Journey = (typeof JOURNEYS)[number];

/** The single fixture client (confidential), overridable per instance. */
export const DEFAULT_CLIENT_ID = "dev-oauth-client";
export const DEFAULT_CLIENT_SECRET = "dev-oauth-secret";

/**
 * The header the API destination checks when the token did not arrive as
 * `Authorization: Bearer` — the named-header placement (`TokenPlacement`
 * kind `header` in @azx-pbc/shared), overridable per instance.
 */
export const DEFAULT_API_TOKEN_HEADER = "x-user-token";
