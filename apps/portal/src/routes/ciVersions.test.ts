import { PassThrough } from "node:stream";
import FormData from "form-data";
import type { RouteOptions } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  ATTR_APP_ID,
  ATTR_OUTCOME,
  INSTR_DEPLOY_REPO_REQUESTS,
  SPAN_DEPLOY_REPO,
} from "@azx-pbc/shared/telemetry";
import { resolveRepoDeployConfig } from "../deployment.js";
import { authenticate } from "../plugins/auth.js";
import {
  defaultGithubClaims,
  githubTokenFixture,
  type GithubTokenFixture,
} from "../test/githubTokens.js";
import { withEnv } from "../test/env.js";
import {
  authHeader,
  buildTestApp,
  multipartBundle,
  uniqueSlug,
  type TestApp,
} from "../test/harness.js";
import { buildZipBuffer } from "../test/zip.js";

/**
 * The CI deploy route's adversarial suite (ADR-0051 Consequences, "Tests ship
 * with it"). New authentication on an internet-facing route: every refusal is
 * asserted along with what the caller is told, what is audited, and that the
 * body is never read.
 */

let t: TestApp;
let gh: GithubTokenFixture;
let audience: string;
/** Every route registered with `authenticate` in its preHandler chain. */
const authenticatedRoutes: { method: string; url: string }[] = [];

