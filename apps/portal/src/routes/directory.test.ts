import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";
import {
  DirectoryError,
  StaticDirectory,
  UnavailableDirectory,
  GRAPH_GROUP_PERMISSION,
  type DirectoryOutcome,
  type DirectoryProvider,
  type GroupName,
  type GroupSummary,
} from "@azx-pbc/directory";
import {
  authHeader,
  buildTestApp,
  createTestPrisma,
  uniqueSlug,
  type TestApp,
} from "../test/harness.js";
import { bumpSearchLimit, RATE_BUCKETS } from "../directory/rateLimit.js";

/**
 * The directory endpoints, and specifically the two properties ADR-0040 leans on
 * that are easy to regress: the restrictions on a **tenant-wide read exposed to
 * every authenticated principal**, and the requirement that an unconsented or
 * unconfigured directory degrades to a working Access tab rather than an error.
 */

const GROUPS: GroupSummary[] = [
  { id: "eng-team", displayName: "Engineering", securityEnabled: true },
  { id: "eng-platform", displayName: "Engineering Platform", securityEnabled: true },
  { id: "product-team", displayName: "Product", securityEnabled: true },
  { id: "platform-admin", displayName: "Platform Admins (app role)", securityEnabled: false },
];

/** A provider that reports no-consent, i.e. the tenant declined the grant. */
class DeniedDirectory implements DirectoryProvider {
  async searchGroups(): Promise<DirectoryOutcome<GroupSummary[]>> {
    return { available: false, reason: "no-consent", detail: "tenant said no" };
  }
  async getGroups(): Promise<DirectoryOutcome<GroupName[]>> {
    return { available: false, reason: "no-consent", detail: "tenant said no" };
  }
}

function get(t: TestApp, url: string) {
  return t.app.inject({ method: "GET", url, headers: authHeader() });
}

