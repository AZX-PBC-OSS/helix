import { actorIsAdmin } from "../plugins/auth.js";
import type { Actor } from "../auth/verifier.js";

/**
 * Controls who may search tenant-wide group names (ADR-0040 decision 11).
 * Unset means `everyone` to preserve existing deployments; operators may choose
 * `admins` or `none`.
 *
 * `PORTAL_DIRECTORY` selects the backend; this policy selects its callers.
 * Backend `off` disables all lookups. Search policy `none` disables discovery
 * but keeps id-to-name resolution available under each route's access checks.
 *
 * `my-groups` resolves the caller's verified token claims without a search gate.
 * App-scoped resolution requires owner-or-admin when search is restricted.
 * Callers can store arbitrary group ids on their own apps, so this still allows
 * bounded name and existence lookups: at most ten ids per request, rate-limited.
 * It does not provide name-to-id discovery. See `ownsAppWhenSearchRestricted`
 * in `../routes/directory.ts` and ADR-0007 for the remaining per-app RBAC work.
 */

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
 * **Case and surrounding whitespace are normalised away first.** `None` and
 * `" none\n"` are the tier they obviously mean, not typos — and treating them as
 * typos was worse than merely pedantic, because the fallback below points at
 * `admins`, so the narrowest tier an operator can ask for was the one most likely
 * to come back *wider* than they wrote.
 *
 * **A genuinely unrecognised value then falls to `admins`, not to `everyone`.** A
 * typo must not silently widen a surface an operator was trying to narrow — that
 * is `createDirectoryFromEnv`'s "a typo must not silently become fixtures",
 * applied to the axis where the failure is a disclosure rather than a fake group
 * list. It stops at `admins` rather than `none` because a typo should not brick
 * the picker for the platform admin who then has to go and diagnose it, and the
 * boot log names the bad value either way.
 *
 * Takes `env` as a parameter and never reads ambient `process.env`, so every
 * branch above is testable — the house idiom, cf. `createDirectoryFromEnv`.
 */
export function directorySearchPolicy(env: NodeJS.ProcessEnv = process.env): DirectorySearchPolicy {
  const raw = env.PORTAL_DIRECTORY_SEARCH;
  if (raw === undefined) return { tier: "everyone" };
  // Normalised before matching, because the fallback only points the safe way for
  // values that are genuinely not tiers. Exact-match treated `None`, and a value
  // carrying a trailing newline (an ordinary outcome of a Bicep parameter or an
  // `az containerapp update`), as typos and *widened* them to `admins` — handing
  // every platform admin the whole directory on a deployment whose operator had
  // just turned search off, with nothing but a boot warning to say so. Casing and
  // whitespace must not be able to change the posture in either direction.
  const normalised = raw.trim().toLowerCase();
  if (normalised === "") return { tier: "everyone" };
  if (isTier(normalised)) return { tier: normalised };
  // The raw string, not the normalised one: the boot log exists to tell an
  // operator what they wrote, and echoing a cleaned-up version back hides exactly
  // the stray character that caused the problem.
  return { tier: "admins", invalid: raw };
}

/** Narrow an already-normalised string to a tier. */
function isTier(value: string): value is DirectorySearchTier {
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
