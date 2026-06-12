import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultTokenPath, deleteTokens, readTokens, writeTokens } from "./tokenStore.js";

const ISSUER = "http://localhost:3002";

let file: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "azx-tokens-"));
  file = path.join(dir, "nested", "tokens.json");
});

const TOKENS = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: Date.now() + 60_000,
  clientId: "azx-cli",
};

describe("token store", () => {
  it("round-trips tokens per issuer", async () => {
    await writeTokens(ISSUER, TOKENS, file);
    await writeTokens("https://other", { ...TOKENS, accessToken: "at-2" }, file);
    expect(await readTokens(ISSUER, file)).toEqual(TOKENS);
    expect((await readTokens("https://other", file))?.accessToken).toBe("at-2");
    expect(await readTokens("https://unknown", file)).toBeUndefined();
  });

  it("creates the credential file with mode 0600", async () => {
    await writeTokens(ISSUER, TOKENS, file);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tolerates a corrupt file (treated as logged out)", async () => {
    await writeTokens(ISSUER, TOKENS, file);
    await writeFile(file, "{not json");
    expect(await readTokens(ISSUER, file)).toBeUndefined();
    // And recovers on the next write.
    await writeTokens(ISSUER, TOKENS, file);
    expect(await readTokens(ISSUER, file)).toEqual(TOKENS);
  });

  it("deleteTokens forgets one issuer and removes an empty file", async () => {
    await writeTokens(ISSUER, TOKENS, file);
    expect(await deleteTokens(ISSUER, file)).toBe(true);
    expect(await readTokens(ISSUER, file)).toBeUndefined();
    expect(await deleteTokens(ISSUER, file)).toBe(false);
    await expect(readFile(file)).rejects.toThrow(); // file gone entirely
  });

  it("defaultTokenPath honors XDG_CONFIG_HOME", () => {
    expect(defaultTokenPath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/azx/tokens.json");
    expect(defaultTokenPath({})).toContain(path.join(".config", "azx", "tokens.json"));
  });
});
