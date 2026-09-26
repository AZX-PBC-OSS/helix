import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TokenVerifier } from "../plugins/auth.js";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * The app-binding approval chain (I-02 T-0009): a provider-bound origin
 * classifies high-risk and files stamped (`providerStamps` + `publicApp` at
 * filing), an origin must be one of the provider's permitted API destinations
 * before any request opens, and approving after the provider moved on is a 409
 * that approves nothing (ADR-0004 — an old pending approval cannot approve
 * access to a newer configuration).
 *
 * Providers are seeded as raw rows (the CRUD routes are T-0008's and need the
 * vault); the sensitive-edit route that bumps a revision in production is
 * T-0010's, so a sensitive edit between filing and approval is simulated as the
 * raw revision bump that transaction ends with.
 */

const OWNER = "owner@azx.io";
const ADMIN = "admin@azx.io";
const ADMIN_GROUP = "platform-admin";

const verifiers: TokenVerifier[] = [
  {
    verify: async (t) => {
      if (t === "owner") return { oid: "oid-owner", sub: OWNER, via: "oidc", groups: [] };
      if (t === "admin")
        return { oid: "oid-admin", sub: ADMIN, via: "oidc", groups: [ADMIN_GROUP] };
      return null;
    },
  },
];

const owner = { authorization: "Bearer owner" };
const admin = { authorization: "Bearer admin" };

let t: TestApp;

beforeAll(async () => {
  process.env.PORTAL_ADMIN_GROUP_ID = ADMIN_GROUP;
  t = buildTestApp({ auth: { verifiers, publicConfig: null } });
  await t.app.ready();
});

afterAll(async () => {
  await t.prisma.connectionProvider.deleteMany({ where: { ref: { in: createdRefs } } });
  await t.close();
});

const createdRefs: string[] = [];

/** Seed a provider row directly (env-partitioned, `revision` defaults to 1). */
async function seedProvider(ref: string, overrides: Record<string, unknown> = {}) {
  createdRefs.push(ref);
  return t.prisma.connectionProvider.create({
    data: {
      ref,
      kind: "rest-delegated",
      displayName: "Asana",
      authorizeEndpoint: "https://vendor.example/oauth/authorize",
      tokenEndpoint: "https://vendor.example/oauth/token",
      requestedScopes: ["default"],
      apiOrigins: ["https://api.asana.com"],
      tokenPlacement: { kind: "header-bearer" },
      env: "prod",
      clientIdMaterial: "sealed-client-id",
      clientSecretMaterial: "sealed-client-secret",
      ...overrides,
    },
  });
}

async function createApp(visibility: Record<string, unknown> = { mode: "internal" }) {
  const slug = uniqueSlug();
  const created = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: owner,
    payload: { slug, displayName: "Bound", visibility },
  });
  expect(created.statusCode).toBe(201);
  return { slug, appId: created.json().id as string };
}

async function putManifest(slug: string, origins: unknown[]) {
  return t.app.inject({
    method: "PUT",
    url: `/api/v1/apps/${slug}/manifest`,
    headers: owner,
    payload: {
      capabilities: { mcp: [], externalOrigins: [], fetch: { shim: false, origins } },
    },
  });
}

async function requestRow(requestId: string) {
  return t.prisma.approvalRequest.findUniqueOrThrow({ where: { id: requestId } });
}

async function manifestOrigins(slug: string): Promise<unknown[]> {
  const manifest = await t.app.inject({
    method: "GET",
    url: `/api/v1/apps/${slug}/manifest`,
    headers: owner,
  });
  return ((manifest.json().capabilities ?? {}).fetch ?? {}).origins ?? [];
}

