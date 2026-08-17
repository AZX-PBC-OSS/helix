import { strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { planBundle } from "@azx-pbc/shared/bundlePlan";
import { BundleTooLargeError, buildCanonicalZip, loadFolder, loadZip } from "./archive";

/** A zip File from a name→text map. */
function zipFile(files: Record<string, string>): File {
  const data = zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])), {
    level: 0,
  });
  return new File([data], "bundle.zip", { type: "application/zip" });
}

/** A File carrying a react-dropzone-style `.path`. */
function pathFile(path: string, content: string): File {
  const file = new File([content], path.split("/").pop() ?? path);
  return Object.assign(file, { path });
}

describe("loadZip", () => {
  it("lists entries with sizes and reads html text, without inflating everything", async () => {
    const loaded = await loadZip(zipFile({ "index.html": "<h1>hi</h1>", "app.js": "x" }), null);
    expect(loaded.entries.map((e) => e.path).sort()).toEqual(["app.js", "index.html"]);
    expect(loaded.htmlText("index.html")).toBe("<h1>hi</h1>");
    expect(loaded.htmlText("app.js")).toBeUndefined();
  });

  it("surfaces a declared build dir from an in-bundle helix.json", async () => {
    const loaded = await loadZip(
      zipFile({ "helix.json": '{"slug":"x","dir":"dist"}', "dist/index.html": "<h1>hi</h1>" }),
      null,
    );
    expect(loaded.declaredDir).toBe("dist");
  });

  it("refuses an upload past the bundle cap before inflating", async () => {
    const big = "a".repeat(4096);
    await expect(loadZip(zipFile({ "big.txt": big }), 1024)).rejects.toBeInstanceOf(
      BundleTooLargeError,
    );
  });
});

describe("loadFolder", () => {
  it("strips the single dropped-folder segment so its contents are the bundle", async () => {
    const loaded = await loadFolder(
      [pathFile("dist/index.html", "<h1>hi</h1>"), pathFile("dist/app.js", "x")],
      null,
    );
    expect(loaded.entries.map((e) => e.path).sort()).toEqual(["app.js", "index.html"]);
  });

  it("keeps nested structure when files share a wrapper that isn't the only segment", async () => {
    const loaded = await loadFolder(
      [pathFile("site/index.html", "<h1>hi</h1>"), pathFile("site/assets/app.js", "x")],
      null,
    );
    // "site/" is the common top and gets stripped; assets/ nesting is preserved.
    expect(loaded.entries.map((e) => e.path).sort()).toEqual(["assets/app.js", "index.html"]);
  });
});

describe("buildCanonicalZip", () => {
  it("re-roots and drops per the plan, producing a zip of exactly the kept files", async () => {
    const loaded = await loadZip(
      zipFile({
        "site/index.html": "<h1>hi</h1>",
        "site/app.js": "console.log(1)",
        "site/.DS_Store": "junk",
      }),
      null,
    );
    const plan = planBundle(loaded.entries, {}, loaded.htmlText);
    expect(plan.root).toBe("site/");

    const out = await buildCanonicalZip(loaded, plan);
    const contents = unzipSync(new Uint8Array(await out.arrayBuffer()));
    expect(Object.keys(contents).sort()).toEqual(["app.js", "index.html"]);
  });

  it("throws rather than silently shipping fewer files than planned", async () => {
    const loaded = await loadZip(zipFile({ "index.html": "<h1>hi</h1>" }), null);
    // A plan referencing a file the archive can't materialize.
    const plan = {
      files: [
        { from: "index.html", to: "index.html" },
        { from: "ghost.js", to: "ghost.js" },
      ],
    };
    await expect(buildCanonicalZip(loaded, plan)).rejects.toThrow(/ghost\.js/);
  });
});

describe("loadFolder — path fallback", () => {
  it("uses the file name when neither .path nor webkitRelativePath is set", async () => {
    // A plain File has webkitRelativePath === "" (not undefined); the fallback
    // must still yield a usable path rather than an empty one.
    const loaded = await loadFolder([new File(["<h1>hi</h1>"], "index.html")], null);
    expect(loaded.entries.map((e) => e.path)).toEqual(["index.html"]);
  });
});
