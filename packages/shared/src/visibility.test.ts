import { describe, expect, it } from "vitest";
import {
  MAX_VISIBILITY_GROUPS,
  VISIBILITY_MODES,
  VisibilitySchema,
  visibilityGroupIds,
  WritableVisibilitySchema,
} from "./visibility.js";

/**
 * `private` was the pre-rename spelling of `internal`, and the name is being
 * held for a genuine owner-plus-platform-admins mode that does not exist yet
 * (TODO.md explains what it is blocked on). The expand/contract releases removed
 * the last row, then the Postgres label itself, so nothing anywhere stores it.
 *
 * These assertions are what keep the reservation real rather than aspirational:
 * if someone reintroduces `private` as an alias for `internal` — the obvious
 * "helpful" change — it fails here, before it can ship a mode whose name means
 * the opposite of what it does.
 */
describe("the `private` visibility mode stays reserved", () => {
  it("is not an offered mode", () => {
    expect(VISIBILITY_MODES).not.toContain("private");
  });

  it("is refused by the schema every boundary validates through", () => {
    expect(VisibilitySchema.safeParse({ mode: "private" }).success).toBe(false);
  });

  it("still accepts each mode the platform does offer", () => {
    for (const mode of VISIBILITY_MODES) {
      const candidate = mode === "group" ? { mode, groupIds: ["g1"] } : { mode };
      expect(VisibilitySchema.safeParse(candidate).success).toBe(true);
    }
  });
});

/**
 * The cap is enforced in this schema and nowhere else (ADR-0040 §5) — no CHECK
 * constraint, no route-level guard. That makes it cheap to retune, and it makes
 * these assertions the only thing standing behind the number, so they are load-
 * bearing rather than decorative.
 */
describe("group visibility takes N groups, any-of", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `g${i}`);

  it("accepts up to the cap and refuses one more", () => {
    expect(
      VisibilitySchema.safeParse({ mode: "group", groupIds: ids(MAX_VISIBILITY_GROUPS) }).success,
    ).toBe(true);
    expect(
      VisibilitySchema.safeParse({ mode: "group", groupIds: ids(MAX_VISIBILITY_GROUPS + 1) })
        .success,
    ).toBe(false);
  });

  // Deliberately valid, and the reason is a read path rather than a policy: this
  // shape has to round-trip because `visibilityFromColumns` sits under every
  // app-shaped response, and a row the schema refuses is a 500 on the whole apps
  // list. The edge's gate is what makes it safe — an empty set admits nobody.
  it("accepts an empty group list (a deny-everyone app, not a validation error)", () => {
    expect(VisibilitySchema.safeParse({ mode: "group", groupIds: [] }).success).toBe(true);
  });

  it("refuses an empty-string id, and a missing list entirely", () => {
    expect(VisibilitySchema.safeParse({ mode: "group", groupIds: [""] }).success).toBe(false);
    expect(VisibilitySchema.safeParse({ mode: "group" }).success).toBe(false);
  });

  it("refuses the pre-ADR-0040 scalar shape rather than silently dropping it", () => {
    // A stale `helix` CLI or a hand-rolled manifest sends this. It must fail
    // loudly: accepted-and-ignored would store a `group` app scoped to nobody.
    expect(VisibilitySchema.safeParse({ mode: "group", groupId: "g1" }).success).toBe(false);
  });

  it("visibilityGroupIds reads the payload, and answers [] for every other mode", () => {
    expect(visibilityGroupIds({ mode: "group", groupIds: ["a", "b"] })).toEqual(["a", "b"]);
    expect(visibilityGroupIds({ mode: "internal" })).toEqual([]);
    expect(visibilityGroupIds({ mode: "password" })).toEqual([]);
    expect(visibilityGroupIds({ mode: "public" })).toEqual([]);
  });
});

/**
 * The write path is stricter than the read path, deliberately. `AppSchema` parses
 * every stored row, so a restriction that made one odd row unrepresentable would
 * turn it into a 500 on the whole apps list — the failure `visibilityFromColumns`
 * was fixed to stop having.
 */
describe("the writable variant refuses what no legitimate path produces", () => {
  it("rejects a comma — the label delimiter — and whitespace", () => {
    for (const bad of ["eng,prod", "eng prod", " eng", "eng\t"]) {
      expect(WritableVisibilitySchema.safeParse({ mode: "group", groupIds: [bad] }).success).toBe(
        false,
      );
    }
  });

  it("accepts what the picker and the CLI can actually express", () => {
    for (const good of [["eng-team"], ["eng-team", "11111111-1111-4111-8111-111111111111"], []]) {
      expect(WritableVisibilitySchema.safeParse({ mode: "group", groupIds: good }).success).toBe(
        true,
      );
    }
    expect(WritableVisibilitySchema.safeParse({ mode: "internal" }).success).toBe(true);
  });

  // The read schema stays permissive on exactly those values, so a row written
  // before the refinement existed still renders instead of 500ing the list.
  it("leaves the read schema permissive, so a legacy row still parses", () => {
    expect(VisibilitySchema.safeParse({ mode: "group", groupIds: ["eng,prod"] }).success).toBe(
      true,
    );
  });
});