beforeAll(async () => {
  audience = resolveRepoDeployConfig().audience;
  gh = await githubTokenFixture(audience);
  t = buildTestApp({ repoDeploy: { getKey: gh.getKey } });
  t.app.addHook("onRoute", (route: RouteOptions) => {
    const pre = route.preHandler;
    const chain = Array.isArray(pre) ? pre : pre ? [pre] : [];
    if (!chain.includes(authenticate as never)) return;
    for (const method of [route.method].flat()) {
      if (method !== "HEAD") authenticatedRoutes.push({ method, url: route.url });
    }
  });
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

const bundle = () =>
  buildZipBuffer([{ name: "index.html", content: "<!doctype html><body>ci</body>" }]);

/** Create an app owned by the dev-token actor; `null` leaves it unbound. */
async function createApp(
  binding: Record<string, unknown> | null = {},
): Promise<{ slug: string; appId: string }> {
  const slug = uniqueSlug("ci");
  const res = await t.app.inject({
    method: "POST",
    url: "/api/v1/apps",
    headers: authHeader(),
    payload: { slug, displayName: slug },
  });
  expect(res.statusCode).toBe(201);
  if (binding !== null) {
    const put = await t.app.inject({
      method: "PUT",
      url: `/api/v1/apps/${slug}/repo-binding`,
      headers: authHeader(),
      payload: { repoFullName: "octo-org/octo-app", branch: "main", ...binding },
    });
    expect(put.statusCode).toBe(200);
  }
  return { slug, appId: res.json().id };
}

async function ciUpload(slug: string, token: string | null, buf?: Buffer) {
  const { payload, headers } = multipartBundle(buf ?? (await bundle()));
  return t.app.inject({
    method: "POST",
    url: `/api/v1/apps/${slug}/ci/versions`,
    headers: token === null ? headers : { ...headers, authorization: `Bearer ${token}` },
    payload,
  });
}

const deniedAudits = (appId: string) =>
  t.prisma.auditEvent.findMany({ where: { appId, action: "app.repo-deploy.denied" } });

describe("POST /api/v1/apps/:slug/ci/versions — accepted", () => {
  it("lands a preview with provenance, pins the repo ids, and audits the deploy", async () => {
    const { slug, appId } = await createApp();
    const token = await gh.mint();
    const res = await ciUpload(slug, token);
    expect(res.statusCode).toBe(201);
    const { version } = res.json();
    expect(version.status).toBe("preview");
    expect(version.source).toEqual({
      provider: "github",
      repositoryId: "1001",
      repoFullName: "octo-org/octo-app",
      ref: "refs/heads/main",
      commitSha: "0123456789abcdef0123456789abcdef01234567",
      workflowRef: "octo-org/octo-app/.github/workflows/helix-deploy.yml@refs/heads/main",
      runId: "777",
      runAttempt: 1,
    });

    const binding = await t.prisma.repoBinding.findUniqueOrThrow({ where: { appId } });
    expect(binding.repositoryId).toBe("1001");
    expect(binding.repositoryOwnerId).toBe("2002");
    expect(binding.pinnedAt).not.toBeNull();

    const audit = await t.prisma.auditEvent.findFirstOrThrow({
      where: { appId, action: "version.upload" },
    });
    expect(audit.actor).toBe("github:octo-org/octo-app");
    expect(audit.metadata).toMatchObject({
      source: { sha: version.source.commitSha, githubActor: "octocat" },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(token);
  });

  it("keeps deploying after a rename once pinned, and stops after a transfer", async () => {
    const { slug, appId } = await createApp();
    expect((await ciUpload(slug, await gh.mint())).statusCode).toBe(201);
    const renamed = await gh.mint({ claims: { repository: "octo-org/renamed" } });
    const afterRename = await ciUpload(slug, renamed);
    expect(afterRename.statusCode).toBe(201);
    // Provenance carries the name at deploy time, so commit links follow the
    // rename; the audit actor stays the binding's name.
    const { version } = afterRename.json();
    expect(version.source.repoFullName).toBe("octo-org/renamed");
    const uploads = await t.prisma.auditEvent.findMany({
      where: { appId, action: "version.upload" },
    });
    expect(uploads.map((a) => a.actor)).toEqual([
      "github:octo-org/octo-app",
      "github:octo-org/octo-app",
    ]);
    const transferred = await gh.mint({ claims: { repository_owner_id: "3003" } });
    expect((await ciUpload(slug, transferred)).statusCode).toBe(403);
  });

  it("does not read the salvage report field", async () => {
    const { slug } = await createApp();
    const { payload, headers } = multipartBundle(
      await bundle(),
      "bundle",
      "bundle.zip",
      JSON.stringify({
        plannerVersion: 1,
        outcome: "rerooted",
        root: "dist",
        fileCount: 1,
      }),
    );
    const res = await t.app.inject({
      method: "POST",
      url: `/api/v1/apps/${slug}/ci/versions`,
      headers: { ...headers, authorization: `Bearer ${await gh.mint()}` },
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().version.deployReport).toBeUndefined();
  });
});

describe("POST /api/v1/apps/:slug/ci/versions — replay", () => {
  it("refuses a token that already produced a version, and audits it", async () => {
    const { slug, appId } = await createApp();
    const token = await gh.mint();
    expect((await ciUpload(slug, token)).statusCode).toBe(201);
    const again = await ciUpload(slug, token);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.details).toEqual({ reason: "replayed" });
    expect(
      (await deniedAudits(appId)).map((a) => (a.metadata as { reason: string }).reason),
    ).toEqual(["replayed"]);
  });

  it("lets exactly one of two concurrent requests with one token through", async () => {
    const { slug } = await createApp();
    expect((await ciUpload(slug, await gh.mint())).statusCode).toBe(201); // pin first
    const token = await gh.mint();
    const results = await Promise.all([ciUpload(slug, token), ciUpload(slug, token)]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes, JSON.stringify(results.map((r) => r.json()))).toEqual([201, 409]);
  });

  it("does not spend the token on a bundle that fails validation", async () => {
    const { slug } = await createApp();
    const token = await gh.mint();
    const symlink = await buildZipBuffer([
      { name: "index.html", content: "x" },
      { name: "leak", symlinkTo: "/etc/passwd" },
    ]);
    const bad = await ciUpload(slug, token, symlink);
    expect(bad.statusCode).toBe(400);
    expect((await ciUpload(slug, token)).statusCode).toBe(201);
  });
});

describe("POST /api/v1/apps/:slug/ci/versions — refusals", () => {
  it.each<[string, () => Promise<string | null>]>([
    ["no token", async () => null],
    ["a portal dev token", async () => "test-token"],
    ["a stranger's signature", () => gh.mint({ key: gh.strangerKey })],
    ["GitHub's default audience", () => gh.mint({ audience: "https://github.com/octo-org" })],
    ["an expired token", () => gh.mint({ exp: Math.floor(Date.now() / 1000) - 60 })],
  ])("401s %s without auditing", async (_label, makeToken) => {
    const { slug, appId } = await createApp();
    const res = await ciUpload(slug, await makeToken());
    expect(res.statusCode).toBe(401);
    expect(await deniedAudits(appId)).toEqual([]);
  });

  it("gives a foreign repo, an unbound app and an unknown slug the same 403, unaudited", async () => {
    const bound = await createApp();
    const unbound = await createApp(null);
    const foreignToken = () =>
      gh.mint({ claims: { repository: "evil/repo", repository_id: "666" } });

    const bodies = [];
    for (const [slug, token] of [
      [bound.slug, await foreignToken()],
      [unbound.slug, await gh.mint()],
      [uniqueSlug("nope"), await gh.mint()],
    ] as const) {
      const res = await ciUpload(slug, token);
      expect(res.statusCode).toBe(403);
      bodies.push(res.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0].error.details).toBeUndefined();
    expect(await deniedAudits(bound.appId)).toEqual([]);
    expect(await deniedAudits(unbound.appId)).toEqual([]);
  });

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string]>([
    ["another branch", {}, { ref: "refs/heads/dev" }, "ref_mismatch"],
    [
      "a pull_request ref",
      {},
      { ref: "refs/pull/3/merge", event_name: "pull_request" },
      "ref_mismatch",
    ],
    ["pull_request_target", {}, { event_name: "pull_request_target" }, "event_rejected"],
    ["workflow_run", {}, { event_name: "workflow_run" }, "event_rejected"],
    ["issue_comment", {}, { event_name: "issue_comment" }, "event_rejected"],
    [
      "an unpinned workflow",
      { workflowRef: "helix/actions/.github/workflows/deploy.yml@refs/tags/v1" },
      {},
      "workflow_mismatch",
    ],
    ["a missing environment", { environment: "production" }, {}, "environment_mismatch"],
  ])(
    "tells the bound repo why it refused %s, and audits it",
    async (_label, binding, claims, reason) => {
      const { slug, appId } = await createApp(binding);
      const res = await ciUpload(slug, await gh.mint({ claims }));
      expect(res.statusCode).toBe(403);
      expect(res.json().error.details).toEqual({ reason });
      const audits = await deniedAudits(appId);
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actor).toBe("github:octo-org/octo-app");
      expect(audits[0]?.metadata).toMatchObject({ reason, runId: "777" });
    },
  );

  it("refuses an archived app after authenticating, without pinning its binding", async () => {
    const { slug, appId } = await createApp();
    await t.prisma.app.update({ where: { id: appId }, data: { archivedAt: new Date() } });
    expect((await ciUpload(slug, await gh.mint())).statusCode).toBe(409);
    const binding = await t.prisma.repoBinding.findUniqueOrThrow({ where: { appId } });
    expect(binding.repositoryId).toBeNull();
  });

  it("refuses a replayed token without re-pinning a binding the owner reset", async () => {
    const { slug, appId } = await createApp();
    const token = await gh.mint();
    expect((await ciUpload(slug, token)).statusCode).toBe(201);
    // Moving the binding away and back clears the pins.
    for (const repoFullName of ["octo-org/other", "octo-org/octo-app"]) {
      await t.app.inject({
        method: "PUT",
        url: `/api/v1/apps/${slug}/repo-binding`,
        headers: authHeader(),
        payload: { repoFullName, branch: "main" },
      });
    }
    expect((await ciUpload(slug, token)).statusCode).toBe(409);
    const binding = await t.prisma.repoBinding.findUniqueOrThrow({ where: { appId } });
    expect(binding.repositoryId).toBeNull();
  });

  it("pins a workflow by workflow_ref when the token has no job_workflow_ref", async () => {
    const workflowRef = "octo-org/octo-app/.github/workflows/helix-deploy.yml@refs/heads/main";
    const { slug } = await createApp({ workflowRef });
    const plain = await gh.mint({ claims: { job_workflow_ref: undefined } });
    expect((await ciUpload(slug, plain)).statusCode).toBe(201);
    const other = await gh.mint({
      claims: {
        job_workflow_ref: undefined,
        workflow_ref: "octo-org/octo-app/.github/workflows/other.yml@refs/heads/main",
      },
    });
    const refused = await ciUpload(slug, other);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.details).toEqual({ reason: "workflow_mismatch" });
  });

  it("404s when the operator turned the feature off", async () => {
    const { slug } = await createApp();
    const token = await gh.mint();
    await withEnv({ PORTAL_REPO_DEPLOY_ENABLED: "false" }, async () => {
      expect((await ciUpload(slug, token)).statusCode).toBe(404);
    });
  });

  it("refuses before reading the body: an upload that never ends still gets an answer", async () => {
    const { slug } = await createApp();
    for (const token of [
      null,
      await gh.mint({ claims: { repository_id: "666", repository: "evil/x" } }),
    ]) {
      const form = new FormData();
      const body = new PassThrough();
      // A multipart preamble for a `bundle` file whose bytes never finish.
      body.write(
        `--${form.getBoundary()}\r\nContent-Disposition: form-data; name="bundle"; filename="b.zip"\r\n` +
          "Content-Type: application/zip\r\n\r\nPK",
      );
      const res = await t.app.inject({
        method: "POST",
        url: `/api/v1/apps/${slug}/ci/versions`,
        headers: {
          "content-type": `multipart/form-data; boundary=${form.getBoundary()}`,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        payload: body,
      });
      expect([401, 403]).toContain(res.statusCode);
      body.destroy();
    }
  });
});

describe("a GitHub token outside the CI route", () => {
  it("is refused by every route behind authenticate", async () => {
    expect(authenticatedRoutes.length).toBeGreaterThan(20);
    const { slug } = await createApp();
    const token = await gh.mint();
    for (const route of authenticatedRoutes) {
      const url = route.url.replace(/:slug/g, slug).replace(/:[A-Za-z]+/g, "x");
      const hasBody = route.method !== "GET" && route.method !== "DELETE";
      const res = await t.app.inject({
        method: route.method as "GET",
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(hasBody ? { "content-type": "application/json" } : {}),
        },
        ...(hasBody ? { payload: "{}" } : {}),
      });
      expect({ route: `${route.method} ${route.url}`, status: res.statusCode }).toEqual({
        route: `${route.method} ${route.url}`,
        status: 401,
      });
    }
  });
});

describe("telemetry", () => {
  let recording: RecordingTelemetry;
  beforeEach(() => {
    recording = startRecordingTelemetry();
  });
  afterEach(async () => {
    await recording.restore();
  });

  it("wraps the deploy in helix.deploy.repo and counts each decision", async () => {
    const { slug, appId } = await createApp();
    const token = await gh.mint();
    expect((await ciUpload(slug, token)).statusCode).toBe(201);
    expect(
      (await ciUpload(slug, await gh.mint({ claims: { ref: "refs/heads/x" } }))).statusCode,
    ).toBe(403);
    expect((await ciUpload(slug, "garbage")).statusCode).toBe(401);

    const spans = recording.spans();
    const repoSpans = spans.filter((s) => s.name === SPAN_DEPLOY_REPO);
    expect(repoSpans.map((s) => s.attributes[ATTR_OUTCOME])).toEqual([
      "accepted",
      "ref_mismatch",
      "bad_token",
    ]);
    const accepted = repoSpans[0]!;
    expect(accepted.attributes[ATTR_APP_ID]).toBe(appId);
    // A denial is not a platform error.
    expect(repoSpans[1]!.status.code).not.toBe(2);
    const bundleSpan = spans.find((s) => s.name === "helix.deploy.bundle");
    expect(bundleSpan?.parentSpanContext?.spanId).toBe(accepted.spanContext().spanId);

    const counts = (await recording.metrics())
      .filter((m) => m.name === INSTR_DEPLOY_REPO_REQUESTS)
      .map((m) => [m.attributes[ATTR_OUTCOME], m.value]);
    expect(counts).toEqual(
      expect.arrayContaining([
        ["accepted", 1],
        ["ref_mismatch", 1],
        ["bad_token", 1],
      ]),
    );

    // Nothing identifying rides any span: not the repo, the actor or the token.
    const claims = defaultGithubClaims();
    for (const span of spans) {
      for (const value of Object.values(span.attributes)) {
        const text = String(value);
        for (const banned of [token, String(claims.repository), String(claims.actor), "octo-org"]) {
          expect(text).not.toContain(banned);
        }
      }
    }
  });
});
