import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import {
  isProviderBindingEffective,
  ProviderExportDocumentSchema,
  type Delta,
  type ProviderExportDocument,
  type ProviderMetadata,
  type ProviderStamp,
} from "@azx-pbc/shared";
import type { TokenVerifier } from "../plugins/auth.js";
import type { PrismaClient } from "../db/client.js";
import { buildTestApp, createTestPrisma, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Provider import/export (I-02 T-0011): the credential-free export document
 * (criterion 11), the preview-before-apply import (criterion 12), and the
 * rule that imported edits obey the form's rules — create mode rides T-0008's
 * sealed create path, an update rides the form's PUT path with its revision
 * CAS, and a sensitive imported update rides T-0010's confirmation →
 * acknowledge → invalidation transaction (reused code, so the assertions
 * reuse T-0010's expectations). Criterion 11's round-trip proof closes the
 * file: export → import → export yields the same meaning.
 */

const ADMIN_GROUP = "platform-admin";
const OWNER_OID = `oid-t0011-owner-${randomUUID().slice(0, 8)}`;
const USER_OID = `oid-t0011-user-${randomUUID().slice(0, 8)}`;

const CLIENT_ID = "vendor-client-id-t0011";
const CLIENT_SECRET = "vendor-client-secret-t0011";

const masterKey = randomBytes(32);
const store = new DevEnvelopeSecretStore({ masterKey });

const prisma: PrismaClient = createTestPrisma();

const verifiers: TokenVerifier[] = [
  {
    verify: async (token) => {
      if (token === "admin")
        return { oid: "oid-t0011-admin", sub: "admin@azx.io", via: "oidc", groups: [ADMIN_GROUP] };
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

/** Create a provider through the real (sealed, audited) form route. */
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
  const meta = res.json() as ProviderMetadata;
  createdRefs.push(meta.ref);
  createdProviderIds.push(meta.id);
  return meta;
}

const exportOf = (id: string) =>
  t.app.inject({ method: "GET", url: `/api/v1/providers/${id}/export`, headers: admin });

const previewOf = (payload: Record<string, unknown>) =>
  t.app.inject({
    method: "POST",
    url: "/api/v1/providers/import/preview",
    headers: admin,
    payload,
  });

const importOf = (payload: Record<string, unknown>) =>
  t.app.inject({ method: "POST", url: "/api/v1/providers/import", headers: admin, payload });

/** The export of a provider, parsed against the one shared document schema. */
async function exportDocument(meta: ProviderMetadata): Promise<ProviderExportDocument> {
  const res = await exportOf(meta.id);
  expect(res.statusCode).toBe(200);
  return ProviderExportDocumentSchema.parse(res.json());
}

/**
 * The approved-binding fixture — an app whose effective manifest binds the
 * provider's ref, granted through the real write-gate and approval (the
 * filing stamps the invalidation must stale-date).
 */
async function seedAppBoundTo(ref: string): Promise<string> {
  const slug = uniqueSlug("t0011");
  createdSlugs.push(slug);
  await prisma.app.create({
    data: {
      slug,
      displayName: `T-0011 fixture ${slug}`,
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

async function seedConnection(providerId: string) {
  return prisma.userConnection.create({
    data: {
      userOid: USER_OID,
      providerId,
      providerRevision: 1,
      env: "prod",
      status: "live",
      material: `sealed-material-${USER_OID}`,
      grantedScopes: ["default"],
      grantedAt: new Date(),
      expiresAt: new Date(Date.now() + 3_600_000),
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

describe("GET /api/v1/providers/:id/export", () => {
  it("yields the shared document schema with every editable field and no credential, token, secret-reference, or environment field", async () => {
    const meta = await createProvider(undefined, {
      displayName: "Asana Enterprise",
      requestedScopes: ["default", "tasks:write"],
      tokenPlacement: { kind: "header", name: "x-api-token" },
    });
    const res = await exportOf(meta.id);
    expect(res.statusCode).toBe(200);

    // Parses against T-0001's document schema — the export is valid import
    // input by construction.
    const document = ProviderExportDocumentSchema.parse(res.json());
    expect(document.version).toBe(1);

    // The serialized keys, enumerated: the document is exactly the editable
    // configuration. No env, no credential field under any spelling — the
    // fields do not exist on the payload, they are not merely empty.
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["provider", "version"]);
    expect(Object.keys(body.provider).sort()).toEqual([
      "apiOrigins",
      "authorizeEndpoint",
      "displayName",
      "kind",
      "ref",
      "requestedScopes",
      "tokenEndpoint",
      "tokenPlacement",
    ]);
    expect(body.provider).toMatchObject({
      ref: meta.ref,
      kind: "rest-delegated",
      displayName: "Asana Enterprise",
      authorizeEndpoint: "https://vendor.example/oauth/authorize",
      tokenEndpoint: "https://vendor.example/oauth/token",
      requestedScopes: ["default", "tasks:write"],
      apiOrigins: ["https://vendor.example"],
      tokenPlacement: { kind: "header", name: "x-api-token" },
    });
    expect(res.payload).not.toContain(CLIENT_ID);
    expect(res.payload).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(body)).not.toContain("clientIdMaterial");
    expect(JSON.stringify(body)).not.toContain("clientSecretMaterial");
  });

  it("re-reads current configuration without changing it, and audits provider.exported with bounded metadata", async () => {
    const meta = await createProvider();
    const before = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });

    const first = await exportOf(meta.id);
    const second = await exportOf(meta.id);
    // Byte-identical repeats: an export is a read, not a transformation.
    expect(second.body).toBe(first.body);

    const after = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });
    expect(after).toEqual(before);

    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "provider.exported", metadata: { path: ["providerId"], equals: meta.id } },
    });
    expect(event.actor).toBeTruthy();
    expect(event.metadata).toMatchObject({ providerId: meta.id, ref: meta.ref, env: "prod" });
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toContain(CLIENT_ID);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain("vendor.example");
  });

  it("404s an unknown provider", async () => {
    const res = await exportOf(randomUUID());
    expect(res.statusCode).toBe(404);
  });
});

describe("a forced read failure during export", () => {
  it("surfaces as an export failure — an error envelope, never a file-like payload", async () => {
    const meta = await createProvider();
    // A read that dies mid-flight — the wrapped client makes the provider
    // read fail the way an interrupted read would.
    const failing = createTestPrisma().$extends({
      query: {
        connectionProvider: {
          findUnique() {
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
        method: "GET",
        url: `/api/v1/providers/${meta.id}/export`,
        headers: admin,
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("internal");
      // No file-like payload: nothing a browser could save as the export.
      expect(res.payload).not.toContain('"version"');
      expect(res.payload).not.toContain('"provider"');
    } finally {
      await bad.close();
    }
  });
});

describe("POST /api/v1/providers/import/preview", () => {
  it("with no mode is the validate-only call — parsed fields, nothing proposed, nothing applied", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const res = await previewOf({ document });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: null, provider: document.provider });
    expect(await prisma.connectionProvider.findUnique({ where: { id: meta.id } })).not.toBeNull();
  });

  it("create-mode against a fresh environment proposes the create with identical field values", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const res = await previewOf({ document, mode: "create", env: "dev" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe("create");
    expect(body.env).toBe("dev");
    // Identical field values — the proposal is the document, verbatim.
    expect(body.provider).toEqual(document.provider);
    expect(body.collision).toBeNull();

    // Preview applies nothing: still exactly one row for the ref, in prod.
    const rows = await prisma.connectionProvider.findMany({ where: { ref: meta.ref } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.env).toBe("prod");
  });

  it("create-mode surfaces the ref+env collision instead of an implicit target", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const res = await previewOf({ document, mode: "create", env: "prod" });
    expect(res.statusCode).toBe(200);
    expect(res.json().collision).toEqual({
      providerId: meta.id,
      ref: meta.ref,
      env: "prod",
    });
  });

  it("update-mode against the source provider proposes a no-op — an empty diff", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const res = await previewOf({ document, mode: "update", targetId: meta.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      mode: "update",
      target: {
        providerId: meta.id,
        ref: meta.ref,
        env: "prod",
        displayName: meta.displayName,
        revision: meta.revision,
      },
      diff: [],
      sensitiveFields: [],
    });
  });

  it("update-mode diffs changed fields one line each and names the sensitive ones", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const imported = {
      ...document.provider,
      displayName: "Asana Renamed",
      tokenEndpoint: "https://other.example/oauth/token",
    };
    const res = await previewOf({
      document: { ...document, provider: imported },
      mode: "update",
      targetId: meta.id,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.diff).toEqual([
      { field: "displayName", current: "Asana", imported: "Asana Renamed" },
      {
        field: "tokenEndpoint",
        current: "https://vendor.example/oauth/token",
        imported: "https://other.example/oauth/token",
      },
    ]);
    // The sensitive list is the apply path's own comparison — a display-name
    // change is not on it, an endpoint change is.
    expect(body.sensitiveFields).toEqual(["tokenEndpoint"]);
  });

  it("400s a malformed document — wrong version, unknown key, an env or credential riding the file", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    expect(
      (await previewOf({ document: { ...document, version: 2 }, mode: "create", env: "dev" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await previewOf({
          document: { ...document, env: "dev" },
          mode: "create",
          env: "dev",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await previewOf({
          document: { ...document, provider: { ...document.provider, clientId: CLIENT_ID } },
          mode: "create",
          env: "dev",
        })
      ).statusCode,
    ).toBe(400);
    expect((await previewOf({ document: { ...document, extra: true } })).statusCode).toBe(400);
    expect(await prisma.connectionProvider.findUnique({ where: { id: meta.id } })).not.toBeNull();
  });

  it("400s a mode selection that is not self-consistent", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    // create without env; create with a target; update without a target —
    // a collision never silently selects one; update with env — a provider
    // never moves environments.
    expect((await previewOf({ document, mode: "create" })).statusCode).toBe(400);
    expect(
      (await previewOf({ document, mode: "create", env: "dev", targetId: meta.id })).statusCode,
    ).toBe(400);
    expect((await previewOf({ document, mode: "update" })).statusCode).toBe(400);
    expect(
      (await previewOf({ document, mode: "update", targetId: meta.id, env: "dev" })).statusCode,
    ).toBe(400);
    expect((await previewOf({ document, env: "dev" })).statusCode).toBe(400);
  });

  it("404s an unknown update target", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const res = await previewOf({ document, mode: "update", targetId: randomUUID() });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/v1/providers/import — create mode", () => {
  it("without credential entry fails validation and creates nothing", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const ref = randomProviderRef();
    createdRefs.push(ref);
    const missing = await importOf({
      mode: "create",
      document: { ...document, provider: { ...document.provider, ref } },
      env: "dev",
    });
    expect(missing.statusCode).toBe(422);
    const blank = await importOf({
      mode: "create",
      document: { ...document, provider: { ...document.provider, ref } },
      env: "dev",
      clientId: CLIENT_ID,
      clientSecret: "",
    });
    expect(blank.statusCode).toBe(422);
    expect(await prisma.connectionProvider.findMany({ where: { ref } })).toEqual([]);
  });

  it("with credentials creates a provider that works like a form-created one — same audited, sealed path", async () => {
    const source = await createProvider();
    const document = await exportDocument(source);
    const ref = randomProviderRef();
    createdRefs.push(ref);

    const res = await importOf({
      mode: "create",
      document: { ...document, provider: { ...document.provider, ref } },
      env: "dev",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.outcome).toBe("created");
    expect(body.provider).toMatchObject({
      ref,
      kind: "rest-delegated",
      displayName: source.displayName,
      env: "dev",
      revision: 1,
      requestedScopes: source.requestedScopes,
      apiOrigins: source.apiOrigins,
      tokenPlacement: source.tokenPlacement,
    });
    createdProviderIds.push(body.provider.id);

    // The response carries no credential material.
    expect(res.payload).not.toContain(CLIENT_ID);
    expect(res.payload).not.toContain(CLIENT_SECRET);

    // The row is a form-created row: every field, sealed material on both
    // halves — never plaintext.
    const row = await prisma.connectionProvider.findUniqueOrThrow({
      where: { id: body.provider.id },
    });
    expect(row.clientIdMaterial).toBeTruthy();
    expect(row.clientSecretMaterial).toBeTruthy();
    expect(row.clientIdMaterial).not.toContain(CLIENT_ID);
    expect(row.clientSecretMaterial).not.toContain(CLIENT_SECRET);

    // Same admin-gated, audited path: provider.imported, actor-stamped,
    // bounded metadata.
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: "provider.imported", metadata: { path: ["ref"], equals: ref } },
    });
    expect(event.actor).toBeTruthy();
    expect(event.metadata).toMatchObject({
      mode: "create",
      ref,
      env: "dev",
      kind: "rest-delegated",
    });
    expect(JSON.stringify(event.metadata)).not.toContain(CLIENT_ID);
    expect(JSON.stringify(event.metadata)).not.toContain(CLIENT_SECRET);
  });

  it("reports the ref+env duplicate as a 409 conflict, never a second provider", async () => {
    const source = await createProvider();
    const document = await exportDocument(source);
    const dup = await importOf({
      mode: "create",
      document,
      env: "prod",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toContain(source.ref);
    const rows = await prisma.connectionProvider.findMany({ where: { ref: source.ref } });
    expect(rows).toHaveLength(1);
  });
});

describe("POST /api/v1/providers/import — update mode", () => {
  it("requires the explicit target — a name collision never silently resolves", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const before = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });

    // The document's ref names an existing provider; without the explicit
    // target id the request is refused whole.
    const res = await importOf({ mode: "update", document, revision: meta.revision });
    expect(res.statusCode).toBe(422);
    const after = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });
    expect(after).toEqual(before);
  });

  it("preserves existing credentials unless explicitly replaced — blank keeps", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const before = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });

    const kept = await importOf({
      mode: "update",
      document: {
        ...document,
        provider: { ...document.provider, displayName: "Asana Renamed" },
      },
      targetId: meta.id,
      revision: meta.revision,
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().outcome).toBe("updated");
    expect(kept.json().provider.revision).toBe(meta.revision);

    const afterKeep = await prisma.connectionProvider.findUniqueOrThrow({
      where: { id: meta.id },
    });
    expect(afterKeep.clientIdMaterial).toBe(before.clientIdMaterial);
    expect(afterKeep.clientSecretMaterial).toBe(before.clientSecretMaterial);
    expect(afterKeep.displayName).toBe("Asana Renamed");

    // An explicit replace seals new material and never echoes it.
    const NEW_SECRET = "replaced-vendor-secret-t0011";
    const replaced = await importOf({
      mode: "update",
      document,
      targetId: meta.id,
      revision: meta.revision,
      clientSecret: NEW_SECRET,
    });
    expect(replaced.statusCode).toBe(200);
    const afterReplace = await prisma.connectionProvider.findUniqueOrThrow({
      where: { id: meta.id },
    });
    expect(afterReplace.clientIdMaterial).toBe(before.clientIdMaterial);
    expect(afterReplace.clientSecretMaterial).not.toBe(before.clientSecretMaterial);
    expect(afterReplace.clientSecretMaterial).not.toContain(NEW_SECRET);
    expect(replaced.payload).not.toContain(NEW_SECRET);
  });

  it("a rejected import — malformed document or stale revision — leaves the target unchanged", async () => {
    const meta = await createProvider();
    const document = await exportDocument(meta);
    const before = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });

    const malformed = await importOf({
      mode: "update",
      document: { ...document, provider: { ...document.provider, displayName: "" } },
      targetId: meta.id,
      revision: meta.revision,
    });
    expect(malformed.statusCode).toBe(422);

    const stale = await importOf({
      mode: "update",
      document: {
        ...document,
        provider: { ...document.provider, displayName: "Never Applied" },
      },
      targetId: meta.id,
      revision: meta.revision + 7,
    });
    expect(stale.statusCode).toBe(409);

    const after = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });
    expect(after).toEqual(before);
  });

  it("a sensitive imported update without confirmation is refused with the impact payload, and nothing changes", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);
    const document = await exportDocument(meta);
    const before = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });

    const res = await importOf({
      mode: "update",
      document: {
        ...document,
        provider: { ...document.provider, tokenEndpoint: "https://other.example/oauth/token" },
      },
      targetId: meta.id,
      revision: meta.revision,
    });
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

    // Rejected: the row, the connection, and the attempt are exactly as before.
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

  it("a sensitive imported update with acknowledgement rides the form's invalidation transaction", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);
    const document = await exportDocument(meta);

    const res = await importOf({
      mode: "update",
      document: {
        ...document,
        provider: { ...document.provider, tokenEndpoint: "https://other.example/oauth/token" },
      },
      targetId: meta.id,
      revision: meta.revision,
      confirmInvalidation: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome).toBe("updated");
    expect(res.json().provider.revision).toBe(meta.revision + 1);

    // One read after the mutation — the same effects T-0010 asserts for the
    // form's PUT, because this IS the form's transaction.
    const row = await prisma.connectionProvider.findUniqueOrThrow({ where: { id: meta.id } });
    expect(row.revision).toBe(meta.revision + 1);
    expect(row.tokenEndpoint).toBe("https://other.example/oauth/token");
    const conn = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn.status).toBe("invalidated");
    expect(conn.pendingRetire).toBe(connection.material);
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).not.toBeNull();

    // The revision bump stale-dates the filed binding stamps (T-0009's rule).
    const stamps = await filedStamps(slug, ref);
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) {
      expect(isProviderBindingEffective(stamp, row)).toBe(false);
    }

    // provider.imported, bounded metadata: mode, target, sensitive flag,
    // impact counts — no material, no endpoint URL.
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: {
        action: "provider.imported",
        metadata: { path: ["providerId"], equals: meta.id },
      },
    });
    expect(event.actor).toBeTruthy();
    expect(event.metadata).toMatchObject({
      mode: "update",
      providerId: meta.id,
      ref,
      env: "prod",
      sensitive: true,
      sensitiveFields: ["tokenEndpoint"],
      invalidatedConnections: 1,
      killedAttempts: 1,
    });
    const serialized = JSON.stringify(event.metadata);
    expect(serialized).not.toContain(CLIENT_ID);
    expect(serialized).not.toContain(CLIENT_SECRET);
    expect(serialized).not.toContain("other.example");
  });

  it("a non-sensitive imported update — a display name — applies without confirmation and invalidates nothing", async () => {
    const ref = randomProviderRef();
    const meta = await createProvider(ref);
    const slug = await seedAppBoundTo(ref);
    const appRow = await prisma.app.findUniqueOrThrow({ where: { slug } });
    const connection = await seedConnection(meta.id);
    const attempt = await seedPendingAttempt(meta.id, appRow.id);
    const document = await exportDocument(meta);

    const res = await importOf({
      mode: "update",
      document: { ...document, provider: { ...document.provider, displayName: "Asana Renamed" } },
      targetId: meta.id,
      revision: meta.revision,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().provider.revision).toBe(meta.revision);

    const conn = await prisma.userConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(conn.status).toBe("live");
    expect(conn.pendingRetire).toBeNull();
    const att = await prisma.connectionConsentAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(att.cancelledAt).toBeNull();
  });
});

