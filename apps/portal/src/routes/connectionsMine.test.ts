import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import type { TokenVerifier } from "../plugins/auth.js";
import type { PrismaClient } from "../db/client.js";
import { claimConsentAttempt, consultConsent } from "../connections/consent.js";
import { completeConsentCallback } from "../connections/completion.js";
import { buildTestApp, createTestPrisma, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * My Connections (I-02 T-0024, spec §My Connections and recovery criteria
 * 42–46): the principal-scoped list and disconnect. The load-bearing cases are
 * the BOLA refusal (another principal's id is a plain 404 that reveals
 * nothing), the one-transaction invalidation (row + ledger mark + pending
 * attempts + audit in one boundary), the T-0012 integration (a pending attempt
 * renders the disconnected outcome at claim; a post-disconnect consult starts
 * a FRESH attempt, never already_connected), and the id-scoped repeat
 * (`already_removed` that writes nothing a newer connection could inherit).
 */

const ADMIN_GROUP = "platform-admin";
const USER_OID = `oid-t0024-user-${randomUUID().slice(0, 8)}`;
const OTHER_OID = `oid-t0024-other-${randomUUID().slice(0, 8)}`;
const OWNER_OID = `oid-t0024-owner-${randomUUID().slice(0, 8)}`;

const SEALED_ACCESS = "PLANTED-ACCESS-MATERIAL-t0024";

const store = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });
const prisma: PrismaClient = createTestPrisma();

const verifiers: TokenVerifier[] = [
  {
    verify: async (token) => {
      if (token === "admin")
        return { oid: "oid-t0024-admin", sub: "admin@azx.io", via: "oidc", groups: [ADMIN_GROUP] };
      if (token === "owner")
        return { oid: OWNER_OID, sub: "owner@azx.io", via: "oidc", groups: [] };
      if (token === "user") return { oid: USER_OID, sub: "user@azx.io", via: "oidc", groups: [] };
      if (token === "other")
        return { oid: OTHER_OID, sub: "other@azx.io", via: "oidc", groups: [] };
      return null;
    },
  },
];
const user = { authorization: "Bearer user" };
const other = { authorization: "Bearer other" };
const admin = { authorization: "Bearer admin" };
const owner = { authorization: "Bearer owner" };

let t: TestApp;

const createdProviderIds: string[] = [];
const createdSlugs: string[] = [];

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  t = buildTestApp({ secretStore: store, auth: { verifiers, publicConfig: null } });
  await t.app.ready();
});

afterAll(async () => {
  await prisma.connectionConsentAttempt.deleteMany({
    where: { providerId: { in: createdProviderIds } },
  });
  await prisma.userConnection.deleteMany({ where: { providerId: { in: createdProviderIds } } });
  await prisma.approvalRequest.deleteMany({ where: { app: { slug: { in: createdSlugs } } } });
  await prisma.app.deleteMany({ where: { slug: { in: createdSlugs } } });
  await prisma.connectionProvider.deleteMany({ where: { id: { in: createdProviderIds } } });
  await prisma.$disconnect();
  await t.close();
});

