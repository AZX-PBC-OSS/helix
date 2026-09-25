import { describe, expect, it } from "vitest";
import * as oidc from "openid-client";
import {
  startDevOAuthVendor,
  type RunningDevOAuthVendor,
  type StartDevOAuthVendorOptions,
} from "./start.js";
import {
  callApiDestination,
  exchangeAuthorizationCode,
  newCodeVerifier,
  refreshAccessToken,
  requestAuthorizationCode,
  s256CodeChallenge,
  type TokenEndpointResult,
} from "./testing.js";
import { DEFAULT_CLIENT_ID, DEFAULT_CLIENT_SECRET, JOURNEYS, TOKEN_MODES } from "./modes.js";

const REDIRECT_URI = "http://localhost:4919/connections/callback";

async function withVendor<T>(
  opts: StartDevOAuthVendorOptions,
  fn: (vendor: RunningDevOAuthVendor) => Promise<T>,
): Promise<T> {
  const vendor = await startDevOAuthVendor(opts);
  try {
    return await fn(vendor);
  } finally {
    await vendor.close();
  }
}

/** Authorize + exchange in one hop — the tokens a connected user would hold. */
async function fullFlowTokens(vendor: RunningDevOAuthVendor): Promise<TokenEndpointResult> {
  const verifier = newCodeVerifier();
  const grant = await requestAuthorizationCode(vendor, {
    redirectUri: REDIRECT_URI,
    challenge: s256CodeChallenge(verifier),
    scope: "tasks.read",
  });
  if (grant.code === undefined) throw new Error(`authorize did not approve: ${grant.error}`);
  return exchangeAuthorizationCode(vendor, grant.code, { verifier, redirectUri: REDIRECT_URI });
}

