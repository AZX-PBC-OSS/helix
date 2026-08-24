import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  APPROVAL_BASELINES,
  CapabilityCatalogueSchema,
  ELEVATION_TRIGGERS,
  MODEL_PRICING,
  providerForModel,
  type CapabilityCatalogue,
} from "@azx-pbc/shared";
import { renderSkill, type SkillVars } from "@azx-pbc/deploy-skill";
import { authenticate } from "../plugins/auth.js";
import { passwordAppsAllowed, publicAppsAllowed } from "../policy/visibilityPolicy.js";
import { resolveAppPublicBase, resolveDevApiBase } from "../deployment.js";
import { resolveMaxFileBytes, resolveMaxTotalBytes } from "../deploy/limits.js";
import { visibilityModesFor } from "@azx-pbc/shared";

const MB = 1024 * 1024;

/**
 * `require.resolve` against the workspace package — the portal is the one
 * runtime that needs the skill *template* on disk (the SPA used to import it
 * with Vite's `?raw`; after ADR-0036 the portal renders server-side and the SPA
 * fetches the result). Resolved once at module load: `SKILL.md` is a static
 * authored document, not something that changes per request.
 */
const require = createRequire(import.meta.url);
const SKILL_TEMPLATE = readFileSync(require.resolve("@azx-pbc/deploy-skill/SKILL.md"), "utf8");

/**
 * The deployment capability catalogue + the rendered skill (ADR-0036). Both
 * sit behind the ADR-0024 bearer chain (decision 5): the connection catalogue
 * lists named integrations this deployment has provisioned, which leaks vendor
 * relationships and internal service names — a real, if small, disclosure. No
 * secret *value* is ever in either response, so this needs no new role or grant.
 *
 * The catalogue is instance-wide, not per-app: its most useful payload is which
 * requests **auto-approve** (decision 3), and that is a menu of what is
 * *requestable* here, not a report of what some app already holds.
 */
export async function catalogueRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/capabilities", { preHandler: authenticate }, async () => {
    return CapabilityCatalogueSchema.parse(await buildCatalogue(app));
  });

  app.get("/api/v1/skill", { preHandler: authenticate }, async (req, reply) => {
    const catalogue = await buildCatalogue(app);
    const vars = skillVarsFromCatalogue(catalogue, req);
    reply.type("text/markdown; charset=utf-8");
    return renderSkill(SKILL_TEMPLATE, vars);
  });
}

/**
 * Assemble the catalogue from data the portal already holds or can query. The
 * one fact it cannot observe — the edge's routing-table composition — is
 * approximated by the seeded `platform` secrets (ADR-0036 §Consequences): under
 * the default symmetric wiring a model is servable when its upstream family has
 * a seeded platform key, so a deployment that never seeded the `openai` secret
 * stops advertising `gpt-*`. The list must agree with
 * `RoutingLlmProvider.supports()` or the 503 pre-check reappears at call time;
 * under the symmetric-wiring assumption it does.
 */
async function buildCatalogue(app: FastifyInstance): Promise<CapabilityCatalogue> {
  // ── Visibility: `group` needs an IdP; `password`/`public` need operator opt-in.
  const idpConfigured = app.authPublicConfig !== null;
  const modes = visibilityModesFor({
    idpConfigured,
    allowPublicApps: publicAppsAllowed(),
    allowPasswordApps: passwordAppsAllowed(),
  });

  // ── Servable LLM models: curated ∩ (family has a seeded platform secret).
  // The platform secret name defaults to the provider family (`anthropic` /
  // `openai`); an operator who overrode `EDGE_LLM_*_CONNECTION` would see
  // inaccurate filtering here — consistent with the accepted symmetric-wiring
  // assumption (ADR-0036, "secret-seeded only" for v1).
  const platformRows = await app.prisma.appSecret.findMany({
    where: { scope: "platform", env: "prod" },
    select: { name: true },
  });
  const seededFamilies = new Set(platformRows.map((r) => r.name));
  const servableModels = Object.keys(MODEL_PRICING).filter((m) => {
    const family = providerForModel(m);
    return family !== undefined && seededFamilies.has(family);
  });

  // ── Fetch connections: named `global`-scope secrets, names only. A global
  // secret has no stored origin (the origin is declared per-app in each
  // manifest), so listing one here would be a guess — an agent learns the
  // connection exists and supplies the origin itself.
  const globalRows = await app.prisma.appSecret.findMany({
    where: { scope: "global", env: "prod" },
    select: { name: true },
    orderBy: { name: "asc" },
  });

  const devApiBase = resolveDevApiBase();

  return CapabilityCatalogueSchema.parse({
    visibility: { modes },
    llm: {
      models: servableModels,
      baselineDollarsPerDay: APPROVAL_BASELINES.dollarsPerDay,
    },
    data: {
      provisioned: true,
      baselineWritesPerDay: APPROVAL_BASELINES.writesPerDay,
      baselineBytesPerDay: APPROVAL_BASELINES.bytesPerDay,
    },
    fetch: {
      externalOriginsPermitted: true,
      connections: globalRows.map((r) => ({ name: r.name })),
      baselineRequestsPerDay: APPROVAL_BASELINES.fetchRequestsPerDay,
    },
    mcp: { enforced: false },
    offline: {
      available: true,
      scopeRule: "must not be the domain root or a /_… reserved path",
    },
    deploy: {
      maxFileMb: resolveMaxFileBytes() / MB,
      maxBundleMb: resolveMaxTotalBytes() / MB,
    },
    ...(devApiBase ? { devApiBase: devApiBase.origin } : {}),
    approval: {
      baselines: APPROVAL_BASELINES,
      elevationTriggers: [...ELEVATION_TRIGGERS],
    },
  });
}

/**
 * Derive the {@link SkillVars} the renderer needs from the catalogue, plus the
 * portal origin read off the request — the one value the catalogue does not
 * carry, because the portal does not know its own public origin from an env var
 * (the SPA learned it from `window.location.origin`; the CLI from its configured
 * portal URL). Reading it from the request means a skill rendered for whoever
 * fetched it carries the origin they used to reach the portal. `x-forwarded-proto`
 * is preferred so a TLS-terminated deployment renders `https`.
 */
function skillVarsFromCatalogue(catalogue: CapabilityCatalogue, req: FastifyRequest): SkillVars {
  return {
    portalOrigin: portalOriginFromRequest(req),
    appsHost: resolveAppPublicBase().host,
    devApiBase: catalogue.devApiBase ?? null,
    llmModels: catalogue.llm.models,
    maxFileMb: catalogue.deploy.maxFileMb,
    maxBundleMb: catalogue.deploy.maxBundleMb,
    baselineDollarsPerDay: catalogue.approval.baselines.dollarsPerDay,
    baselineWritesPerDay: catalogue.approval.baselines.writesPerDay,
    baselineBytesPerDay: catalogue.approval.baselines.bytesPerDay,
    baselineFetchRequestsPerDay: catalogue.approval.baselines.fetchRequestsPerDay,
  };
}

/** The portal's own origin, as the request reached it. */
function portalOriginFromRequest(req: FastifyRequest): string {
  const fwd = req.headers["x-forwarded-proto"];
  const proto = (typeof fwd === "string" ? fwd.split(",")[0]!.trim() : "http") || "http";
  const host = req.headers.host;
  return `${proto}://${host}`;
}
