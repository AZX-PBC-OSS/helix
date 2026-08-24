import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BASELINE_BYTES_PER_DAY,
  BASELINE_DOLLARS_PER_DAY,
  BASELINE_FETCH_REQUESTS_PER_DAY,
  BASELINE_WRITES_PER_DAY,
  CapabilityCatalogueSchema,
  MODEL_PRICING,
  providerForModel,
  type CapabilityCatalogue,
} from "@azx-pbc/shared";
import { authHeader, buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";
import { withEnv } from "../test/env.js";

/**
 * GET /api/v1/capabilities + GET /api/v1/skill (ADR-0036) — the deployment
 * capability catalogue and its rendered skill. Both behind the ADR-0024 bearer
 * chain; the connection catalogue leaks vendor relationships, so the disclosure
 * is authed. The dev token authenticates; platform/global secrets are seeded
 * directly via Prisma because the catalogue reads only `name` (never `material`),
 * so the custody seam is irrelevant to these assertions.
 */
let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});
afterAll(async () => {
  // Clean up seeded secrets before disconnecting — the shared test DB persists
  // across files, so a leftover platform/global row would skew other suites.
  await cleanupSeeded();
  await t.close();
});

/** Names this test seeded, so afterAll can remove them without touching others. */
const seededNames: { scope: string; env: string; name: string }[] = [];

async function seedSecret(opts: {
  scope: "platform" | "global" | "app";
  name: string;
  appId?: string;
  env?: "prod" | "dev";
}): Promise<void> {
  // Clear any leftover from a prior run under the same (scope, env, name) so the
  // create cannot trip the partial unique index on admin-scope names.
  await t.prisma.appSecret.deleteMany({
    where: { scope: opts.scope, env: opts.env ?? "prod", name: opts.name },
  });
  await t.prisma.appSecret.create({
    data: {
      scope: opts.scope,
      appId: opts.appId ?? null,
      env: opts.env ?? "prod",
      name: opts.name,
      // The catalogue never reads material; a placeholder is enough to stand a
      // row up for the name query.
      material: "test-placeholder",
      injection: { kind: "header-bearer" },
      createdBy: "catalogue-test",
    },
  });
  seededNames.push({ scope: opts.scope, env: opts.env ?? "prod", name: opts.name });
}

async function cleanupSeeded(): Promise<void> {
  for (const s of seededNames) {
    await t.prisma.appSecret.deleteMany({
      where: { scope: s.scope, env: s.env, name: s.name },
    });
  }
  seededNames.length = 0;
}

async function catalogue(
  headers: Record<string, string> = authHeader(),
): Promise<CapabilityCatalogue> {
  const res = await t.app.inject({ url: "/api/v1/capabilities", headers });
  expect(res.statusCode).toBe(200);
  return CapabilityCatalogueSchema.parse(res.json());
}

