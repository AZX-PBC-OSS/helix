import { describe, expect, it } from "vitest";
import { parseRequest, type RouteContract } from "../define.js";
import { listApps } from "./apps.js";
import { getAppUsage, getPlatformUsage } from "./usage.js";
import { getAppVisitors } from "./visitors.js";

// These queries are published as optional; omitting them or sending an unknown
// value must both fall back to the default, as the routes always have.
describe.each([
  ["listApps", listApps, "scope", "mine"],
  ["getAppUsage", getAppUsage, "range", "24h"],
  ["getPlatformUsage", getPlatformUsage, "range", "30d"],
  ["getAppVisitors", getAppVisitors, "range", "30d"],
] as const)("%s", (_id, route, name, fallback) => {
  const contract: RouteContract = route;
  it("defaults an omitted value", () => {
    const { query } = parseRequest(contract, { params: { slug: "s" }, query: {} });
    expect((query as Record<string, unknown>)[name]).toBe(fallback);
  });

  it("falls back on an unknown value", () => {
    const { query } = parseRequest(contract, { params: { slug: "s" }, query: { [name]: "bogus" } });
    expect((query as Record<string, unknown>)[name]).toBe(fallback);
  });
});
