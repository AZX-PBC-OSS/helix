import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authHeader, buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

async function createApp(): Promise<string> {
  const slug = uniqueSlug();
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: "Demo" },
  });
  expect(res.statusCode).toBe(201);
  return slug;
}

const enable = (slug: string) =>
  t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/access/password`,
    headers: authHeader(),
  });

const rotate = (slug: string, payload?: Record<string, unknown>) =>
  t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/access/password/rotate`,
    headers: authHeader(),
    payload: payload ?? {},
  });

const getCredential = (slug: string) =>
  t.app.inject({
    method: "GET",
    url: `/api/v1/apps/${slug}/access/password`,
    headers: authHeader(),
  });

const disable = (slug: string) =>
  t.app.inject({
    method: "DELETE",
    url: `/api/v1/apps/${slug}/access/password`,
    headers: authHeader(),
  });

describe("POST /api/v1/apps/:slug/access/password (enable)", () => {
  it("flips visibility to password and returns a hyphenated passphrase + url", async () => {
    const slug = await createApp();
    const res = await enable(slug);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.password.split("-").length).toBeGreaterThanOrEqual(4);
    expect(body.url).toContain(`${slug}.`);
    expect(typeof body.setAt).toBe("string");

    const app = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
    });
    expect(app.json().visibility).toEqual({ mode: "password" });
  });

  it("is idempotent — re-enabling returns the same credential", async () => {
    const slug = await createApp();
    const first = (await enable(slug)).json();
    const second = (await enable(slug)).json();
    expect(second.password).toBe(first.password);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const slug = await createApp();
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/access/password`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST .../rotate", () => {
  it("rerolls a fresh passphrase", async () => {
    const slug = await createApp();
    const before = (await enable(slug)).json().password;
    const after = (await rotate(slug)).json().password;
    expect(after).not.toBe(before);
    expect((await getCredential(slug)).json().password).toBe(after);
  });

  it("accepts a manual password of sufficient length", async () => {
    const slug = await createApp();
    await enable(slug);
    const res = await rotate(slug, { password: "my-manual-passphrase" });
    expect(res.statusCode).toBe(200);
    expect(res.json().password).toBe("my-manual-passphrase");
  });

  it("rejects a too-short manual password (400)", async () => {
    const slug = await createApp();
    await enable(slug);
    const res = await rotate(slug, { password: "short" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("409s when password access is not enabled", async () => {
    const slug = await createApp();
    const res = await rotate(slug);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("conflict");
  });
});

describe("GET .../password (re-display)", () => {
  it("returns the current cleartext credential", async () => {
    const slug = await createApp();
    const created = (await enable(slug)).json().password;
    const res = await getCredential(slug);
    expect(res.statusCode).toBe(200);
    expect(res.json().password).toBe(created);
  });

  it("requires authentication (401)", async () => {
    const slug = await createApp();
    await enable(slug);
    const res = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/access/password`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("404s when not enabled", async () => {
    const slug = await createApp();
    expect((await getCredential(slug)).statusCode).toBe(404);
  });
});

describe("DELETE .../password (disable)", () => {
  it("reverts to private and wipes the credential", async () => {
    const slug = await createApp();
    await enable(slug);
    const res = await disable(slug);
    expect(res.statusCode).toBe(204);

    const app = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
    });
    expect(app.json().visibility).toEqual({ mode: "private" });
    expect((await getCredential(slug)).statusCode).toBe(404);
  });

  it("is idempotent on a non-password app (204)", async () => {
    const slug = await createApp();
    expect((await disable(slug)).statusCode).toBe(204);
  });
});

describe("operator policy: PORTAL_ALLOW_PASSWORD_APPS=false", () => {
  async function withPasswordDisallowed(fn: () => Promise<void>): Promise<void> {
    const prev = process.env.PORTAL_ALLOW_PASSWORD_APPS;
    process.env.PORTAL_ALLOW_PASSWORD_APPS = "false";
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.PORTAL_ALLOW_PASSWORD_APPS;
      else process.env.PORTAL_ALLOW_PASSWORD_APPS = prev;
    }
  }

  it("refuses enable and rotate with 403 (moves into the disallowed mode)", async () => {
    const slug = await createApp();
    await withPasswordDisallowed(async () => {
      const en = await enable(slug);
      expect(en.statusCode).toBe(403);
      expect(en.json().error.code).toBe("forbidden");
      const ro = await rotate(slug);
      expect(ro.statusCode).toBe(403);
    });
  });

  it("still allows disabling an existing password app so it can migrate to private", async () => {
    const slug = await createApp();
    await enable(slug); // enabled while still permitted
    await withPasswordDisallowed(async () => {
      // Re-enabling is refused, but the migration-away path stays open.
      expect((await enable(slug)).statusCode).toBe(403);
      expect((await disable(slug)).statusCode).toBe(204);
    });
    const app = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
    });
    expect(app.json().visibility).toEqual({ mode: "private" });
  });
});

describe("the credential never leaks through registry reads", () => {
  it("is absent from GET /apps/:slug and the manifest", async () => {
    const slug = await createApp();
    const secret = (await enable(slug)).json().password;
    const app = (
      await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}`,
        headers: authHeader(),
      })
    ).body;
    const manifest = (
      await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      })
    ).body;
    // The cleartext credential and the storage columns never appear; note
    // "password" itself legitimately shows up as the visibility mode value.
    for (const needle of [secret, "passwordEnc", "passwordHash", "passwordSalt"]) {
      expect(app).not.toContain(needle);
      expect(manifest).not.toContain(needle);
    }
    expect(JSON.parse(app).visibility).toEqual({ mode: "password" });
  });
});
