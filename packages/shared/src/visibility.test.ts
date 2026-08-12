import { describe, expect, it } from "vitest";
import {
  LEGACY_VISIBILITY_MODE_NAMES,
  VISIBILITY_MODES,
  VisibilitySchema,
  visibilityModeFromDb,
} from "./visibility.js";

/**
 * The read-side alias that makes the `private` → `internal` rename deployable
 * without a window (see the release-1 migration). Two properties matter, and
 * they pull in opposite directions: legacy rows must keep working, and unknown
 * labels must NOT be quietly made to work.
 */
describe("visibilityModeFromDb", () => {
  it("maps the pre-rename label onto its current name", () => {
    expect(visibilityModeFromDb("private")).toBe("internal");
  });

  it("passes every current mode through unchanged", () => {
    for (const mode of VISIBILITY_MODES) {
      expect(visibilityModeFromDb(mode)).toBe(mode);
    }
  });

  // Deliberately not a throw. The edge calls this while building its registry
  // projection: throwing would turn one unrecognised row into a failed load for
  // every app. Passing the value through keeps the blast radius at one app,
  // where `visibilityAllows` denies it.
  it("passes an unrecognised label through rather than throwing", () => {
    expect(() => visibilityModeFromDb("from-the-future")).not.toThrow();
    expect(visibilityModeFromDb("from-the-future")).toBe("from-the-future");
    expect(visibilityModeFromDb("")).toBe("");
  });
});

describe("the legacy label is read-only", () => {
  it("is not an offered mode", () => {
    for (const legacy of LEGACY_VISIBILITY_MODE_NAMES) {
      expect(VISIBILITY_MODES).not.toContain(legacy);
    }
  });

  // The write half of the contract: normalising reads must never soften what the
  // API accepts. A client asking for `private` is refused, so nothing can put the
  // legacy label back into the column after release 2 backfills it away.
  it("is refused on the write path", () => {
    for (const legacy of LEGACY_VISIBILITY_MODE_NAMES) {
      expect(VisibilitySchema.safeParse({ mode: legacy }).success).toBe(false);
    }
  });
});