describe("GET /api/v1/capabilities", () => {
  it("refuses without a bearer token", async () => {
    const res = await t.app.inject({ url: "/api/v1/capabilities" });
    expect(res.statusCode).toBe(401);
  });

  it("returns a valid catalogue with every section", async () => {
    const body = await catalogue();
    expect(body.visibility.modes.length).toBeGreaterThan(0);
    expect(body.llm.models).toBeInstanceOf(Array);
    expect(body.data.provisioned).toBe(true);
    expect(body.fetch.connections).toBeInstanceOf(Array);
    expect(body.mcp.enforced).toBe(false);
    expect(body.offline.available).toBe(true);
    expect(body.deploy.maxFileMb).toBeGreaterThan(0);
    expect(body.deploy.maxBundleMb).toBeGreaterThan(0);
    expect(body.approval.baselines.dollarsPerDay).toBe(BASELINE_DOLLARS_PER_DAY);
    expect(body.approval.elevationTriggers).toContain("publicVisibility");
  });

  describe("visibility modes", () => {
    it("includes group when an IdP is configured", async () => {
      // The default test app builds authPublicConfig from PORTAL_OIDC_ISSUER,
      // which is set in the dev container.
      const body = await catalogue();
      expect(body.visibility.modes).toContain("internal");
      expect(body.visibility.modes).toContain("group");
    });

    it("omits group on a dev-token-only portal", async () => {
      const devOnly = buildTestApp({ auth: { publicConfig: null } });
      try {
        await devOnly.app.ready();
        const res = await devOnly.app.inject({
          url: "/api/v1/capabilities",
          headers: authHeader(),
        });
        expect(res.statusCode).toBe(200);
        const body = CapabilityCatalogueSchema.parse(res.json());
        expect(body.visibility.modes).toContain("internal");
        expect(body.visibility.modes).not.toContain("group");
      } finally {
        await devOnly.close();
      }
    });
  });

  describe("servable LLM models", () => {
    // A model is servable when its upstream family (from MODEL_PRICING) has a
    // seeded `platform` secret. Seeding only `anthropic` advertises the
    // claude-* line and withholds gpt-*/o*; seeding `openai` then adds them.
    it("advertises only models whose family has a seeded platform secret", async () => {
      await cleanupSeeded();
      await seedSecret({ scope: "platform", name: "anthropic" });

      const body = await catalogue();
      const claudeModels = Object.keys(MODEL_PRICING).filter(
        (m) => providerForModel(m) === "anthropic",
      );
      const openaiModels = Object.keys(MODEL_PRICING).filter(
        (m) => providerForModel(m) === "openai",
      );
      for (const m of claudeModels) expect(body.llm.models).toContain(m);
      for (const m of openaiModels) expect(body.llm.models).not.toContain(m);

      await seedSecret({ scope: "platform", name: "openai" });
      const after = await catalogue();
      for (const m of openaiModels) expect(after.llm.models).toContain(m);

      await cleanupSeeded();
      // Removing both drops every curated model — proves the mechanism works in
      // both directions (seeding adds, unseeding withholds).
      const empty = await catalogue();
      expect(empty.llm.models).not.toContain("claude-haiku-4-5");
      expect(empty.llm.models).not.toContain("gpt-4o");
    });
  });

  describe("fetch connections", () => {
    it("lists global connection names, not app-scoped secrets", async () => {
      await cleanupSeeded();
      const globalName = uniqueSlug("g");
      const appName = uniqueSlug("a");
      // An app-scoped secret needs an app row.
      const slug = await createApp();
      const app = await t.prisma.app.findUnique({ where: { slug } });
      await seedSecret({ scope: "global", name: globalName });
      await seedSecret({ scope: "app", name: appName, appId: app!.id });

      const body = await catalogue();
      const names = body.fetch.connections.map((c) => c.name);
      expect(names).toContain(globalName);
      expect(names).not.toContain(appName);
      await cleanupSeeded();
    });
  });

  describe("deploy caps + dev-gateway base", () => {
    it("reports the deploy size caps in megabytes", async () => {
      const body = await catalogue();
      expect(body.deploy.maxFileMb).toBe(50);
      expect(body.deploy.maxBundleMb).toBe(250);
    });

    it("omits devApiBase when the dev gateway is not deployed", async () => {
      await withEnv({ DEV_API_PUBLIC_BASE: undefined }, async () => {
        const body = await catalogue();
        expect(body.devApiBase).toBeUndefined();
      });
    });

    it("reports devApiBase when the dev gateway is deployed", async () => {
      await withEnv({ DEV_API_PUBLIC_BASE: "https://dev-api.apps.example.com" }, async () => {
        const body = await catalogue();
        expect(body.devApiBase).toBe("https://dev-api.apps.example.com");
      });
    });
  });

  describe("approval baselines + elevation triggers", () => {
    it("carries the four baselines from @azx-pbc/shared", async () => {
      const body = await catalogue();
      expect(body.approval.baselines).toEqual({
        dollarsPerDay: BASELINE_DOLLARS_PER_DAY,
        writesPerDay: BASELINE_WRITES_PER_DAY,
        bytesPerDay: BASELINE_BYTES_PER_DAY,
        fetchRequestsPerDay: BASELINE_FETCH_REQUESTS_PER_DAY,
      });
    });

    it("enumerates the requests that queue for a human", async () => {
      const body = await catalogue();
      expect(body.approval.elevationTriggers).toEqual(
        expect.arrayContaining([
          "externalOrigins",
          "fetchOrigins",
          "mcp",
          "publicVisibility",
          "budgetAboveBaseline",
          "uncuratedLlmModel",
        ]),
      );
    });
  });
});

describe("GET /api/v1/skill", () => {
  it("refuses without a bearer token", async () => {
    const res = await t.app.inject({ url: "/api/v1/skill" });
    expect(res.statusCode).toBe(401);
  });

  it("renders text/markdown with no leftover placeholders", async () => {
    const res = await t.app.inject({ url: "/api/v1/skill", headers: authHeader() });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/markdown/);
    const body = res.body;
    expect(body).not.toContain("{{");
    expect(body).not.toContain("<!--");
    // The portal origin is read off the request host.
    expect(body).toContain("localhost");
  });

  it("states the approval baselines", async () => {
    const res = await t.app.inject({ url: "/api/v1/skill", headers: authHeader() });
    expect(res.body).toContain(`$${BASELINE_DOLLARS_PER_DAY}/day of LLM`);
    expect(res.body).toContain(`${BASELINE_WRITES_PER_DAY} writes/day`);
  });

  // Ties the catalogue's servable list to the skill: with only `anthropic`
  // seeded, the skill's model line lists claude models and withholds gpt-*.
  it("renders the servable models, not the curated superset", async () => {
    await cleanupSeeded();
    await seedSecret({ scope: "platform", name: "anthropic" });
    try {
      const res = await t.app.inject({ url: "/api/v1/skill", headers: authHeader() });
      const line = res.body
        .split("\n")
        .find((l) => l.includes("Models this platform prices and will serve"));
      expect(line).toBeDefined();
      expect(line).toContain("claude-haiku-4-5");
      expect(line).not.toContain("gpt-4o");
    } finally {
      await cleanupSeeded();
    }
  });
});

/** Create an app through the API and return its slug (needed for app-scoped secrets). */
async function createApp(): Promise<string> {
  const slug = uniqueSlug();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: "Catalogue test" },
  });
  expect(res.statusCode).toBe(201);
  return slug;
}