describe("GET /api/v1/directory/groups", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = buildTestApp({ directory: new StaticDirectory(GROUPS) });
    await t.app.ready();
  });
  afterAll(async () => {
    await t.close();
  });

  it("requires authentication — it is a tenant-wide read", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/directory/groups?q=eng" });
    expect(res.statusCode).toBe(401);
  });

  it("returns matching groups with their security flag", async () => {
    const res = await get(t, "/api/v1/directory/groups?q=engineering");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      available: true,
      groups: [
        { id: "eng-team", displayName: "Engineering", securityEnabled: true },
        { id: "eng-platform", displayName: "Engineering Platform", securityEnabled: true },
      ],
    });
  });

  // No bare-prefix directory dumps. A one- or two-character query would let any
  // authenticated principal walk the tenant's group list a letter at a time.
  it("refuses a query shorter than three characters", async () => {
    for (const q of ["", "e", "en"]) {
      const res = await get(t, `/api/v1/directory/groups?q=${q}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("validation_failed");
    }
  });

  it("refuses a query that is only whitespace", async () => {
    const res = await get(t, "/api/v1/directory/groups?q=%20%20%20%20");
    expect(res.statusCode).toBe(400);
  });

  it("caps `top`, and refuses one over the cap rather than silently clamping", async () => {
    expect((await get(t, "/api/v1/directory/groups?q=team&top=1")).json().groups).toHaveLength(1);
    const over = await get(t, "/api/v1/directory/groups?q=team&top=1000");
    expect(over.statusCode).toBe(400);
  });

  it("audits every search, whether or not it matched", async () => {
    await get(t, "/api/v1/directory/groups?q=zzzznomatch");
    const events = await t.prisma.auditEvent.findMany({
      where: { action: "directory.search" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    expect(events[0]?.metadata).toMatchObject({ q: "zzzznomatch", resultCount: 0 });
    // Not app-scoped — the column is nullable so this is expressible.
    expect(events[0]?.appId).toBeNull();
  });
});

/**
 * The claim-derived default view (ADR-0040 decision 6).
 *
 * `PORTAL_DEV_ACTOR_GROUPS` is what puts groups on the dev token's actor, so it
 * is stubbed per test rather than inherited: the devcontainer happens to set
 * `platform-admin`, and a suite that silently depended on that would assert
 * almost nothing while looking thorough. The verifier chain is built during
 * `buildApp`, so the stub has to precede it.
 */
describe("GET /api/v1/directory/my-groups", () => {
  async function withActorGroups(groups: string, fn: (t: TestApp) => Promise<void>): Promise<void> {
    vi.stubEnv("PORTAL_DEV_ACTOR_GROUPS", groups);
    const t = buildTestApp({ directory: new StaticDirectory(GROUPS) });
    await t.app.ready();
    try {
      await fn(t);
    } finally {
      await t.close();
      vi.unstubAllEnvs();
    }
  }

  it("resolves the caller's claim ids to names", async () => {
    await withActorGroups("eng-team,product-team", async (t) => {
      const res = await get(t, "/api/v1/directory/my-groups");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        available: true,
        groups: [
          { id: "eng-team", displayName: "Engineering", securityEnabled: true },
          { id: "product-team", displayName: "Product", securityEnabled: true },
        ],
      });
    });
  });

  /**
   * `Actor.groups` is the **union** of the `groups` and `roles` claims
   * (`auth/verifier.ts`), so App Role values ride alongside group ids. An id that
   * doesn't resolve is omitted, not an error — otherwise a platform admin's
   * default view would fail outright on a claim the platform itself put there.
   */
  it("omits claim entries that are not groups, rather than failing", async () => {
    await withActorGroups("eng-team,not-a-real-group", async (t) => {
      const res = await get(t, "/api/v1/directory/my-groups");
      expect(res.statusCode).toBe(200);
      expect(res.json().groups.map((g: { id: string }) => g.id)).toEqual(["eng-team"]);
    });
  });

  /**
   * A caller with no group claims is not a degradation — it is the ordinary state
   * of a tenant that hasn't run the group-claims rollout, or of a user in no
   * groups. Reporting `available: true` with an empty list keeps the banner
   * reserved for the case an operator can actually act on.
   */
  it("reports an empty list, not unavailable, when the caller has no group claims", async () => {
    await withActorGroups("", async (t) => {
      const res = await get(t, "/api/v1/directory/my-groups");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: true, groups: [] });
    });
  });

  it("requires authentication", async () => {
    await withActorGroups("eng-team", async (t) => {
      const res = await t.app.inject({ method: "GET", url: "/api/v1/directory/my-groups" });
      expect(res.statusCode).toBe(401);
    });
  });
});

/**
 * ADR-0040 decision 8. The failure must not surface as a broken Access tab, and
 * must not be silent — so both routes answer 200 with an explicit degraded shape,
 * and the consent case names the permission an administrator has to grant.
 */
describe("degradation when the directory can't answer", () => {
  it("reports no-consent as a 200, naming the missing permission", async () => {
    const t = buildTestApp({ directory: new DeniedDirectory() });
    await t.app.ready();
    try {
      for (const url of ["/api/v1/directory/groups?q=eng", "/api/v1/directory/my-groups"]) {
        const res = await get(t, url);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({
          available: false,
          reason: "no-consent",
          missingPermission: GRAPH_GROUP_PERMISSION,
        });
      }
    } finally {
      await t.close();
    }
  });

  it("reports an unconfigured directory as a 200 with no permission to name", async () => {
    const t = buildTestApp({ directory: new UnavailableDirectory() });
    await t.app.ready();
    try {
      const res = await get(t, "/api/v1/directory/groups?q=eng");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ available: false, reason: "not-configured" });
      // Nothing to ask an administrator for, so nothing is claimed.
      expect(res.json().missingPermission).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});

/**
 * App-scoped name resolution (ADR-0040 §7). Deliberately not a general
 * `?ids=…` resolver: the ids are already readable from `GET /api/v1/apps/:slug`,
 * so this discloses nothing new and needs no rate limit or audit — whereas an
 * arbitrary-id resolver would be a "what is this GUID called" oracle.
 */
describe("GET /api/v1/apps/:slug/visibility/groups", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = buildTestApp({ directory: new StaticDirectory(GROUPS) });
    await t.app.ready();
  });
  afterAll(async () => {
    await t.close();
  });

  const create = (slug: string, groupIds: string[]) =>
    t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: { slug, displayName: slug, visibility: { mode: "group", groupIds } },
    });

  it("names the groups the app is scoped to", async () => {
    const slug = uniqueSlug("res");
    await create(slug, ["eng-team", "product-team"]);
    const res = await get(t, `/api/v1/apps/${slug}/visibility/groups`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      available: true,
      groups: [
        { id: "eng-team", displayName: "Engineering", securityEnabled: true },
        { id: "product-team", displayName: "Product", securityEnabled: true },
      ],
    });
  });

  it("answers an empty list for an app with no groups, without calling the directory", async () => {
    const slug = uniqueSlug("res");
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: { slug, displayName: slug },
    });
    expect((await get(t, `/api/v1/apps/${slug}/visibility/groups`)).json()).toEqual({
      available: true,
      groups: [],
    });
  });

  // A group deleted from the directory after an app was scoped to it. Not an
  // error: the id stays authoritative and the UI renders `unknown group (<id>)`.
  it("omits an id the directory no longer knows, rather than failing", async () => {
    const slug = uniqueSlug("res");
    await create(slug, ["eng-team", "deleted-group"]);
    const res = await get(t, `/api/v1/apps/${slug}/visibility/groups`);
    expect(res.statusCode).toBe(200);
    expect(res.json().groups.map((g: { id: string }) => g.id)).toEqual(["eng-team"]);
  });

  it("404s an unknown app, and requires authentication", async () => {
    expect((await get(t, "/api/v1/apps/nope-nope-nope/visibility/groups")).statusCode).toBe(404);
    const anon = await t.app.inject({
      method: "GET",
      url: "/api/v1/apps/whatever/visibility/groups",
    });
    expect(anon.statusCode).toBe(401);
  });
});

/**
 * ADR-0040 §7: names are resolved live and never stored beside the ids — with one
 * exception, the audit row, which records them **as observed at write time**
 * because that is a historical fact about what the operator believed they were
 * selecting. Audit rows are immutable; a group renamed next month does not
 * rewrite what was true today.
 */
describe("visibility audit records group names as observed at write time", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = buildTestApp({ directory: new StaticDirectory(GROUPS) });
    await t.app.ready();
  });
  afterAll(async () => {
    await t.close();
  });

  it("stores the names alongside the ids", async () => {
    const slug = uniqueSlug("aud");
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: { slug, displayName: slug },
    });
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/visibility`,
      headers: authHeader(),
      payload: { visibility: { mode: "group", groupIds: ["eng-team", "product-team"] } },
    });
    expect(res.statusCode).toBe(200);

    const row = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    const events = await t.prisma.auditEvent.findMany({
      where: { appId: row.id, action: "app.visibility.set" },
    });
    expect(events[0]?.metadata).toMatchObject({
      groupIds: ["eng-team", "product-team"],
      groupNames: { "eng-team": "Engineering", "product-team": "Product" },
    });
  });

  // A visibility change must not fail because a log annotation could not be
  // fetched — the directory is best-effort here and nothing else.
  /**
   * `app.create` recorded only `{ slug }` while already storing visibility. The API
   * accepts a group-scoped app on create (`CreateAppRequestSchema` takes the full
   * union, and `helix create --visibility group:a,b` produces it) — only the SPA
   * declines to offer the mode. So an app could be group-scoped from birth with
   * nothing anywhere recording which groups, or what they were called.
   */
  it("records the groups an app is created with, names included", async () => {
    const slug = uniqueSlug("cre");
    const res = await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: {
        slug,
        displayName: slug,
        visibility: { mode: "group", groupIds: ["eng-team", "product-team"] },
      },
    });
    expect(res.statusCode).toBe(201);
    const row = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    const events = await t.prisma.auditEvent.findMany({
      where: { appId: row.id, action: "app.create" },
    });
    expect(events[0]?.metadata).toMatchObject({
      slug,
      visibility: "group:eng-team,product-team",
      groupIds: ["eng-team", "product-team"],
      groupNames: { "eng-team": "Engineering", "product-team": "Product" },
    });
  });

  it("records the visibility of a non-group app without inventing group keys", async () => {
    const slug = uniqueSlug("cre");
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: { slug, displayName: slug },
    });
    const row = await t.prisma.app.findUniqueOrThrow({ where: { slug } });
    const events = await t.prisma.auditEvent.findMany({
      where: { appId: row.id, action: "app.create" },
    });
    expect(events[0]?.metadata).toMatchObject({ slug, visibility: "internal" });
    expect(events[0]?.metadata).not.toHaveProperty("groupIds");
    expect(events[0]?.metadata).not.toHaveProperty("groupNames");
  });

  it("still applies the change when the directory cannot name anything", async () => {
    const t2 = buildTestApp({ directory: new DeniedDirectory() });
    await t2.app.ready();
    try {
      const slug = uniqueSlug("aud");
      await t2.app.inject({
        method: "POST",
        url: "/api/v1/apps",
        headers: authHeader(),
        payload: { slug, displayName: slug },
      });
      const res = await t2.app.inject({
        method: "POST",
        url: `/api/v1/apps/${slug}/visibility`,
        headers: authHeader(),
        payload: { visibility: { mode: "group", groupIds: ["eng-team"] } },
      });
      expect(res.statusCode).toBe(200);
      const row = await t2.prisma.app.findUniqueOrThrow({ where: { slug } });
      expect(row.visibilityGroupIds).toEqual(["eng-team"]);
      const events = await t2.prisma.auditEvent.findMany({
        where: { appId: row.id, action: "app.visibility.set" },
      });
      // Ids recorded, names absent — not null, and not a failed write.
      expect(events[0]?.metadata).toMatchObject({ groupIds: ["eng-team"] });
      expect(events[0]?.metadata).not.toHaveProperty("groupNames");
    } finally {
      await t2.close();
    }
  });
});

