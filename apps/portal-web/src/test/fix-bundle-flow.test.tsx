import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BundlePlan } from "@azx-pbc/shared/bundlePlan";
import { renderWithProviders } from "./render";
import { FixBundleFlow } from "../deploy/FixBundleFlow";

function rerootedPlan(): BundlePlan {
  return {
    outcome: "rerooted",
    root: "dist/",
    files: [
      { from: "dist/index.html", to: "index.html", bytes: 10 },
      { from: "dist/app.js", to: "app.js", bytes: 20 },
    ],
    drops: [
      { path: "__MACOSX/._x", reason: "junk" },
      { path: "package.json", reason: "outside-root" },
      { path: ".env", reason: "secret" },
    ],
    candidates: [
      { root: "dist/", score: 80, because: ["is a conventional build directory (`dist/`)"] },
      { root: "src/", score: 40, because: ["has an index.html at its root"] },
    ],
    problems: [{ kind: "secret-dropped", path: ".env" }],
  };
}

describe("FixBundleFlow", () => {
  it("shows the chosen root, the kept files, and grouped drops", () => {
    renderWithProviders(
      <FixBundleFlow
        plan={rerootedPlan()}
        fileName="my-app"
        onPickRoot={() => {}}
        onDeploy={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Will deploy 2 files/)).toBeTruthy();
    expect(screen.getByText("index.html")).toBeTruthy();
    // Drop groups by reason.
    expect(screen.getByText(/1 junk files/)).toBeTruthy();
    expect(screen.getByText(/1 secret files/)).toBeTruthy();
    // The secret gets a loud, dedicated callout.
    expect(screen.getByText(/A secret file was left out/)).toBeTruthy();
  });

  it("lets the user pick a different candidate root", async () => {
    const onPickRoot = vi.fn();
    renderWithProviders(
      <FixBundleFlow
        plan={rerootedPlan()}
        fileName="my-app"
        onPickRoot={onPickRoot}
        onDeploy={() => {}}
        onCancel={() => {}}
      />,
    );
    await userEvent.click(screen.getByText("src/"));
    expect(onPickRoot).toHaveBeenCalledWith("src/");
  });

  it("renders a deploy error (the dropzone alert is gone once the confirm step shows)", () => {
    renderWithProviders(
      <FixBundleFlow
        plan={rerootedPlan()}
        fileName="my-app"
        error="bundle exceeds size limits"
        onPickRoot={() => {}}
        onDeploy={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText("Deploy failed")).toBeTruthy();
    expect(screen.getByText("bundle exceeds size limits")).toBeTruthy();
  });

  it("blocks deploy when the bundle is unsalvageable", () => {
    const plan: BundlePlan = {
      outcome: "unsalvageable",
      root: "",
      files: [],
      drops: [],
      candidates: [],
      problems: [{ kind: "no-index" }],
    };
    renderWithProviders(
      <FixBundleFlow
        plan={plan}
        fileName="x"
        onPickRoot={() => {}}
        onDeploy={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/couldn't find a built site/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Deploy this/ })).toHaveProperty("disabled", true);
  });
});
