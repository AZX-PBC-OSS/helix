import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  type ConsultRequest,
  INTERNAL_AUDIENCE,
  INTERNAL_AUTH_HEADER,
  INTERNAL_JWT_TYP,
} from "@azx-pbc/shared";
import {
  ATTR_CONSENT_OPERATION,
  CONSENT_OPERATIONS,
  INSTR_CONSENT_OPERATIONS,
  SPAN_CONSENT_CONSULT,
  SPAN_CONSENT_REDEEM,
} from "@azx-pbc/shared/telemetry";
import { connectionsCallbackUrl } from "../deployment.js";
import { pkceChallenge } from "../connections/consent.js";
import { deriveInternalKey, resolveInternalSecret } from "../internalJwt.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * The dev journey's nonce entry (I-02 T-0016, ADR-0002 §Implementation Notes
 * — the auth-host page, portal-served, reached through the edge's
 * `/connections/*` proxy): one indivisible redemption of the consult's
 * single-use nonce, then a 302 straight to the vendor — and the fixed refusal
 * page for everything else. The consult that writes the attempt runs for real
 * (the internal route, T-0012's contract with the `dev` identity), so the
 * redemption is proven against the row the real state machine wrote.
 */

const ADMIN_GROUP = "platform-admin";
const OID_TAG = randomUUID().slice(0, 8);
const devOid = `oid-entry-developer-${OID_TAG}`;
const DEV_ORIGIN = "https://myapp.lovable.app";

const CLIENT_ID = "planted-public-client-id";
const CLIENT_SECRET = "PLANTED-CLIENT-SECRET-VALUE";
const DEV_BEARER = "PLANTED-DEV-BEARER-TOKEN-VALUE";

const ENTRY_URL = "/connections/consent/start";
const CONSULT_URL = "/internal/connections/consult";
const INTERNAL_KEY = deriveInternalKey(resolveInternalSecret());

/** The dev journey's handoff nonce — what the (edge) start route would mint. */
function freshNonce(): string {
  return randomBytes(32).toString("base64url");
}

const store = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });
let sealedClientSecret = "";

let t: TestApp;

const createdProviderIds: string[] = [];
const createdRefs: string[] = [];
const createdSlugs: string[] = [];

