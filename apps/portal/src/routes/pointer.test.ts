import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Version } from "@helix/shared";
import {
  authHeader,
  buildTestApp,
  multipartBundle,
  uniqueSlug,
  type TestApp,
} from "../test/harness.js";
import { buildZipBuffer } from "../test/zip.js";

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

async function createApp(slug: string) {
  await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: slug },
  });
}

async function upload(slug: string) {
  const { payload, headers } = multipartBundle(
    await buildZipBuffer([{ name: "index.html", content: "<html></html>" }]),
  );
  return t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/versions`,
    headers: { ...authHeader(), ...headers },
    payload,
  });
}

async function listVersions(slug: string): Promise<Version[]> {
  const res = await t.app.inject({
    method: "GET",
    url: `/api/v1/apps/${slug}/versions`,
    headers: authHeader(),
  });
  return res.json();
}

function statusOf(versions: Version[], number: number): string | undefined {
  return versions.find((v) => v.number === number)?.status;
}

function liveCount(versions: Version[]): number {
  return versions.filter((v) => v.status === "live").length;
}

function promote(slug: string, number: number, withAuth = true) {
  return t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/versions/${number}/promote`,
    headers: withAuth ? authHeader() : {},
  });
}

function rollback(slug: string, body?: { toNumber: number }) {
  return t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/rollback`,
    headers: authHeader(),
    payload: body ?? {},
  });
}

describe("promote / rollback lifecycle", () => {
  it("create → upload×2 → promote → promote → rollback keeps exactly one live", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug); // v1
    await upload(slug); // v2

    // Both start as preview.
    expect(liveCount(await listVersions(slug))).toBe(0);

    // Promote v1.
    const p1 = await promote(slug, 1);
    expect(p1.statusCode).toBe(200);
    let versions = await listVersions(slug);
    expect(statusOf(versions, 1)).toBe("live");
    expect(statusOf(versions, 2)).toBe("preview");
    expect(p1.json().currentVersionId).toBe(versions.find((v) => v.number === 1)?.id);

    // Promote v2 — v1 is archived.
    await promote(slug, 2);
    versions = await listVersions(slug);
    expect(statusOf(versions, 2)).toBe("live");
    expect(statusOf(versions, 1)).toBe("archived");
    expect(liveCount(versions)).toBe(1);

    // Rollback (default → most-recent archived = v1).
    const rb = await rollback(slug);
    expect(rb.statusCode).toBe(200);
    versions = await listVersions(slug);
    expect(statusOf(versions, 1)).toBe("live");
    expect(statusOf(versions, 2)).toBe("archived");
    expect(liveCount(versions)).toBe(1);
    expect(rb.json().currentVersionId).toBe(versions.find((v) => v.number === 1)?.id);
  });

  it("promoting an archived version is a 409 (use rollback)", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug);
    await upload(slug);
    await promote(slug, 1);
    await promote(slug, 2); // archives v1

    const res = await promote(slug, 1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
  });

  it("promoting the already-live version is idempotent (200)", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug);
    await promote(slug, 1);
    const res = await promote(slug, 1);
    expect(res.statusCode).toBe(200);
    expect(statusOf(await listVersions(slug), 1)).toBe("live");
  });

  it("rollback to an explicit version number", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug);
    await upload(slug);
    await upload(slug);
    await promote(slug, 1);
    await promote(slug, 3); // live = 3, archived = 1

    const res = await rollback(slug, { toNumber: 1 });
    expect(res.statusCode).toBe(200);
    expect(statusOf(await listVersions(slug), 1)).toBe("live");
  });

  it("rollback with no previous version is a 409", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug);
    await promote(slug, 1);
    const res = await rollback(slug);
    expect(res.statusCode).toBe(409);
  });

  it("promote 404s for an unknown version number", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug);
    const res = await promote(slug, 99);
    expect(res.statusCode).toBe(404);
  });

  it("rejects an unauthenticated promote (401)", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug);
    const res = await promote(slug, 1, false);
    expect(res.statusCode).toBe(401);
  });
});
