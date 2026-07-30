import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseVisibility } from "./commands.js";
import { resolveConfig } from "./config.js";

const NO_CONFIG_FILE = "/tmp/helix-cli-no-config-dir";

/** A throwaway app directory holding the given config files. */
async function appDir(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "helix-config-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), JSON.stringify(body));
  }
  return dir;
}

describe("resolveConfig", () => {
  it("applies defaults when nothing is set", async () => {
    const c = await resolveConfig({}, {}, NO_CONFIG_FILE);
    expect(c.portalUrl).toBe("http://localhost:3001");
    expect(c.dir).toBe("dist");
    expect(c.slug).toBeUndefined();
    expect(c.token).toBeUndefined();
  });

  it("lets flags override env", async () => {
    const c = await resolveConfig(
      { portalUrl: "http://flag", slug: "s", token: "flagtok" },
      { HELIX_PORTAL_URL: "http://env", HELIX_TOKEN: "envtok" },
      NO_CONFIG_FILE,
    );
    expect(c.portalUrl).toBe("http://flag");
    expect(c.token).toBe("flagtok");
    expect(c.slug).toBe("s");
  });

  it("falls back to env when no flag is given", async () => {
    const c = await resolveConfig(
      {},
      { HELIX_PORTAL_URL: "http://env", HELIX_TOKEN: "envtok" },
      NO_CONFIG_FILE,
    );
    expect(c.portalUrl).toBe("http://env");
    expect(c.token).toBe("envtok");
  });

  it("still reads the pre-rename AZX_* env vars", async () => {
    const c = await resolveConfig(
      {},
      { AZX_PORTAL_URL: "http://old", AZX_TOKEN: "oldtok" },
      NO_CONFIG_FILE,
    );
    expect(c.portalUrl).toBe("http://old");
    expect(c.token).toBe("oldtok");
  });

  it("prefers HELIX_* over AZX_* when both are set", async () => {
    const c = await resolveConfig(
      {},
      {
        HELIX_PORTAL_URL: "http://new",
        HELIX_TOKEN: "newtok",
        AZX_PORTAL_URL: "http://old",
        AZX_TOKEN: "oldtok",
      },
      NO_CONFIG_FILE,
    );
    expect(c.portalUrl).toBe("http://new");
    expect(c.token).toBe("newtok");
  });

  it("reads helix.json", async () => {
    const dir = await appDir({ "helix.json": { slug: "from-helix", dir: "build" } });
    const c = await resolveConfig({}, {}, dir);
    expect(c.slug).toBe("from-helix");
    expect(c.dir).toBe("build");
  });

  it("falls back to a pre-rename azx.json", async () => {
    const dir = await appDir({ "azx.json": { slug: "from-azx" } });
    expect((await resolveConfig({}, {}, dir)).slug).toBe("from-azx");
  });

  it("prefers helix.json when both files exist", async () => {
    const dir = await appDir({
      "helix.json": { slug: "from-helix" },
      "azx.json": { slug: "from-azx" },
    });
    expect((await resolveConfig({}, {}, dir)).slug).toBe("from-helix");
  });
});

describe("parseVisibility", () => {
  it("parses each mode", () => {
    expect(parseVisibility(undefined)).toBeUndefined();
    expect(parseVisibility("private")).toEqual({ mode: "private" });
    expect(parseVisibility("public")).toEqual({ mode: "public" });
    expect(parseVisibility("group:eng")).toEqual({ mode: "group", groupId: "eng" });
  });

  it("rejects malformed input", () => {
    expect(() => parseVisibility("nope")).toThrow();
    expect(() => parseVisibility("group:")).toThrow();
  });
});
