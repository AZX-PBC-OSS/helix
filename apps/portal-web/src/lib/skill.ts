import { useMemo } from "react";
import { MODEL_PRICING } from "@azx-pbc/shared";
import { renderSkill } from "@azx-pbc/deploy-skill";
import skillTemplate from "@azx-pbc/deploy-skill/SKILL.md?raw";
import { portalOrigin, useDeployment } from "./deployment";

/**
 * `packages/deploy-skill/SKILL.md` rendered for *this* deployment, or `null`
 * while `GET /api/v1/config` is still in flight.
 *
 * The null is the point: the template's hosts and size caps are
 * `{{PLACEHOLDER}}`s, and what leaves this SPA is acted on directly by a coding
 * agent. Handing one a skill with a placeholder host still in it — or with the
 * default caps rather than this deployment's — is worse than handing it nothing,
 * so every surface that offers the skill offers a *disabled* control until the
 * config lands. That rule lives here rather than at the call sites, which is why
 * this is a hook and not a function: two surfaces hand the skill out (the
 * onboarding modal and the My Apps handoff band) and they must not diverge.
 *
 * Memoised because `AppsListPage` re-renders on every search keystroke.
 */
export function useRenderedSkill(): string | null {
  const { appsHost, devApiBase, deployMaxFileMb, deployMaxBundleMb } = useDeployment();
  const portal = portalOrigin();

  return useMemo(
    () =>
      appsHost && deployMaxFileMb !== null && deployMaxBundleMb !== null
        ? renderSkill(skillTemplate, {
            portalOrigin: portal,
            appsHost,
            devApiBase,
            llmModels: Object.keys(MODEL_PRICING),
            maxFileMb: deployMaxFileMb,
            maxBundleMb: deployMaxBundleMb,
          })
        : null,
    [portal, appsHost, devApiBase, deployMaxFileMb, deployMaxBundleMb],
  );
}
