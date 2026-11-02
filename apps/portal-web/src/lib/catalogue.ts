import { useQuery } from "@tanstack/react-query";
import type { CapabilityCatalogue } from "@azx-pbc/shared";
import { catalogueQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";

/** What {@link useCatalogue} hands its callers, including the failure affordance. */
export interface CatalogueState {
  catalogue: CapabilityCatalogue | null;
  failed: boolean;
  /** Re-run a failed discovery. A no-op while the query is in flight. */
  retry: () => void;
  /** True while a discovery request (initial or retried) is in flight. */
  loading: boolean;
}

/**
 * This deployment's capability catalogue (`GET /api/v1/capabilities`,
 * ADR-0036), or `null` while it has not loaded (or failed to).
 *
 * The catalogue carries the *servable* model set (ADR-0047): the operator's
 * allowlist/blocklist when declared, else the seeded-secret heuristic. The
 * model picker renders from this rather than the bundle's build-time
 * `MODEL_PRICING`, so a model this deployment cannot serve is never offered
 * as a checkbox. Rates stay build-time (`priceForModel`) — a price is a
 * per-model fact the bundle already holds; only the *list* varies per
 * deployment.
 *
 * The null is load-bearing, same rule as `useRenderedSkill`: what the picker
 * offers is acted on directly, so until the catalogue lands the caller shows
 * a loading (or failed) state rather than the compiled-in superset. The query
 * is bearer-gated server-side, hence `enabled: authenticated` — an unsigned
 * visitor keeps the disabled state rather than firing a 401.
 */
export function useCatalogue(): CatalogueState {
  const { authenticated } = useAuth();
  const { data, isError, refetch, isFetching } = useQuery({
    ...catalogueQuery,
    enabled: authenticated,
  });
  return {
    catalogue: data ?? null,
    failed: isError,
    retry: () => void refetch(),
    loading: isFetching,
  };
}
