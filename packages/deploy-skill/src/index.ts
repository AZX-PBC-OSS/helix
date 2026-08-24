/**
 * The agent skill bundle (project plan §2, architecture v1) — `SKILL.md` plus the
 * tiny renderer that turns it into something an agent can act on.
 *
 * `SKILL.md` is deployment-agnostic on disk: every host it mentions is a
 * `{{PLACEHOLDER}}`, and the dev-gateway section is wrapped in a conditional
 * block, because the gateway is an opt-in deployment. Two render modes share one
 * template (ADR-0036):
 *
 *  - {@link renderSkill} — the **instance** rendering, substituting this
 *    deployment's real values. Served by `GET /api/v1/skill` and consumed by the
 *    portal SPA and the `helix skill` CLI command.
 *  - {@link renderSkillGeneric} — the **generic** rendering, substituting
 *    descriptive prose for each placeholder ("your deployment's apps host — see
 *    `GET /api/v1/capabilities`"). The public docs site consumes this; there is
 *    no public *skill*, only public *docs*.
 *
 * Nothing here reaches for a bundler, the filesystem, or the network: this is a
 * document plus a string transform. The "no leftover `{{`" / "no `<!--`"
 * assertions in the test cover **both** modes, so a new placeholder fails the
 * suite until both maps are wired.
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
 *
 * The four `baseline*` fields feed `{{BASELINE_*}}` placeholders in §2 so the
 * skill's "what needs approval" prose stays accurate when an operator retunes a
 * threshold. They are sourced from `@azx-pbc/shared`'s approval constants until
 * something makes them per-deployment configurable; the seam exists before it is
 * needed, and the placeholder test guards it.
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
  /** Deploy size caps in MB, as this deployment configures them (not the defaults). */
  maxFileMb: number;
  maxBundleMb: number;
  /** LLM daily spend cap (USD) at/under which a grant is baseline. */
  baselineDollarsPerDay: number;
  /** App-data daily write budget at/under which a grant is baseline. */
  baselineWritesPerDay: number;
  /** App-data daily byte budget at/under which a grant is baseline. */
  baselineBytesPerDay: number;
  /** Fetch-proxy daily request budget at/under which a grant is baseline. */
  baselineFetchRequestsPerDay: number;
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

/** Substitute every known `{{KEY}}` in `body`; pass an unknown token through. */
function substitute(body: string, substitutions: Record<string, string>): string {
  return body.replace(PLACEHOLDER_RE, (all, key: string) =>
    key in substitutions ? (substitutions[key] as string) : all,
  );
}

/**
 * Substitute this deployment's values into the skill template — the instance
 * rendering, served by `GET /api/v1/skill`.
 *
 * Adding a `{{PLACEHOLDER}}` to `SKILL.md` means adding a field here, a prose
 * entry in {@link renderSkillGeneric}, and at every call site — the test asserts
 * the rendered output carries no leftover `{{`, so a half-wired placeholder
 * fails the suite rather than shipping to an agent.
 */
export function renderSkill(template: string, vars: SkillVars): string {
  const substitutions: Record<string, string> = {
    PORTAL_ORIGIN: vars.portalOrigin,
    APPS_HOST: vars.appsHost,
    DEV_API_BASE: vars.devApiBase ?? "",
    LLM_MODELS: vars.llmModels.join(", "),
    MAX_FILE_MB: String(vars.maxFileMb),
    MAX_BUNDLE_MB: String(vars.maxBundleMb),
    BASELINE_DOLLARS_PER_DAY: String(vars.baselineDollarsPerDay),
    BASELINE_WRITES_PER_DAY: String(vars.baselineWritesPerDay),
    BASELINE_BYTES_PER_DAY: String(vars.baselineBytesPerDay),
    BASELINE_FETCH_REQUESTS_PER_DAY: String(vars.baselineFetchRequestsPerDay),
  };

  const body = vars.devApiBase
    ? template.replace(DEV_API_BLOCK, (_all, inner: string) => inner)
    : template.replace(DEV_API_BLOCK, "");

  return substitute(body, substitutions);
}

/**
 * The **generic** rendering — descriptive prose in place of every placeholder,
 * pointing the reader at their own deployment's `GET /api/v1/capabilities` for
 * values (ADR-0036 decision 1). The public docs site consumes this; there is no
 * public *skill*, only public *docs*.
 *
 * The `IF:DEV_API` block is **kept** (not stripped) with a note that it is
 * deployment-dependent: the dev gateway is an opt-in deployment, so a reader of
 * the generic docs should see that the section exists and learn how it works,
 * then check their own catalogue for whether it is switched on here.
 */
export function renderSkillGeneric(template: string): string {
  const substitutions: Record<string, string> = {
    PORTAL_ORIGIN: "your deployment's portal origin — see `GET /api/v1/capabilities`",
    APPS_HOST: "your deployment's apps host — see `GET /api/v1/capabilities`",
    DEV_API_BASE:
      "your deployment's dev-gateway base, if the dev gateway is deployed here — see `GET /api/v1/capabilities`",
    LLM_MODELS: "the servable models on your deployment — see `GET /api/v1/capabilities`",
    MAX_FILE_MB: "your deployment's per-file deploy cap — see `GET /api/v1/capabilities`",
    MAX_BUNDLE_MB: "your deployment's bundle deploy cap — see `GET /api/v1/capabilities`",
    BASELINE_DOLLARS_PER_DAY:
      "your deployment's LLM spend baseline — see `GET /api/v1/capabilities`",
    BASELINE_WRITES_PER_DAY:
      "your deployment's app-data write baseline — see `GET /api/v1/capabilities`",
    BASELINE_BYTES_PER_DAY:
      "your deployment's app-data byte baseline — see `GET /api/v1/capabilities`",
    BASELINE_FETCH_REQUESTS_PER_DAY:
      "your deployment's fetch-proxy request baseline — see `GET /api/v1/capabilities`",
  };

  // Always keep the dev-gateway block in the generic rendering (markers
  // stripped); the prose substitution for DEV_API_BASE carries the
  // deployment-dependent note.
  const body = template.replace(DEV_API_BLOCK, (_all, inner: string) => inner);

  return substitute(body, substitutions);
}
