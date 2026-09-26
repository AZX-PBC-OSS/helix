import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  EXCHANGE_AUDIENCE,
  EXCHANGE_JWT_TYP,
  INTERNAL_AUDIENCE,
  INTERNAL_AUTH_HEADER,
  INTERNAL_JWT_TYP,
  type ConsultRequest,
} from "@azx-pbc/shared";
import {
  ATTR_CONSENT_OPERATION,
  CONSENT_OPERATIONS,
  INSTR_CONSENT_OPERATIONS,
  SPAN_CONSENT_CANCEL,
  SPAN_CONSENT_CONSULT,
} from "@azx-pbc/shared/telemetry";
import { deriveInternalKey, resolveInternalSecret } from "../internalJwt.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * The internal consent routes (I-02 T-0012, ADR-0002 + ADR-0003 §Shared
 * ground): authorization fails closed on every unverified token shape, the
 * consult and cancel wire contracts round-trip through the real routes, and —
 * the adversarial scan — no serialized response or assembled authorize URL
 * carries credential or bearer material beyond OAuth's own state/PKCE
 * parameters.
 */

const ADMIN_GROUP = "platform-admin";

/** Planted credential material — the scan asserts none of it ever leaks. */
const CLIENT_ID = "planted-public-client-id";
const CLIENT_SECRET = "PLANTED-CLIENT-SECRET-VALUE";
const DEV_BEARER = "PLANTED-DEV-BEARER-TOKEN-VALUE";

const OID_TAG = randomUUID().slice(0, 8);
const userOid = `oid-internal-user-${OID_TAG}`;
const devOid = `oid-internal-developer-${OID_TAG}`;

const CONSULT_URL = "/internal/connections/consult";
const CANCEL_URL = "/internal/connections/cancel";
const CALLBACK_URL = "https://auth.example.test/connections/callback";
const OPENER_ORIGIN = "https://app.example.test";

const INTERNAL_KEY = deriveInternalKey(resolveInternalSecret());

/** A real mint the way the edge writes it (apps/edge/src/internalJwt.ts). */
async function mintToken(
  opts: {
    key?: Buffer;
    audience?: string;
    typ?: string;
    expires?: string;
    issuedAtSec?: number;
  } = {},
): Promise<string> {
  const iat = opts.issuedAtSec ?? Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: opts.typ ?? INTERNAL_JWT_TYP })
    .setAudience(opts.audience ?? INTERNAL_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(opts.expires ?? "30s")
    .sign(opts.key ?? INTERNAL_KEY);
}

const authed = async (): Promise<Record<string, string>> => ({
  [INTERNAL_AUTH_HEADER]: await mintToken(),
  "content-type": "application/json",
});

let t: TestApp;

/** The consult opens the provider's client id through this custody store. */
const store = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });
let sealedClientSecret = "";

const createdProviderIds: string[] = [];
const createdRefs: string[] = [];
const createdSlugs: string[] = [];

/** The everything-approved fixture, seeded through the real portal routes. */
async function seededReady(
  tag: string,
  env: "prod" | "dev" = "prod",
): Promise<{ slug: string; ref: string; providerId: string }> {
  const ref = `i-${OID_TAG}-${tag}`;
  const slug = uniqueSlug("internal");
  createdRefs.push(ref);
  createdSlugs.push(slug);
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: { authorization: "Bearer owner" },
    payload: { slug, displayName: "Internal fixture", visibility: { mode: "internal" } },
  });
  expect(created.statusCode).toBe(201);
  const provider = await t.prisma.connectionProvider.create({
    data: {
      ref,
      kind: "rest-delegated",
      displayName: "Fixture vendor",
      authorizeEndpoint: "https://vendor.example/oauth/authorize",
      tokenEndpoint: "https://vendor.example/oauth/token",
      requestedScopes: ["read"],
      apiOrigins: ["https://api.asana.com"],
      tokenPlacement: { kind: "header-bearer" },
      env,
      clientIdMaterial: await store.seal(CLIENT_ID),
      clientSecretMaterial: sealedClientSecret,
    },
  });
  createdProviderIds.push(provider.id);
  const put = await t.app.inject({
    method: "PUT",
    url: `/api/v1/apps/${slug}/manifest`,
    headers: { authorization: "Bearer owner" },
    payload: {
      capabilities: {
        mcp: [],
        externalOrigins: [],
        fetch: { shim: false, origins: [{ origin: "https://api.asana.com", provider: ref }] },
      },
    },
  });
  expect(put.statusCode).toBe(200);
  const approve = await t.app.inject({
    method: "POST",
    url: `/api/v1/approvals/${put.json().pending}/approve`,
    headers: { authorization: "Bearer admin" },
  });
  expect(approve.statusCode).toBe(200);
  return { slug, ref, providerId: provider.id };
}

function consultBody(fixture: { slug: string; ref: string }, identity: ConsultRequest["identity"]) {
  return {
    identity,
    appSlug: fixture.slug,
    providerRef: fixture.ref,
    openerOrigin: OPENER_ORIGIN,
    callbackUrl: CALLBACK_URL,
  };
}