describe("authorization-code flow (S256 PKCE)", () => {
  it("auto-approves and completes the exchange", async () => {
    await withVendor({}, async (vendor) => {
      const verifier = newCodeVerifier();
      const grant = await requestAuthorizationCode(vendor, {
        redirectUri: REDIRECT_URI,
        challenge: s256CodeChallenge(verifier),
        state: "st-1",
        scope: "tasks.read",
      });
      expect(grant.error).toBeUndefined();
      expect(grant.code).toEqual(expect.any(String));
      expect(grant.state).toBe("st-1");

      const exchange = await exchangeAuthorizationCode(vendor, grant.code as string, {
        verifier,
        redirectUri: REDIRECT_URI,
      });
      expect(exchange.status).toBe(200);
      expect(exchange.body.token_type).toBe("Bearer");
      expect(exchange.body.access_token).toEqual(expect.any(String));
      expect(exchange.body.refresh_token).toEqual(expect.any(String));
      expect(exchange.body.expires_in).toEqual(expect.any(Number));
      expect(exchange.body.scope).toBe("tasks.read");
    });
  });

  it("deny mode redirects back with the standard access_denied error", async () => {
    await withVendor({ authorizeMode: "deny" }, async (vendor) => {
      const grant = await requestAuthorizationCode(vendor, {
        redirectUri: REDIRECT_URI,
        state: "st-2",
      });
      expect(grant.error).toBe("access_denied");
      expect(grant.state).toBe("st-2");
      expect(grant.code).toBeUndefined();
    });
  });

  it("enforces S256: a wrong verifier fails the exchange and burns the code", async () => {
    await withVendor({}, async (vendor) => {
      const verifier = newCodeVerifier();
      const grant = await requestAuthorizationCode(vendor, {
        redirectUri: REDIRECT_URI,
        challenge: s256CodeChallenge(verifier),
      });
      const wrong = await exchangeAuthorizationCode(vendor, grant.code as string, {
        verifier: newCodeVerifier(),
        redirectUri: REDIRECT_URI,
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error).toBe("invalid_grant");

      const correct = await exchangeAuthorizationCode(vendor, grant.code as string, {
        verifier,
        redirectUri: REDIRECT_URI,
      });
      expect(correct.status).toBe(400);
      expect(correct.body.error).toBe("invalid_grant");
    });
  });

  it("refuses an unregistered redirect_uri without redirecting", async () => {
    await withVendor({ redirectUris: [REDIRECT_URI] }, async (vendor) => {
      const verifier = newCodeVerifier();
      const res = await fetch(
        `${vendor.issuer}/authorize?${new URLSearchParams({
          client_id: DEFAULT_CLIENT_ID,
          response_type: "code",
          redirect_uri: "http://evil.example.com/callback",
          code_challenge: s256CodeChallenge(verifier),
          code_challenge_method: "S256",
        })}`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("invalid_request");
    });
  });
});

describe("token-endpoint modes", () => {
  it("rotating: refresh issues a replacement and retires the presented token", async () => {
    await withVendor({ tokenMode: "rotating" }, async (vendor) => {
      const first = await fullFlowTokens(vendor);
      const presented = first.body.refresh_token as string;

      const renewed = await refreshAccessToken(vendor, presented);
      expect(renewed.status).toBe(200);
      const replacement = renewed.body.refresh_token as string;
      expect(replacement).toEqual(expect.any(String));
      expect(replacement).not.toBe(presented);
      expect(renewed.body.access_token).toEqual(expect.any(String));

      const replay = await refreshAccessToken(vendor, presented);
      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_grant");
    });
  });

  it("non-rotating: refresh succeeds, omits refresh_token, and the old token stays valid", async () => {
    await withVendor({ tokenMode: "non-rotating" }, async (vendor) => {
      const first = await fullFlowTokens(vendor);
      const presented = first.body.refresh_token as string;

      const renewed = await refreshAccessToken(vendor, presented);
      expect(renewed.status).toBe(200);
      expect(renewed.body.access_token).toEqual(expect.any(String));
      expect(renewed.body).not.toHaveProperty("refresh_token");

      const again = await refreshAccessToken(vendor, presented);
      expect(again.status).toBe(200);
      expect(again.body.access_token).toEqual(expect.any(String));
    });
  });

  it("hang: the code exchange stalls past a short caller timeout", async () => {
    await withVendor({ tokenMode: "hang" }, async (vendor) => {
      const verifier = newCodeVerifier();
      const grant = await requestAuthorizationCode(vendor, {
        redirectUri: REDIRECT_URI,
        challenge: s256CodeChallenge(verifier),
      });
      const started = Date.now();
      await expect(
        exchangeAuthorizationCode(
          vendor,
          grant.code as string,
          { verifier, redirectUri: REDIRECT_URI },
          AbortSignal.timeout(250),
        ),
      ).rejects.toThrowError();
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    });
  });

  it("hang: flips on mid-journey via setModes and stalls the refresh", async () => {
    await withVendor({ tokenMode: "rotating" }, async (vendor) => {
      const first = await fullFlowTokens(vendor);
      vendor.setModes({ tokenMode: "hang" });
      expect(vendor.modes().tokenMode).toBe("hang");
      await expect(
        refreshAccessToken(
          vendor,
          first.body.refresh_token as string,
          {},
          AbortSignal.timeout(250),
        ),
      ).rejects.toThrowError();
    });
  });

  it("consumed-then-drop: consumes the presented refresh token and returns nothing usable", async () => {
    await withVendor({ tokenMode: "rotating" }, async (vendor) => {
      const first = await fullFlowTokens(vendor);
      const presented = first.body.refresh_token as string;

      vendor.setModes({ tokenMode: "consumed-then-drop" });
      const dropped = await refreshAccessToken(vendor, presented);
      expect(dropped.status).toBe(400);
      expect(dropped.body.error).toBe("invalid_grant");
      expect(dropped.body.access_token).toBeUndefined();
      expect(dropped.body.refresh_token).toBeUndefined();

      // Consumption is real, not a one-off error: even back in a succeeding
      // mode the presented token is gone.
      vendor.setModes({ tokenMode: "rotating" });
      const retry = await refreshAccessToken(vendor, presented);
      expect(retry.status).toBe(400);
      expect(retry.body.error).toBe("invalid_grant");
    });
  });

  it("consumed-then-drop: burns the authorization code on the exchange path too", async () => {
    await withVendor({ tokenMode: "consumed-then-drop" }, async (vendor) => {
      const verifier = newCodeVerifier();
      const grant = await requestAuthorizationCode(vendor, {
        redirectUri: REDIRECT_URI,
        challenge: s256CodeChallenge(verifier),
      });
      const dropped = await exchangeAuthorizationCode(vendor, grant.code as string, {
        verifier,
        redirectUri: REDIRECT_URI,
      });
      expect(dropped.status).toBe(400);
      expect(dropped.body.error).toBe("invalid_grant");

      vendor.setModes({ tokenMode: "rotating" });
      const retry = await exchangeAuthorizationCode(vendor, grant.code as string, {
        verifier,
        redirectUri: REDIRECT_URI,
      });
      expect(retry.status).toBe(400);
      expect(retry.body.error).toBe("invalid_grant");
    });
  });

  it("answers malformed grants with standard error shapes", async () => {
    await withVendor({}, async (vendor) => {
      // The driver only speaks the two supported grant types; poke the raw
      // endpoint for the unsupported one and the bad client.
      const raw = await fetch(`${vendor.issuer}/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${DEFAULT_CLIENT_ID}:${DEFAULT_CLIENT_SECRET}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "password",
          username: "x",
          password: "y",
        }).toString(),
      });
      expect(raw.status).toBe(400);
      const rawBody = (await raw.json()) as { error: string };
      expect(rawBody.error).toBe("unsupported_grant_type");

      const badClient = await fetch(`${vendor.issuer}/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "x",
          client_id: "nobody",
        }).toString(),
      });
      expect(badClient.status).toBe(401);
      const badClientBody = (await badClient.json()) as { error: string };
      expect(badClientBody.error).toBe("invalid_client");
    });
  });
});

