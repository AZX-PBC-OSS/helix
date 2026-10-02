import { describe, expect, it, vi } from "vitest";
import { createGeoResolverFromEnv, isPublicPrefix, StaticGeoResolver } from "./resolver.js";

const log = () => ({ info: vi.fn(), warn: vi.fn() });

describe("isPublicPrefix", () => {
  it.each(["198.51.100.0/24", "8.8.8.0/24", "2001:db8:abcd::/48", "2a00:1450:4009::/48"])(
    "treats %s as locatable",
    (p) => {
      expect(isPublicPrefix(p)).toBe(true);
    },
  );

  it.each([
    "10.1.2.0/24",
    "127.0.0.0/24",
    "172.16.0.0/24",
    "172.31.9.0/24",
    "192.168.1.0/24",
    "100.64.0.0/24",
    "169.254.1.0/24",
    "0.0.0.0/24",
    "224.0.0.0/24",
    "0:0:0::/48",
    "fd12:3456:789a::/48",
    "fe80:0:0::/48",
    "",
  ])("treats %s as unresolvable", (p) => {
    expect(isPublicPrefix(p)).toBe(false);
  });
});

describe("StaticGeoResolver", () => {
  it("never places a private prefix, even one in its table", () => {
    const geo = new StaticGeoResolver({
      "10.0.0.0/24": { country: "US", countryName: null, region: null },
    });
    expect(geo.lookup("10.0.0.0/24")).toBeNull();
  });
});

describe("createGeoResolverFromEnv", () => {
  it("reports itself unavailable when no database is configured", () => {
    const geo = createGeoResolverFromEnv(log(), {});
    expect(geo.status).toEqual({
      available: false,
      reason: "No geolocation database is configured.",
      attribution: null,
    });
    expect(geo.lookup("8.8.8.0/24")).toBeNull();
  });

  it("degrades, and warns, when the configured file cannot be read", () => {
    const l = log();
    const geo = createGeoResolverFromEnv(l, { PORTAL_GEOIP_DB_PATH: "/nonexistent/geo.mmdb" });
    expect(geo.status.available).toBe(false);
    expect(l.warn).toHaveBeenCalledOnce();
  });
});
