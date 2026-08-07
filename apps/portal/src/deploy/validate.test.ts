import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildZipFile } from "../test/zip.js";
import { withEnv } from "../test/env.js";
import { normalizeEntryPath, validateBundle } from "./validate.js";

describe("normalizeEntryPath", () => {
  it("accepts normal relative paths", () => {
    expect(normalizeEntryPath("index.html")).toBe("index.html");
    expect(normalizeEntryPath("assets/app.js")).toBe("assets/app.js");
    expect(normalizeEntryPath("./a/b.css")).toBe("a/b.css");
  });

  it("rejects traversal, absolute, drive-letter, backslash, and null-byte paths", () => {
    expect(normalizeEntryPath("../evil.txt")).toBeNull();
    expect(normalizeEntryPath("a/../../evil")).toBeNull();
    expect(normalizeEntryPath("/etc/passwd")).toBeNull();
    expect(normalizeEntryPath("C:\\windows")).toBeNull();
    expect(normalizeEntryPath("a\\b")).toBeNull();
    expect(normalizeEntryPath("a\0b")).toBeNull();
  });
});

describe("validateBundle", () => {
  it("accepts a well-formed static bundle", async () => {
    const zip = await buildZipFile([
      { name: "index.html", content: "<!doctype html><body>hi</body>" },
      { name: "assets/app.js", content: "console.log('hi')" },
      { name: "assets/style.css", content: "body{}" },
    ]);
    const result = await validateBundle(zip);
    expect(result.entries.map((e) => e.path).sort()).toEqual([
      "assets/app.js",
      "assets/style.css",
      "index.html",
    ]);
    expect(result.entries.find((e) => e.path === "index.html")?.contentType).toBe(
      "text/html; charset=utf-8",
    );
    expect(result.warnings).toEqual([]);
  });

  it("rejects a disallowed file type", async () => {
    const zip = await buildZipFile([{ name: "evil.sh", content: "#!/bin/sh\nrm -rf /" }]);
    await expect(validateBundle(zip)).rejects.toMatchObject({ code: "bundle_invalid" });
  });

  it("rejects symlinks", async () => {
    const zip = await buildZipFile([
      { name: "index.html", content: "<html></html>" },
      { name: "link.html", symlinkTo: "/etc/passwd" },
    ]);
    await expect(validateBundle(zip)).rejects.toMatchObject({ code: "bundle_invalid" });
  });

  it("rejects a decompression-ratio bomb", async () => {
    // 1 MiB of zeros: well under the per-file size cap, but compresses far
    // beyond the ratio limit.
    const zip = await buildZipFile([{ name: "bomb.txt", content: Buffer.alloc(1024 * 1024, 0) }]);
    await expect(validateBundle(zip)).rejects.toMatchObject({ code: "bundle_invalid" });
  });

  // `.wasm`, not `.bin` — an extension outside the mime allowlist is rejected
  // before the size drain runs, so it would pass these tests without ever
  // exercising a cap.
  it("rejects a file over the per-file cap, and accepts it under the default", async () => {
    // Drive the cap down rather than generating tens of MB of incompressible
    // data: same code path, and the test stays fast as the default grows.
    const zip = await buildZipFile([{ name: "big.wasm", content: randomBytes(2 * 1024 * 1024) }]);
    await withEnv({ DEPLOY_MAX_FILE_MB: "1" }, async () => {
      await expect(validateBundle(zip)).rejects.toMatchObject({ code: "bundle_invalid" });
    });
    const result = await validateBundle(zip);
    expect(result.entries.map((e) => e.path)).toEqual(["big.wasm"]);
  });

  it("rejects a bundle over the whole-bundle cap", async () => {
    const zip = await buildZipFile([
      { name: "a.wasm", content: randomBytes(1024 * 1024) },
      { name: "b.wasm", content: randomBytes(1024 * 1024) },
    ]);
    await withEnv({ DEPLOY_MAX_BUNDLE_MB: "1.5" }, async () => {
      await expect(validateBundle(zip)).rejects.toMatchObject({ code: "bundle_invalid" });
    });
  });

  it("warns (does not fail) on non-allowlisted external origins", async () => {
    const zip = await buildZipFile([
      {
        name: "index.html",
        content: `<script src="https://evil.example.com/x.js"></script>`,
      },
    ]);
    const result = await validateBundle(zip);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ file: "index.html", origin: "https://evil.example.com" }),
    );
  });

  it("does not warn on allowlisted CDNs", async () => {
    const zip = await buildZipFile([
      { name: "index.html", content: `<script src="https://cdn.jsdelivr.net/npm/x"></script>` },
    ]);
    const result = await validateBundle(zip);
    expect(result.warnings).toEqual([]);
  });

  it("warns when the bundle has no root index.html", async () => {
    const zip = await buildZipFile([{ name: "about.html", content: "<html></html>" }]);
    const result = await validateBundle(zip);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ file: "index.html", origin: "(none)" }),
    );
  });
});
