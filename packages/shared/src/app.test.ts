import { describe, expect, it } from "vitest";
import {
  RESERVED_SUBDOMAINS,
  SLUG_PATTERN,
  SLUG_TERM_PATTERN,
  blockedTermIn,
  slugRejection,
  slugRejectionMessage,
} from "./app.js";

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

describe("blockedTermIn — whole hyphen-delimited tokens", () => {
  it("matches the term as a token anywhere in the slug", () => {
    for (const slug of ["acme", "acme-demo", "demo-acme", "q3-acme-review"]) {
      expect(blockedTermIn(slug, ["acme"]), slug).toBe("acme");
    }
  });

  it("does not match a term embedded in a longer token", () => {
    for (const slug of ["acmeish", "acme2", "subacme", "my-acmes-app"]) {
      expect(blockedTermIn(slug, ["acme"]), slug).toBeNull();
    }
  });

  it("matches a multi-token term only as that exact run", () => {
    expect(blockedTermIn("acme-energy-demo", ["acme-energy"])).toBe("acme-energy");
    expect(blockedTermIn("acme-demo-energy", ["acme-energy"])).toBeNull();
  });

  it("returns the first matching term and ignores empty terms", () => {
    expect(blockedTermIn("acme-globex", ["", "globex", "acme"])).toBe("globex");
    expect(blockedTermIn("demo", [])).toBeNull();
  });
});

describe("slugRejection", () => {
  it("reserves the dev gateway's host", () => {
    expect(RESERVED_SUBDOMAINS.has("dev-api")).toBe(true);
  });

  it("refuses the platform's reserved labels", () => {
    for (const slug of RESERVED_SUBDOMAINS) {
      expect(slugRejection(slug, [])).toEqual({ reason: "reserved" });
    }
  });

  it("refuses a blocked term and names it in the message", () => {
    const rejection = slugRejection("acme-demo", ["acme"]);
    expect(rejection).toEqual({ reason: "blocked", term: "acme" });
    expect(slugRejectionMessage("acme-demo", rejection!)).toContain('"acme"');
  });

  it("allows everything else", () => {
    expect(slugRejection("demo", ["acme"])).toBeNull();
  });
});

describe("SLUG_TERM_PATTERN", () => {
  it("accepts hyphen-joined lowercase tokens only", () => {
    for (const good of ["acme", "acme-energy", "a1"])
      expect(SLUG_TERM_PATTERN.test(good)).toBe(true);
    for (const bad of ["", "-acme", "acme-", "a--b", "Acme", "ac.me", "a b", "(a+)+"]) {
      expect(SLUG_TERM_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
