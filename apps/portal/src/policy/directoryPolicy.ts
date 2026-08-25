import { actorIsAdmin } from "../plugins/auth.js";
import type { Actor } from "../auth/verifier.js";

/**
 * Operator policy for **who may search the directory** (ADR-0040 decision 11).
 *
 * `GET /api/v1/directory/groups` is a tenant-wide read: it turns a three-letter
 * term into the display names of matching security groups anywhere in the
 * customer's directory. ADR-0040 shipped it open to every authenticated portal
 * principal and said so in its own consequences, because the picker is needed at
 * app-*create* time and so cannot hang off `ownsApp`, and per-app RBAC (ADR-0007)
 * is still outstanding. That is a defensible posture for one tenant and a hard
 * sell for another, which is what this knob exists to stop us arguing about.
 *
 * **This is a different axis from `PORTAL_DIRECTORY`** (`../directory/custody.ts`),
 * which picks the *backend*. This picks *who may query it*. They compose, and the
 * backend wins: `PORTAL_DIRECTORY=off` reports unavailable for everyone whatever
 * the tier says. `none` here is therefore not redundant with it — `off` also kills
 * id→name resolution, where `none` keeps every name resolving and removes only
 * discovery.
 *
 * **The tier gates search alone.** The two id→name resolves stay open to any
 * authenticated caller, because neither discloses anything the caller could not
 * already read: `my-groups` resolves the group claim on the caller's own verified
 * token, and `/apps/:slug/visibility/groups` resolves ids already returned by
 * `GET /api/v1/apps/:slug`. Gating them would break the picker and buy nothing.
 *
 * Flag polarity is deliberately **not** `visibilityPolicy`'s "off unless
 * explicitly true". Those two flags guard surfaces open to the anonymous
 * internet, so default-deny is right. This one guards a surface that already
 * shipped open, and silently tightening it on the next deploy of an existing
 * deployment would break a working picker with no operator action to correlate
 * against. Unset means `everyone` — today's behaviour, exactly — and tightening
 * is an explicit choice.
 */

/** Who may call the tenant-wide group search. */
export const DIRECTORY_SEARCH_TIERS = ["everyone", "admins", "none"] as const;
export type DirectorySearchTier = (typeof DIRECTORY_SEARCH_TIERS)[number];

/** What {@link directorySearchPolicy} chose, and whether the env was garbage. */
export interface DirectorySearchPolicy {
  tier: DirectorySearchTier;
  /**
   * The raw value, set only when it was unrecognised. Present so the boot log can
   * name it — the same reason `DirectoryChoice` carries a `detail`.
   */
  invalid?: string;
}

/**
 * Resolve the tier from the environment.
 *
 * **An unrecognised value falls to `admins`, not to `everyone`.** A typo must not
 * silently widen a surface an operator was trying to narrow — that is
 * `createDirectoryFromEnv`'s "a typo must not silently become fixtures", applied
 * to the axis where the failure is a disclosure rather than a fake group list. It
 * stops at `admins` rather than `none` because a typo should not brick the picker
 * for the platform admin who then has to go and diagnose it, and the boot log
 * names the bad value either way.
 *
 * Takes `env` as a parameter and never reads ambient `process.env`, so every
 * branch above is testable — the house idiom, cf. `createDirectoryFromEnv`.
 */
export function directorySearchPolicy(env: NodeJS.ProcessEnv = process.env): DirectorySearchPolicy {
  const raw = env.PORTAL_DIRECTORY_SEARCH;
  if (raw === undefined || raw === "") return { tier: "everyone" };
  if (is(raw)) return { tier: raw };
  return { tier: "admins", invalid: raw };
}

function is(value: string): value is DirectorySearchTier {
  return (DIRECTORY_SEARCH_TIERS as readonly string[]).includes(value);
}

/** The resolved tier, for callers with nothing to say about a bad value. */
export function directorySearchTier(env: NodeJS.ProcessEnv = process.env): DirectorySearchTier {
  return directorySearchPolicy(env).tier;
}

/**
 * May this actor search the directory?
 *
 * Admin-ness comes from {@link actorIsAdmin} rather than re-reading
 * `PORTAL_ADMIN_GROUP_ID` here, so there is exactly one definition of
 * "platform-admin" in the portal and this cannot drift from the one gating the
 * approvals queue.
 */
export function directorySearchAllowed(
  actor: Actor,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  switch (directorySearchPolicy(env).tier) {
    case "everyone":
      return true;
    case "admins":
      return actorIsAdmin(actor);
    case "none":
      return false;
  }
}
