/**
 * Render the deployment-independent SKILL.md template (ADR-0036).
 * renderSkill substitutes deployment values for the portal and helix skill.
 * renderSkillGeneric substitutes descriptions for the public docs site.
 * Optional sections (dev gateway, background jobs) use conditional blocks.
 *
 * Both modes must replace every placeholder and remove conditional markers;
 * tests check for leftover {{ and <!--. This package only transforms strings
 * and has no runtime dependencies, filesystem access, or network calls.
 */

/** The filename the skill should be saved as; also the name the SPA downloads it under. */
export const SKILL_FILENAME = "SKILL.md";

/** The public app-author guide the jobs section links to (the docs site's `apps/jobs` page). */
export const JOBS_GUIDE_URL = "https://azx-pbc-oss.github.io/helix/apps/jobs";

/** One job type a deployment offers for new grants, as the capability catalogue carries it. */
export interface SkillJobType {
  id: string;
  displayName: string;
}

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
  /**
   * The job types this deployment offers for new grants (the catalogue's `jobs.types`), or
   * `null` when jobs is fully disabled here. An empty list means every job server is retiring.
   */
  jobTypes: readonly SkillJobType[] | null;
}

/**
 * Blocks the template marks as conditional: `IF:DEV_API` sections describe the
 * opt-in dev gateway, `IF:JOBS_OFFERED`/`IF:JOBS_WITHDRAWN` the background-jobs
 * capability. A deployment without a feature should not hand an agent prose
 * about a base URL that will never answer or a grant that cannot be made.
 *
 * Anchored per line (`^…$`) so a marker that something reflowed onto a line with
 * other content — a Markdown formatter turning a preceding `---` and the comment
 * into a `## <!-- IF:DEV_API -->` heading, say — fails to match and leaves the
 * marker visible, instead of matching from mid-line and quietly stranding the
 * text in front of it. `SKILL.md` is in `.prettierignore` for the same reason.
 *
 * Blocks of different names may nest (the dev-gateway note inside
 * IF:JOBS_OFFERED); same-name nesting is not supported.
 */
function conditionalBlock(name: string): RegExp {
  return new RegExp(
    String.raw`^[^\S\n]*<!-- IF:${name} -->\n([\s\S]*?)^[^\S\n]*<!-- /IF:${name} -->\n?`,
    "gm",
  );
}

/** Keep a conditional block's inner text (markers stripped), or drop the whole block. */
function applyBlock(body: string, name: string, keep: boolean): string {
  return keep
    ? body.replace(conditionalBlock(name), (_all, inner: string) => inner)
    : body.replace(conditionalBlock(name), "");
}

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
 * fails the suite rather than shipping to an agent. The same guard covers the
 * conditional blocks (dev gateway, background jobs): every marker must be
 * consumed in both modes.
 */
export function renderSkill(template: string, vars: SkillVars): string {
  const jobTypes = vars.jobTypes ?? [];
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
    JOB_TYPES: jobTypes.map((t) => `\`${t.id}\` (${t.displayName})`).join(", "),
    JOBS_GUIDE_URL,
  };

  // Offered and withdrawn are mutually exclusive: a deployment either offers at
  // least one type, or holds the block that explains retirement. `null` (jobs
  // fully disabled) drops both. Outer blocks first — IF:DEV_API nests inside
  // IF:JOBS_OFFERED.
  const jobsOffered = vars.jobTypes !== null && jobTypes.length > 0;
  let body = applyBlock(template, "JOBS_OFFERED", jobsOffered);
  body = applyBlock(body, "JOBS_WITHDRAWN", vars.jobTypes !== null && !jobsOffered);
  body = applyBlock(body, "DEV_API", Boolean(vars.devApiBase));

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
    JOB_TYPES:
      "the job types your deployment offers, if any — see `jobs.types` in `GET /api/v1/capabilities`; a deployment without jobs omits this section",
    JOBS_GUIDE_URL: "/apps/jobs",
  };

  // Keep the dev-gateway and jobs-offered blocks in the generic rendering
  // (markers stripped): the prose substitutions carry the deployment-dependent
  // note, and the offered section already explains retirement — so the
  // withdrawn alternative is dropped.
  let body = applyBlock(template, "JOBS_OFFERED", true);
  body = applyBlock(body, "JOBS_WITHDRAWN", false);
  body = applyBlock(body, "DEV_API", true);

  return substitute(body, substitutions);
}
