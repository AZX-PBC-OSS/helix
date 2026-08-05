import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevEnvelopeSecretStore } from "@azx-pbc/secret-store";
import { authHeader, buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";

/**
 * Connection-secret CRUD (secrets design §5): app-scoped (owner) and global
 * (admin), write-only/rotate-only, sealed by the store and never re-displayed.
 * The dev token carries the admin group (PORTAL_DEV_ACTOR_GROUPS) so it can
 * drive both families.
 */

let t: TestApp;
// A real envelope store under a throwaway key — proves seal/never-return without
// asserting the on-disk ciphertext (which the store owns).
const store = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });

beforeAll(async () => {
  t = buildTestApp({ secretStore: store });
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

describe("app-scoped secrets", () => {
  it("creates, lists, rotates, and deletes — never returning the value", async () => {
    const slug = await createApp();
    const create = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
      payload: { name: "github-pat", value: "ghp_topsecret" },
    });
    expect(create.statusCode).toBe(201);
    const meta = create.json();
    expect(meta).toMatchObject({
      name: "github-pat",
      scope: "app",
      injection: { kind: "header-bearer" },
    });
    expect(JSON.stringify(meta)).not.toContain("ghp_topsecret"); // write-only

    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    expect(list.json()).toHaveLength(1);

    const rotate = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/github-pat/rotate`,
      headers: authHeader(),
      payload: { value: "ghp_rotated" },
    });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json().rotatedAt).not.toBeNull();

    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/github-pat`,
      headers: authHeader(),
    });
    expect(del.statusCode).toBe(204);
    const after = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    expect(after.json()).toHaveLength(0);
  });

  it("rejects a duplicate name for the same app", async () => {
    const slug = await createApp();
    const body = { name: "dupe", value: "v1" };
    expect((await post(`/api/v1/apps/${slug}/secrets`, body)).statusCode).toBe(201);
    const dup = await post(`/api/v1/apps/${slug}/secrets`, { name: "dupe", value: "v2" });
    expect(dup.statusCode).toBe(409);
  });

  it("keeps prod and dev tiers of the same name isolated (dev-mode §6)", async () => {
    const slug = await createApp();
    // Same name, two tiers — allowed (uniqueness is per-env).
    expect(
      (await post(`/api/v1/apps/${slug}/secrets`, { name: "conn", value: "PROD" })).statusCode,
    ).toBe(201);
    const devCreate = await post(`/api/v1/apps/${slug}/secrets`, {
      name: "conn",
      value: "DEV",
      env: "dev",
    });
    expect(devCreate.statusCode).toBe(201);
    expect(devCreate.json().env).toBe("dev");

    // List shows both tiers, each tagged.
    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    const envs = (list.json() as { env: string }[]).map((s) => s.env).sort();
    expect(envs).toEqual(["dev", "prod"]);

    // Rotating ?env=dev touches only the dev row; a plain (prod) rotate is separate.
    const rotDev = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/conn/rotate?env=dev`,
      headers: authHeader(),
      payload: { value: "DEV2" },
    });
    expect(rotDev.statusCode).toBe(200);
    expect(rotDev.json().env).toBe("dev");

    // Deleting ?env=dev removes only the dev row — the prod one survives.
    const delDev = await t.app.inject({
      method: "DELETE",
      url: `/api/v1/apps/${slug}/secrets/conn?env=dev`,
      headers: authHeader(),
    });
    expect(delDev.statusCode).toBe(204);
    const after = (
      await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/secrets`,
        headers: authHeader(),
      })
    ).json() as { name: string; env: string }[];
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ name: "conn", env: "prod" });
  });
});

describe("global secrets + grants", () => {
  it("creates a global secret and grants it to an app", async () => {
    const slug = await createApp();
    const create = await post("/api/v1/secrets", { name: uniqueSlug("g"), value: "sk_live" });
    expect(create.statusCode).toBe(201);
    const id = create.json().id;

    const grant = await post(`/api/v1/secrets/${id}/grants`, { appSlug: slug });
    expect(grant.statusCode).toBe(201);

    const list = await t.app.inject({
      method: "GET",
      url: "/api/v1/secrets",
      headers: authHeader(),
    });
    const found = list.json().find((s: { id: string }) => s.id === id);
    expect(found.boundApps).toContain(slug);
  });

  it("rejects a duplicate global name", async () => {
    const name = uniqueSlug("g");
    expect((await post("/api/v1/secrets", { name, value: "a" })).statusCode).toBe(201);
    expect((await post("/api/v1/secrets", { name, value: "b" })).statusCode).toBe(409);
  });
});

