/**
 * Operator policy for the two open-to-the-internet visibility modes. `public`
 * (anonymous, no gate) and `password` (shared passphrase) are surfaces a
 * deployment may forbid entirely; `internal`/`group` are SSO-gated and always
 * permitted.
 *
 * Flag polarity is "allow", defaulting off (a mode is permitted only when the
 * env var is explicitly "true"). Disallowed is the platform default — a
 * deployment opts a surface back in per environment. Read here (not a central
 * config module — the
 * portal has none) so the write-gate routes and the `/api/v1/auth/config`
 * bootstrap read one source and never drift. The edge enforces the same policy
 * independently (EDGE_ALLOW_*_APPS) — this is the control-plane half.
 */

/** Whether this deployment permits `public` (anonymous) apps. */
export function publicAppsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PORTAL_ALLOW_PUBLIC_APPS === "true";
}

/** Whether this deployment permits `password` (shared-passphrase) apps. */
export function passwordAppsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PORTAL_ALLOW_PASSWORD_APPS === "true";
}
