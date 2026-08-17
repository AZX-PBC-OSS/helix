import { describe, expect, it } from "vitest";
import { buildZipFile } from "../test/zip.js";
import { PROJECT_ROOT_MACOS, WRAPPER_DIR } from "./fixtures/malformed-bundles.js";
import { validateBundle } from "./validate.js";

/**
 * Characterization tests over the malformed-bundle fixtures
 * (`fixtures/README.md`). These pin what the validator does with real user
 * uploads **today**, which is not what it should do — both assertions below are
 * expected to change when re-rooting lands. They exist so the change is visible
 * as a diff rather than as a behaviour nobody wrote down.
 */
describe("malformed bundles, as validated today", () => {
  it("rejects a project-root zip on its first junk entry, not on anything useful", async () => {
    const zip = await buildZipFile(PROJECT_ROOT_MACOS.entries);

    // The rejection names a macOS sidecar — entry #2 — so the message describes
    // metadata the user never created, and the `helix.json` at entry #3 that
    // names the real build directory is never read.
    await expect(validateBundle(zip)).rejects.toMatchObject({
      code: "bundle_invalid",
      message: "file type not allowed (static files only): __MACOSX/._helix-app",
    });
  });

  it("accepts a wrapper-dir zip that cannot serve a single one of its own paths", async () => {
    const zip = await buildZipFile(WRAPPER_DIR.entries);

    const result = await validateBundle(zip);

    // Validation passes, and every entry sits one directory below where the
    // edge will look for it.
    expect(result.entries.map((e) => e.path)).toEqual(
      WRAPPER_DIR.canonical.map((p) => `marketing-site/${p}`),
    );
    expect(result.entries.some((e) => WRAPPER_DIR.canonical.includes(e.path))).toBe(false);

    // The whole signal: one advisory, with no CSP warnings beside it.
    expect(result.warnings).toEqual([
      {
        file: "index.html",
        origin: "(none)",
        hint: "bundle has no index.html at its root; the app may not serve a default page",
      },
    ]);
  });
});