describe("round-trip (criterion 11)", () => {
  it("export → import create into the other environment → export yields the same meaning", async () => {
    const source = await createProvider(undefined, {
      requestedScopes: ["default", "tasks:write"],
    });
    const first = await exportDocument(source);

    const res = await importOf({
      mode: "create",
      document: first,
      env: "dev",
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(res.statusCode).toBe(201);
    createdProviderIds.push(res.json().provider.id);

    const second = await exportDocument(res.json().provider);
    // The document carries no environment — the dev copy's export is the
    // source's, field for field.
    expect(second).toEqual(first);
  });

  it("export → import update (no credential replace) → export again yields the same meaning", async () => {
    const meta = await createProvider();
    const first = await exportOf(meta.id);

    const noop = await importOf({
      mode: "update",
      document: ProviderExportDocumentSchema.parse(first.json()),
      targetId: meta.id,
      revision: meta.revision,
    });
    expect(noop.statusCode).toBe(200);

    const second = await exportOf(meta.id);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
  });
});

describe("the import/export routes refuse a non-admin", () => {
  let g: TestApp;

  beforeAll(async () => {
    g = buildTestApp({ secretStore: store, auth: { verifiers, publicConfig: null } });
    await g.app.ready();
  });

  afterAll(async () => {
    await g.close();
  });

  const ROUTES: [method: "GET" | "POST", name: string, url: string][] = [
    ["GET", "export", `/api/v1/providers/${randomUUID()}/export`],
    ["POST", "preview", "/api/v1/providers/import/preview"],
    ["POST", "import", "/api/v1/providers/import"],
  ];

  it.each(ROUTES)("refuses %s (%s) for a signed-in non-admin", async (method, _n, url) => {
    const res = await g.app.inject({ method, url, headers: { authorization: "Bearer owner" } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it.each(ROUTES)("admits an admin to %s (%s)", async (method, _n, url) => {
    // Positive control: the gate is not what stops these (400/404 downstream —
    // the ids are unknown and the bodies empty).
    const res = await g.app.inject({ method, url, headers: admin });
    expect(res.statusCode).not.toBe(403);
  });
});
