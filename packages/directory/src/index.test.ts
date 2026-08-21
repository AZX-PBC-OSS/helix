import { describe, expect, it } from "vitest";
import { createDirectory, DEV_FIXTURE_GROUPS } from "./index.js";
import { EntraDirectory } from "./entra.js";
import { StaticDirectory } from "./static.js";
import { UnavailableDirectory } from "./provider.js";

/**
 * `createDirectory` is the single decision point for **which directory a
 * deployment answers group searches from**, so it gets the same treatment as
 * `createSecretStore`'s test: the inversion is what matters, not the happy path.
 *
 * A production portal that fell back to fixtures would not error and would not
 * log — it would show an operator a picker full of groups that do not exist in
 * their tenant, and let them scope an app to an id nobody holds. That app then
 * denies everyone, which looks like a platform bug rather than a config one.
 */
describe("createDirectory backend selection", () => {
  const getToken = async () => "t";

  it("uses the real directory when a token source is present", () => {
    expect(createDirectory({ getToken })).toBeInstanceOf(EntraDirectory);
  });

  it("prefers the real directory even when fixtures are also permitted", () => {
    const dir = createDirectory({ getToken, allowFixtures: true });
    expect(dir).toBeInstanceOf(EntraDirectory);
    expect(dir).not.toBeInstanceOf(StaticDirectory);
  });

  it("uses fixtures only when explicitly permitted", () => {
    expect(createDirectory({ allowFixtures: true })).toBeInstanceOf(StaticDirectory);
  });

  it("reports itself unavailable rather than guessing when nothing is configured", async () => {
    const dir = createDirectory({});
    expect(dir).toBeInstanceOf(UnavailableDirectory);
    // Reports, does not throw (ADR-0040 decision 8) — the Access tab has to keep
    // working, with a banner, on a deployment that never got the Graph grant.
    await expect(dir.searchGroups("eng", 10)).resolves.toMatchObject({
      available: false,
      reason: "not-configured",
    });
    await expect(dir.getGroups(["x"])).resolves.toMatchObject({ available: false });
  });
});

describe("StaticDirectory", () => {
  const dir = new StaticDirectory(DEV_FIXTURE_GROUPS);

  // Substring, not prefix — the same reason EntraDirectory uses $search. A
  // prefix match here would make local behaviour differ from production in the
  // exact way the probe found to be a correctness bug, so the picker would look
  // right in dev and silently omit groups in a real tenant.
  it("matches a term anywhere in the name, not just at the start", async () => {
    const res = await dir.searchGroups("platform", 10);
    if (!res.available) throw new Error("unreachable");
    // "Engineering Platform" carries the term as its second word.
    expect(res.value.map((g) => g.id)).toContain("eng-platform");
  });

  it("matches on id as well as display name, since dev ids are readable", async () => {
    const res = await dir.searchGroups("eng-team", 10);
    if (!res.available) throw new Error("unreachable");
    expect(res.value.map((g) => g.id)).toEqual(["eng-team"]);
  });

  it("enforces the minimum query length, like the real provider", async () => {
    await expect(dir.searchGroups("en", 10)).rejects.toThrow(/at least 3 characters/);
  });

  it("honours the caller's cap", async () => {
    const res = await dir.searchGroups("team", 1);
    if (!res.available) throw new Error("unreachable");
    expect(res.value).toHaveLength(1);
  });

  it("resolves known ids and omits unknown ones", async () => {
    const res = await dir.getGroups(["eng-team", "nope"]);
    expect(res).toEqual({
      available: true,
      value: [{ id: "eng-team", displayName: "Engineering", securityEnabled: true }],
    });
  });

  /**
   * The fixtures have to agree with `apps/dev-idp`'s `groups` claim, or the local
   * loop is a lie: the picker would offer a group, the claim would never carry
   * it, and the edge would deny — with every test still green. Pinned by value
   * rather than by importing dev-idp, because a dev-only app is not a dependency
   * this package may take.
   */
  it("covers the dev-idp claim values so the local loop actually closes", async () => {
    const res = await dir.getGroups(["eng-team", "platform-admin"]);
    if (!res.available) throw new Error("unreachable");
    expect(res.value.map((g) => g.id).sort()).toEqual(["eng-team", "platform-admin"]);
  });

  /**
   * The fixtures carry the flag, so the resolve path reports it — which is what
   * keeps dev from exercising a "flag unknown" path production rarely takes, and
   * what stops the same group reading eligible in one view and ineligible in
   * another.
   */
  it("reports the security flag from a resolve, agreeing with what search says", async () => {
    const resolved = await dir.getGroups(["platform-admin"]);
    const searched = await dir.searchGroups("platform-admin", 10);
    if (!resolved.available || !searched.available) throw new Error("unreachable");
    expect(resolved.value[0]?.securityEnabled).toBe(false);
    expect(searched.value[0]?.securityEnabled).toBe(false);
  });

  // An App Role is not a security group. Marked rather than hidden, so the
  // picker can discourage it with a reason instead of leaving the operator
  // wondering why a group they can see in Entra is missing.
  it("marks a non-security group instead of hiding it", async () => {
    const res = await dir.searchGroups("platform-admin", 10);
    if (!res.available) throw new Error("unreachable");
    expect(res.value).toEqual([
      { id: "platform-admin", displayName: "Platform Admins (app role)", securityEnabled: false },
    ]);
  });
});
