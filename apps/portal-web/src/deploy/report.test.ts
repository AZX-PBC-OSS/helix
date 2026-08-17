import { describe, expect, it } from "vitest";
import { DeployReportSchema } from "@azx-pbc/shared";
import type { BundlePlan } from "@azx-pbc/shared/bundlePlan";
import { toDeployReport } from "./report";

function plan(overrides: Partial<BundlePlan> = {}): BundlePlan {
  return {
    outcome: "rerooted",
    root: "dist/",
    files: [
      { from: "dist/index.html", to: "index.html", bytes: 1 },
      { from: "dist/app.js", to: "app.js", bytes: 1 },
    ],
    drops: [
      { path: "__MACOSX/._x", reason: "junk" },
      { path: "package.json", reason: "outside-root" },
      { path: ".env", reason: "secret" },
    ],
    candidates: [
      { root: "dist/", score: 80, because: [] },
      { root: "src/", score: 40, because: [] },
    ],
    problems: [{ kind: "secret-dropped", path: ".env" }],
    ...overrides,
  };
}

describe("toDeployReport", () => {
  it("distils a plan into a compact, schema-valid report of counts and kinds", () => {
    const report = toDeployReport(plan());
    expect(DeployReportSchema.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      outcome: "rerooted",
      root: "dist/",
      fileCount: 2,
      drops: { junk: 1, "outside-root": 1, secret: 1 },
      problems: ["secret-dropped"],
      candidates: ["dist/", "src/"],
    });
    // It carries counts and kinds only — never the file list itself.
    expect(JSON.stringify(report)).not.toContain("index.html");
  });

  it("stamps the current planner version", () => {
    expect(toDeployReport(plan()).plannerVersion).toBeGreaterThanOrEqual(1);
  });
});
