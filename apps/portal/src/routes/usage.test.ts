import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    /** Frozen as-charged cost in micro-USD — what the edge would have written. */
    costMicroUsd?: number;
    outcome?: string;
    /** Set on `fetch` rows only — the proxied request line. */
    path?: string;
    method?: string;
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
        costMicroUsd: BigInt(c.costMicroUsd ?? 0),
        outcome: c.outcome ?? "ok",
        path: c.path ?? null,
        method: c.method ?? null,
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

  it("aggregates a range into a usage summary with a dense series", async () => {
    const { id, slug } = await seedApp([
      { inputTokens: 1000, outputTokens: 2000, costMicroUsd: 55_000, outcome: "ok" },
      { inputTokens: 500, outputTokens: 500, costMicroUsd: 15_000, outcome: "ok" },
      { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, outcome: "quota_blocked" },
    ]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/usage?range=24h`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.appId).toBe(id);
    expect(body.range).toBe("24h");
    expect(body.requests).toBe(3);
    expect(body.inputTokens).toBe(1500);
    expect(body.outputTokens).toBe(2500);
    expect(body.errorRate).toBeCloseTo(1 / 3, 5);
    expect(body.byOutcome).toEqual({ ok: 2, quota_blocked: 1 });
    expect(body.byModel).toMatchObject([{ model: "claude-opus-4-8", tokens: 4000, requests: 3 }]);
    // Frozen cost: 55_000 + 15_000 micro-USD = $0.07.
    expect(body.byModel[0].costUsd).toBeCloseTo(0.07, 9);
    expect(body.costUsd).toBeCloseTo(0.07, 9);
    // 24h → 24 dense hourly buckets; the seeded calls land in the latest one.
    expect(body.series).toHaveLength(24);
    const seriesCost = body.series.reduce((s: number, p: { costUsd: number }) => s + p.costUsd, 0);
    expect(seriesCost).toBeCloseTo(0.07, 9);
    // Today-since-midnight gauge reflects the same seeded calls.
    expect(body.today.tokens).toBe(4000);
    expect(body.today.costUsd).toBeCloseTo(0.07, 9);
    // No timed calls seeded → p95 is null.
    expect(body.latencyP95Ms).toBeNull();
  });

  it("keeps the trend grid dense after dropping the model group key", async () => {
    // The series query used to GROUP BY (bucket, model) and re-fold in JS. It
    // now aggregates per bucket; the zero-fill comes from COUNT(gc.id) on the
    // LEFT JOIN miss, and two models in one bucket must sum, not duplicate it.
    const { slug } = await seedApp([
      { model: "claude-opus-4-8", inputTokens: 10, outputTokens: 20, costMicroUsd: 500 },
      { model: "claude-haiku-4-5", inputTokens: 30, outputTokens: 40, costMicroUsd: 200 },
    ]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/usage?range=24h`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.series).toHaveLength(24);
    // Exactly one point per bucket, and the two models landed in the same one.
    const buckets = body.series.map((p: { bucket: string }) => p.bucket);
    expect(new Set(buckets).size).toBe(24);
    const live = body.series.filter((p: { requests: number }) => p.requests > 0);
    expect(live).toHaveLength(1);
    expect(live[0].requests).toBe(2);
    expect(live[0].tokens).toBe(100);
    expect(live[0].costUsd).toBeCloseTo(0.0007, 9);
    // The daily-cap gauge sums the same rows.
    expect(body.today.tokens).toBe(100);
  });

  it("keeps denied origins out of the model breakdown but counts them as outcomes", async () => {
    // `byModel` is the one rollup still keyed on `model`. A forbidden row's
    // origin cleared no allowlist, so admitting it would make the group key
    // app-writable — and a denial has no usage to report anyway.
    const { slug } = await seedApp([
      { capability: "fetch", model: "https://api.github.com", outcome: "ok" },
      { capability: "fetch", model: "https://api.evil.com", outcome: "forbidden" },
    ]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/usage?range=24h`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.byModel.map((m: { model: string }) => m.model)).toEqual(["https://api.github.com"]);
    // Still visible as an outcome — the badge sits above this very breakdown.
    expect(body.byOutcome).toEqual({ ok: 1, forbidden: 1 });
    expect(body.requests).toBe(2);
  });
});

describe("GET /api/v1/gateway/audit", () => {
  it("requires a bearer token (401)", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/gateway/audit" });
    expect(res.statusCode).toBe(401);
  });

  it("returns this app's calls newest-first with the slug joined", async () => {
    const { slug } = await seedApp([
      { model: "claude-opus-4-8", inputTokens: 10, outputTokens: 20, costMicroUsd: 550 },
      { model: "claude-haiku-4-5", inputTokens: 30, outputTokens: 40, costMicroUsd: 230 },
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
    // Per-row cost is priced per model, and the telemetry fields are present.
    const opus = body.rows.find((r: { model: string }) => r.model === "claude-opus-4-8");
    const haiku = body.rows.find((r: { model: string }) => r.model === "claude-haiku-4-5");
    // Frozen per-row cost from the ledger column (micro-USD → USD).
    expect(opus.costUsd).toBeCloseTo(0.00055, 9);
    expect(haiku.costUsd).toBeCloseTo(0.00023, 9);
    expect(opus).toMatchObject({ durationMs: 0, statusCode: null, stopReason: null });
    expect(opus.cacheReadInputTokens).toBe(0);
    // The request line is fetch-only; an `llm` row carries neither.
    expect(opus).toMatchObject({ path: null, method: null });
  });

  it("surfaces the request line on a proxied fetch row", async () => {
    const { slug } = await seedApp([
      {
        capability: "fetch",
        model: "https://api.github.com",
        path: "/users/octocat",
        method: "GET",
      },
    ]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/gateway/audit?app=${slug}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0]).toMatchObject({
      capability: "fetch",
      model: "https://api.github.com",
      path: "/users/octocat",
      method: "GET",
    });
  });

  it("serves a conflict row instead of 500ing on it", async () => {
    // `conflict` is written by the app-data 412 path but was missing from
    // GATEWAY_OUTCOMES, so `GatewayCallSchema.parse` threw and took the whole
    // audit page down with it — for every app, until the row aged out.
    const { slug } = await seedApp([
      { capability: "data", model: "user.put", outcome: "conflict" },
    ]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/gateway/audit?app=${slug}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0]).toMatchObject({ outcome: "conflict" });
  });

  it("treats an empty outcome param as no filter, not as a bad one", async () => {
    // Fastify parses `?outcome=` and bare `?outcome` to "". Under the previous
    // truthiness check that meant "no filter"; the validation must not turn a
    // scripted client that always appends the param into a 400.
    const { slug } = await seedApp([{ outcome: "ok" }, { outcome: "error" }]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/gateway/audit?app=${slug}&outcome=`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toHaveLength(2);
  });

  it("rejects an unknown outcome filter rather than serving an empty page", async () => {
    const { slug } = await seedApp([{ outcome: "ok" }]);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/gateway/audit?app=${slug}&outcome=nonsense`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
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

/**
 * The audit log is admin-only, and the usage rollup deliberately is not.
 *
 * `PORTAL_DEV_ACTOR_GROUPS` is what puts groups on the dev token's actor, and the
 * devcontainer *and* CI both set it to `platform-admin` — so every other test in
 * this file is silently running as an admin, and a gate test that inherited that
 * would assert nothing while looking thorough. Stub it empty and rebuild: the
 * verifier chain is built during `buildApp`, so the stub has to precede it. Same
 * idiom, and the same reason, as `directory.test.ts`.
 */
describe("gateway audit admin gate", () => {
  async function withActorGroups(groups: string, fn: (t: TestApp) => Promise<void>): Promise<void> {
    vi.stubEnv("PORTAL_DEV_ACTOR_GROUPS", groups);
    const scoped = buildTestApp();
    await scoped.app.ready();
    try {
      await fn(scoped);
    } finally {
      await scoped.close();
      vi.unstubAllEnvs();
    }
  }

  it("refuses the audit log to an authenticated non-admin", async () => {
    // The regression this pins: before the captured display half, the ledger's
    // subject column was a pairwise `sub` that identified nobody, so any
    // authenticated principal could read it. These rows now carry a real name
    // and address for every app user of every app.
    await withActorGroups("", async (scoped) => {
      const res = await scoped.app.inject({
        method: "GET",
        url: "/api/v1/gateway/audit",
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  it("admits an admin", async () => {
    await withActorGroups("platform-admin", async (scoped) => {
      const res = await scoped.app.inject({
        method: "GET",
        url: "/api/v1/gateway/audit",
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(200);
    });
  });

  it("still lets a non-admin read the aggregate usage rollup", async () => {
    // Not an oversight in the gate above: usage answers "how much" (bucket sums,
    // a model breakdown, COUNT(DISTINCT userOid)) and discloses no principal. Its
    // openness is the pre-existing per-app RBAC gap, tracked in TODO.md.
    await withActorGroups("", async (scoped) => {
      const res = await scoped.app.inject({
        method: "GET",
        url: "/api/v1/gateway/usage",
        headers: authHeader(),
      });
      expect(res.statusCode).toBe(200);
    });
  });
});

describe("GET /api/v1/gateway/usage (platform)", () => {
  it("requires a bearer token (401)", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/gateway/usage" });
    expect(res.statusCode).toBe(401);
  });

  it("includes a seeded app in the platform rollup", async () => {
    const { slug } = await seedApp([
      { inputTokens: 100, outputTokens: 100, costMicroUsd: 3000, outcome: "ok" },
    ]);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/gateway/usage",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Default platform range is 30d → 30 dense daily buckets.
    expect(body.range).toBe("30d");
    expect(body.series).toHaveLength(30);
    // Robust to other tests' data: just assert our app's own rollup entry.
    const mine = body.byApp.find((a: { slug: string | null }) => a.slug === slug);
    expect(mine).toMatchObject({ slug, tokens: 200, requests: 1 });
    expect(body.totals.tokensMTD).toBeGreaterThanOrEqual(200);
    // Dollars are surfaced platform-wide, frozen at write time = $0.003.
    const myCost = 0.003;
    expect(mine.costUsd).toBeCloseTo(myCost, 9);
    expect(body.totals.costMTD).toBeGreaterThanOrEqual(myCost - 1e-9);
  });
});