/** The everything-approved fixture in the DEV tier, seeded through the real routes. */
async function seededDevReady(
  tag: string,
): Promise<{ slug: string; ref: string; providerId: string }> {
  const ref = `e-${OID_TAG}-${tag}`;
  const slug = uniqueSlug("entry");
  createdRefs.push(ref);
  createdSlugs.push(slug);
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: { authorization: "Bearer owner" },
    payload: { slug, displayName: "Entry fixture", visibility: { mode: "internal" } },
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
      env: "dev",
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

/**
 * Run the REAL dev consult — the exact call the edge's dev start route makes
 * (identity kind `dev`: developerOid + the journey's single-use nonce) — and
 * return the attempt it wrote plus the nonce.
 */
async function consultedAttempt(
  fixture: { slug: string; ref: string; providerId: string },
  nonce: string,
  openerOrigin = DEV_ORIGIN,
) {
  const consultBody: ConsultRequest = {
    identity: { kind: "dev", developerOid: devOid, nonce },
    appSlug: fixture.slug,
    providerRef: fixture.ref,
    openerOrigin,
    callbackUrl: "https://auth.example.test/connections/callback",
  };
  const res = await t.app.inject({
    method: "POST",
    url: CONSULT_URL,
    headers: { [INTERNAL_AUTH_HEADER]: await mintToken(), "content-type": "application/json" },
    payload: consultBody,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().outcome).toBe("started");
  const attempt = await t.prisma.connectionConsentAttempt.findUniqueOrThrow({
    where: { nonce },
  });
  return { attempt, nonce };
}

/** Mint the internal JWT the edge writes (apps/edge/src/internalJwt.ts shape). */
function mintToken(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256", typ: INTERNAL_JWT_TYP })
    .setAudience(INTERNAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(INTERNAL_KEY);
}

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  sealedClientSecret = await store.seal(CLIENT_SECRET);
  t = buildTestApp({
    auth: {
      verifiers: [
        {
          verify: async (token) =>
            token === "owner"
              ? { oid: devOid, sub: "owner@azx.io", via: "oidc", groups: [] }
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

describe("the nonce entry redeems once and 302s to the vendor", () => {
  it("first open: redeemed, redirected — the URL carries state and the S256 challenge only", async () => {
    const fixture = await seededDevReady("open");
    const nonce = freshNonce();
    const { attempt } = await consultedAttempt(fixture, nonce);

    const res = await t.app.inject({ method: "GET", url: `${ENTRY_URL}?nonce=${nonce}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");

    // The redirect target is the vendor authorize URL RE-DERIVED at
    // redemption from the portal's stored attempt data (ADR-0002 §
    // Implementation Notes): the provider row's configuration plus the
    // attempt's state and PKCE challenge.
    const target = new URL(res.headers["location"] as string);
    expect(target.origin).toBe("https://vendor.example");
    expect(target.pathname).toBe("/oauth/authorize");
    expect(target.searchParams.get("state")).toBe(attempt.state);
    expect(target.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(target.searchParams.get("redirect_uri")).toBe(connectionsCallbackUrl());
    expect(target.searchParams.get("code_challenge_method")).toBe("S256");
    // The challenge is derived FROM the stored verifier — which itself never
    // appears in any URL (criterion 22).
    expect(target.searchParams.get("code_challenge")).toBe(pkceChallenge(attempt.codeVerifier));
    expect(target.toString()).not.toContain(attempt.codeVerifier);
    expect(target.toString()).not.toContain(DEV_BEARER);

    // The attempt survives — the callback still redeems it by state.
    expect(await t.prisma.connectionConsentAttempt.findUnique({ where: { nonce } })).not.toBeNull();
  });

  it("second open: the same URL is refused — the nonce is single-use", async () => {
    const fixture = await seededDevReady("replay");
    const nonce = freshNonce();
    await consultedAttempt(fixture, nonce);

    const first = await t.app.inject({ method: "GET", url: `${ENTRY_URL}?nonce=${nonce}` });
    expect(first.statusCode).toBe(302);

    const replay = await t.app.inject({ method: "GET", url: `${ENTRY_URL}?nonce=${nonce}` });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["location"]).toBeUndefined();
    // The fixed refusal page: content, no scripts, nothing echoed.
    expect(replay.body).toContain("isn't valid anymore");
    expect(replay.body).not.toContain(nonce);
    expect(replay.headers["content-security-policy"]).toContain("default-src 'none'");
  });
});

describe("the attempt keys to the developer identity in the dev environment", () => {
  it("row level: developerOid as the principal, env dev, the validated Origin as opener", async () => {
    const fixture = await seededDevReady("row");
    const nonce = freshNonce();
    await consultedAttempt(fixture, nonce);

    const attempt = await t.prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { nonce },
    });
    // The saved consent keys to the dev token's developer identity with
    // env: dev (criterion 22; the resolution-tier isolation is T-0030's).
    expect(attempt.userOid).toBe(devOid);
    expect(attempt.env).toBe("dev");
    // The opener origin is the dev caller's VALIDATED Origin — the value the
    // completion message targets; the consult stores it verbatim.
    expect(attempt.openerOrigin).toBe(DEV_ORIGIN);
    // It is a dev-tier attempt through and through: the provider resolved in
    // the dev tier is the fixture's own dev row.
    expect(attempt.providerId).toBe(fixture.providerId);
  });

  it("a different origin than the consult carried is never what the row records", async () => {
    const fixture = await seededDevReady("origin");
    const nonce = freshNonce();
    await consultedAttempt(fixture, nonce, "https://editor.dev.example");
    const attempt = await t.prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { nonce },
    });
    expect(attempt.openerOrigin).toBe("https://editor.dev.example");
    expect(attempt.openerOrigin).not.toBe(DEV_ORIGIN);
  });
});

describe("every other refusal answers the same fixed page", () => {
  it("an unknown nonce refuses without redeeming anything", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `${ENTRY_URL}?nonce=${freshNonce()}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["location"]).toBeUndefined();
    expect(res.body).toContain("isn't valid anymore");
  });

  it("an expired attempt refuses (criterion 25 — expiry bounds the journey)", async () => {
    const fixture = await seededDevReady("expired");
    const nonce = freshNonce();
    await consultedAttempt(fixture, nonce);
    await t.prisma.connectionConsentAttempt.update({
      where: { nonce },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await t.app.inject({ method: "GET", url: `${ENTRY_URL}?nonce=${nonce}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["location"]).toBeUndefined();
  });

  it("a cancelled attempt refuses — a late redemption cannot revive it", async () => {
    const fixture = await seededDevReady("cancelled");
    const nonce = freshNonce();
    await consultedAttempt(fixture, nonce);
    const attempt = await t.prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { nonce },
    });
    const cancel = await t.app.inject({
      method: "POST",
      url: "/internal/connections/cancel",
      headers: {
        [INTERNAL_AUTH_HEADER]: await mintToken(),
        "content-type": "application/json",
      },
      payload: { identity: { kind: "dev", developerOid: devOid, nonce }, state: attempt.state },
    });
    expect(cancel.json()).toEqual({ outcome: "cancelled" });

    const res = await t.app.inject({ method: "GET", url: `${ENTRY_URL}?nonce=${nonce}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["location"]).toBeUndefined();
  });

  it("a provider edited since the attempt refuses — fail closed (provider_changed)", async () => {
    const fixture = await seededDevReady("edited");
    const nonce = freshNonce();
    await consultedAttempt(fixture, nonce);
    // The raw revision bump T-0010's sensitive-edit transaction ends with.
    await t.prisma.connectionProvider.update({
      where: { id: fixture.providerId },
      data: { revision: { increment: 1 } },
    });
    const res = await t.app.inject({ method: "GET", url: `${ENTRY_URL}?nonce=${nonce}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["location"]).toBeUndefined();
  });

  it("a provider deleted since the attempt refuses — attempts dangle, fail closed", async () => {
    const fixture = await seededDevReady("deleted");
    const nonce = freshNonce();
    await consultedAttempt(fixture, nonce);
    await t.prisma.connectionProvider.delete({ where: { id: fixture.providerId } });
    const res = await t.app.inject({ method: "GET", url: `${ENTRY_URL}?nonce=${nonce}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["location"]).toBeUndefined();
  });

  it("a malformed or repeated nonce value is a plain 400, nothing redeemed", async () => {
    for (const url of [`${ENTRY_URL}?nonce=short`, `${ENTRY_URL}?nonce=one&nonce=two`, ENTRY_URL]) {
      const res = await t.app.inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(res.body).toContain("Invalid connection link");
    }
  });
});

describe("telemetry (AGENTS.md §Telemetry ships with the change)", () => {
  it("emits the redeem span and counter, and never the nonce or identity", async () => {
    const recording: RecordingTelemetry = startRecordingTelemetry();
    try {
      const fixture = await seededDevReady("telemetry");
      const nonce = freshNonce();
      await consultedAttempt(fixture, nonce);
      const res = await t.app.inject({ method: "GET", url: `${ENTRY_URL}?nonce=${nonce}` });
      expect(res.statusCode).toBe(302);

      const names = recording.spans().map((s) => s.name);
      // The consult ran for real inside this journey — its span and the
      // redemption's are the two operation spans the dev journey emits here.
      expect(names).toContain(SPAN_CONSENT_CONSULT);
      expect(names).toContain(SPAN_CONSENT_REDEEM);
      const redeem = recording.spans().find((s) => s.name === SPAN_CONSENT_REDEEM);
      expect(redeem?.attributes[ATTR_CONSENT_OPERATION]).toBe("redeem");
      expect(redeem?.attributes["helix.outcome"]).toBe("redeemed");

      const metrics = await recording.metrics();
      const points = metrics.filter((m) => m.name === INSTR_CONSENT_OPERATIONS);
      expect(points.length).toBeGreaterThan(0);
      for (const point of points) {
        expect(CONSENT_OPERATIONS).toContain(point.attributes[ATTR_CONSENT_OPERATION]);
        expect(point.attributes["helix.userOid"]).toBeUndefined();
      }

      // The global scan: no span attribute carries the nonce, the identity,
      // the PKCE verifier, or any planted credential.
      const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
      expect(dump).not.toContain(nonce);
      expect(dump).not.toContain(devOid);
      expect(dump).not.toContain(DEV_BEARER);
    } finally {
      await recording.restore();
    }
  });
});
