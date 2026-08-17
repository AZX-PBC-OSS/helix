import { describe, expect, it } from "vitest";
import {
  PROJECT_ROOT_MACOS,
  WRAPPER_DIR,
  fixtureText,
  toPlannerEntries,
} from "./bundleFixtures.js";
import { type BundleEntry, planBundle } from "./bundlePlan.js";

/** Terse helper: name a file of a given size. */
const f = (path: string, bytes = 100): BundleEntry => ({ path, bytes });

describe("planBundle — junk", () => {
  it("drops macOS sidecars, node_modules, .git, and OS cruft before scoring", () => {
    const plan = planBundle([
      f("index.html"),
      f("__MACOSX/._index.html"),
      f(".DS_Store"),
      f("node_modules/react/index.js"),
      f(".git/config"),
      f("Thumbs.db"),
    ]);
    expect(plan.drops.map((d) => d.path).sort()).toEqual([
      ".DS_Store",
      ".git/config",
      "Thumbs.db",
      "__MACOSX/._index.html",
      "node_modules/react/index.js",
    ]);
    expect(plan.drops.every((d) => d.reason === "junk")).toBe(true);
    expect(plan.files.map((p) => p.to)).toEqual(["index.html"]);
  });

  it("drops a .env as a secret and raises a problem", () => {
    const plan = planBundle([f("index.html"), f(".env"), f(".env.production")]);
    expect(
      plan.drops
        .filter((d) => d.reason === "secret")
        .map((d) => d.path)
        .sort(),
    ).toEqual([".env", ".env.production"]);
    expect(plan.problems).toContainEqual({ kind: "secret-dropped", path: ".env" });
  });
});

describe("planBundle — canonical vs re-rooted", () => {
  it("passes a clean root-level build through as canonical", () => {
    const plan = planBundle([f("index.html"), f("styles.css"), f("app.js")]);
    expect(plan.outcome).toBe("canonical");
    expect(plan.root).toBe("");
    expect(plan.drops).toEqual([]);
    expect(plan.files.map((p) => p.to).sort()).toEqual(["app.js", "index.html", "styles.css"]);
  });

  it("a clean build with a stray .DS_Store is not canonical (junk forces a re-plan)", () => {
    const plan = planBundle([f("index.html"), f(".DS_Store")]);
    expect(plan.outcome).not.toBe("canonical");
    expect(plan.drops).toContainEqual({ path: ".DS_Store", reason: "junk" });
  });
});

describe("planBundle — PROJECT_ROOT_MACOS fixture", () => {
  const entries = toPlannerEntries(PROJECT_ROOT_MACOS.entries);

  it("re-roots to dist/ using the declared build dir, landing the canonical files", () => {
    const plan = planBundle(entries, { declaredDir: "dist" });
    expect(plan.outcome).toBe("rerooted");
    expect(plan.root).toBe("helix-app/dist/");
    expect(plan.files.map((p) => p.to)).toEqual(PROJECT_ROOT_MACOS.canonical);
    // The 13 junk entries are dropped; src/ and the project files are dropped as outside-root.
    expect(plan.drops.filter((d) => d.reason === "junk")).toHaveLength(13);
    expect(
      plan.drops.some((d) => d.path === "helix-app/package.json" && d.reason === "outside-root"),
    ).toBe(true);
    expect(plan.drops.some((d) => d.path === "helix-app/src/index.html")).toBe(true);
  });

  it("still re-roots to dist/ without helix.json — the directory name breaks the src/dist tie", () => {
    const plan = planBundle(entries);
    expect(plan.outcome).toBe("rerooted");
    expect(plan.root).toBe("helix-app/dist/");
    expect(plan.files.map((p) => p.to)).toEqual(PROJECT_ROOT_MACOS.canonical);
  });
});

describe("planBundle — WRAPPER_DIR fixture", () => {
  it("strips the single wrapper directory to land the canonical files", () => {
    const plan = planBundle(toPlannerEntries(WRAPPER_DIR.entries));
    expect(plan.outcome).toBe("rerooted");
    expect(plan.root).toBe("marketing-site/");
    expect(plan.files.map((p) => p.to)).toEqual(WRAPPER_DIR.canonical);
    expect(plan.drops).toEqual([]); // nothing but the wrapper prefix to strip
  });
});

describe("planBundle — ambiguity", () => {
  it("flags a genuine tie between two build-named directories", () => {
    const plan = planBundle([
      f("dist/index.html"),
      f("dist/app.js"),
      f("build/index.html"),
      f("build/app.js"),
    ]);
    expect(plan.outcome).toBe("ambiguous");
    // Both remain plausible; the SPA presents them for the user to choose.
    expect(
      plan.candidates
        .slice(0, 2)
        .map((c) => c.root)
        .sort(),
    ).toEqual(["build/", "dist/"]);
  });

  it("is unsalvageable when nothing looks like an index", () => {
    const plan = planBundle([f("notes.txt"), f("data.json")]);
    expect(plan.outcome).toBe("unsalvageable");
    expect(plan.problems).toContainEqual({ kind: "no-index" });
  });
});

describe("planBundle — reference lint", () => {
  it("warns about an html reference that resolves to nothing in the bundle", () => {
    const entries = [f("index.html"), f("app.js")];
    const text = (p: string) =>
      p === "index.html"
        ? '<script src="./missing.js"></script><script src="./app.js"></script>'
        : undefined;
    const plan = planBundle(entries, {}, text);
    expect(plan.problems).toContainEqual({
      kind: "missing-reference",
      file: "index.html",
      ref: "./missing.js",
    });
  });

  it("does not warn when every local reference resolves (fixture text)", () => {
    const plan = planBundle(
      toPlannerEntries(WRAPPER_DIR.entries),
      {},
      fixtureText(WRAPPER_DIR.entries),
    );
    expect(plan.problems.filter((p) => p.kind === "missing-reference")).toEqual([]);
  });
});

describe("planBundle — offline scope (ADR-0035 / ADR-0038 §11)", () => {
  const offline = { offlineScope: "/app/" };

  it("pins a correctly-nested offline build as canonical — never strips the scope dir", () => {
    const plan = planBundle(
      [f("index.html"), f("app/index.html"), f("app/assets/app.js")],
      offline,
    );
    expect(plan.outcome).toBe("canonical");
    expect(plan.root).toBe("");
    expect(plan.files.map((p) => p.to).sort()).toEqual([
      "app/assets/app.js",
      "app/index.html",
      "index.html",
    ]);
  });

  it("does not strip a lone app/ wrapper when it is the granted scope", () => {
    const plan = planBundle([f("app/index.html"), f("app/assets/app.js")], offline);
    expect(plan.root).toBe("");
    expect(plan.files.map((p) => p.to).sort()).toEqual(["app/assets/app.js", "app/index.html"]);
    expect(plan.outcome).toBe("canonical");
  });

  it("offers to nest a root-level build with relative refs under the scope", () => {
    const text = () => '<script src="assets/app.js"></script>';
    const plan = planBundle([f("index.html"), f("assets/app.js")], offline, text);
    expect(plan.outcome).toBe("nested");
    expect(plan.files.map((p) => p.to).sort()).toEqual(["app/assets/app.js", "app/index.html"]);
  });

  it("refuses to nest when a reference is root-absolute — flags a scope mismatch instead", () => {
    const text = () => '<script src="/assets/app.js"></script>';
    const plan = planBundle([f("index.html"), f("assets/app.js")], offline, text);
    expect(plan.outcome).toBe("ambiguous");
    expect(plan.problems).toContainEqual({ kind: "scope-mismatch", scope: "/app/" });
  });
});
