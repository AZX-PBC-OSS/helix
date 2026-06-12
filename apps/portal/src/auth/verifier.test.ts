import { generateKeyPair, exportJWK, SignJWT, createLocalJWKSet, type JWK } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDevTokenVerifier, createOidcVerifier, type TokenVerifier } from "./verifier.js";

/**
 * The portal-side adversarial JWT suite (working agreement §6): every way a
 * bearer token can be wrong — issuer, audience, expiry, signature, algorithm
 * confusion, shape — must yield null (→ 401 via the chain), never an actor.
 */

type SignKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

const ISSUER = "http://idp.test";
const AUDIENCE = "urn:helix:portal";

let rightKey: SignKey;
let rightPublicJwk: JWK;
let wrongKey: SignKey;
let verifier: TokenVerifier;

beforeAll(async () => {
  const right = await generateKeyPair("RS256");
  rightKey = right.privateKey;
  rightPublicJwk = { ...(await exportJWK(right.publicKey)), alg: "RS256", use: "sig" };
  const wrong = await generateKeyPair("RS256");
  wrongKey = wrong.privateKey;

  verifier = createOidcVerifier({
    issuer: ISSUER,
    audience: AUDIENCE,
    getKey: createLocalJWKSet({ keys: [rightPublicJwk] }),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface MintOptions {
  issuer?: string;
  audience?: string;
  sub?: string | null;
  expiresIn?: string;
  key?: SignKey;
  claims?: Record<string, unknown>;
}

async function mint(opts: MintOptions = {}): Promise<string> {
  let jwt = new SignJWT({
    ...(opts.sub === null ? {} : { sub: opts.sub ?? "5f0d5d2a-1111-4abc-8def-000000000001" }),
    ...opts.claims,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt();
  jwt = jwt.setExpirationTime(opts.expiresIn ?? "5m");
  return jwt.sign(opts.key ?? rightKey);
}

describe("createOidcVerifier", () => {
  it("accepts a valid token and prefers email for the actor sub", async () => {
    const actor = await verifier.verify(
      await mint({ claims: { email: "alice@azx.dev", name: "Alice Anders" } }),
    );
    expect(actor).toEqual({
      sub: "alice@azx.dev",
      via: "oidc",
      email: "alice@azx.dev",
      name: "Alice Anders",
    });
  });

  it("falls back preferred_username → sub for the actor sub", async () => {
    const preferred = await verifier.verify(
      await mint({ claims: { preferred_username: "alice" } }),
    );
    expect(preferred?.sub).toBe("alice");
    const bare = await verifier.verify(await mint());
    expect(bare?.sub).toBe("5f0d5d2a-1111-4abc-8def-000000000001");
  });

  it("rejects the wrong issuer", async () => {
    expect(await verifier.verify(await mint({ issuer: "http://evil.test" }))).toBeNull();
  });

  it("rejects the wrong audience", async () => {
    expect(await verifier.verify(await mint({ audience: "urn:other:api" }))).toBeNull();
  });

  it("rejects an expired token", async () => {
    expect(await verifier.verify(await mint({ expiresIn: "-1m" }))).toBeNull();
  });

  it("rejects a signature from a different key", async () => {
    expect(await verifier.verify(await mint({ key: wrongKey }))).toBeNull();
  });

  it("rejects a token without sub", async () => {
    expect(await verifier.verify(await mint({ sub: null }))).toBeNull();
  });

  it("rejects HS256 alg confusion (symmetric key = the public JWKS bytes)", async () => {
    const hsToken = await new SignJWT({ sub: "x" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(Buffer.from(JSON.stringify(rightPublicJwk)));
    expect(await verifier.verify(hsToken)).toBeNull();
  });

  it("rejects alg:none", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ sub: "x", iss: ISSUER, aud: AUDIENCE, iat: now, exp: now + 300 }),
    ).toString("base64url");
    expect(await verifier.verify(`${header}.${payload}.`)).toBeNull();
  });

  it("returns null (not an error) for non-JWT tokens, without touching the network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await verifier.verify("dev-deploy-token")).toBeNull();
    expect(await verifier.verify("")).toBeNull();
    expect(await verifier.verify("a.b")).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects malformed JWT structure", async () => {
    expect(await verifier.verify("!!.!!.!!")).toBeNull();
  });
});

describe("createDevTokenVerifier", () => {
  it("matches only the exact token", async () => {
    const dev = createDevTokenVerifier("secret-token", "dev@azx.io");
    expect(await dev.verify("secret-token")).toEqual({ sub: "dev@azx.io", via: "dev-token" });
    expect(await dev.verify("secret-token ")).toBeNull();
    expect(await dev.verify("other")).toBeNull();
  });

  it("refuses to be constructed in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createDevTokenVerifier("t", "a")).toThrow(/production/);
    vi.unstubAllEnvs();
  });
});
