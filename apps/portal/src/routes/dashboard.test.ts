import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestApp, uniqueSlug, type TestApp } from "../test/harness.js";
import { setLiveVersion } from "../deploy/pointer.js";
import { blobPrefixFor } from "../db/mappers.js";

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

/** Create an app row directly; optionally promote a version to live. */
async function seedApp(displayName: string, { deploy }: { deploy: boolean }) {
  const slug = uniqueSlug();
  const appRow = await t.prisma.app.create({
    data: { slug, displayName, visibilityMode: "private" },
  });
  if (deploy) {
    const version = await t.prisma.version.create({
      data: { appId: appRow.id, number: 1, blobPrefix: blobPrefixFor(appRow.id, 1) },
    });
    await setLiveVersion({
      prisma: t.prisma,
      appId: appRow.id,
      versionId: version.id,
      action: "version.promote",
      actor: "test",
    });
  }
  return { slug, displayName };
}

describe("GET / (demo dashboard)", () => {
  it("renders an HTML list with links and deploy status", async () => {
    const live = await seedApp("Deployed App", { deploy: true });
    await seedApp("Pending App", { deploy: false });

    const res = await t.app.inject({ method: "GET", url: "/" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");

    const html = res.body;
    // Deployed app: linked to the dev edge (scheme + port) and shows its live version.
    expect(html).toContain(`href="http://${live.slug}.localtest.me:8080"`);
    expect(html).toContain("Deployed App");
    expect(html).toContain("live · v1");
    // Never-deployed app: shown but flagged, no live link required.
    expect(html).toContain("Pending App");
    expect(html).toContain("not deployed yet");
  });

  it("escapes HTML in display names", async () => {
    await seedApp("<script>alert(1)</script>", { deploy: false });

    const res = await t.app.inject({ method: "GET", url: "/" });

    expect(res.body).not.toContain("<script>alert(1)</script>");
    expect(res.body).toContain("&lt;script&gt;");
  });

  it("honours APP_PUBLIC_BASE for link origins", async () => {
    const prev = process.env.APP_PUBLIC_BASE;
    process.env.APP_PUBLIC_BASE = "https://azx-labs.com";
    try {
      const live = await seedApp("Prod Domain App", { deploy: true });
      const res = await t.app.inject({ method: "GET", url: "/" });
      expect(res.body).toContain(`href="https://${live.slug}.azx-labs.com"`);
    } finally {
      if (prev === undefined) delete process.env.APP_PUBLIC_BASE;
      else process.env.APP_PUBLIC_BASE = prev;
    }
  });
});