describe("filing a provider-bound origin (the write-gate)", () => {
  it("opens a high-risk request whose payload carries the ref + filing-time revision stamp", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`, { revision: 3 });
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref, required: true },
    ]);
    expect(put.statusCode).toBe(200);
    const requestId = put.json().pending;
    expect(requestId).toBeTruthy();

    // Nothing applied yet — the binding waits for approval.
    expect(await manifestOrigins(slug)).toEqual([]);

    const row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.risk).toBe("high");
    const deltas = row.deltas as { path: string; providerStamps: unknown[] }[];
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.path).toBe(`fetch.origins[+https://api.asana.com→provider:${provider.ref}]`);
    // The filing-time stamp: ref + providerId + revision as the filer saw them.
    expect(deltas[0]!.providerStamps).toEqual([
      { ref: provider.ref, env: "prod", providerId: provider.id, revision: 3 },
    ]);
  });

  it("stamps a public app's request publicApp: true, a non-public app's as not-public", async () => {
    const internal = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`);
    const internalPut = await putManifest(internal.slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    expect(internalPut.statusCode).toBe(200);
    const internalRow = await requestRow(internalPut.json().pending);
    expect(
      (internalRow.deltas as { publicApp?: boolean }[]).every((d) => d.publicApp === false),
    ).toBe(true);

    const pub = await createApp({ mode: "public" });
    const publicPut = await putManifest(pub.slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    expect(publicPut.statusCode).toBe(200);
    const publicRow = await requestRow(publicPut.json().pending);
    expect((publicRow.deltas as { publicApp?: boolean }[]).every((d) => d.publicApp === true)).toBe(
      true,
    );
  });

  it("stamps one entry per env row under the ref, and the origin must be permitted in both", async () => {
    const { slug } = await createApp();
    const ref = `pb-${randomUUID().slice(0, 8)}`;
    const prod = await seedProvider(ref, { env: "prod" });
    const dev = await seedProvider(ref, {
      env: "dev",
      apiOrigins: ["https://dev-api.asana.com"],
    });

    // Permitted by prod but not dev: the whole save is refused — the binding
    // resolves in the caller's tier, so every env row must permit the origin.
    const rejected = await putManifest(slug, [{ origin: "https://api.asana.com", provider: ref }]);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().error.code).toBe("validation_failed");
    expect(rejected.json().error.message).toMatch(/dev environment/);

    // Once both rows permit it: files with both rows stamped.
    await t.prisma.connectionProvider.update({
      where: { id: dev.id },
      data: { apiOrigins: ["https://dev-api.asana.com", "https://api.asana.com"] },
    });
    const filed = await putManifest(slug, [{ origin: "https://api.asana.com", provider: ref }]);
    expect(filed.statusCode).toBe(200);
    const row = await requestRow(filed.json().pending);
    const stamps = (
      row.deltas as { providerStamps: { env: string; providerId: string }[] }[]
    ).flatMap((d) => d.providerStamps);
    expect(stamps).toHaveLength(2);
    expect(stamps.map((s) => s.providerId).sort()).toEqual([prod.id, dev.id].sort());
  });
});

describe("manifest-save validation of the binding (criterion 15)", () => {
  it("refuses an origin outside the provider's apiOrigins — no request opened", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`);
    const put = await putManifest(slug, [
      { origin: "https://evil.example", provider: provider.ref },
    ]);
    expect(put.statusCode).toBe(400);
    expect(put.json().error.code).toBe("validation_failed");
    expect(await t.prisma.approvalRequest.findMany({ where: { app: { slug } } })).toEqual([]);
    expect(await manifestOrigins(slug)).toEqual([]);
  });

  it("refuses a binding to a reference with no provider row at all", async () => {
    const { slug } = await createApp();
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: `no-such-${randomUUID().slice(0, 8)}` },
    ]);
    expect(put.statusCode).toBe(400);
    expect(put.json().error.message).toMatch(/no provider with that reference/);
    expect(await t.prisma.approvalRequest.findMany({ where: { app: { slug } } })).toEqual([]);
  });
});

