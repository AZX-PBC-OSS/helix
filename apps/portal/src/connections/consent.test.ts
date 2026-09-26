import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import {
  ConsultRequestSchema,
  CONSENT_ATTEMPT_TTL_SECONDS,
  type ConsultRequest,
} from "@azx-pbc/shared";
import type { PrismaClient } from "../db/client.js";
import { buildTestApp, createTestPrisma, uniqueSlug, type TestApp } from "../test/harness.js";
import {
  cancelConsentAttempt,
  claimConsentAttempt,
  consultConsent,
  pkceChallenge,
  sweepExpiredConsentAttempts,
} from "./consent.js";

/**
 * The consent state machine at the store level (I-02 T-0012, ADR-0002): the
 * consult's three outcomes and its attempt write, the own-attempts-only
 * cancel, the callback's claim-shaped probe (single-use, expiry- and
 * cancel-aware), and the expiry sweep. The route-level contract — internal
 * authorization, wire parsing, the adversarial scan — is
 * `routes/connectionsInternal.test.ts`'s.
 *
 * The approval chain is driven through the REAL routes (manifest PUT →
 * approve) so the stamps the consult consumes are the ones T-0009 files; a
 * sensitive edit is simulated as the raw revision bump T-0010's transaction
 * ends with (the same simulation `approvals/providerBindings.test.ts` uses).
 */

const ADMIN_GROUP = "platform-admin";
const USER_OID = "oid-consent-user";
const OTHER_OID = "oid-consent-other";
const DEV_OID = "oid-consent-developer";

const CLIENT_ID = "planted-public-client-id";
const CLIENT_SECRET = "PLANTED-CLIENT-SECRET-VALUE";

const AUTH_BASE = "https://auth.example.test";
const CALLBACK_URL = `${AUTH_BASE}/connections/callback`;
const OPENER_ORIGIN = "https://app.example.test/";

/** Distinct per file so parallel suites never collide on unique rows. */
const OID_TAG = randomUUID().slice(0, 8);
const userOid = `${USER_OID}-${OID_TAG}`;
const otherOid = `${OTHER_OID}-${OID_TAG}`;
const devOid = `${DEV_OID}-${OID_TAG}`;

const masterKey = randomBytes(32);
const store = new DevEnvelopeSecretStore({ masterKey });

const prisma: PrismaClient = createTestPrisma();

const prodIdentity = { kind: "user" as const, userOid };
const otherIdentity = { kind: "user" as const, userOid: otherOid };

let seeder: TestApp;

beforeAll(async () => {
  // The verifier chain the seeding routes authenticate with.
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  seeder = buildTestApp({
    auth: {
      verifiers: [
        {
          verify: async (t) =>
            t === "owner"
              ? { oid: userOid, sub: "owner@azx.io", via: "oidc", groups: [] }
              : t === "admin"
                ? { oid: "oid-admin", sub: "admin@azx.io", via: "oidc", groups: [ADMIN_GROUP] }
                : null,
        },
      ],
      publicConfig: null,
    },
  });
  await seeder.app.ready();
});

afterAll(async () => {
  await prisma.connectionConsentAttempt.deleteMany({
    where: { providerId: { in: createdProviderIds } },
  });
  await prisma.userConnection.deleteMany({
    where: { providerId: { in: createdProviderIds } },
  });
  await prisma.approvalRequest.deleteMany({ where: { app: { slug: { in: createdSlugs } } } });
  await prisma.app.deleteMany({ where: { slug: { in: createdSlugs } } });
  await prisma.connectionProvider.deleteMany({ where: { ref: { in: createdRefs } } });
  await prisma.$disconnect();
  await seeder.close();
});

const createdProviderIds: string[] = [];
const createdRefs: string[] = [];
const createdSlugs: string[] = [];

