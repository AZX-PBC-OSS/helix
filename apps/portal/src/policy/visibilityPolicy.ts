/**
 * Operator policy for the two open-to-the-internet visibility modes. `public`
 * (anonymous, no gate) and `password` (shared passphrase) are surfaces a
 * deployment may forbid entirely; `private`/`group` are SSO-gated and always
 * permitted.
 *
 * Flag polarity is "allow", defaulting on today (a mode is permitted unless the
 * env var is explicitly "false"). The intent is to eventually make disallowed
 * the platform default — that flip changes each `!== "false"` below to
 * `=== "true"`, nothing else. Read here (not a central config module — the
 * portal has none) so the write-gate routes and the `/api/v1/auth/config`
 * bootstrap read one source and never drift. The edge enforces the same policy
 * independently (EDGE_ALLOW_*_APPS) — this is the control-plane half.
 */

/** Whether this deployment permits `public` (anonymous) apps. */
export function publicAppsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PORTAL_ALLOW_PUBLIC_APPS !== "false";
}

/** Whether this deployment permits `password` (shared-passphrase) apps. */
export function passwordAppsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PORTAL_ALLOW_PASSWORD_APPS !== "false";
}
