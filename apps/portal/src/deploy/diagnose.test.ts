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

  // Timeout raised off the 5s default: building the 20k-entry fixture shares that
  // budget with the assertion, and on a loaded CI runner the pair flakes. What this
  // test guarantees is the 3s bound on diagnoseBundle below; the timeout is a backstop.
  //
  // FLAKINESS: this is a wall-clock assertion, so it is load-sensitive by nature — a
  // CI runner has fewer cores than a dev box and vitest schedules this alongside ~130
  // other files. Today diagnoseBundle lands around 320ms against the 3s bound (~9x
  // headroom) and the fixture builds stored rather than deflated, so both halves are
  // well clear. If it starts failing again, diagnose before widening anything: a real
  // regression shows up as diagnoseBundle itself creeping toward the bound, whereas
  // noise shows up as a timeout with the measured span still small. Options, in the
  // order worth reaching for:
  //   1. Shrink the fixture. MAX_ENTRIES (5k) is where enumeration stops, so ~6k
  //      entries proves the cap just as well and cuts the setup cost ~3x.
  //   2. Drop the timing assertion for a deterministic one — count the entries
  //      yauzl actually reads and assert it stops at MAX_ENTRIES. That pins the
  //      bound the test exists for with no clock involved; the cost is that it no
  //      longer catches a planner that is quadratic *within* the cap.
  //   3. Raise the 3s bound. Cheapest, and the weakest — it trades away the signal
  //      this test is here for, so prefer 1 or 2.
  it(
    "stays fast on a pathological many-entry zip (bounded enumeration)",
    { timeout: 30_000 },
    async () => {
      // 20k unique-directory entries — the shape that made the old O(dirs×files)
      // planner hang. Enumeration is capped and the linear planner is quick.
      const entries = Array.from({ length: 20_000 }, (_, i) => ({
        name: `d${i}/a${i}.js`,
        content: "x",
      }));
      // Stored, not deflated: archiving 20k entries at level 9 costs several times
      // what the call under test does, and only the latter is what we assert on.
      const zip = await buildZipFile(entries, { store: true });
      const start = performance.now();
      await diagnoseBundle(zip);
      expect(performance.now() - start).toBeLessThan(3000);
    },
  );

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