describe("platform secrets (vendor keys, e.g. the LLM key)", () => {
  it("creates a platform secret, lists + rotates it, but never grants it", async () => {
    const slug = await createApp();
    const name = uniqueSlug("p");
    const create = await post("/api/v1/secrets", {
      name,
      value: "sk-ant-topsecret",
      scope: "platform",
      injection: { kind: "header", name: "x-api-key" },
    });
    expect(create.statusCode).toBe(201);
    const meta = create.json();
    expect(meta).toMatchObject({ scope: "platform", name });
    expect(JSON.stringify(meta)).not.toContain("sk-ant-topsecret"); // write-only

    // It shows up in the admin list (alongside global secrets).
    const list = await t.app.inject({
      method: "GET",
      url: "/api/v1/secrets",
      headers: authHeader(),
    });
    expect(list.json().find((s: { id: string }) => s.id === meta.id)).toBeDefined();

    // Rotation works.
    const rotate = await post(`/api/v1/secrets/${meta.id}/rotate`, { value: "sk-ant-rotated" });
    expect(rotate.statusCode).toBe(200);
    expect(rotate.json().rotatedAt).not.toBeNull();

    // A platform secret is NOT grantable — the grant route is global-only, so the
    // platform id isn't found there. This is the control that keeps the vendor key
    // off the app fetch path; egress resolves it only for the `llm` capability.
    const grant = await post(`/api/v1/secrets/${meta.id}/grants`, { appSlug: slug });
    expect(grant.statusCode).toBe(404);
  });

  it("rejects a duplicate platform name", async () => {
    const name = uniqueSlug("p");
    const body = { name, value: "a", scope: "platform" };
    expect((await post("/api/v1/secrets", body)).statusCode).toBe(201);
    expect(
      (await post("/api/v1/secrets", { name, value: "b", scope: "platform" })).statusCode,
    ).toBe(409);
  });
});

async function post(url: string, payload: Record<string, unknown>) {
  return t.app.inject({ method: "POST", url, headers: authHeader(), payload });
}

/**
 * Against the dev store `destroy()` is a no-op and can't fail. Against Key Vault
 * it is a network call, and a swallowed failure strands a live vault entry still
 * holding the old credential — the exact leak `destroy()` exists to prevent
 * (ADR-0006). The request must still succeed (the row is already written), but
 * the failure has to land somewhere an operator will see it.
 */
