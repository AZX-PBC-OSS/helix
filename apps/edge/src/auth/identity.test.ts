import { describe, expect, it } from "vitest";
import { captureEmail, captureName, truncate, USER_EMAIL_MAX, USER_NAME_MAX } from "./identity.js";

/**
 * The capture rules for the display half. Most of what follows is a *negative*
 * specification — what must NOT end up in a label column — because the failure
 * this code exists to prevent is a column that looks like an attribution and
 * isn't.
 */
describe("captureName", () => {
  it("takes a name claim as-is", () => {
    expect(captureName("Alice Anders")).toBe("Alice Anders");
  });

  it("is null for a missing, empty or non-string claim", () => {
    for (const bad of [undefined, null, "", 42, {}, []]) {
      expect(captureName(bad)).toBeNull();
    }
  });

  it("bounds an absurd directory attribute", () => {
    const captured = captureName("A".repeat(USER_NAME_MAX + 100));
    expect(captured).toHaveLength(USER_NAME_MAX + 1);
    expect(captured?.endsWith("…")).toBe(true);
  });

  it("never ellipsizes a name of the length Entra itself permits", () => {
    const atLimit = "A".repeat(USER_NAME_MAX);
    expect(captureName(atLimit)).toBe(atLimit);
  });
});

describe("captureEmail", () => {
  it("takes an address claim", () => {
    expect(captureEmail("alice@azx.dev")).toBe("alice@azx.dev");
  });

  it("rejects a claim that is not addressable", () => {
    // The case that matters: `preferred_username` is Entra's UPN and is USUALLY
    // an address, but is not contractually one. A `userEmail` column holding a
    // non-address is worse than a null, because the column's whole value is that
    // a reader can act on it.
    expect(captureEmail("ALICE")).toBeNull();
    expect(captureEmail("")).toBeNull();
    expect(captureEmail(undefined)).toBeNull();
  });

  it("bounds an address at the RFC 5321 forward-path maximum", () => {
    const captured = captureEmail(`${"a".repeat(USER_EMAIL_MAX)}@azx.dev`);
    expect(captured).toHaveLength(USER_EMAIL_MAX + 1);
  });
});

describe("the capture ladder as oidc.ts applies it", () => {
  // Mirrors the derivation in `OidcClient.exchangeCode`. Kept here as a table so
  // the tenant shapes that differ from `apps/dev-idp` are covered — dev-idp emits
  // `name` + `email` and NO `preferred_username`, so the UPN fallback and the
  // no-name tenant are otherwise never exercised.
  const capture = (claims: { name?: unknown; email?: unknown; preferred_username?: unknown }) => {
    const name = captureName(claims.name);
    const email = captureEmail(claims.email) ?? captureEmail(claims.preferred_username);
    return { name, email, displayName: name ?? email ?? "sub-value" };
  };

  it("prefers the email claim, then the UPN", () => {
    expect(capture({ email: "a@x.dev", preferred_username: "b@x.dev" }).email).toBe("a@x.dev");
    expect(capture({ preferred_username: "b@x.dev" }).email).toBe("b@x.dev");
  });

  it("falls back to the address as the display label when a tenant sends no name", () => {
    // Pre-existing behaviour that must not regress: such a user already saw their
    // address as `displayName` via `/_api/me` before the split existed.
    const { name, email, displayName } = capture({ email: "a@x.dev" });
    expect(name).toBeNull();
    expect(displayName).toBe("a@x.dev");
    expect(email).toBe("a@x.dev");
  });

  it("NEVER captures the subject as a label, even when no claim is present", () => {
    // The whole point. `displayName` still falls back (it is a non-empty
    // contract for `/_api/me`), but a stored label that IS the opaque subject
    // would render as an attribution while attributing nothing.
    const { name, email, displayName } = capture({});
    expect(name).toBeNull();
    expect(email).toBeNull();
    expect(displayName).toBe("sub-value");
  });
});

describe("truncate", () => {
  it("leaves a value at the limit alone and marks one over", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("abc…");
  });
});
