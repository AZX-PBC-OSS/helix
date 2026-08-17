import { PROJECT_ROOT_MACOS, WRAPPER_DIR } from "@azx-pbc/shared/bundleFixtures";
import { describe, expect, it } from "vitest";
import { buildZipFile } from "../test/zip.js";
import { diagnoseBundle } from "./diagnose.js";

describe("diagnoseBundle", () => {
  it("re-reads a project-root upload and points at the real build directory", async () => {
    const zip = await buildZipFile(PROJECT_ROOT_MACOS.entries);
    const diag = await diagnoseBundle(zip);
    expect(diag).toBeDefined();
    // Names the build dir and the whole-project shape — not the first junk entry.
    expect(diag!.message).toMatch(/whole project/);
    expect(diag!.message).toContain("helix-app/dist/");
    expect(diag!.message).toMatch(/junk/);
    expect(diag!.details).toMatchObject({
      salvage: { outcome: "rerooted", root: "helix-app/dist/", keep: 3 },
    });
  });

  it("explains a bundle with no index.html", async () => {
    const zip = await buildZipFile([
      { name: "notes.txt", content: "hi" },
      { name: "data.json", content: "{}" },
    ]);
    const diag = await diagnoseBundle(zip);
    expect(diag!.message).toMatch(/no index\.html/i);
  });

  it("adds nothing for a clean, canonical bundle", async () => {
    const zip = await buildZipFile([
      { name: "index.html", content: "<h1>hi</h1>" },
      { name: "app.js", content: "console.log(1)" },
    ]);
    expect(await diagnoseBundle(zip)).toBeUndefined();
  });

  it("is failure-tolerant — an unreadable file yields no diagnosis", async () => {
    expect(await diagnoseBundle("/nonexistent/not-a.zip")).toBeUndefined();
  });

  it("leaves the wrapper-dir bundle to validation (it deploys today, no diagnosis needed here)", async () => {
    // WRAPPER_DIR validates green, so the route never calls diagnose for it — but
    // if it did, the planner re-roots rather than declaring failure.
    const zip = await buildZipFile(WRAPPER_DIR.entries);
    const diag = await diagnoseBundle(zip);
    expect(diag!.details).toMatchObject({
      salvage: { outcome: "rerooted", root: "marketing-site/" },
    });
  });
});
