import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import {
  isProviderBindingEffective,
  type Delta,
  type ProviderMetadata,
  type ProviderStamp,
} from "@azx-pbc/shared";
import type { TokenVerifier } from "../plugins/auth.js";
import type { PrismaClient } from "../db/client.js";
import { consultConsent } from "../connections/consent.js";
import { buildTestApp, createTestPrisma, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Sensitive provider edits, deletion, impact counts, and the invalidation
 * transaction (I-02 T-0010): the 409 `confirmation_required` gate, the one
 * all-or-nothing transaction (ADR-0004 §Implementation Notes) whose revision
 * bump invalidates connections, kills pending attempts, and blocks bindings,
 * the impact endpoint (criterion 9), and deletion's already_removed /
 * no-restore rules (criterion 10).
 *
 * The binding chain is driven through the REAL routes (manifest PUT → approve)
 * so the stamps the assertions consume are the ones T-0009 files; the blocked
 * binding is asserted through T-0009's own rule
 * (`isProviderBindingEffective` — what the manifest read and the consult
 * consume) and through the consult's `not_available` outcome, never
 * re-derived locally.
 */

const ADMIN_GROUP = "platform-admin";
const OWNER_OID = `oid-t0010-owner-${randomUUID().slice(0, 8)}`;
const USER_OID = `oid-t0010-user-${randomUUID().slice(0, 8)}`;

const CLIENT_ID = "vendor-client-id-t0010";
const CLIENT_SECRET = "vendor-client-secret-t0010";

const masterKey = randomBytes(32);
const store = new DevEnvelopeSecretStore({ masterKey });

const prisma: PrismaClient = createTestPrisma();

const verifiers: TokenVerifier[] = [
  {
    verify: async (token) => {
      if (token === "admin")
        return { oid: "oid-t0010-admin", sub: "admin@azx.io", via: "oidc", groups: [ADMIN_GROUP] };
      if (token === "owner")
        return { oid: OWNER_OID, sub: "owner@azx.io", via: "oidc", groups: [] };
      return null;
    },
  },
];
const admin = { authorization: "Bearer admin" };
const owner = { authorization: "Bearer owner" };

let t: TestApp;

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
  await prisma.connectionProvider.deleteMany({ where: { ref: { in: createdRefs } } });
  await prisma.$disconnect();
  await t.close();
});

const createdProviderIds: string[] = [];
const createdRefs: string[] = [];
const createdSlugs: string[] = [];

