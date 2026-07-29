import { describe, expect, it } from "vitest";
import {
  ManagedIdentityTokenProvider,
  TokenError,
  managedIdentityTokenProviderFromEnv,
  type FetchToken,
  type TokenFetchResult,
} from "./token.js";

const BASE_OPTS = {
  identityEndpoint: "http://169.254.169.254/msi/token",
  identityHeader: "the-identity-header",
  clientId: "client-guid-123",
};

/** A fetchToken returning a token that expires at `expiresOn` (epoch seconds). */
function tokenFetch(
  token: string,
  expiresOn: number | string,
  status = 200,
): {
  fetch: FetchToken;
  calls: () => number;
  lastUrl: () => string;
  lastHeaders: () => Record<string, string>;
} {
  let count = 0;
  let url = "";
  let headers: Record<string, string> = {};
  const fetch: FetchToken = async (u, h) => {
    count += 1;
    url = u;
    headers = h;
    const body =
      status === 200 ? JSON.stringify({ access_token: token, expires_on: expiresOn }) : "denied";
    return { status, body } satisfies TokenFetchResult;
  };
  return { fetch, calls: () => count, lastUrl: () => url, lastHeaders: () => headers };
}

describe("ManagedIdentityTokenProvider (Key Vault)", () => {
  it("requests the vault audience with client_id and the identity header", async () => {
    const now = 1_000_000;
    const f = tokenFetch("tok", now / 1000 + 3600);
    const p = new ManagedIdentityTokenProvider({
      ...BASE_OPTS,
      now: () => now,
      fetchToken: f.fetch,
    });

    await p.getToken();
    const url = new URL(f.lastUrl());
    expect(url.searchParams.get("client_id")).toBe("client-guid-123");
    // No trailing slash — the Key Vault audience differs from Storage's.
    expect(url.searchParams.get("resource")).toBe("https://vault.azure.net");
    expect(url.searchParams.get("api-version")).toBe("2019-08-01");
    expect(f.lastHeaders()["X-IDENTITY-HEADER"]).toBe("the-identity-header");
  });

  it("caches the token across calls within its lifetime", async () => {
    let now = 1_000_000;
    const f = tokenFetch("tok", now / 1000 + 3600);
    const p = new ManagedIdentityTokenProvider({
      ...BASE_OPTS,
      now: () => now,
      fetchToken: f.fetch,
    });

    expect(await p.getToken()).toBe("tok");
    now += 60_000;
    expect(await p.getToken()).toBe("tok");
    expect(f.calls()).toBe(1);
  });

  it("refreshes once inside the skew window before hard expiry", async () => {
    const now = 1_000_000;
    // Expires in 4 minutes; default skew is 5 minutes → already due for refresh.
    const f = tokenFetch("tok", now / 1000 + 240);
    const p = new ManagedIdentityTokenProvider({
      ...BASE_OPTS,
      now: () => now,
      fetchToken: f.fetch,
    });

    await p.getToken();
    await p.getToken();
    expect(f.calls()).toBe(2);
  });

  it("refreshes after hard expiry", async () => {
    let now = 1_000_000;
    const f = tokenFetch("tok", now / 1000 + 3600);
    const p = new ManagedIdentityTokenProvider({
      ...BASE_OPTS,
      now: () => now,
      fetchToken: f.fetch,
    });

    await p.getToken();
    now += 3600 * 1000 + 1;
    await p.getToken();
    expect(f.calls()).toBe(2);
  });

  it("single-flights concurrent refreshes into one fetch", async () => {
    const now = 1_000_000;
    let resolve!: (r: TokenFetchResult) => void;
    let count = 0;
    const fetch: FetchToken = () => {
      count += 1;
      return new Promise<TokenFetchResult>((r) => {
        resolve = r;
      });
    };
    const p = new ManagedIdentityTokenProvider({ ...BASE_OPTS, now: () => now, fetchToken: fetch });

    const a = p.getToken();
    const b = p.getToken();
    resolve({
      status: 200,
      body: JSON.stringify({ access_token: "tok", expires_on: now / 1000 + 3600 }),
    });
    expect(await a).toBe("tok");
    expect(await b).toBe("tok");
    expect(count).toBe(1);
  });

  it("throws on a non-200 from the identity endpoint", async () => {
    const f = tokenFetch("tok", 2_000_000_000, 400);
    const p = new ManagedIdentityTokenProvider({ ...BASE_OPTS, fetchToken: f.fetch });
    await expect(p.getToken()).rejects.toBeInstanceOf(TokenError);
  });

  it("does not poison the cache on failure — the next call retries", async () => {
    const now = 1_000_000;
    let attempt = 0;
    const fetch: FetchToken = async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("network down");
      return {
        status: 200,
        body: JSON.stringify({ access_token: "tok", expires_on: now / 1000 + 3600 }),
      };
    };
    const p = new ManagedIdentityTokenProvider({ ...BASE_OPTS, now: () => now, fetchToken: fetch });

    await expect(p.getToken()).rejects.toBeInstanceOf(TokenError);
    expect(await p.getToken()).toBe("tok");
    expect(attempt).toBe(2);
  });

  it("parses expires_on given as a numeric string", async () => {
    let now = 1_000_000;
    const f = tokenFetch("tok", String(now / 1000 + 3600));
    const p = new ManagedIdentityTokenProvider({
      ...BASE_OPTS,
      now: () => now,
      fetchToken: f.fetch,
    });
    expect(await p.getToken()).toBe("tok");
    now += 60_000;
    expect(await p.getToken()).toBe("tok");
    expect(f.calls()).toBe(1);
  });

  it("throws when the response is not JSON", async () => {
    const fetch: FetchToken = async () => ({ status: 200, body: "<html>nope" });
    const p = new ManagedIdentityTokenProvider({ ...BASE_OPTS, fetchToken: fetch });
    await expect(p.getToken()).rejects.toThrow(/not JSON/);
  });

  it("throws when the response is missing access_token", async () => {
    const fetch: FetchToken = async () => ({
      status: 200,
      body: JSON.stringify({ expires_on: 123 }),
    });
    const p = new ManagedIdentityTokenProvider({ ...BASE_OPTS, fetchToken: fetch });
    await expect(p.getToken()).rejects.toThrow(/access_token/);
  });

  it("rejects an invalid expires_on", async () => {
    const fetch: FetchToken = async () => ({
      status: 200,
      body: JSON.stringify({ access_token: "tok", expires_on: "soon" }),
    });
    const p = new ManagedIdentityTokenProvider({ ...BASE_OPTS, fetchToken: fetch });
    await expect(p.getToken()).rejects.toThrow(/expires_on/);
  });
});

describe("managedIdentityTokenProviderFromEnv", () => {
  it("returns null when the managed-identity env is absent", () => {
    expect(managedIdentityTokenProviderFromEnv({})).toBeNull();
  });

  it("returns null when AZURE_CLIENT_ID is missing (user-assigned MI is ambiguous)", () => {
    expect(
      managedIdentityTokenProviderFromEnv({
        IDENTITY_ENDPOINT: "http://169.254.169.254/msi/token",
        IDENTITY_HEADER: "h",
      }),
    ).toBeNull();
  });

  it("builds a provider when all three vars are present", () => {
    const p = managedIdentityTokenProviderFromEnv({
      IDENTITY_ENDPOINT: "http://169.254.169.254/msi/token",
      IDENTITY_HEADER: "h",
      AZURE_CLIENT_ID: "cid",
    });
    expect(p).toBeInstanceOf(ManagedIdentityTokenProvider);
  });
});
