import { beforeAll, describe, expect, it } from "vitest";
import { createGithubOidcVerifier, type GithubOidcVerifier } from "./githubOidc.js";
import {
  GITHUB_ISSUER,
  githubTokenFixture,
  type GithubTokenFixture,
} from "../test/githubTokens.js";

/**
 * The GitHub Actions token verifier's adversarial suite (ADR-0051 decision 4):
 * every way a token can be wrong must be refused, and the refusal must say
 * whether the token was GitHub-signed for someone else.
 */

const AUDIENCE = "https://portal.example.test";

let gh: GithubTokenFixture;
let verifier: GithubOidcVerifier;

beforeAll(async () => {
  gh = await githubTokenFixture(AUDIENCE);
  verifier = createGithubOidcVerifier({
    issuer: GITHUB_ISSUER,
    audience: AUDIENCE,
    getKey: gh.getKey,
  });
});

const now = () => Math.floor(Date.now() / 1000);

describe("createGithubOidcVerifier", () => {
  it("accepts a GitHub-shaped token for this portal and returns its claims", async () => {
    const result = await verifier.verify(await gh.mint());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims).toMatchObject({
        repository_id: "1001",
        repository_owner_id: "2002",
        ref: "refs/heads/main",
        event_name: "push",
      });
    }
  });

  it("falls back to workflow_ref when a token has no job_workflow_ref", async () => {
    const result = await verifier.verify(
      await gh.mint({ claims: { job_workflow_ref: undefined } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.job_workflow_ref).toBe(result.claims.workflow_ref);
  });

  it("refuses an http issuer at construction", () => {
    expect(() =>
      createGithubOidcVerifier({ issuer: "http://token.example", audience: AUDIENCE }),
    ).toThrow(/https/);
  });

  it.each<[string, () => Promise<string>, "bad_token" | "bad_audience"]>([
    ["a wrong issuer", () => gh.mint({ issuer: "https://token.example.com" }), "bad_token"],
    ["a key GitHub's JWKS doesn't list", () => gh.mint({ key: gh.strangerKey }), "bad_token"],
    ["an expired token", () => gh.mint({ exp: now() - 60 }), "bad_token"],
    ["a token not yet valid", () => gh.mint({ nbf: now() + 600 }), "bad_token"],
    ["a token with no jti", () => gh.mint({ claims: { jti: undefined } }), "bad_token"],
    [
      "a token with no repository_id",
      () => gh.mint({ claims: { repository_id: undefined } }),
      "bad_token",
    ],
    ["a numeric repository_id", () => gh.mint({ claims: { repository_id: 1001 } }), "bad_token"],
    ["a malformed sha", () => gh.mint({ claims: { sha: "not-a-sha" } }), "bad_token"],
    [
      "another service's audience",
      () => gh.mint({ audience: "https://other.example" }),
      "bad_audience",
    ],
    [
      "GitHub's default audience",
      () => gh.mint({ audience: "https://github.com/octo-org" }),
      "bad_audience",
    ],
    [
      "an audience array that includes ours",
      () => gh.mint({ audience: [AUDIENCE, "x"] }),
      "bad_audience",
    ],
    [
      "the audience with a trailing slash",
      () => gh.mint({ audience: `${AUDIENCE}/` }),
      "bad_audience",
    ],
  ])("refuses %s", async (_label, makeToken, outcome) => {
    expect(await verifier.verify(await makeToken())).toEqual({ ok: false, outcome });
  });

  it.each(["", "not-a-jwt", "a.b", "a.b.c"])("refuses the non-token %j", async (token) => {
    expect(await verifier.verify(token)).toEqual({ ok: false, outcome: "bad_token" });
  });

  it("refuses an HS256 token signed with the audience as the secret", async () => {
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ jti: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(GITHUB_ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(AUDIENCE));
    expect(await verifier.verify(token)).toEqual({ ok: false, outcome: "bad_token" });
  });
});
