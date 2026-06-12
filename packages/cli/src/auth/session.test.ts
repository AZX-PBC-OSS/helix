import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeTokenProvider, type SessionDeps } from "./session.js";
import { readTokens, writeTokens, type StoredTokens } from "./tokenStore.js";

const ISSUER = "http://localhost:3002";
const PORTAL = "http://localhost:3001";

let storePath: string;

beforeEach(async () => {
  storePath = path.join(await mkdtemp(path.join(os.tmpdir(), "azx-session-")), "tokens.json");
});

function deps(overrides: Partial<SessionDeps> = {}): SessionDeps {
  return {
    getAuthConfig: vi.fn(async () => ({ issuer: ISSUER, cliClientId: "azx-cli" })),
    refresh: vi.fn(async (): Promise<StoredTokens> => {
      throw new Error("refresh not expected");
    }),
    storePath,
    ...overrides,
  };
}

describe("makeTokenProvider", () => {
  it("a static token short-circuits everything", async () => {
    const d = deps();
    const provider = makeTokenProvider({ portalUrl: PORTAL, staticToken: "static" }, d);
    expect(await provider()).toBe("static");
    expect(d.getAuthConfig).not.toHaveBeenCalled();
  });

  it("returns undefined (→ 'run azx login') with an empty cache", async () => {
    const provider = makeTokenProvider({ portalUrl: PORTAL }, deps());
    expect(await provider()).toBeUndefined();
  });

  it("returns a cached unexpired token without refreshing", async () => {
    await writeTokens(
      ISSUER,
      {
        accessToken: "at",
        refreshToken: "rt",
        expiresAt: Date.now() + 600_000,
        clientId: "azx-cli",
      },
      storePath,
    );
    const d = deps();
    const provider = makeTokenProvider({ portalUrl: PORTAL }, d);
    expect(await provider()).toBe("at");
    expect(d.refresh).not.toHaveBeenCalled();
  });

  it("refreshes within the expiry margin and persists the renewal", async () => {
    await writeTokens(
      ISSUER,
      {
        accessToken: "old",
        refreshToken: "rt",
        expiresAt: Date.now() + 10_000,
        clientId: "azx-cli",
      },
      storePath,
    );
    const renewed: StoredTokens = {
      accessToken: "new",
      refreshToken: "rt-2",
      expiresAt: Date.now() + 600_000,
      clientId: "azx-cli",
    };
    const d = deps({ refresh: vi.fn(async () => renewed) });
    const provider = makeTokenProvider({ portalUrl: PORTAL }, d);

    expect(await provider()).toBe("new");
    expect(d.refresh).toHaveBeenCalledWith(ISSUER, "azx-cli", "rt");
    expect(await readTokens(ISSUER, storePath)).toEqual(renewed);
  });

  it("treats a refused refresh as logged out, not an error", async () => {
    await writeTokens(
      ISSUER,
      { accessToken: "old", refreshToken: "rt", expiresAt: Date.now() - 1, clientId: "azx-cli" },
      storePath,
    );
    const d = deps({
      refresh: vi.fn(async () => {
        throw new Error("invalid_grant");
      }),
    });
    const provider = makeTokenProvider({ portalUrl: PORTAL }, d);
    expect(await provider()).toBeUndefined();
  });

  it("an expired token without a refresh token means logged out", async () => {
    await writeTokens(
      ISSUER,
      { accessToken: "old", expiresAt: Date.now() - 1, clientId: "azx-cli" },
      storePath,
    );
    const provider = makeTokenProvider({ portalUrl: PORTAL }, deps());
    expect(await provider()).toBeUndefined();
  });
});
