import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultTokenPath, deleteTokens, readTokens, writeTokens } from "./tokenStore.js";

const ISSUER = "http://localhost:3002";
const PORTAL = "http://localhost:3001";
const KEY = { portalUrl: PORTAL, issuer: ISSUER };

let file: string;

beforeEach(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "helix-tokens-"));
  file = path.join(dir, "nested", "tokens.json");
});

const TOKENS = {
  accessToken: "at-1",
  refreshToken: "rt-1",
  expiresAt: Date.now() + 60_000,
  clientId: "azx-cli",
};

describe("token store", () => {
  it("round-trips tokens per portal origin", async () => {
    await writeTokens(KEY, TOKENS, file);
    await writeTokens(
      { portalUrl: "https://other.portal", issuer: ISSUER },
      { ...TOKENS, accessToken: "at-2" },
      file,
    );
    expect(await readTokens(KEY, file)).toEqual(TOKENS);
    expect(
      (await readTokens({ portalUrl: "https://other.portal", issuer: ISSUER }, file))?.accessToken,
    ).toBe("at-2");
    expect(
      await readTokens({ portalUrl: "https://unknown.portal", issuer: ISSUER }, file),
    ).toBeUndefined();
  });

  it("never returns tokens for a different portal origin, same issuer", async () => {
    // The attack the binding kills: a planted helix.json points the CLI at a
    // hostile portal that echoes the REAL issuer in its auth config.
    await writeTokens(KEY, TOKENS, file);
    expect(
      await readTokens({ portalUrl: "https://evil.example", issuer: ISSUER }, file),
    ).toBeUndefined();
  });

  it("normalizes the portal URL to its origin", async () => {
    await writeTokens(KEY, TOKENS, file);
    expect(await readTokens({ portalUrl: `${PORTAL}/some/path/`, issuer: ISSUER }, file)).toEqual(
      TOKENS,
    );
  });

  it("returns nothing when the portal's advertised issuer changed since login", async () => {
    await writeTokens(KEY, TOKENS, file);
    expect(
      await readTokens({ portalUrl: PORTAL, issuer: "http://other-idp.test" }, file),
    ).toBeUndefined();
  });

  it("treats a version-1 (issuer-keyed) file as logged out", async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, byIssuer: { [ISSUER]: TOKENS } }));
    expect(await readTokens(KEY, file)).toBeUndefined();
  });

  it("creates the credential file with mode 0600", async () => {
    await writeTokens(KEY, TOKENS, file);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tolerates a corrupt file (treated as logged out)", async () => {
    await writeTokens(KEY, TOKENS, file);
    await writeFile(file, "{not json");
    expect(await readTokens(KEY, file)).toBeUndefined();
    // And recovers on the next write.
    await writeTokens(KEY, TOKENS, file);
    expect(await readTokens(KEY, file)).toEqual(TOKENS);
  });

  it("deleteTokens forgets one portal and removes an empty file", async () => {
    await writeTokens(KEY, TOKENS, file);
    expect(await deleteTokens(PORTAL, file)).toBe(true);
    expect(await readTokens(KEY, file)).toBeUndefined();
    expect(await deleteTokens(PORTAL, file)).toBe(false);
    await expect(readFile(file)).rejects.toThrow(); // file gone entirely
  });

  it("defaultTokenPath honors XDG_CONFIG_HOME", () => {
    expect(defaultTokenPath({ XDG_CONFIG_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/helix/tokens.json");
    expect(defaultTokenPath({})).toContain(path.join(".config", "helix", "tokens.json"));
  });
});
