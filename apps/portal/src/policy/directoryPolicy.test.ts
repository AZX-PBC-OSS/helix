import { afterEach, describe, expect, it } from "vitest";
import {
  DIRECTORY_SEARCH_TIERS,
  directorySearchAllowed,
  directorySearchPolicy,
  directorySearchTier,
} from "./directoryPolicy.js";
import type { Actor } from "../auth/verifier.js";

const actor = (groups: string[] = []): Actor => ({
  sub: "alice@azx.dev",
  via: "oidc",
  groups,
});

/**
 * `actorIsAdmin` reads `PORTAL_ADMIN_GROUP_ID` from the ambient environment (it
 * is the portal's single definition of platform-admin, and `directorySearchAllowed`
 * reuses it rather than re-deriving one). Only the *tier* is injectable, so these
 * tests set the admin group the way every other portal test does.
 */
const ADMIN_GROUP = "platform-admin";
const prevAdminGroup = process.env.PORTAL_ADMIN_GROUP_ID;
afterEach(() => {
  if (prevAdminGroup === undefined) delete process.env.PORTAL_ADMIN_GROUP_ID;
  else process.env.PORTAL_ADMIN_GROUP_ID = prevAdminGroup;
});

describe("directorySearchPolicy", () => {
  it("defaults to everyone when unset, preserving what ADR-0040 shipped", () => {
    expect(directorySearchPolicy({})).toEqual({ tier: "everyone" });
  });

  it("treats an empty string as unset rather than as a tier", () => {
    // Container Apps and compose both express "no value" as an empty string.
    expect(directorySearchPolicy({ PORTAL_DIRECTORY_SEARCH: "" })).toEqual({ tier: "everyone" });
  });

  it.each(DIRECTORY_SEARCH_TIERS)("accepts the %s tier", (tier) => {
    expect(directorySearchPolicy({ PORTAL_DIRECTORY_SEARCH: tier })).toEqual({ tier });
  });

  it("falls back to admins on an unrecognised value, and reports the value", () => {
    // The direction matters more than the destination: a typo must never widen
    // a surface the operator was trying to narrow, and the boot log needs the
    // bad value to be able to name it.
    expect(directorySearchPolicy({ PORTAL_DIRECTORY_SEARCH: "everybody" })).toEqual({
      tier: "admins",
      invalid: "everybody",
    });
  });

  /**
   * These pinned the opposite behaviour when the fallback was exact-match, which
   * made the *narrowest* tier the one most likely to come back wider than the
   * operator wrote: `None` is not a typo, and the fallback points at `admins`.
   */
  it.each([
    ["None", "none"],
    ["NONE", "none"],
    [" none", "none"],
    ["none ", "none"],
    ["none\n", "none"],
    ["Everyone", "everyone"],
    ["  ADMINS  ", "admins"],
  ])("resolves %j to the tier it plainly means (%s)", (raw, tier) => {
    const policy = directorySearchPolicy({ PORTAL_DIRECTORY_SEARCH: raw });
    expect(policy.tier).toBe(tier);
    // Normalised, not "recovered from an error" — nothing to warn about.
    expect(policy.invalid).toBeUndefined();
  });

  it("still falls back to admins for a value that is genuinely not a tier", () => {
    expect(directorySearchPolicy({ PORTAL_DIRECTORY_SEARCH: "  Everybody " }).tier).toBe("admins");
  });

  it("reports the raw value as invalid, not the normalised one", () => {
    // The boot log exists to tell an operator what they wrote. Echoing a trimmed,
    // lowercased version back hides the stray character that caused the problem.
    expect(directorySearchPolicy({ PORTAL_DIRECTORY_SEARCH: " Everybody\n" }).invalid).toBe(
      " Everybody\n",
    );
  });

  it("treats a whitespace-only value as unset", () => {
    expect(directorySearchPolicy({ PORTAL_DIRECTORY_SEARCH: "   " }).tier).toBe("everyone");
  });

  it("reports no `invalid` for a value it accepted", () => {
    expect(directorySearchPolicy({ PORTAL_DIRECTORY_SEARCH: "none" }).invalid).toBeUndefined();
  });

  it("directorySearchTier is the same resolution without the reason", () => {
    expect(directorySearchTier({ PORTAL_DIRECTORY_SEARCH: "admins" })).toBe("admins");
    expect(directorySearchTier({})).toBe("everyone");
  });
});

describe("directorySearchAllowed", () => {
  it("allows anyone under everyone, admin or not", () => {
    const env = { PORTAL_DIRECTORY_SEARCH: "everyone" };
    process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
    expect(directorySearchAllowed(actor(), env)).toBe(true);
    expect(directorySearchAllowed(actor([ADMIN_GROUP]), env)).toBe(true);
  });

  it("allows only platform-admins under admins", () => {
    const env = { PORTAL_DIRECTORY_SEARCH: "admins" };
    process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
    expect(directorySearchAllowed(actor([ADMIN_GROUP]), env)).toBe(true);
    expect(directorySearchAllowed(actor(["eng-team"]), env)).toBe(false);
    expect(directorySearchAllowed(actor(), env)).toBe(false);
  });

  it("refuses everyone under none, including admins", () => {
    const env = { PORTAL_DIRECTORY_SEARCH: "none" };
    process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
    expect(directorySearchAllowed(actor([ADMIN_GROUP]), env)).toBe(false);
  });

  it("refuses everyone under admins when no admin group is configured", () => {
    // `actorIsAdmin` is false for everybody without PORTAL_ADMIN_GROUP_ID, so
    // this combination locks search entirely. That is the correct direction —
    // an unconfigured admin group must not mean "everyone is an admin" — and it
    // is exactly what the boot log exists to make diagnosable.
    delete process.env.PORTAL_ADMIN_GROUP_ID;
    const env = { PORTAL_DIRECTORY_SEARCH: "admins" };
    expect(directorySearchAllowed(actor([ADMIN_GROUP]), env)).toBe(false);
  });
});
