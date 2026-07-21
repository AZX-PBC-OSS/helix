import { describe, expect, it } from "vitest";
import { resolvePortalRuntimeUrl } from "./client.js";

const PORTAL_URL = "postgresql://helix_portal:helix_portal@db:5432/helix";
const OWNER_URL = "postgresql://helix:helix@db:5432/helix";

describe("resolvePortalRuntimeUrl", () => {
  it("prefers PORTAL_DATABASE_URL (the least-privilege helix_portal role)", () => {
    expect(
      resolvePortalRuntimeUrl({ PORTAL_DATABASE_URL: PORTAL_URL, DATABASE_URL: OWNER_URL }),
    ).toBe(PORTAL_URL);
  });

  it("falls back to the owner DSN outside production (dev convenience)", () => {
    expect(resolvePortalRuntimeUrl({ DATABASE_URL: OWNER_URL })).toBe(OWNER_URL);
    expect(resolvePortalRuntimeUrl({ DATABASE_URL: OWNER_URL, NODE_ENV: "test" })).toBe(OWNER_URL);
  });

  it("refuses the owner-DSN fallback in production (RLS bypass, defeats the split)", () => {
    expect(() =>
      resolvePortalRuntimeUrl({ DATABASE_URL: OWNER_URL, NODE_ENV: "production" }),
    ).toThrow(/PORTAL_DATABASE_URL/);
  });

  it("accepts the role DSN in production", () => {
    expect(
      resolvePortalRuntimeUrl({ PORTAL_DATABASE_URL: PORTAL_URL, NODE_ENV: "production" }),
    ).toBe(PORTAL_URL);
  });

  it("throws when neither DSN is set", () => {
    expect(() => resolvePortalRuntimeUrl({})).toThrow(/PORTAL_DATABASE_URL or DATABASE_URL/);
  });
});
