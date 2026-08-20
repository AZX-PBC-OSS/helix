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
    allowInsecure: true, // the fixture issuer is http
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface MintOptions {
  issuer?: string;
  audience?: string;
  sub?: string | null;
  /** `null` mints a token with NO exp claim. */
  expiresIn?: string | null;
  /** When false, mints a token with NO iat claim. */
  issuedAt?: boolean;
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
    .setAudience(opts.audience ?? AUDIENCE);
  if (opts.issuedAt !== false) jwt = jwt.setIssuedAt();
  if (opts.expiresIn !== null) jwt = jwt.setExpirationTime(opts.expiresIn ?? "5m");
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
      groups: [],
    });
  });

  it("unions the groups and roles claims", async () => {
    const groups = await verifier.verify(await mint({ claims: { groups: ["platform-admin"] } }));
    expect(groups?.groups).toEqual(["platform-admin"]);
    const roles = await verifier.verify(await mint({ claims: { roles: ["admins"] } }));
    expect(roles?.groups).toEqual(["admins"]);
    const none = await verifier.verify(await mint());
    expect(none?.groups).toEqual([]);
    // Both at once — `groups` first, then whatever `roles` adds.
    const both = await verifier.verify(
      await mint({ claims: { groups: ["group-a"], roles: ["role-b"] } }),
    );
    expect(both?.groups).toEqual(["group-a", "role-b"]);
  });

  /**
   * The regression this case exists to hold. `groups ?? roles` discarded
   * `roles` the instant `groups` was present, and the admin gate
   * (`actorIsAdmin`, plugins/auth.ts) reads exactly one configured value out of
   * that array. So the day the portal app registration starts emitting a
   * security-groups claim (ADR-0040), every platform admin loses the approvals
   * queue and the admin pages — triggered by an IdP-side config change, with no
   * deploy and, before this, nothing in the repo that would go red.
   */
  it("keeps the admin role claim when a groups claim is also present", async () => {
    const actor = await verifier.verify(
      await mint({
        claims: {
          groups: ["11111111-2222-3333-4444-555555555555"],
          roles: ["platform-admin"],
        },
      }),
    );
    expect(actor?.groups).toContain("platform-admin");
    expect(actor?.groups).toContain("11111111-2222-3333-4444-555555555555");
  });

  it("dedupes a value carried by both claims", async () => {
    const actor = await verifier.verify(
      await mint({ claims: { groups: ["shared", "a"], roles: ["shared", "b"] } }),
    );
    expect(actor?.groups).toEqual(["shared", "a", "b"]);
  });

  /**
   * The second half of the same bug: `??` fell through only on null/undefined,
   * so a *malformed* `groups` claim was truthy, won the coalesce, filtered down
   * to [] — and silently threw away a perfectly good `roles`. Same lockout, and
   * this one needed no registration change to fire.
   */
  it("still reads roles when the groups claim is present but malformed", async () => {
    for (const malformed of ["platform-admin", 42, {}, true, [""], [7]]) {
      const actor = await verifier.verify(
        await mint({ claims: { groups: malformed, roles: ["platform-admin"] } }),
      );
      expect(actor?.groups).toEqual(["platform-admin"]);
    }
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

  it("rejects a token with no exp claim (jose only enforces exp when present)", async () => {
    expect(await verifier.verify(await mint({ expiresIn: null }))).toBeNull();
  });

  it("rejects a token with no iat claim", async () => {
    expect(await verifier.verify(await mint({ issuedAt: false }))).toBeNull();
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

describe("createOidcVerifier transport security", () => {
  it("refuses a non-https issuer without the insecure flag", () => {
    expect(() => createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE })).toThrow(/https/);
  });

  it("refuses the insecure flag in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() =>
      createOidcVerifier({ issuer: ISSUER, audience: AUDIENCE, allowInsecure: true }),
    ).toThrow(/production/);
    vi.unstubAllEnvs();
  });

  function stubDiscovery(doc: Record<string, unknown>): void {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("rejects a discovery document whose issuer differs from the configured one", async () => {
    const https = createOidcVerifier({ issuer: "https://idp.test", audience: AUDIENCE });
    stubDiscovery({ issuer: "https://other.test", jwks_uri: "https://idp.test/jwks" });
    // The throw is swallowed into a null verdict; the key stays unresolved.
    expect(await https.verify(await mint({ issuer: "https://idp.test" }))).toBeNull();
  });

  it("rejects a discovery document pointing at an http jwks_uri", async () => {
    const https = createOidcVerifier({ issuer: "https://idp.test", audience: AUDIENCE });
    stubDiscovery({ issuer: "https://idp.test", jwks_uri: "http://idp.test/jwks" });
    expect(await https.verify(await mint({ issuer: "https://idp.test" }))).toBeNull();
  });
});

describe("createDevTokenVerifier", () => {
  it("matches only the exact token", async () => {
    const dev = createDevTokenVerifier("secret-token", "dev@azx.io");
    expect(await dev.verify("secret-token")).toEqual({
      sub: "dev@azx.io",
      via: "dev-token",
      groups: [],
    });
    expect(await dev.verify("secret-token ")).toBeNull();
    expect(await dev.verify("other")).toBeNull();
  });

  it("refuses to be constructed in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createDevTokenVerifier("t", "a")).toThrow(/production/);
    vi.unstubAllEnvs();
  });
});
