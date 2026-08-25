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
 * **The tier gates search; the two id→name resolves are treated separately, and
 * not identically.** `my-groups` resolves the group claim on the caller's own
 * verified token and genuinely discloses nothing new, so it is never gated.
 *
 * `/apps/:slug/visibility/groups` is the one that needed a second look. An
 * earlier version of this comment claimed it too "discloses nothing the caller
 * could not already read", on the grounds that it resolves ids already returned
 * by `GET /api/v1/apps/:slug`. That is false, because **the caller chooses the
 * ids**: `POST /api/v1/apps` is authenticate-only and `VisibilityGroupIdsSchema`
 * never checks a group id against the directory, so anyone can store ten
 * arbitrary ids on an app of their own and read the names back. Ids that do not
 * resolve are omitted, which makes it an existence oracle as well as a name one.
 *
 * So it is narrowed rather than excused: on any deployment that set a tier, the
 * route additionally requires owner-or-admin (`ownsAppWhenSearchRestricted` in
 * `../routes/directory.ts`). What remains after that is an operator resolving ids
 * on their *own* apps, bounded by the resolve limiter at ten ids per request —
 * and it does not defeat the tier, because there is no name→id direction and
 * Entra object ids are not guessable. Closing it entirely is per-app RBAC
 * (ADR-0007), not this knob.
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
  if (is(normalised)) return { tier: normalised };
  // The raw string, not the normalised one: the boot log exists to tell an
  // operator what they wrote, and echoing a cleaned-up version back hides exactly
  // the stray character that caused the problem.
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
