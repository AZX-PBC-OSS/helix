import { describe, expect, it } from "vitest";
import { PortalMeResponseSchema, portalApiScope } from "./auth.js";

describe("portalApiScope", () => {
  it("appends /access to an Entra App ID URI audience", () => {
    expect(portalApiScope("api://e7dcb199-77d8-499f-8c18-07b8b2cc9fb8")).toBe(
      "api://e7dcb199-77d8-499f-8c18-07b8b2cc9fb8/access",
    );
  });

  it("prefixes api:// for a bare client-id GUID audience (Entra v2 token aud)", () => {
    expect(portalApiScope("e7dcb199-77d8-499f-8c18-07b8b2cc9fb8")).toBe(
      "api://e7dcb199-77d8-499f-8c18-07b8b2cc9fb8/access",
    );
  });

  it("tolerates a trailing slash on the audience", () => {
    expect(portalApiScope("api://abc/")).toBe("api://abc/access");
  });

  it("returns null for the dev-idp urn audience (resource indicators, no scope)", () => {
    expect(portalApiScope("urn:helix:portal")).toBeNull();
  });

  it("returns null when no audience is advertised", () => {
    expect(portalApiScope(undefined)).toBeNull();
  });
});

/**
 * Portals are customer-deployed and version independently (ADR-0028) while this
 * schema is bundled into the published CLI (ADR-0032), so a new CLI against an
 * older portal is routine — and both fields below were hard breaks while they were
 * required: `helix whoami` failed outright, and `helix login` failed at its final
 * "greet the actor" step, which runs *after* the tokens are written, so a login
 * that had genuinely succeeded reported an error.
 */
describe("PortalMeResponseSchema back-compat", () => {
  it("parses a portal that predates canSearchDirectory, defaulting it to true", () => {
    const parsed = PortalMeResponseSchema.parse({
      sub: "alice@azx.dev",
      via: "oidc",
      isAdmin: false,
    });
    // A portal old enough to omit the field has no tier enforcement at all, so it
    // behaves exactly like `everyone`. `false` would tell a client that search is
    // unavailable on a portal where it works.
    expect(parsed.canSearchDirectory).toBe(true);
  });

  it("parses a portal that predates isAdmin, defaulting it to false", () => {
    const parsed = PortalMeResponseSchema.parse({ sub: "alice@azx.dev", via: "oidc" });
    // Opposite polarity on purpose: silence is not a grant of admin.
    expect(parsed.isAdmin).toBe(false);
  });

  it("leaves searchRestriction absent when the portal did not send one", () => {
    const parsed = PortalMeResponseSchema.parse({ sub: "a", via: "oidc", isAdmin: false });
    expect(parsed.searchRestriction).toBeUndefined();
  });
});