describe("fake API destination", () => {
  it("reports a Bearer-placed token with the header name it arrived in", async () => {
    await withVendor({}, async (vendor) => {
      const tokens = await fullFlowTokens(vendor);
      const call = await callApiDestination(vendor, {
        bearerToken: tokens.body.access_token as string,
        path: "/api/echo",
      });
      expect(call.status).toBe(200);
      expect(call.report.placement).toBe("header-bearer");
      expect(call.report.headerName).toBe("authorization");
      expect(call.report.token).toBe(tokens.body.access_token);
      expect(call.report.method).toBe("POST");
      expect(call.report.path).toBe("/api/echo");
    });
  });

  it("reports a named-header placement verbatim", async () => {
    await withVendor({}, async (vendor) => {
      const tokens = await fullFlowTokens(vendor);
      const call = await callApiDestination(vendor, {
        headerName: "x-user-token",
        headerToken: tokens.body.access_token as string,
      });
      expect(call.status).toBe(200);
      expect(call.report.placement).toBe("header");
      expect(call.report.headerName).toBe("x-user-token");
      expect(call.report.token).toBe(tokens.body.access_token);
    });
  });

  it("honors a per-instance named header and reports an unauthenticated call", async () => {
    await withVendor({ apiTokenHeaderName: "x-api-token" }, async (vendor) => {
      const named = await callApiDestination(vendor, {
        headerName: "x-api-token",
        headerToken: "tok",
      });
      expect(named.report.placement).toBe("header");
      expect(named.report.headerName).toBe("x-api-token");

      // Bearer still wins the priority rule when both are present.
      const both = await callApiDestination(vendor, {
        bearerToken: "t1",
        headerName: "x-api-token",
        headerToken: "t2",
      });
      expect(both.report.placement).toBe("header-bearer");

      const none = await callApiDestination(vendor, {
        headerName: "x-unrelated",
        headerToken: "t",
      });
      expect(none.status).toBe(401);
      expect(none.report.placement).toBe("none");
      expect(none.report.headerName).toBeNull();
    });
  });
});

describe("in-process starter", () => {
  it("boots on an ephemeral port, serves one full exchange, and shuts down cleanly", async () => {
    const vendor = await startDevOAuthVendor();
    try {
      expect(vendor.port).toBeGreaterThan(0);
      expect(vendor.issuer).toBe(`http://localhost:${vendor.port}`);
      expect(vendor.modes()).toEqual({ tokenMode: "rotating", authorizeMode: "approve" });

      const verifier = newCodeVerifier();
      const grant = await requestAuthorizationCode(vendor, {
        redirectUri: REDIRECT_URI,
        challenge: s256CodeChallenge(verifier),
      });
      const exchange = await exchangeAuthorizationCode(vendor, grant.code as string, {
        verifier,
        redirectUri: REDIRECT_URI,
      });
      expect(exchange.status).toBe(200);
      expect(exchange.body.access_token).toEqual(expect.any(String));
    } finally {
      await vendor.close();
    }
    // Idempotent, and the surface is really gone afterwards.
    await vendor.close();
    await expect(fetch(`${vendor.issuer}/authorize`)).rejects.toThrowError();
  });
});

