import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { startDevOAuthVendor } from "@azx-pbc/dev-oauth-vendor";
import type { ServiceOAuthRecipe, ServiceOAuthCredential } from "@azx-pbc/shared";
import { serviceTokenExchange } from "./serviceOAuthTransport.js";
import { makePinnedDispatcher } from "./ssrf.js";

const dispatcher = makePinnedDispatcher(true, 1000);
const exchange = serviceTokenExchange(dispatcher);
const recipe: ServiceOAuthRecipe = {
  kind: "oauth-service-account",
  tokenEndpoint: "https://vendor.example/token",
  grantType: "client_credentials",
  clientAuthentication: "client_secret_basic",
  scopes: ["read"],
  replaySafePostPaths: [],
};
const credential: ServiceOAuthCredential = {
  kind: recipe.kind,
  clientId: "id:+ space",
  clientSecret: "secret:+ space",
};
afterAll(() => dispatcher.close());

describe("service-account OAuth wire protocol", () => {
  it.each(["client_secret_basic", "client_secret_post"] as const)(
    "uses form-encoded client credentials with %s",
    async (clientAuthentication) => {
      const vendor = await startDevOAuthVendor({
        serviceAccounts: true,
        clientId: credential.clientId,
        clientSecret: credential.clientSecret,
      });
      try {
        const token = await exchange(
          { ...recipe, clientAuthentication, tokenEndpoint: `${vendor.issuer}/token` },
          credential,
          undefined,
          AbortSignal.timeout(2000),
        );
        expect(token.access).toBeTruthy();
        expect(token.refresh).toBeUndefined();
        expect(vendor.tokenCalls()[0]?.grantType).toBe("client_credentials");
      } finally {
        await vendor.close();
      }
    },
  );
  it("supports password and rotating refresh without client identification or authentication", async () => {
    const vendor = await startDevOAuthVendor({ serviceAccounts: true, clientSecret: null });
    try {
      const config: ServiceOAuthRecipe = {
        ...recipe,
        tokenEndpoint: `${vendor.issuer}/token`,
        grantType: "password",
        clientAuthentication: "none",
      };
      const cred: ServiceOAuthCredential = {
        kind: recipe.kind,
        username: "fixture-service",
        password: "fixture-password",
      };
      const a = await exchange(config, cred, undefined, AbortSignal.timeout(2000));
      const b = await exchange(config, cred, a.refresh, AbortSignal.timeout(2000));
      expect(b.refresh).not.toBe(a.refresh);
      expect(vendor.tokenCalls().map((c) => c.grantType)).toEqual(["password", "refresh_token"]);
    } finally {
      await vendor.close();
    }
  });
  it.each([
    { body: { access_token: "token", token_type: "Bearer" }, status: 200 },
    { body: { access_token: "token", token_type: "MAC", expires_in: 3600 }, status: 200 },
    {
      body: { access_token: "token", token_type: "Bearer", expires_in: 3600, scope: "other" },
      status: 200,
    },
    {
      body: { access_token: "token\r\nsecret", token_type: "Bearer", expires_in: 3600 },
      status: 200,
    },
    { body: "x".repeat(70_000), status: 200 },
  ])("rejects malformed, unsafe, or narrowed token responses", async ({ body, status }) => {
    const server = createServer((_req, res) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const tokenEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await expect(
        exchange({ ...recipe, tokenEndpoint }, credential, undefined, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ outcome: "needs_attention" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("never follows a token redirect and respects non-JSON rate-limit responses", async () => {
    let calls = 0;
    const server = createServer((_req, res) => {
      calls++;
      res.writeHead(calls === 1 ? 302 : 429, {
        location: "/redirect-target",
        "retry-after": "120",
      });
      res.end("private-vendor-body-SENTINEL");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const tokenEndpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await expect(
        exchange({ ...recipe, tokenEndpoint }, credential, undefined, AbortSignal.timeout(1000)),
      ).rejects.toThrow("temporary_failure");
      expect(calls).toBe(1);
      await expect(
        exchange({ ...recipe, tokenEndpoint }, credential, undefined, AbortSignal.timeout(1000)),
      ).rejects.toMatchObject({ retryMs: 120000, allowFallback: false });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
  it("applies private-address SSRF protection to token calls", async () => {
    const protectedDispatcher = makePinnedDispatcher(false, 1000);
    try {
      await expect(
        serviceTokenExchange(protectedDispatcher)(
          { ...recipe, tokenEndpoint: "https://127.0.0.1/token" },
          credential,
          undefined,
          AbortSignal.timeout(1000),
        ),
      ).rejects.toThrow("temporary_failure");
    } finally {
      await protectedDispatcher.close();
    }
  });
});