describe("a failed destroy is reported, not swallowed", () => {
  let f: TestApp;

  beforeAll(async () => {
    const failing = new DevEnvelopeSecretStore({ masterKey: randomBytes(32) });
    failing.destroy = async () => {
      throw new Error("vault delete denied");
    };
    f = buildTestApp({ secretStore: failing });
    await f.app.ready();
  });
  afterAll(async () => {
    await f.close();
  });

  it("still rotates, and records secret.destroy_failed", async () => {
    const slug = uniqueSlug();
    const created = await f.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: { slug, displayName: "Demo" },
    });
    expect(created.statusCode).toBe(201);

    await f.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
      payload: { name: "conn", value: "v1" },
    });
    const rotate = await f.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/conn/rotate`,
      headers: authHeader(),
      payload: { value: "v2" },
    });
    // The row already points at the new value; failing the request would be worse.
    expect(rotate.statusCode).toBe(200);

    const appRow = await f.prisma.app.findUnique({ where: { slug } });
    const events = await f.prisma.auditEvent.findMany({
      where: { appId: appRow?.id, action: "secret.destroy_failed" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ name: "conn", reason: "rotate" });
  });
});

/**
 * `seal()` writes to the vault *before* the DB row exists, so every path from seal to a
 * committed row is a window in which a failure strands a live, unreferenced credential —
 * under a deliberately opaque random name, unpurgeable for 90 days under purge protection.
 *
 * This is invisible under the dev envelope (`destroy()` is a no-op and `material` is the
 * ciphertext in the row, so there is nothing to orphan), so it needs a store that actually
 * tracks entries. The invariant asserted throughout: **the vault holds no entry the
 * database doesn't reference.**
 */
describe("no path strands an unreferenced vault entry", () => {
  /**
   * A dev store that also keeps a set of live "vault" entries, keyed by material, plus
   * a gate so a `seal()` can be stalled — the only way to force two rotations to both
   * read the row before either writes, which is the interleaving the CAS exists for.
   * Left to `Promise.all` alone the two requests serialize and both legitimately succeed.
   */
  class TrackingStore extends DevEnvelopeSecretStore {
    readonly live = new Set<string>();
    readonly sealed = new Set<string>();
    stallNext: Promise<void> | null = null;
    onStall: (() => void) | null = null;
    override async seal(value: string): Promise<string> {
      const stall = this.stallNext;
      if (stall) {
        this.stallNext = null;
        this.onStall?.();
        this.onStall = null;
        await stall;
      }
      const material = await super.seal(value);
      this.live.add(material);
      this.sealed.add(material);
      return material;
    }
    override async destroy(material: string): Promise<void> {
      this.live.delete(material);
    }
  }

  let t2: TestApp;
  let vault: TrackingStore;

  beforeAll(async () => {
    vault = new TrackingStore({ masterKey: randomBytes(32) });
    t2 = buildTestApp({ secretStore: vault });
    await t2.app.ready();
  });
  afterAll(async () => {
    await t2.close();
  });

  const inject = (method: "POST" | "DELETE", url: string, payload?: Record<string, unknown>) =>
    t2.app.inject({ method, url, headers: authHeader(), payload });

  /**
   * Materials the DB references. The test database is shared, so this is scoped to what
   * *this* store minted — rows from other suites are sealed by other store instances.
   */
  async function referenced(): Promise<Set<string>> {
    const rows = await t2.prisma.appSecret.findMany({ select: { material: true } });
    return new Set(rows.map((r) => r.material).filter((m) => vault.sealed.has(m)));
  }

  /** The invariant: the vault holds no entry the database doesn't reference. */
  async function expectNoOrphans(): Promise<void> {
    const refs = await referenced();
    expect([...vault.live].filter((m) => !refs.has(m))).toEqual([]);
  }

  it("releases the sealed material when an admin create loses the uniqueness race", async () => {
    const name = uniqueSlug("g");
    expect((await inject("POST", "/api/v1/secrets", { name, value: "a" })).statusCode).toBe(201);

    // Bypass the route's non-atomic pre-check to hit the partial unique index directly —
    // this is what two concurrent admin POSTs collide on.
    const dup = await inject("POST", "/api/v1/secrets", { name, value: "b" });
    expect(dup.statusCode).toBe(409);
    await expectNoOrphans();
  });

  it("releases the sealed material when the DB write fails outright", async () => {
    const slug = uniqueSlug();
    expect((await inject("POST", "/api/v1/apps", { slug, displayName: "Demo" })).statusCode).toBe(
      201,
    );
    expect(
      (await inject("POST", `/api/v1/apps/${slug}/secrets`, { name: "conn", value: "v1" }))
        .statusCode,
    ).toBe(201);
    // Same (appId, env, name) → unique violation on the app-scoped index.
    expect(
      (await inject("POST", `/api/v1/apps/${slug}/secrets`, { name: "conn", value: "v2" }))
        .statusCode,
    ).toBe(409);
    await expectNoOrphans();
  });

  it("releases the loser's material when two rotations race", async () => {
    const slug = uniqueSlug();
    await inject("POST", "/api/v1/apps", { slug, displayName: "Demo" });
    await inject("POST", `/api/v1/apps/${slug}/secrets`, { name: "conn", value: "v1" });

    // Stall A's seal so B runs to completion in between. Both requests then hold the
    // same pre-rotation material, which is the state a plain `update` resolves as
    // last-write-wins — leaving the loser's fresh vault entry live and unreferenced.
    let release!: () => void;
    let entered!: () => void;
    const stalled = new Promise<void>((r) => {
      entered = r;
    });
    vault.stallNext = new Promise<void>((r) => {
      release = r;
    });
    vault.onStall = entered;

    // The async IIFE matters: `inject()` is chainable and light-my-request defers the
    // actual dispatch until something calls `.then()`, so a bare `const a = inject(…)`
    // never runs and the two requests deadlock on the gate.
    const a = (async () =>
      inject("POST", `/api/v1/apps/${slug}/secrets/conn/rotate`, {
        value: "v2",
      }))();
    await stalled; // A has read the row and is now parked inside seal()
    const b = await inject("POST", `/api/v1/apps/${slug}/secrets/conn/rotate`, { value: "v3" });
    release();

    expect(b.statusCode).toBe(200); // B read and wrote while A was stalled
    expect((await a).statusCode).toBe(409); // A's compare-and-swap finds the row moved
    await expectNoOrphans(); // …and A released the material it had already sealed
  });

  it("leaves no orphan and no dead reference across the whole suite", async () => {
    const refs = await referenced();
    // Nothing live-but-unreferenced (an orphan)…
    expect([...vault.live].filter((m) => !refs.has(m))).toEqual([]);
    // …and nothing referenced-but-released (a row pointing at a destroyed entry).
    expect([...refs].filter((m) => !vault.live.has(m))).toEqual([]);
  });
});

describe("recipe⇄material validation", () => {
  const PRIVATE = "ghp_LIVEPRIVATEKEY_abcdefghijklmnop";
  const BLOB = JSON.stringify({ credential: "pub-abc", key: PRIVATE });
  const HMAC = {
    kind: "hmac-timestamp",
    timestampHeader: "x-date",
    template: "Credential={credential},Signature={signature}",
  };

  async function post(slug: string, payload: Record<string, unknown>) {
    return await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
      payload,
    });
  }

  it("creates an hmac-timestamp secret, defaulting authHeader and leaking neither half", async () => {
    const slug = await createApp();
    const res = await post(slug, { name: "signed", value: BLOB, injection: HMAC });
    expect(res.statusCode).toBe(201);
    expect(res.json().injection).toEqual({ ...HMAC, authHeader: "authorization" });
    // Write-only applies to both halves — the public credential is inside the
    // sealed value, so metadata can show neither.
    expect(res.payload).not.toContain(PRIVATE);
    expect(res.payload).not.toContain("pub-abc");
  });

  it.each([
    ["a bare token where a blob is required", PRIVATE],
    ["JSON missing the key half", JSON.stringify({ credential: "pub" })],
    ["JSON missing the credential half", JSON.stringify({ key: "priv" })],
  ])("rejects %s with a 400 and creates nothing", async (_label, value) => {
    const slug = await createApp();
    const res = await post(slug, { name: "signed", value, injection: HMAC });
    expect(res.statusCode).toBe(400);
    // The 400 must not echo the credential it refused.
    expect(res.payload).not.toContain(value.slice(0, 10));
    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    expect(list.json()).toEqual([]);
  });

  // The quiet, dangerous direction: a static recipe presents the material
  // verbatim, so a blob would send the PRIVATE half to the vendor in cleartext.
  it("refuses an hmac blob stored under a header-bearer recipe", async () => {
    const slug = await createApp();
    const res = await post(slug, { name: "confused", value: BLOB });
    expect(res.statusCode).toBe(400);
  });

  /**
   * The one behaviour with no compile-time guard. The recipe is immutable but the
   * material is not, so rotation is where they drift — and without the rotate-side
   * check this returns 200 and silently installs a credential that can never
   * authenticate (or, in the reverse direction, leaks the private half upstream).
   */
  it("validates on rotate too, leaving the old material in place on refusal", async () => {
    const slug = await createApp();
    expect((await post(slug, { name: "signed", value: BLOB, injection: HMAC })).statusCode).toBe(
      201,
    );

    const bad = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/signed/rotate`,
      headers: authHeader(),
      payload: { value: "plain-token-not-a-blob" },
    });
    expect(bad.statusCode).toBe(400);

    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    expect(list.json()[0].rotatedAt).toBeNull();

    const good = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/signed/rotate`,
      headers: authHeader(),
      payload: { value: JSON.stringify({ credential: "pub-2", key: "priv-2" }) },
    });
    expect(good.statusCode).toBe(200);
    expect(good.json().rotatedAt).not.toBeNull();
  });

  // Recipe-scoped, not a new global constraint: a static recipe still takes any
  // opaque string, including JSON that isn't a credential blob.
  it("leaves a header-bearer rotation to an arbitrary string alone", async () => {
    const slug = await createApp();
    expect((await post(slug, { name: "plain", value: "sk_live_1" })).statusCode).toBe(201);
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/plain/rotate`,
      headers: authHeader(),
      payload: { value: '{"note":"still just a string to us"}' },
    });
    expect(res.statusCode).toBe(200);
  });

  it("applies the same validation on the admin create path", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/secrets",
      headers: authHeader(),
      payload: { name: uniqueSlug(), value: PRIVATE, scope: "global", injection: HMAC },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("an unreadable stored recipe degrades one row, not the response", () => {
  /**
   * `app_secrets.injection` is schemaless JSON re-parsed on every read, so a row
   * written before a constraint existed can fail to parse. It used to throw out of
   * `toMetadata` and fail the *whole list* — and the admin query returns `global`
   * and `platform` together, so one bad platform row (the LLM vendor key) hid
   * every global secret, reported as a 400 no 5xx alerting would see.
   *
   * `host` is the poison here on purpose: it is a *security* violation, so even
   * the lenient stored parser refuses it. Hygiene violations are tolerated and
   * come back parsed (asserted separately below).
   */
  async function poison(id: string, injection: unknown): Promise<void> {
    await t.prisma.appSecret.update({
      where: { id },
      data: { injection: injection as never },
    });
  }

  it("lists healthy admin secrets alongside a poisoned one", async () => {
    const good = await t.app.inject({
      method: "POST",
      url: "/api/v1/secrets",
      headers: authHeader(),
      payload: { name: uniqueSlug(), value: "sk_good", scope: "global" },
    });
    expect(good.statusCode).toBe(201);
    const bad = await t.app.inject({
      method: "POST",
      url: "/api/v1/secrets",
      headers: authHeader(),
      payload: { name: uniqueSlug(), value: "sk_bad", scope: "platform" },
    });
    expect(bad.statusCode).toBe(201);
    await poison(bad.json().id, { kind: "header", name: "host" });

    const list = await t.app.inject({
      method: "GET",
      url: "/api/v1/secrets",
      headers: authHeader(),
    });
    expect(list.statusCode).toBe(200);
    const rows = list.json() as Array<{ id: string; injection: unknown }>;
    expect(rows.find((r) => r.id === bad.json().id)?.injection).toBeNull();
    expect(rows.find((r) => r.id === good.json().id)?.injection).toEqual({
      kind: "header-bearer",
    });
  });

  it("lists app-scoped secrets the same way", async () => {
    const slug = await createApp();
    const created = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
      payload: { name: "poisoned", value: "sk_1" },
    });
    await poison(created.json().id, { kind: "header", name: "host" });
    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0].injection).toBeNull();
  });

  // A hygiene violation is *not* an unreadable row — it parses, normalised. Such
  // a row was already dead on the wire (undici rejects the header name), so
  // failing the read would have converted a contained 502 into a broken page.
  it("keeps a legacy hygiene-violating row readable and rotatable", async () => {
    const slug = await createApp();
    const created = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
      payload: { name: "legacy", value: "sk_1" },
    });
    await poison(created.json().id, { kind: "header", name: "X Api Key", template: "{}" });

    const list = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/secrets`,
      headers: authHeader(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()[0].injection).toEqual({ kind: "header", name: "x api key", template: "{}" });

    // Rotation restores control of the *credential*. It does not repair the
    // recipe — that is immutable, so the row stays broken on the wire.
    const rot = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/secrets/legacy/rotate`,
      headers: authHeader(),
      payload: { value: "sk_2" },
    });
    expect(rot.statusCode).toBe(200);
    expect(rot.json().injection).toEqual({ kind: "header", name: "x api key", template: "{}" });
  });

  it.each([
    ["app-scoped", true],
    ["admin", false],
  ])(
    "refuses to rotate a security-violating row (%s), but allows delete",
    async (_l, appScoped) => {
      const slug = await createApp();
      const created = appScoped
        ? await t.app.inject({
            method: "POST",
            url: `/api/v1/apps/${slug}/secrets`,
            headers: authHeader(),
            payload: { name: "poisoned", value: "sk_1" },
          })
        : await t.app.inject({
            method: "POST",
            url: "/api/v1/secrets",
            headers: authHeader(),
            payload: { name: uniqueSlug(), value: "sk_1", scope: "global" },
          });
      const id = created.json().id as string;
      await poison(id, { kind: "header", name: "host" });

      const rotateUrl = appScoped
        ? `/api/v1/apps/${slug}/secrets/poisoned/rotate`
        : `/api/v1/secrets/${id}/rotate`;
      const rot = await t.app.inject({
        method: "POST",
        url: rotateUrl,
        headers: authHeader(),
        payload: { value: "sk_2" },
      });
      expect(rot.statusCode).toBe(409);

      // Delete is the documented recovery and must still work.
      const del = await t.app.inject({
        method: "DELETE",
        url: appScoped ? `/api/v1/apps/${slug}/secrets/poisoned` : `/api/v1/secrets/${id}`,
        headers: authHeader(),
      });
      expect(del.statusCode).toBe(204);
    },
  );
});
