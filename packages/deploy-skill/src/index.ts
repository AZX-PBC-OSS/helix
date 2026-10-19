/**
 * Render the SKILL.md template for one deployment (ADR-0036, ADR-0052).
 *
 * The template carries only this deployment's topology as placeholders. Values
 * that change per release or per deployment (models, budgets, caps) are not in
 * the skill at all: it points the agent at `helix capabilities` and the public
 * docs instead, so a downloaded copy stays correct.
 *
 * Rendering must replace every placeholder and remove the conditional markers;
 * tests check for leftover {{ and <!--. This package only transforms strings
 * and has no runtime dependencies, filesystem access, or network calls.
 */

/** The filename the skill should be saved as; also the name the SPA downloads it under. */
export const SKILL_FILENAME = "SKILL.md";

/**
 * This deployment's topology, as the skill needs to state it. Every field is
 * fixed once the platform is deployed, which is what lets a downloaded skill
 * stay accurate.
 */
export interface SkillVars {
  /** Origin serving the portal API, e.g. `https://portal.example.com`. */
  portalOrigin: string;
  /** Host (with port, if any) apps are served under — an app lives at `https://<slug>.<appsHost>`. */
  appsHost: string;
  /** Dev-gateway base with no slug, e.g. `https://dev-api.example.com`; `null` when not deployed here. */
  devApiBase: string | null;
}

/**
 * Blocks the template marks as dev-gateway-only. Kept when `devApiBase` is set,
 * removed wholesale when it isn't — a deployment without the gateway should not
 * hand an agent a base URL that will never answer.
 *
 * Anchored per line (`^…$`) so a marker that something reflowed onto a line with
 * other content — a Markdown formatter turning a preceding `---` and the comment
 * into a `## <!-- IF:DEV_API -->` heading, say — fails to match and leaves the
 * marker visible, instead of matching from mid-line and quietly stranding the
 * text in front of it. `SKILL.md` is in `.prettierignore` for the same reason.
 */
const DEV_API_BLOCK = /^[^\S\n]*<!-- IF:DEV_API -->\n([\s\S]*?)^[^\S\n]*<!-- \/IF:DEV_API -->\n?/gm;

const PLACEHOLDER_RE = /\{\{([A-Z_]+)\}\}/g;

/**
 * Substitute this deployment's values into the skill template, served by
 * `GET /api/v1/skill`.
 *
 * Adding a `{{PLACEHOLDER}}` to `SKILL.md` means adding a field here and at
 * every call site. Only add one for a value that is fixed per deployment; the
 * test asserts no `{{` is left over, so a half-wired placeholder fails the
 * suite rather than shipping to an agent.
 */
export function renderSkill(template: string, vars: SkillVars): string {
  const substitutions: Record<string, string> = {
    PORTAL_ORIGIN: vars.portalOrigin,
    APPS_HOST: vars.appsHost,
    DEV_API_BASE: vars.devApiBase ?? "",
  };

  const body = vars.devApiBase
    ? template.replace(DEV_API_BLOCK, (_all, inner: string) => inner)
    : template.replace(DEV_API_BLOCK, "");

  // An unknown token passes through, so the leftover-`{{` test catches it.
  return body.replace(PLACEHOLDER_RE, (all, key: string) =>
    key in substitutions ? (substitutions[key] as string) : all,
  );
}
