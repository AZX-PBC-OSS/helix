import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

function createApp(slug: string) {
  return t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: slug },
  });
}

async function upload(slug: string, buf: Buffer, withAuth = true) {
  const { payload, headers } = multipartBundle(buf);
  return t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/versions`,
    headers: withAuth ? { ...authHeader(), ...headers } : headers,
    payload,
  });
}

const simpleBundle = () =>
  buildZipBuffer([
    { name: "index.html", content: "<!doctype html><body>hi</body>" },
    { name: "app.js", content: "console.log(1)" },
  ]);

describe("POST /api/v1/apps/:slug/versions", () => {
  it("uploads a bundle as preview v1 and stores its blobs", async () => {
    const slug = uniqueSlug();
    await createApp(slug);

    const res = await upload(slug, await simpleBundle());
    expect(res.statusCode).toBe(201);
    const { version, warnings } = res.json();

    expect(version.number).toBe(1);
    expect(version.status).toBe("preview");
    expect(version.blobPrefix).toMatch(/\/1\/$/);
    expect(warnings).toEqual([]);

    expect(t.blob.keysUnder(version.blobPrefix)).toEqual([
      `${version.blobPrefix}app.js`,
      `${version.blobPrefix}index.html`,
    ]);
    expect(t.blob.objects.get(`${version.blobPrefix}index.html`)?.contentType).toBe(
      "text/html; charset=utf-8",
    );
  });

  it("assigns monotonic per-app version numbers", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    const first = await upload(slug, await simpleBundle());
    const second = await upload(slug, await simpleBundle());
    expect(first.json().version.number).toBe(1);
    expect(second.json().version.number).toBe(2);
  });

  it("returns CSP warnings without failing the deploy", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    const zip = await buildZipBuffer([
      { name: "index.html", content: `<script src="https://evil.example.com/x.js"></script>` },
    ]);
    const res = await upload(slug, zip);
    expect(res.statusCode).toBe(201);
    expect(res.json().warnings.length).toBeGreaterThan(0);
  });

  it("rejects an invalid bundle (400 bundle_invalid) and writes no version", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    const res = await upload(slug, await buildZipBuffer([{ name: "evil.sh", content: "x" }]));
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("bundle_invalid");

    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/versions`,
      headers: authHeader(),
    });
    expect(list.json()).toEqual([]);
  });

  it("adds a layout diagnosis without hiding a security-relevant rejection reason", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    // A symlink (a hard security rejection) inside a project-root-shaped archive
    // (which the planner has a layout opinion about). The compose must keep the
    // symlink reason visible and auditable (ADR-0038 #3), not replace it.
    const res = await upload(
      slug,
      await buildZipBuffer([
        { name: "proj/link.html", symlinkTo: "/etc/passwd" },
        { name: "proj/dist/index.html", content: "<h1>hi</h1>" },
        { name: "proj/package.json", content: "{}" },
      ]),
    );
    expect(res.statusCode).toBe(400);
    const { message, details } = res.json().error;
    expect(message).toMatch(/symlinks are not allowed/); // original reason survives
    expect(message).toMatch(/whole project|dist\//); // diagnosis appended
    expect(details.reason).toMatch(/symlinks are not allowed/); // and kept structured
  });

  it("stores a valid deploy report and returns it on the version", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    const report = JSON.stringify({
      plannerVersion: 1,
      outcome: "rerooted",
      root: "dist/",
      fileCount: 2,
      drops: { junk: 3 },
      problems: [],
      candidates: ["dist/", "src/"],
    });
    const { payload, headers } = multipartBundle(
      await simpleBundle(),
      "bundle",
      "bundle.zip",
      report,
    );
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/versions`,
      headers: { ...authHeader(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().version.deployReport).toMatchObject({ outcome: "rerooted", root: "dist/" });
  });

  it("ignores a malformed deploy report rather than failing the deploy", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    const { payload, headers } = multipartBundle(
      await simpleBundle(),
      "bundle",
      "bundle.zip",
      "not json at all",
    );
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/versions`,
      headers: { ...authHeader(), ...headers },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().version.deployReport).toBeUndefined();
  });

  it("rejects an unauthenticated upload (401)", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    const res = await upload(slug, await simpleBundle(), false);
    expect(res.statusCode).toBe(401);
  });

  it("rejects upload and promote on an archived app (409 conflict)", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug, await simpleBundle());
    await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/archive`,
      headers: authHeader(),
    });

    const uploadRes = await upload(slug, await simpleBundle());
    expect(uploadRes.statusCode).toBe(409);
    expect(uploadRes.json().error.code).toBe("conflict");

    const promoteRes = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/versions/1/promote`,
      headers: authHeader(),
    });
    expect(promoteRes.statusCode).toBe(409);

    const rollbackRes = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/rollback`,
      headers: authHeader(),
      payload: {},
    });
    expect(rollbackRes.statusCode).toBe(409);
  });

  it("404s for an unknown app", async () => {
    const res = await upload(uniqueSlug(), await simpleBundle());
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/v1/apps/:slug/versions", () => {
  it("lists versions newest first", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    await upload(slug, await simpleBundle());
    await upload(slug, await simpleBundle());

    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/versions`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((v: { number: number }) => v.number)).toEqual([2, 1]);
  });

  it("requires sign-in to list versions (401)", async () => {
    const slug = uniqueSlug();
    await createApp(slug);
    const res = await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}/versions` });
    expect(res.statusCode).toBe(401);
  });
});
