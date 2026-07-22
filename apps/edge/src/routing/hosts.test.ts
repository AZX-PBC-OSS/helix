import { describe, expect, it } from "vitest";
import { classifyHost } from "./hosts.js";

const BASE = "local.helix.azxlabs.io";

describe("classifyHost", () => {
  it("classifies a single-label subdomain as an app host", () => {
    expect(classifyHost("demo.local.helix.azxlabs.io", BASE)).toEqual({
      kind: "app",
      slug: "demo",
    });
  });

  it("strips the port and lowercases", () => {
    expect(classifyHost("Demo.Local.Helix.AzxLabs.Io:8080", BASE)).toEqual({
      kind: "app",
      slug: "demo",
    });
  });

  it("classifies the apex domain as platform", () => {
    expect(classifyHost("local.helix.azxlabs.io", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost("local.helix.azxlabs.io:8080", BASE)).toEqual({ kind: "platform" });
  });

  it("classifies multi-label subdomains as platform", () => {
    expect(classifyHost("a.b.local.helix.azxlabs.io", BASE)).toEqual({ kind: "platform" });
  });

  it("classifies unrelated hosts, localhost and IPs as platform", () => {
    expect(classifyHost("localhost:8080", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost("127.0.0.1:8080", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost("example.com", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost("notlocal.helix.azxlabs.io", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost("[::1]:8080", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost(undefined, BASE)).toEqual({ kind: "platform" });
  });

  it("classifies the auth host as its own kind", () => {
    expect(classifyHost("auth.local.helix.azxlabs.io", BASE)).toEqual({ kind: "auth" });
    expect(classifyHost("Auth.local.helix.azxlabs.io:8443", BASE)).toEqual({ kind: "auth" });
    // Only an exact label on the base domain — never nested or elsewhere.
    expect(classifyHost("auth.evil.com", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost("a.auth.local.helix.azxlabs.io", BASE)).toEqual({ kind: "platform" });
  });

  it("reserves platform subdomains", () => {
    for (const label of ["portal", "api", "www"]) {
      expect(classifyHost(`${label}.local.helix.azxlabs.io`, BASE)).toEqual({ kind: "platform" });
    }
  });

  it("rejects labels that are not valid slugs", () => {
    expect(classifyHost("-bad.local.helix.azxlabs.io", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost("bad-.local.helix.azxlabs.io", BASE)).toEqual({ kind: "platform" });
    expect(classifyHost(".local.helix.azxlabs.io", BASE)).toEqual({ kind: "platform" });
  });

  it("honors a configurable base domain", () => {
    expect(classifyHost("demo.azx.helix.azxlabs.io", "azx.helix.azxlabs.io")).toEqual({
      kind: "app",
      slug: "demo",
    });
    expect(classifyHost("demo.local.helix.azxlabs.io", "azx.helix.azxlabs.io")).toEqual({
      kind: "platform",
    });
  });
});