/** The dev-token actor's `sub`, which is what the rate-limit bucket is keyed on. */
const TEST_ACTOR_SUB = process.env.PORTAL_DEV_ACTOR ?? "dev@azx.io";

/**
 * Clear this actor's rate-limit windows before every test.
 *
 * `portal_rate_counters` is real Postgres and the bucket key is per actor, not per
 * test — and every test here authenticates as the same dev token. Without this, the
 * one test that deliberately exhausts a budget leaves a row that 429s unrelated
 * tests for the rest of the window, including on the *next* run of the file. The
 * suite would then pass or fail depending on how recently it last ran.
 */
beforeEach(async () => {
  const prisma = createTestPrisma();
  try {
    await prisma.portalRateCounter.deleteMany({
      where: { bucketKey: { in: [`dirsearch:${TEST_ACTOR_SUB}`, `dirresolve:${TEST_ACTOR_SUB}`] } },
    });
  } finally {
    await prisma.$disconnect();
  }
});

/** A directory whose upstream is throttled or broken — transient, not structural. */
class ThrottledDirectory implements DirectoryProvider {
  async searchGroups(): Promise<DirectoryOutcome<GroupSummary[]>> {
    throw new DirectoryError("graph GET /groups returned 429", 429, "TooManyRequests");
  }
  async getGroups(): Promise<DirectoryOutcome<GroupName[]>> {
    throw new DirectoryError("graph POST /getByIds returned 429", 429, "TooManyRequests");
  }
}

