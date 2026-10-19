import { describe, expect, it, vi } from "vitest";
import { githubTokenSource, requestGithubIdToken } from "./githubActions.js";

describe("githubTokenSource", () => {
  it("needs both Actions env vars", () => {
    expect(githubTokenSource({})).toBeNull();
    expect(githubTokenSource({ ACTIONS_ID_TOKEN_REQUEST_URL: "https://x" })).toBeNull();
    expect(
      githubTokenSource({
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://x",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "t",
      }),
    ).toEqual({ requestUrl: "https://x", requestToken: "t" });
  });
});

describe("requestGithubIdToken", () => {
  const source = {
    requestUrl: "https://pipelines.example/idtoken?api-version=2.0",
    requestToken: "runtime-token",
  };

  it("asks for the portal audience, keeping the endpoint's own query", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ value: "id.token.here" })));
    const token = await requestGithubIdToken(
      source,
      "https://portal.example.com",
      fetchImpl as never,
    );
    expect(token).toBe("id.token.here");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.searchParams.get("api-version")).toBe("2.0");
    expect(url.searchParams.get("audience")).toBe("https://portal.example.com");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer runtime-token");
  });

  it("fails clearly on a refusal or an empty response", async () => {
    await expect(
      requestGithubIdToken(source, "a", (async () => new Response("", { status: 403 })) as never),
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      requestGithubIdToken(source, "a", (async () => new Response("{}")) as never),
    ).rejects.toThrow(/no token/);
  });
});