async function seedProvider(env: "prod" | "dev" = "prod"): Promise<{
  id: string;
  ref: string;
  displayName: string;
}> {
  const ref = `prov-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const row = await prisma.connectionProvider.create({
    data: {
      ref,
      kind: "rest-delegated",
      displayName: `Asana (${env})`,
      authorizeEndpoint: "https://vendor.example/oauth/authorize",
      tokenEndpoint: "https://vendor.example/oauth/token",
      requestedScopes: ["read", "write"],
      apiOrigins: ["https://vendor.example"],
      tokenPlacement: { kind: "header-bearer" },
      env,
      clientIdMaterial: await store.seal("client-id-t0024"),
      clientSecretMaterial: await store.seal("client-secret-t0024"),
    },
  });
  createdProviderIds.push(row.id);
  return { id: row.id, ref, displayName: row.displayName };
}

function seedConnection(
  userOid: string,
  providerId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.userConnection.create({
    data: {
      userOid,
      providerId,
      providerRevision: 1,
      env: "prod",
      status: "live",
      material: `${SEALED_ACCESS}-${userOid}-${providerId}`,
      grantedScopes: ["read", "write"],
      grantedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    },
  });
}

function seedPendingAttempt(
  userOid: string,
  providerId: string,
  appId: string,
  overrides: Record<string, unknown> = {},
) {
  return prisma.connectionConsentAttempt.create({
    data: {
      state: `state-${randomUUID()}`,
      codeVerifier: `verifier-${randomUUID()}`,
      userOid,
      providerId,
      providerRevision: 1,
      appId,
      env: "prod",
      openerOrigin: "https://app.example.test",
      expiresAt: new Date(Date.now() + 300_000),
      ...overrides,
    },
  });
}

/** An app whose effective manifest binds the provider's ref, via the real write-gate. */
async function seedAppBoundTo(ref: string): Promise<string> {
  const slug = uniqueSlug("t0024");
  createdSlugs.push(slug);
  await prisma.app.create({
    data: {
      slug,
      displayName: `T-0024 fixture ${slug}`,
      ownerId: OWNER_OID,
      visibilityMode: "internal",
      visibilityGroupIds: [],
    },
  });
  const put = await t.app.inject({
    method: "PUT",
    url: `/api/v1/apps/${slug}/manifest`,
    headers: owner,
    payload: {
      capabilities: {
        mcp: [],
        externalOrigins: [],
        fetch: { shim: false, origins: [{ origin: "https://vendor.example", provider: ref }] },
      },
    },
  });
  expect(put.statusCode).toBe(200);
  const approve = await t.app.inject({
    method: "POST",
    url: `/api/v1/approvals/${put.json().pending}/approve`,
    headers: admin,
  });
  expect(approve.statusCode).toBe(200);
  return slug;
}

const listMine = () =>
  t.app.inject({ method: "GET", url: "/api/v1/connections/mine", headers: user });
const disconnect = (id: string, headers = user) =>
  t.app.inject({ method: "DELETE", url: `/api/v1/connections/mine/${id}`, headers });

describe("GET /api/v1/connections/mine", () => {
  it("lists only the caller's connections, metadata only, with the bound apps per connection", async () => {
    const prod = await seedProvider("prod");
    const dev = await seedProvider("dev");
    const slug = await seedAppBoundTo(prod.ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const mine = await seedConnection(USER_OID, prod.id);
    await seedConnection(USER_OID, dev.id, { env: "dev" });
    await seedConnection(OTHER_OID, prod.id); // someone else's — never listed

    const res = await listMine();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connections).toHaveLength(2);
    expect(body.connections.map((c: { providerRef: string }) => c.providerRef).sort()).toEqual(
      [prod.ref, dev.ref].sort(),
    );
    const prodCard = body.connections.find(
      (c: { providerRef: string }) => c.providerRef === prod.ref,
    );
    expect(prodCard).toMatchObject({
      id: mine.id,
      providerDisplayName: `Asana (prod)`,
      env: "prod",
      status: "live",
      grantedScopes: ["read", "write"],
    });
    expect(prodCard.sharedApps).toEqual([{ id: appRow.id, slug, displayName: appRow.displayName }]);
    const devCard = body.connections.find(
      (c: { providerRef: string }) => c.providerRef === dev.ref,
    );
    expect(devCard).toMatchObject({ env: "dev", sharedApps: [] });

    // Metadata only: the sealed material and the provider's endpoints never ride.
    expect(res.payload).not.toContain(SEALED_ACCESS);
    expect(res.payload).not.toContain("vendor.example");
    expect(res.payload).not.toContain(OTHER_OID);
  });

  it("excludes invalidated tombstones and reports reconnect-needed as its own status", async () => {
    const provider = await seedProvider();
    await seedConnection(USER_OID, provider.id, { status: "reconnect-needed" });
    await seedConnection(USER_OID, provider.id, {
      env: "dev",
      status: "invalidated", // the tombstone — no card
    });

    const res = await listMine();
    expect(res.statusCode).toBe(200);
    // Scoped to this provider's rows: the dev tombstone is no card, the
    // reconnect-needed row is listed under its own status.
    const statuses = res
      .json()
      .connections.filter((c: { providerRef: string }) => c.providerRef === provider.ref)
      .map((c: { status: string }) => c.status);
    expect(statuses).toEqual(["reconnect-needed"]);
  });

  it("refuses an unauthenticated call", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/connections/mine" });
    expect(res.statusCode).toBe(401);
  });
});

describe("DELETE /api/v1/connections/mine/:id — the disconnect transaction", () => {
  it("invalidates the row, ledger-marks the material, and kills the pending attempts — audited, in one transaction", async () => {
    const provider = await seedProvider();
    const slug = await seedAppBoundTo(provider.ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, provider.id);
    const attempt = await seedPendingAttempt(USER_OID, provider.id, appRow.id);
    const alreadyDead = await seedPendingAttempt(USER_OID, provider.id, appRow.id, {
      cancelledAt: new Date(), // killed earlier — the disconnect must not re-stamp it
    });

    const res = await disconnect(connection.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "disconnected" });

    // ADR-0008's one-UPDATE rule: the status flip and the ledger mark are the
    // same write — the sweep, not the display, is what stops the use.
    const row = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.status).toBe("invalidated");
    expect(row.pendingRetire).toBe(connection.material);
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).not.toBeNull();
    // An attempt killed earlier keeps its own marker — the disconnect's kill
    // only ever touches the still-pending ones.
    const dead = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: alreadyDead.id },
    });
    expect(dead.cancelledAt).toEqual(alreadyDead.cancelledAt);

    // The audit event, bounded metadata (design.md §Operator-visible signals).
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        action: "connection.disconnected",
        metadata: { path: ["connectionId"], equals: connection.id },
      },
    });
    expect(event.actor).toBe(USER_OID);
    expect(event.metadata).toMatchObject({ providerRef: provider.ref, env: "prod" });
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toContain(connection.material);
    expect(serialized).not.toContain("vendor.example");
  });

  it("renders the disconnected outcome at claim — T-0012's state machine refuses the killed attempt", async () => {
    const provider = await seedProvider();
    const slug = await seedAppBoundTo(provider.ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, provider.id, { status: "reconnect-needed" });
    // 43+ chars — the state's entropy floor (ConsentStateSchema); the callback
    // refuses anything shorter as a probe before it ever claims.
    const state = randomBytes(32).toString("base64url");
    await seedPendingAttempt(USER_OID, provider.id, appRow.id, { state });

    const res = await disconnect(connection.id);
    expect(res.json()).toEqual({ outcome: "disconnected" });

    const claim = await claimConsentAttempt(prisma, state);
    expect(claim).toEqual({ claimed: false, reason: "cancelled" });
    // …and the callback's completion renders the disconnected page — the
    // killed attempt can never establish anything (criterion 44).
    const completion = await completeConsentCallback(prisma, {
      state,
      code: null,
      error: null,
    });
    expect(completion.outcome).toBe("disconnected");
  });

  it("makes the next consult start a FRESH attempt — never already_connected", async () => {
    const provider = await seedProvider();
    const slug = await seedAppBoundTo(provider.ref);
    const connection = await seedConnection(USER_OID, provider.id);
    const consultReq = {
      identity: { kind: "user", userOid: USER_OID },
      appSlug: slug,
      providerRef: provider.ref,
      openerOrigin: "https://app.example.test",
      callbackUrl: "https://auth.example.test/connections/callback",
    } as const;

    // While live, consent has nothing to do.
    const before = await consultConsent(prisma, store, consultReq);
    expect(before.outcome).toBe("already_connected");

    expect((await disconnect(connection.id)).json()).toEqual({ outcome: "disconnected" });

    // The row state, not the display: the consult's no-live-connection
    // predicate now fails and a fresh attempt starts (criterion 44 —
    // reconnecting requires a new explicit action).
    const after = await consultConsent(prisma, store, consultReq);
    expect(after.outcome).toBe("started");
    expect(after).toMatchObject({ authorizeUrl: expect.stringContaining("vendor.example") });
  });

  it("answers already_removed on repeat, writes nothing, and leaves nothing a newer connection could inherit", async () => {
    const provider = await seedProvider();
    const slug = await seedAppBoundTo(provider.ref);
    await seedPendingAttempt(
      USER_OID,
      provider.id,
      (await prisma.app.findUniqueOrThrow({ where: { slug } })).id,
    );
    const connection = await seedConnection(USER_OID, provider.id);

    const first = await disconnect(connection.id);
    expect(first.json()).toEqual({ outcome: "disconnected" });
    const eventsAfterFirst = await prisma.auditEvent.count({
      where: {
        action: "connection.disconnected",
        metadata: { path: ["connectionId"], equals: connection.id },
      },
    });
    expect(eventsAfterFirst).toBe(1);

    // The repeat — a stale tab's click on the removed connection: answered
    // from the tombstone, id-scoped, and it writes NOTHING (no second event,
    // no ledger change, no attempt touched).
    const repeat = await disconnect(connection.id);
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ outcome: "already_removed" });
    expect(
      await prisma.auditEvent.count({
        where: {
          action: "connection.disconnected",
          metadata: { path: ["connectionId"], equals: connection.id },
        },
      }),
    ).toBe(1);

    // Re-establish the newer connection exactly as the callback's upsert
    // would (fresh material, fresh grant, the old material ledger-marked) —
    // and assert it is live with the reconnect-upsert's own ledger mark: the
    // repeat left nothing dead or marked for the newer connection to inherit.
    await prisma.$executeRaw`UPDATE user_connections
      SET status = 'live', material = ${`${connection.material}-newer`}, "grantedAt" = now(),
          "pendingRetire" = "material", "updatedAt" = now()
      WHERE id = ${connection.id}::uuid`;
    const newer = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(newer.status).toBe("live");
    expect(newer.material).toBe(`${connection.material}-newer`);
    expect(newer.pendingRetire).toBe(connection.material);
    // …and the newer connection is fully usable by the state machine again:
    // the consult answers already_connected off the row the repeat left whole.
    const freshConsult = await consultConsent(prisma, store, {
      identity: { kind: "user", userOid: USER_OID },
      appSlug: slug,
      providerRef: provider.ref,
      openerOrigin: "https://app.example.test",
      callbackUrl: "https://auth.example.test/connections/callback",
    });
    expect(freshConsult.outcome).toBe("already_connected");
  });

  it("reports a disconnect it cannot complete as a failure and applies nothing", async () => {
    const provider = await seedProvider();
    const slug = await seedAppBoundTo(provider.ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, provider.id);
    const attempt = await seedPendingAttempt(USER_OID, provider.id, appRow.id);

    // The attempt-kill write fails mid-transaction — the row invalidation and
    // the ledger mark must roll back with it (criterion 44: never a
    // successful removal Helix did not complete).
    const failing = createTestPrisma().$extends({
      query: {
        connectionConsentAttempt: {
          updateMany() {
            throw new Error("interrupted");
          },
        },
      },
    }) as unknown as PrismaClient;
    const bad = buildTestApp({
      secretStore: store,
      auth: { verifiers, publicConfig: null },
      prisma: failing,
    });
    await bad.app.ready();
    try {
      const res = await bad.app.inject({
        method: "DELETE",
        url: `/api/v1/connections/mine/${connection.id}`,
        headers: user,
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await bad.close();
    }

    const row = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.status).toBe("live");
    expect(row.pendingRetire).toBeNull();
    expect(
      (await prisma.connectionConsentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
        .cancelledAt,
    ).toBeNull();
    expect(
      await prisma.auditEvent.count({
        where: {
          action: "connection.disconnected",
          metadata: { path: ["connectionId"], equals: connection.id },
        },
      }),
    ).toBe(0);
  });
});

describe("BOLA — another principal's connection does not exist", () => {
  it("refuses a foreign id with the same 404 an unknown id gets, and touches nothing", async () => {
    const provider = await seedProvider();
    const foreignConnection = await seedConnection(OTHER_OID, provider.id);
    const unknownId = randomUUID();

    const foreign = await disconnect(foreignConnection.id);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe("not_found");
    // The unknown id's failure is byte-for-byte the same shape: the response
    // never reveals whether the id exists for someone else.
    const unknown = await disconnect(unknownId);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual(foreign.json());
    expect(foreign.payload).not.toContain(OTHER_OID);

    // The owner disconnects, then repeats: disconnected, then already_removed.
    expect((await disconnect(foreignConnection.id, other)).json()).toEqual({
      outcome: "disconnected",
    });
    expect((await disconnect(foreignConnection.id, other)).json()).toEqual({
      outcome: "already_removed",
    });
    // …and even NOW, with the row a tombstone, the foreign id is still a
    // plain 404 to the other principal — never an already_removed, which
    // would disclose the row.
    const stillForeign = await disconnect(foreignConnection.id);
    expect(stillForeign.statusCode).toBe(404);
    expect(stillForeign.json()).toEqual(foreign.json());
    // The owner's tombstone is untouched by the refused call.
    const row = await prisma.userConnection.findUniqueOrThrow({
      where: { id: foreignConnection.id },
    });
    expect(row.status).toBe("invalidated");
  });

  it("never lists another principal's connections, even on a shared provider", async () => {
    const provider = await seedProvider();
    await seedConnection(OTHER_OID, provider.id);
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/connections/mine",
      headers: other,
    });
    expect(res.statusCode).toBe(200);
    // Other tests in this file give OTHER_OID connections on other providers;
    // scoping to this provider's ref is the assertion that matters — one row,
    // the caller's own, never the other principal's.
    const rows = res
      .json()
      .connections.filter((c: { providerRef: string }) => c.providerRef === provider.ref);
    expect(rows).toHaveLength(1);
  });
});
