import { MODEL_PRICING, providerForModel } from "@azx-pbc/shared";

/**
 * Models advertised by the catalogue, rendered skill, and SPA (ADR-0047).
 * Read comma-separated env values on each call:
 * - PORTAL_LLM_MODEL_ALLOWLIST, when non-empty, replaces the seeded-secret
 *   heuristic. Intersect it with the priced catalogue. Bicep derives it from
 *   foundryModels for keyless deployments, which have no vendor secret to detect.
 * - PORTAL_LLM_MODEL_BLOCKLIST removes models from either selection mode.
 *
 * This controls discovery only. The approval classifier still accepts priced
 * models omitted here, so a hand-written manifest may request one that the
 * upstream cannot serve. Unknown, unpriced models cannot be advertised.
 */

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
