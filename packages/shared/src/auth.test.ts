import { describe, expect, it } from "vitest";
import { portalApiScope } from "./auth.js";

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
