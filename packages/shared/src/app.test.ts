import { describe, expect, it } from "vitest";
import { SLUG_PATTERN } from "./app.js";

/**
 * Bug-class ledger (sister project): tenancy/cache keys built by
 * delimiter-joining ids. The edge's shared `rate_counters` namespace keys the
 * anon limiter and the login throttle by `<namespace>:<req.ip>:<appId>` — a
 * delimiter join of a client-influenced IP and the app id. That join is only
 * injective while the slug can never contain the delimiter (or start/end with
 * one): `anon:${ip}:${appId}` then always splits uniquely from the right, so
 * two different (ip, appId) pairs can never share a bucket and a tenant can
 * never ride a neighbor's budget. The slug schema is the only thing standing
 * between the join and that guarantee, so pin it here, where the pattern lives.
 */
describe("SLUG_PATTERN — counter-key injectivity", () => {
  it("rejects the delimiter the edge joins rate-limit keys with", () => {
    for (const bad of ["a:b", ":", "look:alike", "::1"]) {
      expect(SLUG_PATTERN.test(bad), `"${bad}" must not be a slug`).toBe(false);
    }
  });

  it("accepts exactly the DNS labels the subdomain routing promises", () => {
    for (const good of ["demo", "my-app", "a", "app-1"]) {
      expect(SLUG_PATTERN.test(good), `"${good}" must be a slug`).toBe(true);
    }
  });
});
