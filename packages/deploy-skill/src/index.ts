/**
 * The agent skill bundle (project plan §2, architecture v1) — `SKILL.md` plus the
 * tiny renderer that turns it into something an agent can act on.
 *
 * `SKILL.md` is deployment-agnostic on disk: every host it mentions is a
 * `{{PLACEHOLDER}}`, and the dev-gateway section is wrapped in a conditional
 * block, because the gateway is an opt-in deployment. A consumer reads the file,
 * calls {@link renderSkill} with this deployment's topology (from
 * `GET /api/v1/config`), and hands the result to the agent. Nothing here reaches
 * for a bundler, the filesystem, or the network: the portal SPA imports the
 * markdown with Vite's `?raw` and a future `helix skill` command would read it
 * off disk, but the substitution rules stay in one place either way.
 *
 * Zero runtime dependencies, on purpose — the package is a document plus a
 * string transform.
 */

/** The filename the skill should be saved as; also the name the SPA downloads it under. */
export const SKILL_FILENAME = "SKILL.md";

/**
 * This deployment's topology, as the skill needs to state it. Every field is a
 * value the control plane knows and the app author does not — which is the whole
 * reason the template is rendered rather than shipped verbatim.
 */
export interface SkillVars {
  /** Origin serving the portal API, e.g. `https://portal.example.com`. */
  portalOrigin: string;
  /** Host (with port, if any) apps are served under — an app lives at `https://<slug>.<appsHost>`. */
  appsHost: string;
  /** Dev-gateway base with no slug, e.g. `https://dev-api.example.com`; `null` when not deployed here. */
  devApiBase: string | null;
  /** Model ids this platform prices and will serve, for the manifest allowlist. */
  llmModels: readonly string[];
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

/**
 * Substitute this deployment's values into the skill template.
 *
 * Adding a `{{PLACEHOLDER}}` to `SKILL.md` means adding a field here and at every
 * call site — the test asserts the rendered output carries no leftover `{{`, so a
 * half-wired placeholder fails the suite rather than shipping to an agent.
 */
export function renderSkill(template: string, vars: SkillVars): string {
  const substitutions: Record<string, string> = {
    PORTAL_ORIGIN: vars.portalOrigin,
    APPS_HOST: vars.appsHost,
    DEV_API_BASE: vars.devApiBase ?? "",
    LLM_MODELS: vars.llmModels.join(", "),
  };

  const body = vars.devApiBase
    ? template.replace(DEV_API_BLOCK, (_all, inner: string) => inner)
    : template.replace(DEV_API_BLOCK, "");

  return body.replace(/\{\{([A-Z_]+)\}\}/g, (all, key: string) =>
    key in substitutions ? (substitutions[key] as string) : all,
  );
}
