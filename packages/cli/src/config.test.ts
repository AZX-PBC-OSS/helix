import { describe, expect, it } from "vitest";
import { parseVisibility } from "./commands.js";
import { resolveConfig } from "./config.js";

const NO_AZX_JSON = "/tmp/helix-cli-no-config-dir";

describe("resolveConfig", () => {
  it("applies defaults when nothing is set", async () => {
    const c = await resolveConfig({}, {}, NO_AZX_JSON);
    expect(c.portalUrl).toBe("http://localhost:3001");
    expect(c.dir).toBe("dist");
    expect(c.slug).toBeUndefined();
    expect(c.token).toBeUndefined();
  });

  it("lets flags override env", async () => {
    const c = await resolveConfig(
      { portalUrl: "http://flag", slug: "s", token: "flagtok" },
      { AZX_PORTAL_URL: "http://env", AZX_TOKEN: "envtok" },
      NO_AZX_JSON,
    );
    expect(c.portalUrl).toBe("http://flag");
    expect(c.token).toBe("flagtok");
    expect(c.slug).toBe("s");
  });

  it("falls back to env when no flag is given", async () => {
    const c = await resolveConfig(
      {},
      { AZX_PORTAL_URL: "http://env", AZX_TOKEN: "envtok" },
      NO_AZX_JSON,
    );
    expect(c.portalUrl).toBe("http://env");
    expect(c.token).toBe("envtok");
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
