import { useQuery } from "@tanstack/react-query";
import { skillQuery } from "../api/queries";
import { useAuth } from "../auth/AuthProvider";

/**
 * `packages/deploy-skill/SKILL.md` rendered for *this* deployment, or `null`
 * while it has not loaded.
 *
 * Before ADR-0036 the SPA rendered the skill itself — a Vite `?raw` import of
 * the template plus this deployment's topology from `GET /api/v1/config`, with
 * `Object.keys(MODEL_PRICING)` (the *curated* catalog) as the model list. That
 * listed models the edge could not actually serve, so an agent built against it
 * 502'd at call time. The skill is now rendered server-side by
 * `GET /api/v1/skill` from the capability catalogue, whose model list is the
 * *servable* set (curated ∩ secret-seeded) — so this hook is an authed fetch,
 * not a client-side string transform.
 *
 * The null is the point: the template's hosts and size caps are
 * `{{PLACEHOLDER}}`s, and what leaves this SPA is acted on directly by a coding
 * agent. Handing one a skill with a placeholder host still in it — or a model
 * the platform cannot serve — is worse than handing it nothing, so every surface
 * that offers the skill offers a *disabled* control until it lands. That rule
 * lives here rather than at the call sites, which is why this is a hook and not
 * a function: two surfaces hand the skill out (the onboarding modal and the apps
 * page's handoff band) and they must not diverge.
 *
 * Bearer-gated server-side, so the query is `enabled: authenticated` — an
 * unsigned visitor keeps the disabled control rather than firing a 401.
 */
export function useRenderedSkill(): string | null {
  const { authenticated } = useAuth();
  const { data } = useQuery({ ...skillQuery, enabled: authenticated });
  return data ?? null;
}
