import { describe, expect, it } from "vitest";
import { VISIBILITY_MODES, VisibilitySchema } from "./visibility.js";

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
      const candidate = mode === "group" ? { mode, groupId: "g1" } : { mode };
      expect(VisibilitySchema.safeParse(candidate).success).toBe(true);
    }
  });
});