function randomProviderRef(): string {
  return `prov-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** Create a provider through the real (sealed, audited) route. */
async function createProvider(ref?: string, overrides: Record<string, unknown> = {}) {
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/providers",
    headers: admin,
    payload: {
      ref: ref ?? randomProviderRef(),
      kind: "rest-delegated",
      displayName: "Asana",
      env: "prod",
      authorizeEndpoint: "https://vendor.example/oauth/authorize",
      tokenEndpoint: "https://vendor.example/oauth/token",
      requestedScopes: ["default"],
      apiOrigins: ["https://vendor.example"],
      tokenPlacement: { kind: "header-bearer" },
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  const meta = res.json();
  createdRefs.push(meta.ref);
  return meta as ProviderMetadata;
}

/**
 * The approved-binding fixture: an app whose effective manifest binds the
 * provider's ref, granted through the real write-gate and approval — the
 * filing stamp the invalidation must stale-date.
 */
async function seedAppBoundTo(ref: string): Promise<string> {
  const slug = uniqueSlug("t0010");
  createdSlugs.push(slug);
  await prisma.app.create({
    data: {
      slug,
      displayName: `T-0010 fixture ${slug}`,
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

async function seedConnection(
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
      material: `sealed-material-${userOid}`,
      grantedScopes: ["default"],
      grantedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    },
  });
}

async function seedPendingAttempt(providerId: string, appId: string) {
  return prisma.connectionConsentAttempt.create({
    data: {
      state: `state-${randomUUID()}`,
      codeVerifier: `verifier-${randomUUID()}`,
      userOid: USER_OID,
      providerId,
      providerRevision: 1,
      appId,
      env: "prod",
      openerOrigin: "https://app.example.test",
      expiresAt: new Date(Date.now() + 300_000),
    },
  });
}

/** The full-replace edit body — a sensitive delta only where overridden. */
const editBody = (revision: number, overrides: Record<string, unknown> = {}) => ({
  displayName: "Asana",
  authorizeEndpoint: "https://vendor.example/oauth/authorize",
  tokenEndpoint: "https://vendor.example/oauth/token",
  requestedScopes: ["default"],
  apiOrigins: ["https://vendor.example"],
  tokenPlacement: { kind: "header-bearer" },
  revision,
  ...overrides,
});

const putProvider = (id: string, payload: Record<string, unknown>) =>
  t.app.inject({ method: "PUT", url: `/api/v1/providers/${id}`, headers: admin, payload });

const getImpact = (id: string) =>
  t.app.inject({ method: "GET", url: `/api/v1/providers/${id}/impact`, headers: admin });

/** The binding stamps T-0009 filed for an app's approved provider-bound origin. */
async function filedStamps(slug: string, ref: string): Promise<ProviderStamp[]> {
  const rows = await prisma.approvalRequest.findMany({
    where: { app: { slug }, status: "approved" },
    select: { deltas: true },
  });
  return rows.flatMap((r) =>
    (r.deltas as unknown as Delta[]).flatMap((d) =>
      (d.providerStamps ?? []).filter((s) => s.ref === ref),
    ),
  );
}

describe("sensitive PUT without acknowledgement", () => {
  it("409s confirmation_required with the impact payload and applies nothing", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);
    const before = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });

    const res = await putProvider(
      meta.id,
      editBody(meta.revision, { tokenEndpoint: "https://other.example/oauth/token" }),
    );
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("confirmation_required");
    expect(res.json().error.details).toMatchObject({
      impact: {
        providerId: meta.id,
        ref,
        env: "prod",
        connections: 1,
        pendingAttempts: 1,
        boundApps: [{ id: appRow.id, slug, displayName: appRow.displayName }],
      },
      sensitiveFields: ["tokenEndpoint"],
    });

    // Nothing applied: the row, the connection, and the attempt are exactly
    // as before — no confirmation, no mutation (criterion 7).
    const after = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });
    expect(after).toEqual(before);
    const conn = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn.status).toBe("live");
    expect(conn.pendingRetire).toBeNull();
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).toBeNull();
  });

  it("never treats a display-name change or a secret rotation as sensitive", async () => {
    const meta = await createProvider();
    const displayOnly = await putProvider(
      meta.id,
      editBody(meta.revision, { displayName: "Asana Workflows" }),
    );
    expect(displayOnly.statusCode).toBe(200);
    // A rotation alone, against the just-loaded revision — also non-sensitive.
    const rotated = await putProvider(meta.id, {
      ...editBody(displayOnly.json().revision, { displayName: "Asana Workflows" }),
      clientSecret: "rotated-secret",
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().revision).toBe(meta.revision);
  });
});

describe("sensitive PUT with acknowledgement — the one transaction", () => {
  it("bumps the revision, invalidates connections, kills attempts, and blocks the binding — visible in one read", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);

    const res = await putProvider(
      meta.id,
      editBody(meta.revision, {
        confirmInvalidation: true,
        tokenEndpoint: "https://other.example/oauth/token",
        clientSecret: "rotated-during-sensitive-edit",
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().revision).toBe(meta.revision + 1);

    // One read after the mutation — every effect of the transaction is there
    // together; no intermediate state was observable in between.
    const row = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });
    expect(row.revision).toBe(meta.revision + 1);
    expect(row.tokenEndpoint).toBe("https://other.example/oauth/token");
    const conn = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn.status).toBe("invalidated");
    // ADR-0008's one-UPDATE rule: the ledger mark rode the invalidation.
    expect(conn.pendingRetire).toBe(connection.material);
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).not.toBeNull();

    // The revision bump IS the binding block (ADR-0004): every stamp filed at
    // the old revision is ineffective by T-0009's rule — the rule the manifest
    // read (the SPA's reapproval-needed badge) consumes.
    const stamps = await filedStamps(slug, ref);
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) {
      expect(isProviderBindingEffective(stamp, row)).toBe(false);
    }

    // …and the consult (T-0012) answers not_available off the same state.
    const consult = await consultConsent(prisma, store, {
      identity: { kind: "user", userOid: USER_OID },
      appSlug: slug,
      providerRef: ref,
      openerOrigin: "https://app.example.test",
      callbackUrl: "https://auth.example.test/connections/callback",
    });
    expect(consult).toEqual({ outcome: "not_available" });
  });

  it("leaves revision, connections, and attempts exactly as before when the transaction is interrupted", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);
    const before = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });

    // A wrapped client whose attempt-kill write fails mid-transaction — after
    // the provider row's UPDATE and the connection invalidation have run, so
    // only the rollback puts them back (explore.md §Test Patterns).
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
        method: "PUT",
        url: `/api/v1/providers/${meta.id}`,
        headers: admin,
        payload: editBody(meta.revision, {
          confirmInvalidation: true,
          tokenEndpoint: "https://other.example/oauth/token",
          clientSecret: "never-applied-secret",
        }),
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await bad.close();
    }

    const after = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });
    expect(after).toEqual(before);
    const conn = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn.status).toBe("live");
    expect(conn.pendingRetire).toBeNull();
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).toBeNull();
  });
});

describe("non-sensitive edits invalidate nothing", () => {
  it("applies a display-name change with the connection and attempt untouched", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);

    const res = await putProvider(
      meta.id,
      editBody(meta.revision, { displayName: "Asana Renamed" }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().revision).toBe(meta.revision);

    const conn = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn.status).toBe("live");
    expect(conn.pendingRetire).toBeNull();
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).toBeNull();
  });

  it("applies a secret rotation with the connection and attempt untouched", async () => {
    const meta = await createProvider();
    const slug = await seedAppBoundTo(meta.ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);
    const before = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });

    const res = await putProvider(meta.id, {
      ...editBody(meta.revision),
      displayName: "Asana",
      clientSecret: "fresh-vendor-secret",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revision).toBe(meta.revision);

    const after = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });
    expect(after.revision).toBe(before.revision);
    expect(after.clientSecretMaterial).not.toBe(before.clientSecretMaterial);
    expect(after.authorizeEndpoint).toBe(before.authorizeEndpoint);
    const conn = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn.status).toBe("live");
    expect(conn.pendingRetire).toBeNull();
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).toBeNull();
  });
});

describe("GET /api/v1/providers/:id/impact", () => {
  it("counts the seeded state: bound apps, non-invalidated connections, claimable attempts", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const boundSlug = await seedAppBoundTo(ref);
    const secondSlug = await seedAppBoundTo(ref); // a second bound app
    const unboundRef = randomProviderRef();
    await createProvider(unboundRef); // bound to nothing
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug: boundSlug } });

    await seedConnection(`${USER_OID}-a`, meta.id);
    await seedConnection(`${USER_OID}-b`, meta.id, { status: "reconnect-needed" });
    await seedConnection(`${USER_OID}-c`, meta.id, { status: "invalidated" }); // not impact
    await seedPendingAttempt(meta.id, appRow.id);
    await prisma.connectionConsentAttempt.create({
      data: {
        state: `state-${randomUUID()}`,
        codeVerifier: `verifier-${randomUUID()}`,
        userOid: USER_OID,
        providerId: meta.id,
        providerRevision: 1,
        appId: appRow.id,
        env: "prod",
        openerOrigin: "https://app.example.test",
        expiresAt: new Date(Date.now() + 300_000),
        cancelledAt: new Date(), // already dead — not impact
      },
    });

    const res = await getImpact(meta.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      providerId: meta.id,
      ref,
      env: "prod",
      connections: 2,
      pendingAttempts: 1,
    });
    // Both ref-bound apps, slug-ordered.
    expect(
      res
        .json()
        .boundApps.map((a: { slug: string }) => a.slug)
        .sort(),
    ).toEqual([boundSlug, secondSlug].sort());
    // The unbound provider reports nothing pending anywhere.
    const other = await prisma.connectionProvider.findUniqueOrThrow({
      where: { ref_env: { ref: unboundRef, env: "prod" } },
    });
    const empty = await getImpact(other.id);
    expect(empty.json()).toMatchObject({ boundApps: [], connections: 0, pendingAttempts: 0 });

    // No credential material in the payload — the impact payload is metadata.
    expect(res.payload).not.toContain(CLIENT_ID);
    expect(res.payload).not.toContain(CLIENT_SECRET);
  });

  it("404s an unknown provider", async () => {
    const res = await getImpact(randomUUID());
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE with acknowledgement", () => {
  it("invalidates connections and attempts, removes the provider, audits with bounded metadata", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(USER_OID, meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);

    const res = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/providers/${meta.id}`,
      headers: admin,
      payload: { confirmInvalidation: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ outcome: "deleted" });
    expect(await prisma.connectionProvider.findUnique({ where: { id: meta.id } })).toBeNull();

    const conn = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn.status).toBe("invalidated");
    expect(conn.pendingRetire).toBe(connection.material);
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).not.toBeNull();

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "provider.deleted", metadata: { path: ["providerId"], equals: meta.id } },
    });
    expect(event.actor).toBeTruthy();
    expect(event.metadata).toMatchObject({
      ref,
      env: "prod",
      providerId: meta.id,
      boundApps: 1,
      connections: 1,
      pendingAttempts: 1,
    });
    // Bounded metadata: no credential or endpoint URL ever.
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toContain(CLIENT_ID);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain("vendor.example");
  });

  it("409s confirmation_required without the acknowledgement", async () => {
    const meta = await createProvider();
    const res = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/providers/${meta.id}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("confirmation_required");
    expect(res.json().error.details.impact).toMatchObject({
      providerId: meta.id,
      ref: meta.ref,
      connections: 0,
      pendingAttempts: 0,
    });
    expect(await prisma.connectionProvider.findUnique({ where: { id: meta.id } })).not.toBeNull();
  });

  it("answers already_removed on repeat and never touches a same-ref replacement", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const first = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/providers/${meta.id}`,
      headers: admin,
      payload: { confirmInvalidation: true },
    });
    expect(first.json()).toEqual({ outcome: "deleted" });

    // Recreate under the same ref: a new surrogate id, restoring nothing.
    const replacement = await createProvider(ref, { displayName: "Asana Reborn" });
    expect(replacement.id).not.toBe(meta.id);

    // The repeat deletion names the OLD id: already_removed, and the
    // replacement — which shares only the ref — is untouched (criterion 10).
    const repeat = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/providers/${meta.id}`,
      headers: admin,
      payload: { confirmInvalidation: true },
    });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toEqual({ outcome: "already_removed" });
    expect(
      await prisma.connectionProvider.findUnique({ where: { id: replacement.id } }),
    ).not.toBeNull();

    // An unknown id that was never a provider is still a 404.
    const unknown = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/providers/${randomUUID()}`,
      headers: admin,
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("restores nothing: the replacement's fresh identity keeps old approvals dangling", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const stamps = await filedStamps(slug, ref);

    await t.app.inject({
      method: "DELETE",
      url: `/api/v1/providers/${meta.id}`,
      headers: admin,
      payload: { confirmInvalidation: true },
    });
    const replacement = await createProvider(ref);
    const replacementRow = await prisma.connectionProvider.findUniqueOrThrow({
      where: { id: replacement.id },
    });

    // The old stamps match neither the missing row nor the new one — nothing
    // was restored (ADR-0004 §Consequences; delete+recreate mints a new id).
    for (const stamp of stamps) {
      expect(isProviderBindingEffective(stamp, null)).toBe(false);
      expect(isProviderBindingEffective(stamp, replacementRow)).toBe(false);
    }
  });
});
