import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDevTokenVerifier } from "../auth/verifier.js";
import { withEnv } from "../test/env.js";
import { authHeader, buildTestApp, TEST_TOKEN, uniqueSlug, type TestApp } from "../test/harness.js";

/** `GET/PUT/DELETE /api/v1/apps/:slug/repo-binding` (ADR-0051 decision 2). */

const OTHER_TOKEN = "other-token";
let t: TestApp;

beforeAll(async () => {
  t = buildTestApp({
    auth: {
      verifiers: [
        createDevTokenVerifier(TEST_TOKEN, "dev@azx.io"),
        createDevTokenVerifier(OTHER_TOKEN, "other@azx.io", [], "other-oid"),
      ],
    },
  });
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

async function createApp(): Promise<{ slug: string; appId: string }> {
  const slug = uniqueSlug("rb");
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: slug },
  });
  return { slug, appId: res.json().id };
}

const put = (slug: string, payload: object, token = TEST_TOKEN) =>
  t.app.inject({
    method: "PUT",
    url: `/api/v1/apps/${slug}/repo-binding`,
    headers: authHeader(token),
    payload,
  });
const get = (slug: string, token = TEST_TOKEN) =>
  t.app.inject({
    method: "GET",
    url: `/api/v1/apps/${slug}/repo-binding`,
    headers: authHeader(token),
  });
const del = (slug: string, token = TEST_TOKEN) =>
  t.app.inject({
    method: "DELETE",
    url: `/api/v1/apps/${slug}/repo-binding`,
    headers: authHeader(token),
  });

describe("repo binding routes", () => {
  it("creates, reads and audits a binding", async () => {
    const { slug, appId } = await createApp();
    const missing = await get(slug);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.details).toEqual({ reason: "no_binding" });
    const res = await put(slug, { repoFullName: "octo-org/octo-app", branch: "main" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      provider: "github",
      repoFullName: "octo-org/octo-app",
      branch: "main",
    });
    expect(res.json().repositoryId).toBeUndefined();
    expect((await get(slug)).json()).toEqual(res.json());
    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: { appId, action: "app.repo-binding.set" },
    });
    expect(audit.actor).toBe("dev@azx.io");
  });

  it("is owner-only, for reads as well as writes", async () => {
    const { slug } = await createApp();
    await put(slug, { repoFullName: "octo-org/octo-app", branch: "main" });
    expect((await get(slug, OTHER_TOKEN)).statusCode).toBe(403);
    expect(
      (await put(slug, { repoFullName: "evil/x", branch: "main" }, OTHER_TOKEN)).statusCode,
    ).toBe(403);
    expect((await del(slug, OTHER_TOKEN)).statusCode).toBe(403);
  });

  it("clears the pins when the repo changes, and keeps them otherwise", async () => {
    const { slug, appId } = await createApp();
    await put(slug, { repoFullName: "octo-org/octo-app", branch: "main" });
    const pin = () =>
      t.prisma.repoBinding.update({
        where: { appId },
        data: { repositoryId: "1001", repositoryOwnerId: "2002", pinnedAt: new Date() },
      });
    await pin();

    const branchOnly = await put(slug, {
      repoFullName: "Octo-Org/octo-app",
      branch: "release",
      environment: "production",
    });
    expect(branchOnly.json()).toMatchObject({
      repositoryId: "1001",
      branch: "release",
      environment: "production",
    });

    const moved = await put(slug, { repoFullName: "octo-org/other", branch: "release" });
    expect(moved.json().repositoryId).toBeUndefined();
    expect(moved.json().environment).toBeUndefined();
  });

  it.each([
    { repoFullName: "no-slash", branch: "main" },
    { repoFullName: "octo/..", branch: "main" },
    { repoFullName: "-bad/x", branch: "main" },
    { repoFullName: "octo/x", branch: "refs/heads/main" },
    { repoFullName: "octo/x", branch: "has space" },
    { repoFullName: "octo/x", branch: "a..b" },
    { repoFullName: "octo/x", branch: "main", workflowRef: "deploy.yml" },
    { repoFullName: "octo/x", branch: "main", environment: "" },
  ])("rejects %j", async (payload) => {
    const { slug } = await createApp();
    expect((await put(slug, payload)).statusCode).toBe(400);
  });

  it("deletes idempotently", async () => {
    const { slug, appId } = await createApp();
    await put(slug, { repoFullName: "octo-org/octo-app", branch: "main" });
    expect((await del(slug)).statusCode).toBe(204);
    expect((await del(slug)).statusCode).toBe(204);
    expect((await get(slug)).statusCode).toBe(404);
    expect(
      await t.prisma.auditEvent.count({ where: { appId, action: "app.repo-binding.delete" } }),
    ).toBe(1);
  });

  it("refuses to bind an archived app", async () => {
    const { slug, appId } = await createApp();
    await t.prisma.app.update({ where: { id: appId }, data: { archivedAt: new Date() } });
    expect(
      (await put(slug, { repoFullName: "octo-org/octo-app", branch: "main" })).statusCode,
    ).toBe(409);
  });

  it("404s every verb when the feature is off", async () => {
    const { slug } = await createApp();
    await withEnv({ PORTAL_REPO_DEPLOY_ENABLED: "false" }, async () => {
      expect((await get(slug)).statusCode).toBe(404);
      expect((await put(slug, { repoFullName: "octo/x", branch: "main" })).statusCode).toBe(404);
      expect((await del(slug)).statusCode).toBe(404);
    });
  });
});
