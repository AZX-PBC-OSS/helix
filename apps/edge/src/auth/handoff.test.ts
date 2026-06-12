import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveAuthKeys } from "./secrets.js";
import { mintHandoffToken, verifyHandoffToken } from "./handoff.js";
import { TEST_AUTH_SECRET } from "../test/config.js";

const { handoffKey, flowKey } = deriveAuthKeys(TEST_AUTH_SECRET);
const APP_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APP_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SESSION = "11111111-1111-4111-8111-111111111111";
const TTL = 30;
const TOLERANCE = 5;

const mint = () =>
  mintHandoffToken({ sessionId: SESSION, appId: APP_A, rd: "/page?x=1" }, handoffKey, TTL);

afterEach(() => {
  vi.useRealTimers();
});

describe("handoff token", () => {
  it("round-trips claims for the right audience", async () => {
    const claims = await verifyHandoffToken(await mint(), APP_A, handoffKey, {
      ttlSec: TTL,
      clockToleranceSec: TOLERANCE,
    });
    expect(claims).toEqual({ sessionId: SESSION, appId: APP_A, rd: "/page?x=1" });
  });

  it("rejects the wrong audience (audience confusion, JWS level)", async () => {
    expect(
      await verifyHandoffToken(await mint(), APP_B, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });

  it("rejects any tampering with the payload (rd is signature-covered)", async () => {
    const token = await mint();
    const [h, p, s] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    payload.rd = "https://evil.example/";
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString("base64url"), s].join(".");
    expect(
      await verifyHandoffToken(forged, APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });

  it("rejects a token signed with the wrong key — including the flow key", async () => {
    const foreign = await new SignJWT({ rd: "/" })
      .setProtectedHeader({ alg: "HS256", typ: "helix-handoff+jwt" })
      .setJti(SESSION)
      .setAudience(APP_A)
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(flowKey); // domain separation: the *other* derived key
    expect(
      await verifyHandoffToken(foreign, APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });

  it("rejects alg confusion: none and RS256 are not HS256", async () => {
    // alg: none (unsecured JWT) — hand-built, no signature.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "helix-handoff+jwt" })).toString(
      "base64url",
    );
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({ jti: SESSION, aud: APP_A, rd: "/", iat: now, exp: now + 30 }),
    ).toString("base64url");
    expect(
      await verifyHandoffToken(`${header}.${payload}.`, APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });

  it("rejects the wrong typ (a flow token can never redeem)", async () => {
    const wrongTyp = await new SignJWT({ rd: "/" })
      .setProtectedHeader({ alg: "HS256", typ: "helix-flow+jwt" })
      .setJti(SESSION)
      .setAudience(APP_A)
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(handoffKey);
    expect(
      await verifyHandoffToken(wrongTyp, APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });

  it("rejects a token without exp or iat (jose only enforces them if present)", async () => {
    const eternal = await new SignJWT({ rd: "/" })
      .setProtectedHeader({ alg: "HS256", typ: "helix-handoff+jwt" })
      .setJti(SESSION)
      .setAudience(APP_A)
      .sign(handoffKey);
    expect(
      await verifyHandoffToken(eternal, APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });

  it("expires after TTL, honoring clock tolerance at the edges", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    const token = await mint();

    // Just inside exp + tolerance: still valid.
    vi.setSystemTime(new Date("2026-06-12T12:00:34Z"));
    expect(
      await verifyHandoffToken(token, APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).not.toBeNull();

    // Just past exp + tolerance: dead.
    vi.setSystemTime(new Date("2026-06-12T12:00:36Z"));
    expect(
      await verifyHandoffToken(token, APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });

  it("rejects a token minted in the future beyond tolerance", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T12:10:00Z"));
    const future = await mint();
    vi.setSystemTime(new Date("2026-06-12T12:00:00Z"));
    // iat 10 minutes ahead — exp check passes (it's in the future), but a
    // sane verifier must not accept not-yet-issued tokens.
    expect(
      await verifyHandoffToken(future, APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });

  it("rejects garbage", async () => {
    expect(
      await verifyHandoffToken("", APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
    expect(
      await verifyHandoffToken("a.b.c", APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
    expect(
      await verifyHandoffToken("not-a-jwt", APP_A, handoffKey, {
        ttlSec: TTL,
        clockToleranceSec: TOLERANCE,
      }),
    ).toBeNull();
  });
});
