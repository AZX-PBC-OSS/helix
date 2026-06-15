import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authHeader, buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

/** Create an app and seed gateway_calls rows for it; returns the app id + slug. */
async function seedApp(
  calls: Array<{
    userOid?: string;
    capability?: string;
    model?: string;
    inputTokens?: number;
    outputTokens?: number;
    outcome?: string;
  }>,
): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug();
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: "Usage Test" },
  });
  const id = created.json().id as string;
  for (const c of calls) {
    await t.prisma.gatewayCall.create({
      data: {
        appId: id,
        userOid: c.userOid ?? "user-1",
        capability: c.capability ?? "llm",
        model: c.model ?? "claude-opus-4-8",
        inputTokens: c.inputTokens ?? 0,
        outputTokens: c.outputTokens ?? 0,
        outcome: c.outcome ?? "ok",
      },
    });
  }
  return { id, slug };
}

describe("GET /api/v1/apps/:slug/usage", () => {
  it("requires a bearer token (401)", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/apps/whatever/usage" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("404s an unknown app", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${uniqueSlug()}/usage`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("aggregates today's calls into a usage summary", async () => {
    const { id, slug } = await seedApp([
      { inputTokens: 1000, outputTokens: 2000, outcome: "ok" },
      { inputTokens: 500, outputTokens: 500, outcome: "ok" },
      { inputTokens: 0, outputTokens: 0, outcome: "quota_blocked" },
    ]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/usage?window=1`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.appId).toBe(id);
    expect(body.windowDays).toBe(1);
    expect(body.requests).toBe(3);
    expect(body.inputTokens).toBe(1500);
    expect(body.outputTokens).toBe(2500);
    expect(body.errorRate).toBeCloseTo(1 / 3, 5);
    expect(body.byOutcome).toEqual({ ok: 2, quota_blocked: 1 });
    expect(body.byModel).toEqual([{ model: "claude-opus-4-8", tokens: 4000, requests: 3 }]);
  });
});

describe("GET /api/v1/gateway/audit", () => {
  it("requires a bearer token (401)", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/gateway/audit" });
    expect(res.statusCode).toBe(401);
  });

  it("returns this app's calls newest-first with the slug joined", async () => {
    const { slug } = await seedApp([
      { model: "claude-opus-4-8", inputTokens: 10, outputTokens: 20 },
      { model: "claude-haiku-4-5", inputTokens: 30, outputTokens: 40 },
    ]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/gateway/audit?app=${slug}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r: { slug: string }) => r.slug === slug)).toBe(true);
    // Newest-first: the second-inserted row comes back first.
    const times = body.rows.map((r: { createdAt: string }) => r.createdAt);
    expect(times[0] >= times[1]).toBe(true);
  });

  it("filters by outcome", async () => {
    const { slug } = await seedApp([{ outcome: "ok" }, { outcome: "error" }, { outcome: "error" }]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/gateway/audit?app=${slug}&outcome=error`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rows).toHaveLength(2);
    expect(body.rows.every((r: { outcome: string }) => r.outcome === "error")).toBe(true);
  });
});

describe("GET /api/v1/gateway/usage (platform)", () => {
  it("requires a bearer token (401)", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/gateway/usage" });
    expect(res.statusCode).toBe(401);
  });

  it("includes a seeded app in the platform rollup", async () => {
    const { slug } = await seedApp([{ inputTokens: 100, outputTokens: 100, outcome: "ok" }]);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/gateway/usage",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tokens14d).toHaveLength(14);
    expect(body.requests14d).toHaveLength(14);
    // Robust to other tests' data: just assert our app's own rollup entry.
    const mine = body.byApp.find((a: { slug: string | null }) => a.slug === slug);
    expect(mine).toMatchObject({ slug, tokens: 200, requests: 1 });
    expect(body.totals.tokensMTD).toBeGreaterThanOrEqual(200);
  });
});