/**
 * A transient upstream failure must not look like an empty result or a crash.
 *
 * `DirectoryError` is not an `AppError`, so it used to fall through to the generic
 * 500 handler. In the SPA that leaves an errored query with no data, so the
 * picker's `unavailable` check stays null, no banner renders, and it reports "no
 * matching groups" — a throttled directory reading as "that group does not exist"
 * for every operator at once.
 *
 * It is deliberately NOT turned into `available: false`: that shape means
 * "permanently, until an operator acts", and a Graph blip is neither. 503 is
 * retryable and says so.
 */
describe("a transient directory failure is a typed 503, not a 500", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = buildTestApp({ directory: new ThrottledDirectory() });
    await t.app.ready();
  });
  afterAll(async () => {
    await t.close();
  });

  it("maps it on every route that calls Graph", async () => {
    const slug = uniqueSlug("thr");
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: { slug, displayName: slug, visibility: { mode: "group", groupIds: ["eng-team"] } },
    });

    for (const url of [
      "/api/v1/directory/groups?q=eng",
      `/api/v1/apps/${slug}/visibility/groups`,
      "/api/v1/directory/my-groups",
    ]) {
      const res = await get(t, url);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe("capability_unavailable");
    }
  });
});

/**
 * Both id -> name routes issue a `getByIds` to Graph on every request. Neither was
 * limited: the omission was justified on information-disclosure grounds, which is
 * true and answers the wrong question — the resource being spent is the tenant's
 * shared Graph throttle budget, which is exactly why the search route limits
 * before its upstream call.
 */
describe("the resolve routes spend a rate-limit budget", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = buildTestApp({ directory: new StaticDirectory(GROUPS) });
    await t.app.ready();
  });
  afterAll(async () => {
    await t.close();
  });

  const exhaust = async (sub: string, bucket: "search" | "resolve") => {
    // Spend the whole window directly, so the test does not depend on the limit.
    for (let i = 0; i <= RATE_BUCKETS[bucket].limit; i += 1) {
      await bumpSearchLimit(t.prisma, sub, bucket);
    }
  };

  it("429s the app-scoped resolve once the resolve budget is gone", async () => {
    const slug = uniqueSlug("rl");
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: { slug, displayName: slug, visibility: { mode: "group", groupIds: ["eng-team"] } },
    });
    expect((await get(t, `/api/v1/apps/${slug}/visibility/groups`)).statusCode).toBe(200);

    await exhaust(TEST_ACTOR_SUB, "resolve");
    const res = await get(t, `/api/v1/apps/${slug}/visibility/groups`);
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");

    // Search keeps its own budget — page-render traffic must not spend the
    // allowance that guards the tenant-wide read.
    expect((await get(t, "/api/v1/directory/groups?q=eng")).statusCode).toBe(200);
  });

  it("does not spend a resolve on an app with no groups", async () => {
    const slug = uniqueSlug("rl");
    await t.app.inject({
      method: "POST",
      url: "/api/v1/apps",
      headers: authHeader(),
      payload: { slug, displayName: slug },
    });
    const before = await t.prisma.portalRateCounter.findUnique({
      where: { bucketKey: `dirresolve:${TEST_ACTOR_SUB}` },
    });
    await get(t, `/api/v1/apps/${slug}/visibility/groups`);
    const after = await t.prisma.portalRateCounter.findUnique({
      where: { bucketKey: `dirresolve:${TEST_ACTOR_SUB}` },
    });
    expect(after?.count ?? 0).toBe(before?.count ?? 0);
  });
});