describe("per-instance mode isolation", () => {
  it("does not leak between two concurrently running instances", async () => {
    const rotating = await startDevOAuthVendor({ tokenMode: "rotating" });
    const nonRotating = await startDevOAuthVendor({ tokenMode: "non-rotating" });
    try {
      const [a, b] = await Promise.all([fullFlowTokens(rotating), fullFlowTokens(nonRotating)]);
      const rtA = a.body.refresh_token as string;
      const rtB = b.body.refresh_token as string;

      const [renewA, renewB] = await Promise.all([
        refreshAccessToken(rotating, rtA),
        refreshAccessToken(nonRotating, rtB),
      ]);
      expect(renewA.body.refresh_token).toEqual(expect.any(String));
      expect(renewB.body).not.toHaveProperty("refresh_token");

      expect((await refreshAccessToken(rotating, rtA)).status).toBe(400);
      expect((await refreshAccessToken(nonRotating, rtB)).status).toBe(200);

      // Flipping one instance's authorize mode leaves the other untouched.
      rotating.setModes({ authorizeMode: "deny" });
      const deniedA = await requestAuthorizationCode(rotating, { redirectUri: REDIRECT_URI });
      const approvedB = await requestAuthorizationCode(nonRotating, { redirectUri: REDIRECT_URI });
      expect(deniedA.error).toBe("access_denied");
      expect(approvedB.code).toBeDefined();
      expect(nonRotating.modes()).toEqual({ tokenMode: "non-rotating", authorizeMode: "approve" });
    } finally {
      await Promise.all([rotating.close(), nonRotating.close()]);
    }
  });
});

describe("openid-client contract (the client the egress uses)", () => {
  it("validates the non-fault token responses end to end", async () => {
    await withVendor({ tokenMode: "rotating" }, async (vendor) => {
      const config = new oidc.Configuration(
        {
          issuer: vendor.issuer,
          authorization_endpoint: `${vendor.issuer}/authorize`,
          token_endpoint: `${vendor.issuer}/token`,
        },
        DEFAULT_CLIENT_ID,
        { client_secret: DEFAULT_CLIENT_SECRET, token_endpoint_auth_method: "client_secret_basic" },
        oidc.ClientSecretBasic(DEFAULT_CLIENT_SECRET),
      );
      oidc.allowInsecureRequests(config);

      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const redirectTo = oidc.buildAuthorizationUrl(config, {
        redirect_uri: REDIRECT_URI,
        scope: "tasks.read",
        state: "oc-state",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const authorizeRes = await fetch(redirectTo, { redirect: "manual" });
      expect(authorizeRes.status).toBe(302);
      const location = authorizeRes.headers.get("location");
      expect(location).not.toBeNull();

      const tokens = await oidc.authorizationCodeGrant(config, new URL(location as string), {
        pkceCodeVerifier: verifier,
        expectedState: "oc-state",
      });
      expect(tokens.access_token).toEqual(expect.any(String));
      expect(tokens.refresh_token).toEqual(expect.any(String));

      const renewed = await oidc.refreshTokenGrant(config, tokens.refresh_token as string);
      expect(renewed.access_token).toEqual(expect.any(String));
      expect(renewed.refresh_token).toEqual(expect.any(String));
      expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
    });
  });

  it("surfaces a consumed-then-drop refresh as the standard invalid_grant error", async () => {
    await withVendor({ tokenMode: "rotating" }, async (vendor) => {
      const config = new oidc.Configuration(
        {
          issuer: vendor.issuer,
          authorization_endpoint: `${vendor.issuer}/authorize`,
          token_endpoint: `${vendor.issuer}/token`,
        },
        DEFAULT_CLIENT_ID,
        { client_secret: DEFAULT_CLIENT_SECRET, token_endpoint_auth_method: "client_secret_basic" },
        oidc.ClientSecretBasic(DEFAULT_CLIENT_SECRET),
      );
      oidc.allowInsecureRequests(config);

      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const redirectTo = oidc.buildAuthorizationUrl(config, {
        redirect_uri: REDIRECT_URI,
        scope: "tasks.read",
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      });
      const authorizeRes = await fetch(redirectTo, { redirect: "manual" });
      const tokens = await oidc.authorizationCodeGrant(
        config,
        new URL(authorizeRes.headers.get("location") as string),
        {
          pkceCodeVerifier: verifier,
          expectedState: "s",
        },
      );

      vendor.setModes({ tokenMode: "consumed-then-drop" });
      await expect(oidc.refreshTokenGrant(config, tokens.refresh_token as string)).rejects.toThrow(
        // openid-client recognizes the standard error body and raises it as a
        // protocol error — the shape the egress will see.
        /server responded with an error/i,
      );
    });
  });
});

describe("exported vocabulary", () => {
  it("carries the four token modes and the journey list the consumer suites import", () => {
    expect(TOKEN_MODES).toEqual(["rotating", "non-rotating", "hang", "consumed-then-drop"]);
    expect(JOURNEYS).toContain("popup-consent-success");
    expect(JOURNEYS).toContain("safe-completion-notification");
  });
});
