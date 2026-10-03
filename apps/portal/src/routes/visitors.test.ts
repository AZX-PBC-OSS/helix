import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VisitorSummarySchema } from "@azx-pbc/shared";
import type { TokenVerifier } from "../plugins/auth.js";
import { StaticGeoResolver, UnavailableGeoResolver } from "../geo/resolver.js";
import { sweepExpiredVisits } from "../visits/retention.js";
import { rollUpLocations } from "./visitors.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * ADR-0050: the owner's Visitors view. Pins the gate (owner or admin only), the
 * 30-minute visit definition, the prior-window delta, prod-only scoping, the
 * geo roll-up, and retention.
 */

const ADMIN_GROUP = "platform-admin";
const verifiers: TokenVerifier[] = [
  {
    verify: async (t) => {
      if (t === "owner") return { oid: "oid-owner", sub: "owner@azx.io", via: "oidc", groups: [] };
      if (t === "other") return { oid: "oid-other", sub: "other@azx.io", via: "oidc", groups: [] };
      if (t === "admin")
        return { oid: "oid-admin", sub: "admin@azx.io", via: "oidc", groups: [ADMIN_GROUP] };
      return null;
    },
  },
];
const owner = { authorization: "Bearer owner" };
const other = { authorization: "Bearer other" };
const admin = { authorization: "Bearer admin" };

const geo = new StaticGeoResolver({
  "198.51.100.0/24": { country: "US", countryName: "United States", region: "Washington" },
  "203.0.113.0/24": { country: "US", countryName: "United States", region: "Washington" },
  "192.0.2.0/24": { country: "CA", countryName: "Canada", region: "Ontario" },
});

let t: TestApp;

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  t = buildTestApp({ auth: { verifiers, publicConfig: null }, geo });
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Midday today, so `now - n minutes` stays inside today's bucket. */
function todayAt(minutesAfterNoon: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return new Date(d.getTime() + minutesAfterNoon * MIN);
}

async function ownedApp(): Promise<{ id: string; slug: string }> {
  const slug = uniqueSlug();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: owner,
    payload: { slug, displayName: "Visited" },
  });
  expect(res.statusCode).toBe(201);
  return { id: res.json().id as string, slug };
}

async function seedVisits(
  appId: string,
  rows: Array<{ at: Date; hash: string | null; prefix?: string | null; env?: string }>,
): Promise<void> {
  await t.prisma.appVisit.createMany({
    data: rows.map((r) => ({
      appId,
      createdAt: r.at,
      visitorHash: r.hash,
      ipPrefix: r.prefix === undefined ? "198.51.100.0/24" : r.prefix,
      env: r.env ?? "prod",
    })),
  });
}

async function summary(slug: string, range = "30d", headers = owner) {
  const res = await t.app.inject({
    method: "GET",
    url: `/api/v1/apps/${slug}/visitors?range=${range}`,
    headers,
  });
  return res;
}

describe("GET /api/v1/apps/:slug/visitors — access", () => {
  it("requires a bearer token", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/apps/x/visitors" });
    expect(res.statusCode).toBe(401);
  });

  it("refuses a signed-in non-owner, and serves the owner and an admin", async () => {
    const { slug } = await ownedApp();
    expect((await summary(slug, "30d", other)).statusCode).toBe(403);
    expect((await summary(slug, "30d", owner)).statusCode).toBe(200);
    expect((await summary(slug, "30d", admin)).statusCode).toBe(200);
  });

  it("404s an unknown app for an admin", async () => {
    expect((await summary(uniqueSlug(), "30d", admin)).statusCode).toBe(404);
  });
});

