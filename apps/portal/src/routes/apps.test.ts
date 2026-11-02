import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PrismaClient } from "../db/client.js";
import {
  authHeader,
  buildTestApp,
  createTestPrisma,
  uniqueSlug,
  type TestApp,
} from "../test/harness.js";
import { SERVING_JOBS_CATALOGUE, withEnv } from "../test/env.js";

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

function createApp(payload: Record<string, unknown>) {
  return t.app.inject({ method: "POST", url: "/api/v1/apps", headers: authHeader(), payload });
}

describe("POST /api/v1/apps", () => {
  it("creates an app (201), defaulting visibility to internal", async () => {
    const slug = uniqueSlug();
    const res = await createApp({ slug, displayName: "My App" });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.slug).toBe(slug);
    expect(body.displayName).toBe("My App");
    expect(body.visibility).toEqual({ mode: "internal" });
    expect(body.currentVersionId).toBeNull();
  });

  it("rejects an unauthenticated request (401)", async () => {
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      payload: { slug: uniqueSlug(), displayName: "X" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("unauthorized");
  });

  it("rejects a duplicate slug (409 slug_taken)", async () => {
    const slug = uniqueSlug();
    expect((await createApp({ slug, displayName: "First" })).statusCode).toBe(201);
    const res = await createApp({ slug, displayName: "Second" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("slug_taken");
  });

  it("rejects a non-DNS-label slug (400 validation_failed)", async () => {
    const res = await createApp({ slug: "Bad Slug", displayName: "X" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("grants an installed jobs type at creation, and refuses an uninstalled one", async () => {
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
      const created = await createApp({
        slug,
        displayName: "Born with jobs",
        capabilities: { jobs: { types: ["jobs:fetch"] } },
      });
      expect(created.statusCode).toBe(201);
      // The create response carries no capability body — read the manifest.
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(got.json().capabilities.jobs).toEqual({ types: ["jobs:fetch"] });
    });

    const uninstalled = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
      const refused = await createApp({
        slug: uninstalled,
        displayName: "Ungrantable",
        capabilities: { jobs: { types: ["jobs:report"] } },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("validation_failed");
    });
    // The refused app does not exist — the refusal precedes any write.
    const got = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${uninstalled}`,
      headers: authHeader(),
    });
    expect(got.statusCode).toBe(404);
  });

  it("refuses a jobs grant at creation while jobs is fully disabled, and creates no app", async () => {
    // The disabled posture is the deployment's live default until the
    // catalogue-source wiring lands: even the production type is ungrantable
    // at birth, because the empty pre-image makes every requested type an
    // addition.
    const slug = uniqueSlug();
    await withEnv({ PORTAL_JOBS_CATALOGUE: undefined }, async () => {
      const refused = await createApp({
        slug,
        displayName: "Born disabled",
        capabilities: { jobs: { types: ["jobs:fetch"] } },
      });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("validation_failed");
      expect(refused.json().error.message).toContain("jobs:fetch");
    });
    const got = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
    });
    expect(got.statusCode).toBe(404);
  });

  it("creates with an optional description and round-trips it on read", async () => {
    const slug = uniqueSlug();
    const created = await createApp({
      slug,
      displayName: "Described",
      description: "Tracks Q3 spend by team.",
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().description).toBe("Tracks Q3 spend by team.");

    const got = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
    });
    expect(got.json().description).toBe("Tracks Q3 spend by team.");
  });

  it("omits the description key entirely when unset", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Undescribed" });
    expect(created.statusCode).toBe(201);
    expect("description" in created.json()).toBe(false);
  });

  it("rejects an over-length description (400 validation_failed)", async () => {
    const res = await createApp({
      slug: uniqueSlug(),
      displayName: "X",
      description: "a".repeat(501),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });
});

describe("PATCH /api/v1/apps/:slug", () => {
  it("sets, edits and clears the description, auditing each real change", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Editable" });

    const set = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
      payload: { description: "First summary." },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().description).toBe("First summary.");

    const edited = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
      payload: { description: "Second summary." },
    });
    expect(edited.json().description).toBe("Second summary.");

    const cleared = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
      payload: { description: null },
    });
    expect(cleared.statusCode).toBe(200);
    // Cleared means omitted on the wire, same as never set.
    expect("description" in cleared.json()).toBe(false);
  });

  it("treats an absent key as no change and a no-op value as no write", async () => {
    const slug = uniqueSlug();
    const created = await createApp({
      slug,
      displayName: "Stable",
      description: "Unchanged.",
    });
    const updatedAt = created.json().updatedAt;

    const empty = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
      payload: {},
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().description).toBe("Unchanged.");

    const same = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
      payload: { description: "Unchanged." },
    });
    expect(same.statusCode).toBe(200);
    // A no-op must not bump `updatedAt` — the record did not change.
    expect(same.json().updatedAt).toBe(updatedAt);
  });

  it("rejects an over-length description (400 validation_failed)", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Capped" });
    const res = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
      payload: { description: "a".repeat(501) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("404s an unknown slug", async () => {
    const res = await t.app.inject({
      method: "PATCH",
      url: `/api/v1/apps/${uniqueSlug()}`,
      headers: authHeader(),
      payload: { description: "x" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("records the changed description in the app.update audit trail", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Audited" });
    const appId = created.json().id;
    await t.app.inject({
      method: "PATCH",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
      payload: { description: "Recorded." },
    });
    const events = await t.prisma.auditEvent.findMany({
      where: { appId, action: "app.update" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toEqual({ description: "Recorded." });
  });
});

describe("POST /api/v1/apps/:slug/archive and /unarchive", () => {
  it("archives and unarchives an app, idempotently, with audit events", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Archivable" });
    expect(created.json().archivedAt).toBeNull();

    const archived = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/archive`,
      headers: authHeader(),
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archivedAt).not.toBeNull();

    // Idempotent: re-archiving keeps the original timestamp.
    const again = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/archive`,
      headers: authHeader(),
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().archivedAt).toBe(archived.json().archivedAt);

    const unarchived = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/unarchive`,
      headers: authHeader(),
    });
    expect(unarchived.statusCode).toBe(200);
    expect(unarchived.json().archivedAt).toBeNull();

    const appId = created.json().id;
    const events = await t.prisma.auditEvent.findMany({ where: { appId } });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("app.archive");
    expect(actions).toContain("app.unarchive");
    // Idempotent re-archive must not have produced a second archive event.
    expect(actions.filter((a) => a === "app.archive")).toHaveLength(1);
  });

  it("requires auth (401) and 404s on unknown slug", async () => {
    const noAuth = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${uniqueSlug()}/archive`,
    });
    expect(noAuth.statusCode).toBe(401);

    const missing = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${uniqueSlug()}/archive`,
      headers: authHeader(),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe("manifest (capabilities) GET/PUT", () => {
  it("stores capabilities at create time and returns them via the manifest", async () => {
    const slug = uniqueSlug();
    await createApp({
      slug,
      displayName: "LLM App",
      capabilities: { llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 } },
    });

    const got = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: authHeader(),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toEqual({
      app: slug,
      visibility: { mode: "internal" },
      capabilities: {
        llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 },
        mcp: [],
        externalOrigins: [],
      },
    });
  });

  it("defaults to the baseline grant set when capabilities are omitted", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Bare" });
    const got = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: authHeader(),
    });
    expect(got.json().capabilities).toEqual({ mcp: [], externalOrigins: [] });
  });

  it("births elevated-shaped grants with no approval request — the create route runs no classifier", async () => {
    // The known gap the create route's comment records: unlike the manifest
    // PUT, creation classifies nothing, so every elevated capability class
    // (an mcp server, a direct-CSP origin, a fetch origin, an over-baseline
    // budget) commits verbatim. This pins the gap's exact shape at the route
    // level — the existing storage test uses an under-baseline grant — so a
    // change here (closing the gap, or gating only part of it) cannot land
    // without touching this test and the marker beside the route together.
    const slug = uniqueSlug();
    const created = await createApp({
      slug,
      displayName: "Born elevated",
      capabilities: {
        mcp: ["pagerduty"],
        externalOrigins: ["https://one.example"],
      },
    });
    expect(created.statusCode).toBe(201);
    const got = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: authHeader(),
    });
    expect(got.json().capabilities.mcp).toEqual(["pagerduty"]);
    expect(got.json().capabilities.externalOrigins).toEqual(["https://one.example"]);
    // No pending request exists for the elevated classes the PUT would queue.
    const reqs = await t.prisma.approvalRequest.findMany({
      where: { appId: created.json().id },
    });
    expect(reqs).toHaveLength(0);
  });

  it("replaces grants via PUT (auth required) and audits the change", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Editable" });

    const noAuth = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      payload: { capabilities: { llm: { models: ["m"] } } },
    });
    expect(noAuth.statusCode).toBe(401);

    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: authHeader(),
      payload: { capabilities: { llm: { models: ["claude-opus-4-8"], dollarsPerDay: 25 } } },
    });
    expect(put.statusCode).toBe(200);
    // Curated model + sub-baseline budget → all baseline, nothing pending.
    expect(put.json().manifest.capabilities.llm).toEqual({
      models: ["claude-opus-4-8"],
      dollarsPerDay: 25,
    });
    expect(put.json().pending).toBeNull();

    const events = await t.prisma.auditEvent.findMany({ where: { appId: created.json().id } });
    expect(events.map((e) => e.action)).toContain("app.manifest.set");
  });

  it("write-gate: commits baseline deltas live but bundles elevated ones into a pending request", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Gated" });

    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/manifest`,
      headers: authHeader(),
      payload: {
        capabilities: {
          // baseline: a data scope grant
          data: { user: true },
          // elevated: an arbitrary MCP server (high risk)
          mcp: ["pagerduty"],
        },
      },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json();
    // The pending part is NOT applied to the live manifest.
    expect(body.manifest.capabilities.mcp).toEqual([]);
    expect(body.manifest.capabilities.data.user).toBe(true);
    expect(typeof body.pending).toBe("string");

    const reqs = await t.prisma.approvalRequest.findMany({ where: { appId: created.json().id } });
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.status).toBe("pending");
    expect(reqs[0]?.risk).toBe("high");

    const events = await t.prisma.auditEvent.findMany({ where: { appId: created.json().id } });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(["app.manifest.set", "approval.request"]),
    );
  });

  it("404s setting a manifest on an unknown slug", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${uniqueSlug()}/manifest`,
      headers: authHeader(),
      payload: { capabilities: { llm: { models: ["m"] } } },
    });
    expect(res.statusCode).toBe(404);
  });

  // The jobs grant rides the existing write-gate: type additions are baseline
  // (nothing queues) and the delta path is the ordinary array-membership one.
  describe("jobs grants (background jobs)", () => {
    const putManifest = (slug: string, capabilities: unknown) =>
      t.app.inject({
        method: "PUT",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
        payload: { capabilities },
      });

    it("adds a qualified type as a baseline change through the real write path", async () => {
      const slug = uniqueSlug();
      const created = await createApp({ slug, displayName: "Jobs App" });
      // The deployment offers the fetch type; the add commits immediately.
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        const put = await putManifest(slug, { jobs: { types: ["jobs:fetch"] } });
        expect(put.statusCode).toBe(200);
        const body = put.json();
        expect(body.pending).toBeNull();
        expect(body.applied.map((d: { path: string }) => d.path)).toEqual([
          "jobs.types[+jobs:fetch]",
        ]);
        expect(body.manifest.capabilities.jobs).toEqual({ types: ["jobs:fetch"] });
      });

      const events = await t.prisma.auditEvent.findMany({ where: { appId: created.json().id } });
      expect(events.map((e: { action: string }) => e.action)).toContain("app.manifest.set");
    });

    it("refuses a type no serving server installs, and a grant while jobs is fully disabled", async () => {
      const slug = uniqueSlug();
      await createApp({ slug, displayName: "Jobs App" });
      // An installed-looking type the deployment does not offer — the write
      // gate checks additions against the catalogue source at write time.
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        const unavailable = await putManifest(slug, { jobs: { types: ["jobs:report"] } });
        expect(unavailable.statusCode).toBe(400);
        expect(unavailable.json().error.code).toBe("validation_failed");
        expect(unavailable.json().error.message).toContain("jobs:report");
      });
      // Fully disabled — even the fetch type is not grantable.
      const disabled = await putManifest(slug, { jobs: { types: ["jobs:fetch"] } });
      expect(disabled.statusCode).toBe(400);
      expect(disabled.json().error.code).toBe("validation_failed");
      // Nothing was written by either refused attempt.
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(got.json().capabilities.jobs).toBeUndefined();
    });

    it("a removed withdrawn type cannot be re-added", async () => {
      const slug = uniqueSlug();
      await createApp({ slug, displayName: "Jobs App" });
      await t.prisma.app.update({
        where: { slug },
        data: { capabilities: { jobs: { types: ["legacy:thing"] } } },
      });
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        const removed = await putManifest(slug, { data: { user: true } });
        expect(removed.statusCode).toBe(200);
        expect(removed.json().manifest.capabilities.jobs).toBeUndefined();

        const reAdded = await putManifest(slug, {
          data: { user: true },
          jobs: { types: ["legacy:thing"] },
        });
        expect(reAdded.statusCode).toBe(400);
        expect(reAdded.json().error.code).toBe("validation_failed");
      });
    });

    it("preserves a saved withdrawn type through an unrelated save, and stays removable", async () => {
      const slug = uniqueSlug();
      await createApp({ slug, displayName: "Jobs App" });
      // A grant saved while a now-retired server still offered `legacy:thing`:
      // seeded directly, because the write path refuses *new* grants of types
      // no serving server installs — which is exactly why the preservation
      // path must never re-validate a saved type. The PUT below runs with the
      // catalogue source configured, so the withdrawn type passes the addition
      // check as a keep, not an add.
      await t.prisma.app.update({
        where: { slug },
        data: { capabilities: { jobs: { types: ["jobs:fetch", "legacy:thing"] } } },
      });

      // An unrelated save — a data grant — round-trips the withdrawn type
      // untouched, with no jobs delta manufactured for it.
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        const unrelated = await putManifest(slug, {
          data: { user: true },
          jobs: { types: ["jobs:fetch", "legacy:thing"] },
        });
        expect(unrelated.statusCode).toBe(200);
        expect(unrelated.json().applied.map((d: { path: string }) => d.path)).toEqual([
          "data.user",
        ]);
        expect(unrelated.json().manifest.capabilities.jobs).toEqual({
          types: ["jobs:fetch", "legacy:thing"],
        });

        // Removing the last type removes the grant — the block goes, not an
        // empty one.
        const removed = await putManifest(slug, { data: { user: true } });
        expect(removed.statusCode).toBe(200);
        expect(removed.json().applied.map((d: { path: string }) => d.path)).toEqual([
          "jobs.types[-jobs:fetch]",
          "jobs.types[-legacy:thing]",
        ]);
        expect(removed.json().manifest.capabilities.jobs).toBeUndefined();
      });
    });

    it("a saved withdrawn type survives an unrelated save and stays removable while jobs is fully disabled", async () => {
      // The disabled posture is the deployment's live default until the
      // catalogue-source wiring lands, and apps may already hold grants from
      // a retired server. The gate must treat a kept type as a keep even when
      // the deployment advertises nothing at all — a gate that refused every
      // requested type on a disabled deployment would brick every manifest
      // save for the apps holding those grants.
      const slug = uniqueSlug();
      await createApp({ slug, displayName: "Jobs App" });
      await t.prisma.app.update({
        where: { slug },
        data: { capabilities: { jobs: { types: ["legacy:thing"] } } },
      });
      await withEnv({ PORTAL_JOBS_CATALOGUE: undefined }, async () => {
        // The save that KEEPS the type (a full replace still carrying it):
        const kept = await putManifest(slug, {
          data: { user: true },
          jobs: { types: ["legacy:thing"] },
        });
        expect(kept.statusCode).toBe(200);
        expect(kept.json().manifest.capabilities.jobs).toEqual({ types: ["legacy:thing"] });

        // The save that REMOVES it — removal never consults the deployment:
        const removed = await putManifest(slug, { data: { user: true } });
        expect(removed.statusCode).toBe(200);
        expect(removed.json().manifest.capabilities.jobs).toBeUndefined();

        // …and once removed, the disabled deployment re-refuses the re-add.
        const reAdded = await putManifest(slug, {
          data: { user: true },
          jobs: { types: ["legacy:thing"] },
        });
        expect(reAdded.statusCode).toBe(400);
        expect(reAdded.json().error.code).toBe("validation_failed");
        expect(reAdded.json().error.message).toContain("legacy:thing");
      });
    });

    it("an origin grant preserves a saved withdrawn type and files no jobs delta, with the catalogue source configured", async () => {
      // The origin-grant route's safety rests on its `mutate` spreading the
      // effective capabilities — the withdrawn type is a keep, never an add,
      // and the relative append must not rebuild the blob without it. A
      // mutate that stopped spreading would silently strip saved grants from
      // every one-click origin grant.
      const slug = uniqueSlug();
      const created = await createApp({ slug, displayName: "Origins" });
      await t.prisma.app.update({
        where: { slug },
        data: { capabilities: { jobs: { types: ["legacy:thing"] } } },
      });
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        const grant = await t.app.inject({
          method: "POST",
          url: `/api/v1/apps/${slug}/access/origin`,
          headers: authHeader(),
          payload: { origin: "https://one.example" },
        });
        expect(grant.statusCode).toBe(200);
        // The origin waits for approval — the elevated-only shape.
        expect(grant.json().applied).toEqual([]);
        expect(grant.json().pending).not.toBeNull();
        // The withdrawn type survived the grant…
        expect(grant.json().manifest.capabilities.jobs).toEqual({ types: ["legacy:thing"] });
        // …and the filed request carries the origin alone.
        const reqs = await t.prisma.approvalRequest.findMany({
          where: { appId: created.json().id },
        });
        expect(reqs).toHaveLength(1);
        expect(reqs.flatMap((r) => (r.deltas as { path: string }[]).map((d) => d.path))).toEqual([
          "externalOrigins[+https://one.example]",
        ]);
      });
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(got.json().capabilities.jobs).toEqual({ types: ["legacy:thing"] });
    });

    it("a duplicated type at creation is stored verbatim and persists until the block is removed", async () => {
      // `JobsCapabilitySchema` is syntax-only — no set rule — and creation
      // stores the parsed payload verbatim, so a duplicated qualified type is
      // born into the blob. The write path's array deltas are set-based and
      // `applyArray`'s add never dedupes an existing array, so the duplicate
      // survives every save short of removing the block. Membership semantics
      // are unaffected everywhere (the gate, classifier and edge all treat the
      // grant as a set); this pins the stored shape's actual lifetime so the
      // schema fix that dedupes it lands knowing what it changes.
      const slug = uniqueSlug();
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        const created = await createApp({
          slug,
          displayName: "Duplicate born",
          capabilities: { jobs: { types: ["jobs:fetch", "jobs:fetch"] } },
        });
        expect(created.statusCode).toBe(201);
        const got = await t.app.inject({
          method: "GET",
          url: `/api/v1/apps/${slug}/manifest`,
          headers: authHeader(),
        });
        expect(got.json().capabilities.jobs).toEqual({ types: ["jobs:fetch", "jobs:fetch"] });

        // The no-op save commits no jobs delta (the classifier diffs a set)
        // and does not normalize the stored array.
        const noOp = await putManifest(slug, {
          jobs: { types: ["jobs:fetch", "jobs:fetch"] },
        });
        expect(noOp.statusCode).toBe(200);
        expect(noOp.json().applied).toEqual([]);
        expect(noOp.json().manifest.capabilities.jobs).toEqual({
          types: ["jobs:fetch", "jobs:fetch"],
        });

        // Removing the block clears every copy at once.
        const removed = await putManifest(slug, {});
        expect(removed.statusCode).toBe(200);
        expect(removed.json().manifest.capabilities.jobs).toBeUndefined();
      });
    });

    it("refuses a bare alias, a wildcard and a jobs budget field with 400", async () => {
      const slug = uniqueSlug();
      await createApp({ slug, displayName: "Jobs App" });
      for (const jobs of [
        { types: ["fetch"] },
        { types: ["jobs:*"] },
        { types: ["jobs:fetch"], jobsPerDay: 5 },
      ]) {
        const res = await putManifest(slug, { jobs });
        expect(res.statusCode, JSON.stringify(jobs)).toBe(400);
        expect(res.json().error.code).toBe("validation_failed");
      }
      // Nothing was written by any of the refused attempts.
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(got.json().capabilities.jobs).toBeUndefined();
    });

    it("a misconfigured catalogue source at write time is a platform failure (500), never a client 400", async () => {
      const slug = uniqueSlug();
      await createApp({ slug, displayName: "Jobs App" });
      // The gate reads the catalogue source per write; a delivery that is not
      // a valid projection is the platform's failure, so it must surface as
      // the internal 500 exactly as the catalogue read route does — a 400
      // here would read as the caller's mistake.
      await withEnv({ PORTAL_JOBS_CATALOGUE: "not json" }, async () => {
        const put = await putManifest(slug, { data: { user: true } });
        expect(put.statusCode).toBe(500);
        expect(put.json().error.code).toBe("internal");
      });
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(got.json().capabilities.data).toBeUndefined();
    });

    it("a type a retiring server still installs is refused as a new grant", async () => {
      const slug = uniqueSlug();
      await createApp({ slug, displayName: "Jobs App" });
      // The retiring entry keeps its installed list, but retirement closes
      // catalogue additions: the write gate derives the advertised set from
      // the serving entries only, so a new grant of the installed type is
      // refused even though the configuration still names it.
      await withEnv(
        {
          PORTAL_JOBS_CATALOGUE: '{"servers":{"jobs":{"state":"retiring","types":["jobs:fetch"]}}}',
        },
        async () => {
          const put = await putManifest(slug, { jobs: { types: ["jobs:fetch"] } });
          expect(put.statusCode).toBe(400);
          expect(put.json().error.code).toBe("validation_failed");
          expect(put.json().error.message).toContain("jobs:fetch");
        },
      );
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(got.json().capabilities.jobs).toBeUndefined();
    });

    it("an unavailable jobs add refuses the whole save — even when the rest queues for approval", async () => {
      const slug = uniqueSlug();
      const created = await createApp({ slug, displayName: "Jobs App" });
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        // The mcp grant alone is an elevated change that files a request; the
        // unavailable jobs add must refuse before classification, so the save
        // lands as neither a baseline write nor a pending request.
        const mixed = await putManifest(slug, {
          data: { user: true },
          mcp: ["pagerduty"],
          jobs: { types: ["jobs:report"] },
        });
        expect(mixed.statusCode).toBe(400);
        expect(mixed.json().error.code).toBe("validation_failed");
        expect(mixed.json().error.message).toContain("jobs:report");
      });
      const reqs = await t.prisma.approvalRequest.findMany({
        where: { appId: created.json().id },
      });
      expect(reqs).toHaveLength(0);
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(got.json().capabilities.mcp).toEqual([]);
      expect(got.json().capabilities.data).toBeUndefined();
      expect(got.json().capabilities.jobs).toBeUndefined();
    });

    it("names every unavailable type in one refusal, not just the first", async () => {
      const slug = uniqueSlug();
      await createApp({ slug, displayName: "Jobs App" });
      // Two unavailable types in one save — one uninstalled, one synthetic:
      // the refusal is the author's only feedback, so it must report each
      // offending id. A gate that stopped at the first violation would leave
      // the author fixing one type at a time with no signal about the rest.
      await withEnv({ PORTAL_JOBS_CATALOGUE: SERVING_JOBS_CATALOGUE }, async () => {
        const put = await putManifest(slug, {
          jobs: { types: ["jobs:report", "legacy:thing"] },
        });
        expect(put.statusCode).toBe(400);
        expect(put.json().error.code).toBe("validation_failed");
        expect(put.json().error.message).toContain("jobs:report");
        expect(put.json().error.message).toContain("legacy:thing");
      });
      const got = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(got.json().capabilities.jobs).toBeUndefined();
    });
  });
});