describe("the apply-time provider conflict (criterion 18)", () => {
  it("409s an approval after the provider's revision advanced, and approves nothing", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`, { revision: 2 });
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    const requestId = put.json().pending as string;

    // The sensitive edit T-0010's transaction would perform, between filing and
    // approval: the revision advances under the same identity.
    await t.prisma.connectionProvider.update({
      where: { id: provider.id },
      data: { revision: 3 },
    });

    const approve = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.code).toBe("conflict");
    expect(approve.json().error.message).toMatch(/provider changed after this request was filed/);

    // Approves nothing: no capability write, no decision, request stays pending.
    expect(await manifestOrigins(slug)).toEqual([]);
    const row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(
      await t.prisma.auditEvent.findMany({
        where: { appId: row.appId, action: "approval.approve" },
      }),
    ).toEqual([]);

    // The owner's resubmission path: a fresh save files a fresh stamp, which approves.
    const refiled = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    expect(refiled.statusCode).toBe(200);
    const approved = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${refiled.json().pending}/approve`,
      headers: admin,
    });
    expect(approved.statusCode).toBe(200);
    expect(await manifestOrigins(slug)).toEqual([
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
  });

  it("409s an approval after the provider row was deleted", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`);
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    const requestId = put.json().pending as string;

    await t.prisma.connectionProvider.delete({ where: { id: provider.id } });

    const approve = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
    expect(approve.statusCode).toBe(409);
    expect(approve.json().error.code).toBe("conflict");
    expect(await manifestOrigins(slug)).toEqual([]);
    expect((await requestRow(requestId)).status).toBe("pending");
  });

  it("approves a request whose stamps still match — and the binding lands", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`);
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    const approve = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${put.json().pending}/approve`,
      headers: admin,
    });
    expect(approve.statusCode).toBe(200);
    expect(approve.json().status).toBe("approved");
    expect(await manifestOrigins(slug)).toEqual([
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
  });

  it("still denies and withdraws a stale-stamped request (only approval is gated)", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`);
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    const requestId = put.json().pending as string;
    await t.prisma.connectionProvider.update({
      where: { id: provider.id },
      data: { revision: 9 },
    });

    const deny = await t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/deny`,
      headers: admin,
      payload: { note: "obsolete" },
    });
    expect(deny.statusCode).toBe(200);
    expect(deny.json().status).toBe("denied");
    expect(await manifestOrigins(slug)).toEqual([]);
  });
});

describe("the re-stamp amendment (resubmitting a stale binding)", () => {
  /** Approve a pending request as the admin. */
  async function approve(requestId: string) {
    return t.app.inject({
      method: "POST",
      url: `/api/v1/approvals/${requestId}/approve`,
      headers: admin,
    });
  }

  /** The manifest read's per-binding effectiveness (the SPA's badge data). */
  async function bindingStatuses(
    slug: string,
  ): Promise<{ origin: string; ref: string; effective: boolean }[]> {
    const manifest = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: owner,
    });
    return manifest.json().providerBindings ?? [];
  }

  it("an unchanged resave of a stale binding re-elevates it: fresh stamp, high risk, approval repairs the binding", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`);
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    const approved = await approve(put.json().pending as string);
    expect(approved.statusCode).toBe(200);
    expect(await bindingStatuses(slug)).toEqual([
      { origin: "https://api.asana.com", ref: provider.ref, effective: true },
    ]);

    // The sensitive edit T-0010's route performs: the revision advances under
    // the same identity, staling the landed binding (criterion 18's stamp).
    await t.prisma.connectionProvider.update({
      where: { id: provider.id },
      data: { revision: 7 },
    });
    expect(await bindingStatuses(slug)).toEqual([
      { origin: "https://api.asana.com", ref: provider.ref, effective: false },
    ]);

    // The SPA's "save the manifest to resubmit" — an UNCHANGED manifest PUT —
    // must file the recovery: a pending request re-adding the binding against
    // the new revision.
    const resave = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    expect(resave.statusCode).toBe(200);
    const requestId = resave.json().pending;
    expect(requestId).toBeTruthy();
    const row = await requestRow(requestId);
    expect(row.status).toBe("pending");
    expect(row.risk).toBe("high");
    const deltas = row.deltas as { path: string; providerStamps: unknown[] }[];
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.path).toBe(`fetch.origins[+https://api.asana.com→provider:${provider.ref}]`);
    expect(deltas[0]!.providerStamps).toEqual([
      { ref: provider.ref, env: "prod", providerId: provider.id, revision: 7 },
    ]);

    // The binding is not duplicated while the request pends: effective state
    // still holds the origin exactly once.
    expect(await manifestOrigins(slug)).toEqual([
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);

    // Approving the re-add applies idempotently — once, and effective again.
    const repaired = await approve(requestId);
    expect(repaired.statusCode).toBe(200);
    expect(await manifestOrigins(slug)).toEqual([
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    expect(await bindingStatuses(slug)).toEqual([
      { origin: "https://api.asana.com", ref: provider.ref, effective: true },
    ]);
  });

  it("a resave whose bindings are all effective files nothing (a no-op save stays a no-op)", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`);
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    expect((await approve(put.json().pending as string)).statusCode).toBe(200);

    const resave = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    expect(resave.statusCode).toBe(200);
    expect(resave.json().pending).toBeNull();
    expect(await t.prisma.approvalRequest.count({ where: { app: { slug } } })).toBe(1);
  });

  it("removing a stale binding stays baseline — the drop commits now and re-elevates nothing", async () => {
    const { slug } = await createApp();
    const provider = await seedProvider(`pb-${randomUUID().slice(0, 8)}`);
    const put = await putManifest(slug, [
      { origin: "https://api.asana.com", provider: provider.ref },
    ]);
    expect((await approve(put.json().pending as string)).statusCode).toBe(200);
    await t.prisma.connectionProvider.update({
      where: { id: provider.id },
      data: { revision: 4 },
    });

    const dropped = await putManifest(slug, []);
    expect(dropped.statusCode).toBe(200);
    expect(dropped.json().pending).toBeNull();
    expect(await manifestOrigins(slug)).toEqual([]);
  });
});