/** The everything-approved fixture: app + provider + approved binding. */
async function seededReady(
  tag: string,
  env: "prod" | "dev" = "prod",
): Promise<{ slug: string; ref: string; providerId: string }> {
  const ref = `c-${OID_TAG}-${tag}`;
  const slug = uniqueSlug("consent");
  createdRefs.push(ref);
  createdSlugs.push(slug);
  await prisma.app.create({
    data: {
      slug,
      displayName: `Consent fixture ${tag}`,
      // The owner the manifest PUT's ownsApp gate compares (the seeder's
      // verifier carries this oid).
      ownerId: userOid,
      visibilityMode: "internal",
      visibilityGroupIds: [],
    },
  });
  const provider = await prisma.connectionProvider.create({
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
      clientSecretMaterial: await store.seal(CLIENT_SECRET),
    },
  });
  createdProviderIds.push(provider.id);

  // File the provider-bound origin through the real write-gate and approve it,
  // so the consult consumes a stamp exactly as T-0009 files one.
  const put = await seeder.app.inject({
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
  const approve = await seeder.app.inject({
    method: "POST",
    url: `/api/v1/approvals/${put.json().pending}/approve`,
    headers: { authorization: "Bearer admin" },
  });
  expect(approve.statusCode).toBe(200);
  return { slug, ref, providerId: provider.id };
}

function consultRequest(
  fixture: { slug: string; ref: string },
  env: "prod" | "dev",
  identity: ConsultRequest["identity"],
): ConsultRequest {
  return ConsultRequestSchema.parse({
    identity,
    appSlug: fixture.slug,
    providerRef: fixture.ref,
    openerOrigin: OPENER_ORIGIN,
    callbackUrl: CALLBACK_URL,
  });
}

async function consultState(
  fixture: { slug: string; ref: string },
  env: "prod" | "dev",
  identity: ConsultRequest["identity"],
): Promise<string> {
  const res = await consultConsent(prisma, store, consultRequest(fixture, env, identity));
  if (res.outcome !== "started") throw new Error(`expected started, got ${res.outcome}`);
  return new URL(res.authorizeUrl).searchParams.get("state")!;
}

async function attemptRows(providerId: string) {
  return prisma.connectionConsentAttempt.findMany({ where: { providerId } });
}

async function seedLiveConnection(oid: string, providerId: string, env: string) {
  return prisma.userConnection.create({
    data: {
      userOid: oid,
      providerId,
      providerRevision: 1,
      env,
      status: "live",
      material: "sealed-fixture-material",
      grantedScopes: ["read"],
      grantedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
}

describe("consult — the three outcomes", () => {
  it("not_available for an unapproved binding, writing no attempt", async () => {
    const ref = `c-${OID_TAG}-unapproved`;
    const slug = uniqueSlug("consent");
    createdRefs.push(ref);
    createdSlugs.push(slug);
    await prisma.app.create({
      data: {
        slug,
        displayName: "Unbound",
        ownerId: userOid,
        visibilityMode: "internal",
        visibilityGroupIds: [],
      },
    });
    const provider = await prisma.connectionProvider.create({
      data: {
        ref,
        kind: "rest-delegated",
        displayName: "Fixture vendor",
        authorizeEndpoint: "https://vendor.example/oauth/authorize",
        tokenEndpoint: "https://vendor.example/oauth/token",
        requestedScopes: ["read"],
        apiOrigins: ["https://api.asana.com"],
        tokenPlacement: { kind: "header-bearer" },
        env: "prod",
        clientIdMaterial: await store.seal(CLIENT_ID),
        clientSecretMaterial: await store.seal(CLIENT_SECRET),
      },
    });
    createdProviderIds.push(provider.id);

    const res = await consultConsent(
      prisma,
      store,
      consultRequest({ slug, ref }, "prod", prodIdentity),
    );
    expect(res).toEqual({ outcome: "not_available" });
    expect(await attemptRows(provider.id)).toEqual([]);
  });

  it("not_available when the provider row is missing in the consult's tier", async () => {
    // Binding approved against a ref whose only row is `dev`; a prod consult
    // finds no provider row in its tier.
    const fixture = await seededReady("dev-only", "dev");
    const res = await consultConsent(prisma, store, consultRequest(fixture, "prod", prodIdentity));
    expect(res).toEqual({ outcome: "not_available" });
    expect(await attemptRows(fixture.providerId)).toEqual([]);
  });

  it("not_available after the binding became ineffective (revision advanced)", async () => {
    const fixture = await seededReady("stale");
    // The sensitive edit T-0010's transaction ends with.
    await prisma.connectionProvider.update({
      where: { id: fixture.providerId },
      data: { revision: 99 },
    });
    const res = await consultConsent(prisma, store, consultRequest(fixture, "prod", prodIdentity));
    expect(res).toEqual({ outcome: "not_available" });
    expect(await attemptRows(fixture.providerId)).toEqual([]);
  });

  it("writes exactly one pending attempt for the valid case, with the full field list", async () => {
    const fixture = await seededReady("valid");
    const before = Date.now();
    const res = await consultConsent(prisma, store, consultRequest(fixture, "prod", prodIdentity));
    expect(res.outcome).toBe("started");

    const attempts = await attemptRows(fixture.providerId);
    expect(attempts).toHaveLength(1);
    const attempt = attempts[0]!;
    // The fixed field list (ADR-0002): state, PKCE verifier, identity,
    // provider id+revision, app, env, opener origin, five-minute TTL.
    expect(attempt.state).toHaveLength(43);
    expect(attempt.codeVerifier).toHaveLength(43);
    expect(attempt.userOid).toBe(userOid);
    expect(attempt.providerId).toBe(fixture.providerId);
    expect(attempt.providerRevision).toBe(1);
    expect(attempt.appId).toBe(
      (await prisma.app.findUniqueOrThrow({ where: { slug: fixture.slug } })).id,
    );
    expect(attempt.env).toBe("prod");
    expect(attempt.openerOrigin).toBe("https://app.example.test");
    expect(attempt.nonce).toBeNull();
    expect(attempt.cancelledAt).toBeNull();
    const ttlMs = attempt.expiresAt.getTime() - before;
    // TIMESTAMP(3) rounds, and the clock moves between `before` and the write —
    // a second of slack on each side is generous already.
    expect(ttlMs).toBeGreaterThan((CONSENT_ATTEMPT_TTL_SECONDS - 5) * 1000);
    expect(ttlMs).toBeLessThanOrEqual((CONSENT_ATTEMPT_TTL_SECONDS + 1) * 1000);
  });

  it("returns an authorize URL that parses with the expected state + S256 challenge", async () => {
    const fixture = await seededReady("url");
    const res = await consultConsent(prisma, store, consultRequest(fixture, "prod", prodIdentity));
    if (res.outcome !== "started") throw new Error(`expected started, got ${res.outcome}`);
    const attempt = (await attemptRows(fixture.providerId))[0]!;

    const url = new URL(res.authorizeUrl);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(
      "https://vendor.example/oauth/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(url.searchParams.get("state")).toBe(attempt.state);
    expect(url.searchParams.get("code_challenge")).toBe(pkceChallenge(attempt.codeVerifier));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("read");
  });
});

describe("consult — a working connection is never replaced", () => {
  it("answers already_connected twice and leaves the connection row untouched", async () => {
    const fixture = await seededReady("connected");
    const connection = await seedLiveConnection(userOid, fixture.providerId, "prod");

    const first = await consultConsent(
      prisma,
      store,
      consultRequest(fixture, "prod", prodIdentity),
    );
    expect(first).toEqual({ outcome: "already_connected" });
    const second = await consultConsent(
      prisma,
      store,
      consultRequest(fixture, "prod", prodIdentity),
    );
    expect(second).toEqual({ outcome: "already_connected" });

    expect(await attemptRows(fixture.providerId)).toEqual([]);
    const after = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.status).toBe("live");
    expect(after.material).toBe(connection.material);
    expect(after.expiresAt.getTime()).toBe(connection.expiresAt.getTime());
  });

  it("makes the already-connected decision indivisible against a connection landing mid-consult", async () => {
    const fixture = await seededReady("race");
    // A completion committing between the consult's connection read and its
    // attempt write, simulated at the read: the extension answers "no
    // connection" while saving a live one at that exact moment. The guarded
    // INSERT must then refuse — the consult still answers already_connected
    // and no attempt exists for a user who is now connected.
    const racing = prisma.$extends({
      query: {
        userConnection: {
          async findUnique({ query }) {
            void query;
            await prisma.userConnection.create({
              data: {
                userOid,
                providerId: fixture.providerId,
                providerRevision: 1,
                env: "prod",
                status: "live",
                material: "sealed-race-material",
                grantedScopes: ["read"],
                grantedAt: new Date(),
                expiresAt: new Date(Date.now() + 3_600_000),
              },
            });
            return null;
          },
        },
      },
    });
    const res = await consultConsent(
      racing as unknown as PrismaClient,
      store,
      consultRequest(fixture, "prod", prodIdentity),
    );
    expect(res).toEqual({ outcome: "already_connected" });
    expect(await attemptRows(fixture.providerId)).toEqual([]);
  });

  it("lets concurrent consults for different users each write their own attempt", async () => {
    const fixture = await seededReady("concurrent");
    const [mine, theirs] = await Promise.all([
      consultConsent(prisma, store, consultRequest(fixture, "prod", prodIdentity)),
      consultConsent(prisma, store, consultRequest(fixture, "prod", otherIdentity)),
    ]);
    expect(mine.outcome).toBe("started");
    expect(theirs.outcome).toBe("started");
    const rows = await attemptRows(fixture.providerId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.userOid))).toEqual(new Set([userOid, otherOid]));
  });
});

describe("consult — the dev tier", () => {
  it("writes the dev attempt keyed to the developer identity in dev, carrying the nonce", async () => {
    const fixture = await seededReady("dev", "dev");
    const res = await consultConsent(
      prisma,
      store,
      consultRequest(fixture, "dev", {
        kind: "dev",
        developerOid: devOid,
        nonce: `nonce-${OID_TAG}-singleuse`,
      }),
    );
    expect(res.outcome).toBe("started");
    const attempts = await attemptRows(fixture.providerId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.env).toBe("dev");
    expect(attempts[0]!.userOid).toBe(devOid);
    expect(attempts[0]!.nonce).toBe(`nonce-${OID_TAG}-singleuse`);
  });

  it("refuses a replayed nonce (the single-use handoff cannot mint a second attempt)", async () => {
    const fixture = await seededReady("nonce", "dev");
    const req = consultRequest(fixture, "dev", {
      kind: "dev",
      developerOid: devOid,
      nonce: `nonce-r-${OID_TAG}-replay`,
    });
    await expect(consultConsent(prisma, store, req)).resolves.toMatchObject({
      outcome: "started",
    });
    await expect(consultConsent(prisma, store, req)).rejects.toMatchObject({ code: "conflict" });
  });
});

describe("cancel — own attempts only", () => {
  it("the owning user's cancel marks the attempt cancelled", async () => {
    const fixture = await seededReady("cancel");
    const state = await consultState(fixture, "prod", prodIdentity);
    await expect(cancelConsentAttempt(prisma, { identity: prodIdentity, state })).resolves.toEqual({
      outcome: "cancelled",
    });
    const attempt = await prisma.connectionConsentAttempt.findUniqueOrThrow({ where: { state } });
    expect(attempt.cancelledAt).not.toBeNull();
  });

  it("a cancel by anyone else is refused and the attempt stays the owner's to cancel", async () => {
    const fixture = await seededReady("not-owner");
    const state = await consultState(fixture, "prod", prodIdentity);
    await expect(cancelConsentAttempt(prisma, { identity: otherIdentity, state })).resolves.toEqual(
      { outcome: "not_cancellable" },
    );
    const attempt = await prisma.connectionConsentAttempt.findUniqueOrThrow({ where: { state } });
    expect(attempt.cancelledAt).toBeNull();
    await expect(cancelConsentAttempt(prisma, { identity: prodIdentity, state })).resolves.toEqual({
      outcome: "cancelled",
    });
  });

  it("a dev-tier identity cannot cancel a prod attempt (env separation)", async () => {
    const fixture = await seededReady("env-split");
    const state = await consultState(fixture, "prod", prodIdentity);
    await expect(
      cancelConsentAttempt(prisma, {
        identity: { kind: "dev", developerOid: devOid, nonce: `n-${OID_TAG}-env-single` },
        state,
      }),
    ).resolves.toEqual({ outcome: "not_cancellable" });
    const attempt = await prisma.connectionConsentAttempt.findUniqueOrThrow({ where: { state } });
    expect(attempt.cancelledAt).toBeNull();
  });

  it("an unknown state and an expired attempt answer not_cancellable", async () => {
    await seededReady("unknown");
    await expect(
      cancelConsentAttempt(prisma, {
        identity: prodIdentity,
        state: `no-such-state-${OID_TAG}-000000000000000000000000000`,
      }),
    ).resolves.toEqual({ outcome: "not_cancellable" });

    const fixture = await seededReady("expired-cancel");
    const state = await consultState(fixture, "prod", prodIdentity);
    await prisma.connectionConsentAttempt.update({
      where: { state },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(cancelConsentAttempt(prisma, { identity: prodIdentity, state })).resolves.toEqual({
      outcome: "not_cancellable",
    });
  });

  it("a late completion of a cancelled attempt cannot claim it", async () => {
    const fixture = await seededReady("late");
    const state = await consultState(fixture, "prod", prodIdentity);
    await cancelConsentAttempt(prisma, { identity: prodIdentity, state });
    await expect(claimConsentAttempt(prisma, state)).resolves.toEqual({
      claimed: false,
      reason: "cancelled",
    });
    // The refusal is not a delete — the record stays for the sweep.
    expect(await prisma.connectionConsentAttempt.findUnique({ where: { state } })).not.toBeNull();
  });
});

describe("the callback's claim-shaped probe", () => {
  it("claims a live attempt exactly once, returning the full attempt", async () => {
    const fixture = await seededReady("claim");
    const state = await consultState(fixture, "prod", prodIdentity);
    const stored = await prisma.connectionConsentAttempt.findUniqueOrThrow({ where: { state } });

    const claim = await claimConsentAttempt(prisma, state);
    if (!claim.claimed) throw new Error(`expected claimed, got ${claim.reason}`);
    expect(claim.attempt.state).toBe(state);
    expect(claim.attempt.userOid).toBe(userOid);
    expect(claim.attempt.env).toBe("prod");
    expect(claim.attempt.providerId).toBe(fixture.providerId);
    expect(claim.attempt.providerRevision).toBe(1);
    expect(claim.attempt.codeVerifier).toBe(stored.codeVerifier);
    // The completion message's target origin is the consult-recorded value.
    expect(claim.attempt.openerOrigin).toBe("https://app.example.test");

    // Single-use: the row is gone, and a second claim is not_found.
    expect(await prisma.connectionConsentAttempt.findUnique({ where: { state } })).toBeNull();
    await expect(claimConsentAttempt(prisma, state)).resolves.toEqual({
      claimed: false,
      reason: "not_found",
    });
  });

  it("refuses an expired attempt at/after the TTL and leaves it for the sweep", async () => {
    const fixture = await seededReady("expired-claim");
    const state = await consultState(fixture, "prod", prodIdentity);
    await prisma.connectionConsentAttempt.update({
      where: { state },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    await expect(claimConsentAttempt(prisma, state)).resolves.toEqual({
      claimed: false,
      reason: "expired",
    });
    expect(await prisma.connectionConsentAttempt.findUnique({ where: { state } })).not.toBeNull();
  });

  it("arbitrates concurrent claims to exactly one winner", async () => {
    const fixture = await seededReady("claim-race");
    const state = await consultState(fixture, "prod", prodIdentity);
    const [a, b] = await Promise.all([
      claimConsentAttempt(prisma, state),
      claimConsentAttempt(prisma, state),
    ]);
    const winners = [a, b].filter((c) => c.claimed);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ claimed: true, attempt: { state } });
  });
});

describe("the expiry sweep", () => {
  it("removes expired rows without touching live ones", async () => {
    const fixture = await seededReady("sweep");
    const liveState = await consultState(fixture, "prod", prodIdentity);
    const expiredState = await consultState(fixture, "prod", prodIdentity);
    const cancelledState = await consultState(fixture, "prod", prodIdentity);
    await prisma.connectionConsentAttempt.update({
      where: { state: expiredState },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await prisma.connectionConsentAttempt.update({
      where: { state: cancelledState },
      data: { cancelledAt: new Date() },
    });

    // Exactly the expired rows go — pending-live and cancelled-live survive.
    await sweepExpiredConsentAttempts(prisma);
    const remaining = await prisma.connectionConsentAttempt.findMany({
      where: { providerId: fixture.providerId },
      select: { state: true },
    });
    expect(remaining.map((r) => r.state).sort()).toEqual([liveState, cancelledState].sort());
  });
});