describe("GET /api/v1/apps and /:slug", () => {
  it("round-trips a group-visibility app and 404s on unknown", async () => {
    const slug = uniqueSlug();
    await createApp({
      slug,
      displayName: "Grouped",
      visibility: { mode: "group", groupIds: ["g1"] },
    });

    const got = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().visibility).toEqual({ mode: "group", groupIds: ["g1"] });

    const list = await t.app.inject({
      method: "GET",
      url: "/api/v1/apps",
      headers: authHeader(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().some((a: { slug: string }) => a.slug === slug)).toBe(true);

    const missing = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${uniqueSlug()}`,
      headers: authHeader(),
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe("not_found");
  });

  // Clients render this rather than templating `<slug>.<domain>` themselves —
  // the SPA ships prebuilt, so anything it composed would be wrong per-deploy.
  it("carries the app's public URL, composed from the deployment's apps base", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Locatable" });
    expect(created.json().url).toBe(`https://${slug}.local.helix.azxlabs.io:8080`);

    const detail = await t.app.inject({
      method: "GET",
      url: `/api/v1/apps/${slug}`,
      headers: authHeader(),
    });
    expect(detail.json().url).toBe(`https://${slug}.local.helix.azxlabs.io:8080`);

    const list = await t.app.inject({ method: "GET", url: "/api/v1/apps", headers: authHeader() });
    const listed = list.json().find((a: { slug: string }) => a.slug === slug);
    expect(listed.url).toBe(`https://${slug}.local.helix.azxlabs.io:8080`);
  });

  it("follows APP_PUBLIC_BASE, so a redeploy to a new domain needs no client change", async () => {
    const prev = process.env.APP_PUBLIC_BASE;
    process.env.APP_PUBLIC_BASE = "https://apps.example.com";
    try {
      const slug = uniqueSlug();
      const created = await createApp({ slug, displayName: "Rehomed" });
      expect(created.json().url).toBe(`https://${slug}.apps.example.com`);
    } finally {
      if (prev === undefined) delete process.env.APP_PUBLIC_BASE;
      else process.env.APP_PUBLIC_BASE = prev;
    }
  });

  it("requires sign-in to read the registry (401)", async () => {
    const list = await t.app.inject({ method: "GET", url: "/api/v1/apps" });
    expect(list.statusCode).toBe(401);
    expect(list.json().error.code).toBe("unauthorized");

    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Hidden" });
    const detail = await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}` });
    expect(detail.statusCode).toBe(401);
    const manifest = await t.app.inject({ method: "GET", url: `/api/v1/apps/${slug}/manifest` });
    expect(manifest.statusCode).toBe(401);
  });
});

describe("operator policy: PORTAL_ALLOW_PUBLIC_APPS=false", () => {
  const setVisibility = (slug: string, body: Record<string, unknown>) =>
    t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/visibility`,
      headers: authHeader(),
      payload: body,
    });

  async function withPublicDisallowed(fn: () => Promise<void>): Promise<void> {
    const prev = process.env.PORTAL_ALLOW_PUBLIC_APPS;
    process.env.PORTAL_ALLOW_PUBLIC_APPS = "false";
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.PORTAL_ALLOW_PUBLIC_APPS;
      else process.env.PORTAL_ALLOW_PUBLIC_APPS = prev;
    }
  }

  it("refuses to create a public app (403 forbidden)", async () => {
    await withPublicDisallowed(async () => {
      const res = await createApp({
        slug: uniqueSlug(),
        displayName: "Would-be public",
        visibility: { mode: "public" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });
  });

  it("refuses the elevated → public change instead of opening an approval (403)", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Private now" });
    await withPublicDisallowed(async () => {
      const res = await setVisibility(slug, { visibility: { mode: "public" } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });
    // No approval request was opened.
    const reqs = await t.prisma.approvalRequest.findMany({
      where: { app: { slug } },
    });
    expect(reqs).toHaveLength(0);
  });

  it("still allows reductions (→ group) so an app can move off an open surface", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Reducible" });
    await withPublicDisallowed(async () => {
      const res = await setVisibility(slug, { visibility: { mode: "group", groupIds: ["g1"] } });
      expect(res.statusCode).toBe(200);
      expect(res.json().applied).toHaveLength(1);
    });
  });

  /**
   * The route-level half of ADR-0040 §5's regression. `classifyVisibilityChange`
   * used to compare bare modes, so `group → group` returned null and the handler
   * treats null as a no-op and returns before writing — editing which group could
   * open an app answered **200 with no write and no audit row**. That was
   * invisible while an app held one group behind a free-text box; it is the
   * central operation now, so it gets asserted at the route, not only in the
   * classifier's unit test.
   */
  it("applies a group-set edit that leaves the mode alone, and audits it", async () => {
    const slug = uniqueSlug();
    await createApp({
      slug,
      displayName: "Regrouped",
      visibility: { mode: "group", groupIds: ["eng"] },
    });

    const res = await setVisibility(slug, {
      visibility: { mode: "group", groupIds: ["eng", "product"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().pending).toBeNull(); // baseline — applies immediately
    expect(res.json().applied).toEqual([
      { path: "visibility", from: "group:eng", to: "group:eng,product", risk: "low" },
    ]);
    expect(res.json().app.visibility).toEqual({ mode: "group", groupIds: ["eng", "product"] });

    // The write actually landed, rather than the response merely describing it.
    const row = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    expect(row.visibilityGroupIds).toEqual(["eng", "product"]);

    // And the audit row carries the machine-readable set, not just the diff —
    // an audit entry is the only place group values are recorded at all (§7).
    const events = await t.prisma.auditEvent.findMany({
      where: { appId: row.id, action: "app.visibility.set" },
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.metadata).toMatchObject({ groupIds: ["eng", "product"] });
    // Names come from the directory at write time (ADR-0040 §7 — the audit row is
    // the one place a name is recorded, because it is a historical fact rather
    // than a cache). The default test harness has no directory that knows "eng",
    // so the key is absent rather than null — "we could not name these", not
    // "these have no names". The named case is covered in directory.test.ts.
    expect(events[0]?.metadata).not.toHaveProperty("groupNames");
  });

  it("removing a group is also a baseline write, not a no-op", async () => {
    const slug = uniqueSlug();
    await createApp({
      slug,
      displayName: "Narrowed",
      visibility: { mode: "group", groupIds: ["eng", "product"] },
    });
    const res = await setVisibility(slug, { visibility: { mode: "group", groupIds: ["eng"] } });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toHaveLength(1);
    const row = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    expect(row.visibilityGroupIds).toEqual(["eng"]);
  });

  // Order is meaningless in an any-of set, so re-sending the same groups in a
  // different order must stay a genuine no-op: no write, no policyVersion bump
  // (which forces an edge projection reload), no audit row.
  it("treats a reordered group set as a no-op", async () => {
    const slug = uniqueSlug();
    await createApp({
      slug,
      displayName: "Reordered",
      visibility: { mode: "group", groupIds: ["eng", "product"] },
    });
    const before = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    const res = await setVisibility(slug, {
      visibility: { mode: "group", groupIds: ["product", "eng"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toEqual([]);
    const after = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    expect(after.policyVersion).toBe(before.policyVersion);
    const events = await t.prisma.auditEvent.findMany({
      where: { appId: before.id, action: "app.visibility.set" },
    });
    expect(events).toHaveLength(0);
  });

  /**
   * The label-as-equality-key collision, at the route. `["eng","prod"]` and
   * `["eng,prod"]` render the same `group:eng,prod`, so switching between them
   * compared equal and the handler took its no-op branch: 200, no write, no audit.
   * The reverse mattered more — an app scoped to the single id (which admits
   * nobody) could not be corrected.
   *
   * The write path now refuses the comma outright, which is the belt; the classifier
   * comparing sets is the braces, and `approval.test.ts` pins that directly.
   */
  it("refuses a group id containing the label delimiter (400)", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Pasted" });
    for (const bad of ["eng,prod", "eng prod"]) {
      const res = await setVisibility(slug, { visibility: { mode: "group", groupIds: [bad] } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
    }
  });

  it("dedupes a repeated group id rather than storing or counting it twice", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Duped" });
    const res = await setVisibility(slug, {
      visibility: { mode: "group", groupIds: ["eng", "eng", "prod"] },
    });
    expect(res.statusCode).toBe(200);
    const row = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    expect(row.visibilityGroupIds).toEqual(["eng", "prod"]);
    // And the delta reads as the set, not as `group:eng,eng,prod`.
    expect(res.json().applied).toEqual([
      { path: "visibility", from: "internal", to: "group:eng,prod", risk: "low" },
    ]);
  });

  it("refuses more than the capped number of groups (400)", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Too many" });
    const res = await setVisibility(slug, {
      visibility: {
        mode: "group",
        groupIds: Array.from({ length: 11 }, (_, i) => `g${i}`),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });
});

/**
 * Concurrent writes to an app's effective policy state (docs/design/approvals.md
 * §5). `capabilities` is replaced whole, so without the `policyVersion` CAS two
 * writers computing from the same pre-image silently discard each other's deltas
 * and both are told 200.
 */
describe("concurrent policy writes", () => {
  /** A client whose `apps` CAS write is parked until released. */
  function gatedPolicyWrite() {
    let reachedItsWrite!: () => void;
    const atTheWrite = new Promise<void>((resolve) => {
      reachedItsWrite = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prisma = createTestPrisma().$extends({
      query: {
        app: {
          async updateMany({ args, query }) {
            reachedItsWrite();
            await gate;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;
    return { prisma, atTheWrite, release };
  }

  it("409s the manifest PUT that lost, instead of discarding the other's deltas", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Contended" });
    const gated = gatedPolicyWrite();
    const slow = buildTestApp({ prisma: gated.prisma });
    await slow.app.ready();
    try {
      // The async IIFE matters: light-my-request defers dispatch until something
      // awaits the chain, so a bare `inject()` never runs (secrets.test.ts:395).
      const first = (async () =>
        slow.app.inject({
          method: "PUT",
          url: `/api/v1/apps/${slug}/manifest`,
          headers: authHeader(),
          payload: { capabilities: { data: { user: true } } },
        }))();
      // It has read the pre-image and is about to write it back. Let a second,
      // unrelated baseline change commit underneath it first.
      await gated.atTheWrite;
      const second = await t.app.inject({
        method: "PUT",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
        payload: { capabilities: { llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 } } },
      });
      expect(second.statusCode).toBe(200);
      gated.release();
      const lost = await first;

      expect(lost.statusCode).toBe(409);
      expect(lost.json().error.code).toBe("conflict");

      // The committed change survived intact — the loser wrote nothing.
      const manifest = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/manifest`,
        headers: authHeader(),
      });
      expect(manifest.json().capabilities.llm).toEqual({
        models: ["claude-opus-4-8"],
        dollarsPerDay: 10,
      });
      expect(manifest.json().capabilities.data?.user ?? false).toBe(false);
    } finally {
      await slow.close();
    }
  });

  it("hands the losing password-enable a 409 rather than a passphrase that is not stored", async () => {
    const slug = uniqueSlug();
    await createApp({ slug, displayName: "Passworded" });
    const gated = gatedPolicyWrite();
    const slow = buildTestApp({ prisma: gated.prisma });
    await slow.app.ready();
    try {
      const first = (async () =>
        slow.app.inject({
          method: "POST",
          url: `/api/v1/apps/${slug}/access/password`,
          headers: authHeader(),
        }))();
      await gated.atTheWrite;
      const second = await t.app.inject({
        method: "POST",
        url: `/api/v1/apps/${slug}/access/password`,
        headers: authHeader(),
      });
      expect(second.statusCode).toBe(201);
      gated.release();
      const lost = await first;

      // The whole point: 201 + a cleartext passphrase that does not open the app
      // is unrecoverable — the caller cannot tell it is the wrong one.
      expect(lost.statusCode).toBe(409);
      const stored = await t.app.inject({
        method: "GET",
        url: `/api/v1/apps/${slug}/access/password`,
        headers: authHeader(),
      });
      expect(stored.json().password).toBe(second.json().password);
    } finally {
      await slow.close();
    }
  });

  it("files both origin grants concurrently — an elevated-only change writes nothing to CAS over", async () => {
    const slug = uniqueSlug();
    const created = await createApp({ slug, displayName: "Origins" });
    const grant = (origin: string) =>
      t.app.inject({
        method: "POST",
        url: `/api/v1/apps/${slug}/access/origin`,
        headers: authHeader(),
        payload: { origin },
      });
    const [a, b] = await Promise.all([grant("https://one.example"), grant("https://two.example")]);
    // Neither grant changes the live blob (the origin waits for approval), so
    // neither may be turned away as a conflict and no origin may be dropped.
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const reqs = await t.prisma.approvalRequest.findMany({
      where: { appId: created.json().id as string },
    });
    expect(reqs).toHaveLength(2);
    expect(reqs.flatMap((r) => (r.deltas as { path: string }[]).map((d) => d.path)).sort()).toEqual(
      ["externalOrigins[+https://one.example]", "externalOrigins[+https://two.example]"],
    );
  });
});
