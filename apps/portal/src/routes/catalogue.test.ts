import { randomUUID } from "node:crypto";
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
import { SERVING_JOBS_CATALOGUE, withEnv } from "../test/env.js";

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

  describe("operator model policy (ADR-0047)", () => {
    it("an allowlist replaces the seeded-secret heuristic entirely", async () => {
      // The keyless-Foundry shape: NO platform secrets seeded, yet the deployed
      // models must advertise — the operator's declaration IS the servable set.
      await cleanupSeeded();
      await withEnv({ PORTAL_LLM_MODEL_ALLOWLIST: "claude-opus-4-8,gpt-5-mini" }, async () => {
        const body = await catalogue();
        expect(body.llm.models).toEqual(["claude-opus-4-8", "gpt-5-mini"]);
      });
      // …and with the var gone, the heuristic resumes.
      await seedSecret({ scope: "platform", name: "anthropic" });
      const after = await catalogue();
      expect(after.llm.models).toContain("claude-opus-4-8");
      expect(after.llm.models).not.toContain("gpt-5-mini");
      await cleanupSeeded();
    });

    it("drops allowlist entries that name no catalog model", async () => {
      await cleanupSeeded();
      await withEnv({ PORTAL_LLM_MODEL_ALLOWLIST: "claude-opus-4-8,claude-typo-9" }, async () => {
        const body = await catalogue();
        expect(body.llm.models).toEqual(["claude-opus-4-8"]);
      });
    });

    it("subtracts the blocklist from the heuristic result", async () => {
      await cleanupSeeded();
      await seedSecret({ scope: "platform", name: "anthropic" });
      await seedSecret({ scope: "platform", name: "openai" });
      await withEnv({ PORTAL_LLM_MODEL_BLOCKLIST: "claude-fable-5,claude-fable-5-1" }, async () => {
        const body = await catalogue();
        expect(body.llm.models).not.toContain("claude-fable-5");
        expect(body.llm.models).not.toContain("claude-fable-5-1");
        expect(body.llm.models).toContain("claude-opus-4-8");
        expect(body.llm.models).toContain("gpt-5-mini");
      });
      await cleanupSeeded();
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

  describe("fetch providers", () => {
    /** Unique per-run ref, so parallel suites' provider rows never collide. */
    const ref = `cat-${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    /** Seed a provider row directly — the catalogue reads rows, not the vault. */
    async function seedProvider(env: "prod" | "dev"): Promise<void> {
      await t.prisma.connectionProvider.deleteMany({ where: { ref, env } });
      await t.prisma.connectionProvider.create({
        data: {
          ref,
          kind: "rest-delegated",
          displayName: "Asana",
          authorizeEndpoint: "https://vendor.example/oauth/authorize",
          tokenEndpoint: "https://vendor.example/oauth/token",
          requestedScopes: ["default"],
          apiOrigins: ["https://api.asana.com"],
          tokenPlacement: { kind: "header-bearer" },
          env,
          clientIdMaterial: "sealed-client-id",
          clientSecretMaterial: "sealed-client-secret",
        },
      });
    }

    afterAll(async () => {
      await t.prisma.connectionProvider.deleteMany({ where: { ref } });
    });

    it("returns every configured provider to a signed-in principal, metadata only", async () => {
      await seedProvider("prod");
      await seedProvider("dev");
      // Raw env-pinned rows: the same ref appears once per environment.
      const body = await catalogue();
      const entries = body.fetch.providers.filter((p) => p.ref === ref);
      expect(entries.map((p) => `${p.env}`).sort()).toEqual(["dev", "prod"]);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          ref,
          kind: "rest-delegated",
          displayName: "Asana",
          apiOrigins: ["https://api.asana.com"],
        });
      }

      // No credential field anywhere in the payload — not even an empty one.
      const raw = await t.app.inject({
        url: "/api/v1/capabilities",
        headers: authHeader(),
      });
      expect(raw.statusCode).toBe(200);
      const rawBody = raw.body;
      expect(rawBody).not.toContain("clientIdMaterial");
      expect(rawBody).not.toContain("clientSecretMaterial");
      expect(rawBody).not.toContain("sealed-client");
    });

    it("leaves the existing catalogue sections unchanged beside the providers list", async () => {
      const body = await catalogue();
      expect(body.fetch.connections).toBeInstanceOf(Array);
      expect(body.fetch.externalOriginsPermitted).toBe(true);
      expect(body.fetch.baselineRequestsPerDay).toBe(BASELINE_FETCH_REQUESTS_PER_DAY);
      expect(body.fetch.providers).toBeInstanceOf(Array);
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

  describe("background jobs (the installed-type catalogue)", () => {
    // The block is derived from `PORTAL_JOBS_CATALOGUE` — the deployment's
    // credential-free server map — read per call, so each case sets the env
    // around its inject. Unset is a fully disabled installation.
    it("is absent on a fully disabled installation (unset)", async () => {
      await withEnv({ PORTAL_JOBS_CATALOGUE: undefined }, async () => {
        expect((await catalogue()).jobs).toBeUndefined();
      });
    });

    it("is absent when the map is explicitly empty", async () => {
      await withEnv({ PORTAL_JOBS_CATALOGUE: '{"servers":{}}' }, async () => {
        expect((await catalogue()).jobs).toBeUndefined();
      });
    });

    it("advertises the serving entries' installed types with their display names", async () => {
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        expect((await catalogue()).jobs).toEqual({
          types: [{ id: "jobs:fetch", displayName: "Outbound fetch job" }],
        });
      });
    });

    it("advertises the diagnostic type on a non-production stack that listed it", async () => {
      await withEnv(
        {
          PORTAL_JOBS_CATALOGUE:
            '{"servers":{"jobs":{"state":"serving","types":["jobs:fetch","jobs:diagnostic"]}}}',
        },
        async () => {
          expect((await catalogue()).jobs).toEqual({
            types: [
              { id: "jobs:fetch", displayName: "Outbound fetch job" },
              { id: "jobs:diagnostic", displayName: "Diagnostic job (non-production)" },
            ],
          });
        },
      );
    });

    it("withdraws a retiring type while the block survives (an empty list)", async () => {
      await withEnv(
        {
          PORTAL_JOBS_CATALOGUE: '{"servers":{"jobs":{"state":"retiring","types":["jobs:fetch"]}}}',
        },
        async () => {
          expect((await catalogue()).jobs).toEqual({ types: [] });
        },
      );
    });

    it("discloses no routing or credential field — the entry is the id and its name", async () => {
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        const raw = await t.app.inject({ url: "/api/v1/capabilities", headers: authHeader() });
        const jobs = (await catalogue()).jobs;
        expect(jobs).toBeDefined();
        for (const entry of jobs!.types) {
          expect(Object.keys(entry).sort()).toEqual(["displayName", "id"]);
        }
        for (const private_ of [
          "endpoint",
          "databaseUrl",
          "callbackUrl",
          "roots",
          "edgeToJobs",
          "synthetic",
        ]) {
          expect(raw.body).not.toContain(private_);
        }
      });
    });

    it("a malformed source is a platform failure (500), never a client 400", async () => {
      for (const bad of ["not json", '{"servers":{"jobs":{"state":"serving"}}}']) {
        await withEnv({ PORTAL_JOBS_CATALOGUE: bad }, async () => {
          const res = await t.app.inject({ url: "/api/v1/capabilities", headers: authHeader() });
          expect(res.statusCode, bad).toBe(500);
        });
      }
    });

    it("a source leaking a credential field fails the parse — the strict form is the custody line", async () => {
      await withEnv(
        {
          PORTAL_JOBS_CATALOGUE:
            '{"servers":{"jobs":{"state":"serving","types":["jobs:fetch"],"roots":{"edgeToJobs":"x","jobsToEdge":"y","portalToJobs":"z"}}}}',
        },
        async () => {
          const res = await t.app.inject({ url: "/api/v1/capabilities", headers: authHeader() });
          expect(res.statusCode).toBe(500);
        },
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

  // Same tie for the operator-declared path (ADR-0047): the skill an agent
  // reads must not name a model this deployment withholds.
  it("renders the operator-declared allowlist, with no secrets seeded", async () => {
    await cleanupSeeded();
    await withEnv({ PORTAL_LLM_MODEL_ALLOWLIST: "claude-opus-4-8" }, async () => {
      const res = await t.app.inject({ url: "/api/v1/skill", headers: authHeader() });
      const line = res.body
        .split("\n")
        .find((l) => l.includes("Models this platform prices and will serve"));
      expect(line).toBeDefined();
      expect(line).toContain("claude-opus-4-8");
      expect(line).not.toContain("gpt-4o");
    });
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