const prodIdentity = { kind: "user" as const, userOid };

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  sealedClientSecret = await store.seal(CLIENT_SECRET);
  t = buildTestApp({
    auth: {
      verifiers: [
        {
          verify: async (token) =>
            token === "owner"
              ? { oid: userOid, sub: "owner@azx.io", via: "oidc", groups: [] }
              : token === "admin"
                ? { oid: "oid-admin", sub: "admin@azx.io", via: "oidc", groups: [ADMIN_GROUP] }
                : null,
        },
      ],
      publicConfig: null,
    },
    secretStore: store,
  });
  await t.app.ready();
});

afterAll(async () => {
  await t.prisma.connectionConsentAttempt.deleteMany({
    where: { providerId: { in: createdProviderIds } },
  });
  await t.prisma.userConnection.deleteMany({
    where: { providerId: { in: createdProviderIds } },
  });
  await t.prisma.approvalRequest.deleteMany({ where: { app: { slug: { in: createdSlugs } } } });
  await t.prisma.app.deleteMany({ where: { slug: { in: createdSlugs } } });
  await t.prisma.connectionProvider.deleteMany({ where: { ref: { in: createdRefs } } });
  await t.close();
});

describe("internal authorization fails closed (ADR-0003)", () => {
  it("refuses a missing token on every operation", async () => {
    for (const url of [CONSULT_URL, CANCEL_URL]) {
      const res = await t.app.inject({ method: "POST", url, payload: {} });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("refuses a wrong-audience token on every operation", async () => {
    const token = await mintToken({ audience: "azx-somewhere-else" });
    for (const url of [CONSULT_URL, CANCEL_URL]) {
      const res = await t.app.inject({
        method: "POST",
        url,
        headers: { [INTERNAL_AUTH_HEADER]: token },
        payload: {},
      });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("refuses an expired token on every operation", async () => {
    const token = await mintToken({
      issuedAtSec: Math.floor(Date.now() / 1000) - 120,
      expires: "30s",
    });
    for (const url of [CONSULT_URL, CANCEL_URL]) {
      const res = await t.app.inject({
        method: "POST",
        url,
        headers: { [INTERNAL_AUTH_HEADER]: token },
        payload: {},
      });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("refuses a token signed with a foreign key and a cross-direction token", async () => {
    const foreign = await mintToken({ key: deriveInternalKey(randomBytes(32)) });
    const exchange = await mintToken({ typ: EXCHANGE_JWT_TYP, audience: EXCHANGE_AUDIENCE });
    for (const token of [foreign, exchange]) {
      const res = await t.app.inject({
        method: "POST",
        url: CONSULT_URL,
        headers: { [INTERNAL_AUTH_HEADER]: token },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    }
  });
});

describe("the consult route", () => {
  it("round-trips the wire contract: one attempt + a parsing authorize URL", async () => {
    const fixture = await seededReady("consult");
    const res = await t.app.inject({
      method: "POST",
      url: CONSULT_URL,
      headers: await authed(),
      payload: consultBody(fixture, prodIdentity),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ outcome: "started" });
    const authorizeUrl = res.json().authorizeUrl as string;

    const attempt = await t.prisma.connectionConsentAttempt.findFirstOrThrow({
      where: { providerId: fixture.providerId },
    });
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get("state")).toBe(attempt.state);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
  });

  it("answers not_available when no approved request backs the binding", async () => {
    const fixture = await seededReady("not-available");
    // Flip the approval to denied — the write-gate's refused-grant state. The
    // manifest binding is present, but no approved stamp backs it.
    const request = await t.prisma.approvalRequest.findFirstOrThrow({
      where: { app: { slug: fixture.slug } },
    });
    await t.prisma.approvalRequest.update({
      where: { id: request.id },
      data: { status: "denied" },
    });
    const res = await t.app.inject({
      method: "POST",
      url: CONSULT_URL,
      headers: await authed(),
      payload: consultBody(fixture, prodIdentity),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "not_available" });
    expect(
      await t.prisma.connectionConsentAttempt.findMany({
        where: { providerId: fixture.providerId },
      }),
    ).toEqual([]);
  });

  it("rejects a malformed body with a 400 — no state touched", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: CONSULT_URL,
      headers: await authed(),
      payload: { identity: { kind: "user" }, appSlug: "x", providerRef: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });
});

describe("the cancel route", () => {
  it("cancels the owner's attempt and refuses a stranger's", async () => {
    const fixture = await seededReady("cancel");
    const consult = await t.app.inject({
      method: "POST",
      url: CONSULT_URL,
      headers: await authed(),
      payload: consultBody(fixture, prodIdentity),
    });
    const state = new URL(consult.json().authorizeUrl as string).searchParams.get("state")!;

    // A different identity holding the same state value is refused.
    const stranger = await t.app.inject({
      method: "POST",
      url: CANCEL_URL,
      headers: await authed(),
      payload: { identity: { kind: "user", userOid: `oid-other-${OID_TAG}` }, state },
    });
    expect(stranger.statusCode).toBe(200);
    expect(stranger.json()).toEqual({ outcome: "not_cancellable" });
    expect(
      (await t.prisma.connectionConsentAttempt.findUniqueOrThrow({ where: { state } })).cancelledAt,
    ).toBeNull();

    const own = await t.app.inject({
      method: "POST",
      url: CANCEL_URL,
      headers: await authed(),
      payload: { identity: prodIdentity, state },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json()).toEqual({ outcome: "cancelled" });
    expect(
      (await t.prisma.connectionConsentAttempt.findUniqueOrThrow({ where: { state } })).cancelledAt,
    ).not.toBeNull();
  });

  it("an unknown state answers not_cancellable without a 404 (no enumeration)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: CANCEL_URL,
      headers: await authed(),
      payload: {
        identity: prodIdentity,
        state: `no-such-state-${OID_TAG}-000000000000000000000000000`,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "not_cancellable" });
  });
});

describe("the adversarial scan — no credential material on the wire", () => {
  it("serializes every consult/cancel response and finds no planted secret", async () => {
    const fixture = await seededReady("scan");
    const devFixture = await seededReady("scan-dev", "dev");
    const consult = await t.app.inject({
      method: "POST",
      url: CONSULT_URL,
      headers: await authed(),
      payload: consultBody(fixture, prodIdentity),
    });
    const devConsult = await t.app.inject({
      method: "POST",
      url: CONSULT_URL,
      headers: await authed(),
      payload: consultBody(devFixture, {
        kind: "dev",
        developerOid: devOid,
        nonce: `scan-nonce-${OID_TAG}-singleuse`,
      }),
    });
    expect(devConsult.statusCode).toBe(200);
    const state = new URL(consult.json().authorizeUrl as string).searchParams.get("state")!;
    const cancel = await t.app.inject({
      method: "POST",
      url: CANCEL_URL,
      headers: await authed(),
      payload: { identity: prodIdentity, state },
    });

    const dump = [consult.body, devConsult.body, cancel.body].join("\n");
    for (const secret of [CLIENT_SECRET, sealedClientSecret, DEV_BEARER]) {
      expect(dump, `a response leaked ${secret}`).not.toContain(secret);
    }
    // The PKCE verifier is protocol state that must stay off the wire — only
    // its S256 challenge rides the URL (the state itself is OAuth protocol).
    const devAttempt = await t.prisma.connectionConsentAttempt.findFirstOrThrow({
      where: { providerId: devFixture.providerId, nonce: { not: null } },
    });
    expect(dump).not.toContain(devAttempt.codeVerifier);
    expect(dump).not.toContain("Bearer ");
  });

  it("the assembled authorize URL carries only OAuth protocol parameters", async () => {
    const fixture = await seededReady("url-scan");
    const res = await t.app.inject({
      method: "POST",
      url: CONSULT_URL,
      headers: await authed(),
      payload: consultBody(fixture, prodIdentity),
    });
    const authorizeUrl = res.json().authorizeUrl as string;
    const url = new URL(authorizeUrl);
    expect([...url.searchParams.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
    for (const secret of [CLIENT_SECRET, sealedClientSecret, DEV_BEARER]) {
      expect(authorizeUrl, `the URL leaked ${secret}`).not.toContain(secret);
    }
  });
});

describe("telemetry (AGENTS.md §Telemetry ships with the change)", () => {
  it("emits the operation spans and counter, and never the identity", async () => {
    const recording: RecordingTelemetry = startRecordingTelemetry();
    try {
      const fixture = await seededReady("telemetry");
      await t.app.inject({
        method: "POST",
        url: CONSULT_URL,
        headers: await authed(),
        payload: consultBody(fixture, prodIdentity),
      });
      const attempt = await t.prisma.connectionConsentAttempt.findFirstOrThrow({
        where: { providerId: fixture.providerId },
      });
      await t.app.inject({
        method: "POST",
        url: CANCEL_URL,
        headers: await authed(),
        payload: { identity: prodIdentity, state: attempt.state },
      });

      const names = recording.spans().map((s) => s.name);
      expect(names).toContain(SPAN_CONSENT_CONSULT);
      expect(names).toContain(SPAN_CONSENT_CANCEL);

      const metrics = await recording.metrics();
      const consent = metrics.filter((m) => m.name === INSTR_CONSENT_OPERATIONS);
      expect(consent.length).toBeGreaterThan(0);
      for (const point of consent) {
        expect(CONSENT_OPERATIONS).toContain(point.attributes[ATTR_CONSENT_OPERATION]);
        expect(point.attributes["helix.userOid"]).toBeUndefined();
      }

      // The global scan: no span attribute carries the caller's identity or
      // protocol state — every attribute of every span, not one field.
      const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
      expect(dump).not.toContain(userOid);
      expect(dump).not.toContain(CLIENT_SECRET);
      expect(dump).not.toContain(attempt.state);
      expect(dump).not.toContain(attempt.codeVerifier);
    } finally {
      await recording.restore();
    }
  });
});
