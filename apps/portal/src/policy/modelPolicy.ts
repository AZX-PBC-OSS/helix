import { MODEL_PRICING, providerForModel } from "@azx-pbc/shared";

/**
 * Operator policy for the **servable** LLM model set (ADR-0047) — which catalog
 * models this deployment advertises in the capability catalogue
 * (`GET /api/v1/capabilities`), the rendered skill, and the SPA's model picker.
 *
 * Two optional knobs, both comma-separated model ids:
 *
 * - `PORTAL_LLM_MODEL_ALLOWLIST` — when set (non-empty after parsing), it **is**
 *   the servable set: the operator has declared what the upstreams actually
 *   serve, replacing the ADR-0036 v1 heuristic (a model is servable when its
 *   provider family has a seeded `platform` secret). The heuristic cannot see
 *   keyless Foundry wiring — managed-identity connections seed no secret — so
 *   on a `deployFoundry` install the Bicep derives this list from
 *   `foundryModels` and the catalogue reports what was deployed rather than
 *   nothing. Entries are still intersected with the priced catalog: an id the
 *   platform cannot price is one the edge refuses, so advertising it would
 *   repeat the curated≠servable defect. There is deliberately no way to
 *   advertise an uncatalogued model — that is the fully-dynamic catalogue this
 *   deployment knob exists to avoid.
 * - `PORTAL_LLM_MODEL_BLOCKLIST` — subtracted in either mode; the first-party
 *   operator's "everything except these" knob.
 *
 * Both are display-surface policy only: the classifier (`classifyChange`) is
 * untouched, so a hand-written manifest naming a withheld-but-priced model
 * still auto-approves and then fails at the upstream — the documented backstop
 * for a model with no deployment (ADR-0047 §Consequences).
 *
 * Pure and env-injected (same shape as `visibilityPolicy.ts`) so tests override
 * env per case without rebuilding the app. Read per call, never frozen at boot.
 */

/** The parsed operator policy. */
export interface ModelPolicy {
  /**
   * The declared servable ids (catalog order), or null when unset — `""`,
   * whitespace, and a list of only empty entries all mean "no override",
   * because the Bicep emits an empty string for an unset array param.
   */
  allowlist: readonly string[] | null;
  /** Ids withheld in either mode (catalog order). */
  blocklist: readonly string[];
  /**
   * Entries in either list that name no catalog model — almost certainly
   * typos, or a Foundry deployment the platform does not price. The route
   * warn-logs them; a bad value must never fail a request or a boot.
   */
  unknown: readonly string[];
}

function parseIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse the operator model policy from the environment. */
export function modelPolicy(env: NodeJS.ProcessEnv = process.env): ModelPolicy {
  const allow = parseIds(env.PORTAL_LLM_MODEL_ALLOWLIST);
  const block = parseIds(env.PORTAL_LLM_MODEL_BLOCKLIST);
  // Catalog order for both lists, so the catalogue's output order is the
  // catalog's, not the operator's string's.
  const allowlist =
    allow.length > 0 ? Object.keys(MODEL_PRICING).filter((m) => allow.includes(m)) : null;
  const known = new Set(Object.keys(MODEL_PRICING));
  return {
    allowlist,
    blocklist: Object.keys(MODEL_PRICING).filter((m) => block.includes(m)),
    unknown: [...allow, ...block].filter((m) => !known.has(m)),
  };
}

/**
 * The servable model ids for the catalogue, in catalog order. With an
 * allowlist: exactly it, minus the blocklist — `seededFamilies` is not
 * consulted (the declaration replaces the heuristic it cannot see past).
 * Without one: the heuristic — a model is servable when its provider family
 * has a seeded `platform` secret — minus the blocklist.
 */
export function servableLlmModels(
  policy: ModelPolicy,
  seededFamilies: ReadonlySet<string>,
): string[] {
  const base = policy.allowlist ?? Object.keys(MODEL_PRICING);
  const blocked = new Set(policy.blocklist);
  return base.filter((m) => {
    if (blocked.has(m)) return false;
    if (policy.allowlist !== null) return true;
    const family = providerForModel(m);
    return family !== undefined && seededFamilies.has(family);
  });
}