describe("GET /api/v1/apps/:slug/visitors — counting", () => {
  it("collapses loads within 30 minutes into one visit and splits on a longer gap", async () => {
    const { id, slug } = await ownedApp();
    await seedVisits(id, [
      // Visitor a: three loads, the third 31 minutes after the second → 2 visits.
      { at: todayAt(0), hash: "a" },
      { at: todayAt(30), hash: "a" }, // exactly 30 minutes: still the same visit
      { at: todayAt(61), hash: "a" },
      // Visitor b: one load → 1 visit.
      { at: todayAt(5), hash: "b" },
      // No hash (edge had no key): its own visit each time, no visitor.
      { at: todayAt(6), hash: null },
      { at: todayAt(7), hash: null },
    ]);
    const res = await summary(slug);
    expect(res.statusCode).toBe(200);
    const body = VisitorSummarySchema.parse(res.json());
    expect(body.current).toEqual({ visits: 5, uniqueVisitors: 2 });
    const today = body.series.at(-1);
    expect(today).toMatchObject({ visits: 5, uniqueVisitors: 2 });
  });

  it("returns a dense daily series and a prior window of the same length", async () => {
    const { id, slug } = await ownedApp();
    await seedVisits(id, [
      { at: todayAt(0), hash: "a" },
      { at: new Date(todayAt(0).getTime() - 2 * DAY), hash: "b" },
      // Prior 7-day window.
      { at: new Date(todayAt(0).getTime() - 9 * DAY), hash: "c" },
      { at: new Date(todayAt(0).getTime() - 10 * DAY), hash: "d" },
      { at: new Date(todayAt(0).getTime() - 10 * DAY + 2 * 60 * MIN), hash: "d" },
      // Outside both windows.
      { at: new Date(todayAt(0).getTime() - 20 * DAY), hash: "e" },
    ]);
    const body = VisitorSummarySchema.parse((await summary(slug, "7d")).json());
    expect(body.range).toBe("7d");
    expect(body.series).toHaveLength(7);
    expect(body.series.reduce((n, p) => n + p.visits, 0)).toBe(2);
    expect(body.current).toEqual({ visits: 2, uniqueVisitors: 2 });
    expect(body.prior).toEqual({ visits: 3, uniqueVisitors: 2 });
  });

  /** Start of the 7d window, as the route computes it in the UTC DB session. */
  function sevenDayStart(): number {
    const n = new Date();
    return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()) - 6 * DAY;
  }

  it("attributes a visit straddling the window start to the window it began in", async () => {
    const { id, slug } = await ownedApp();
    const start = sevenDayStart();
    await seedVisits(id, [
      { at: new Date(start - 5 * MIN), hash: "b" },
      { at: new Date(start + 5 * MIN), hash: "b" },
    ]);
    const body = VisitorSummarySchema.parse((await summary(slug, "7d")).json());
    expect(body.current).toEqual({ visits: 0, uniqueVisitors: 1 });
    expect(body.prior).toEqual({ visits: 1, uniqueVisitors: 1 });
  });

  it("does not count a visit already in progress when the prior window opens", async () => {
    const { id, slug } = await ownedApp();
    const priorStart = sevenDayStart() - 7 * DAY;
    await seedVisits(id, [
      { at: new Date(priorStart - 10 * MIN), hash: "c" },
      { at: new Date(priorStart + 10 * MIN), hash: "c" },
    ]);
    const body = VisitorSummarySchema.parse((await summary(slug, "7d")).json());
    expect(body.prior).toEqual({ visits: 0, uniqueVisitors: 1 });
  });

  it("counts prod only, and never another app's visits", async () => {
    const { id, slug } = await ownedApp();
    const { id: otherId } = await ownedApp();
    await seedVisits(id, [
      { at: todayAt(0), hash: "a" },
      { at: todayAt(1), hash: "b", env: "dev" },
    ]);
    await seedVisits(otherId, [{ at: todayAt(0), hash: "z" }]);
    const body = VisitorSummarySchema.parse((await summary(slug)).json());
    expect(body.current).toEqual({ visits: 1, uniqueVisitors: 1 });
  });

  it("falls back to 30d for an unknown range", async () => {
    const { slug } = await ownedApp();
    const body = VisitorSummarySchema.parse((await summary(slug, "1y")).json());
    expect(body.range).toBe("30d");
    expect(body.series).toHaveLength(30);
  });
});

describe("GET /api/v1/apps/:slug/visitors — location", () => {
  it("rolls prefixes up to regions and keeps private networks unresolved", async () => {
    const { id, slug } = await ownedApp();
    await seedVisits(id, [
      { at: todayAt(0), hash: "a", prefix: "198.51.100.0/24" },
      { at: todayAt(0), hash: "b", prefix: "203.0.113.0/24" },
      { at: todayAt(90), hash: "b", prefix: "203.0.113.0/24" },
      { at: todayAt(0), hash: "c", prefix: "192.0.2.0/24" },
      { at: todayAt(0), hash: "d", prefix: "10.1.2.0/24" },
      { at: todayAt(0), hash: "e", prefix: null },
    ]);
    const body = VisitorSummarySchema.parse((await summary(slug)).json());
    expect(body.geo.available).toBe(true);
    expect(body.locations).toEqual([
      { country: "US", countryName: "United States", region: "Washington", visitors: 2, visits: 3 },
      { country: "CA", countryName: "Canada", region: "Ontario", visitors: 1, visits: 1 },
    ]);
    expect(body.unresolved).toEqual({ visits: 2, uniqueVisitors: 2 });
    expect(body.otherLocations).toEqual({ visits: 0, uniqueVisitors: 0 });
  });

  it("names the top ten and rolls the rest into otherLocations", () => {
    const table = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `198.51.${i}.0/24`,
        { country: "US", countryName: null, region: `Region ${i}` },
      ]),
    );
    const rows = Array.from({ length: 12 }, (_, i) => ({
      ipPrefix: `198.51.${i}.0/24`,
      visits: BigInt(20 - i),
      visitors: BigInt(20 - i),
    }));
    const out = rollUpLocations(rows, new StaticGeoResolver(table));
    expect(out.locations).toHaveLength(10);
    expect(out.locations[0]?.region).toBe("Region 0");
    expect(out.otherLocations).toEqual({ visits: 9 + 10, uniqueVisitors: 9 + 10 });
  });

  it("reports unavailable geo as a value and counts every row unresolved", () => {
    const geo = new UnavailableGeoResolver("No geolocation database is configured.");
    const out = rollUpLocations([{ ipPrefix: "198.51.100.0/24", visits: 3n, visitors: 2n }], geo);
    expect(geo.status.available).toBe(false);
    expect(out.locations).toEqual([]);
    expect(out.unresolved).toEqual({ visits: 3, uniqueVisitors: 2 });
  });
});

describe("retention", () => {
  it("deletes only visits older than the retention window", async () => {
    const { id } = await ownedApp();
    const now = new Date();
    await seedVisits(id, [
      { at: new Date(now.getTime() - 181 * DAY), hash: "old" },
      { at: new Date(now.getTime() - 179 * DAY), hash: "kept" },
    ]);
    await sweepExpiredVisits(t.prisma, 180, now);
    const left = await t.prisma.appVisit.findMany({ where: { appId: id } });
    expect(left.map((r) => r.visitorHash)).toEqual(["kept"]);
  });
});
