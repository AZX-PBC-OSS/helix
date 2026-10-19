import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PortalClient } from "./client.js";
import { deployCommand } from "./commands.js";
import type { ResolvedConfig } from "./config.js";

/** `helix deploy` picks the CI route only in GitHub Actions with an ID token and no static token. */

const ACTIONS_ENV = {
  GITHUB_ACTIONS: "true",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.example/idtoken?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runtime",
};
const VERSION = {
  id: "22222222-2222-4222-8222-222222222222",
  appId: "11111111-1111-4111-8111-111111111111",
  number: 3,
  blobPrefix: "apps/x/3/",
  status: "preview",
  createdAt: "2026-10-19T00:00:00.000Z",
};

let dir: string;
let calls: { url: string; init: RequestInit }[];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "helix-deploy-ci-"));
  await writeFile(path.join(dir, "index.html"), "<p>hi</p>");
  calls = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/api/v1/config")) {
      return Response.json({
        appPublicBase: "https://example.com",
        repoDeploy: {
          enabled: true,
          audience: "https://portal.example.com",
          serverUrl: "https://github.com",
        },
      });
    }
    if (url.startsWith("https://pipelines.example/"))
      return Response.json({ value: "gh.id.token" });
    return Response.json({ version: VERSION, warnings: [] }, { status: 201 });
  });
});
afterEach(() => vi.restoreAllMocks());

const config = (over: Partial<ResolvedConfig> = {}): ResolvedConfig => ({
  portalUrl: "http://localhost:3001",
  slug: "demo",
  dir,
  ...over,
});
const authOf = (c: { init: RequestInit }) =>
  (c.init.headers as Record<string, string> | undefined)?.authorization;

describe("helix deploy route selection", () => {
  it("uses the job's OIDC token on the CI route, asking for the portal's own audience", async () => {
    await deployCommand(new PortalClient("http://localhost:3001"), config(), {}, ACTIONS_ENV);
    const tokenCall = calls.find((c) => c.url.startsWith("https://pipelines.example/"))!;
    // The configured audience, not the URL the CLI happened to be pointed at.
    expect(new URL(tokenCall.url).searchParams.get("audience")).toBe("https://portal.example.com");
    const upload = calls.at(-1)!;
    expect(upload.url).toBe("http://localhost:3001/api/v1/apps/demo/ci/versions");
    expect(authOf(upload)).toBe("Bearer gh.id.token");
  });

  it("keeps an explicit HELIX_TOKEN on the signed-in route", async () => {
    await deployCommand(
      new PortalClient("http://localhost:3001", "static"),
      config({ token: "static" }),
      {},
      ACTIONS_ENV,
    );
    expect(calls.map((c) => c.url)).toEqual(["http://localhost:3001/api/v1/apps/demo/versions"]);
    expect(authOf(calls[0]!)).toBe("Bearer static");
  });

  it("uses the signed-in route outside Actions", async () => {
    await deployCommand(new PortalClient("http://localhost:3001", "tok"), config(), {}, {});
    expect(calls.map((c) => c.url)).toEqual(["http://localhost:3001/api/v1/apps/demo/versions"]);
  });

  it("explains a missing id-token permission in Actions", async () => {
    await expect(
      deployCommand(
        new PortalClient("http://localhost:3001"),
        config(),
        {},
        { GITHUB_ACTIONS: "true" },
      ),
    ).rejects.toThrow(/id-token: write/);
    expect(calls).toEqual([]);
  });

  it("refuses --promote on the CI route before uploading", async () => {
    await expect(
      deployCommand(
        new PortalClient("http://localhost:3001"),
        config(),
        { promote: true },
        ACTIONS_ENV,
      ),
    ).rejects.toThrow(/preview/);
    expect(calls).toEqual([]);
  });

  it("points a foreign-repo refusal at the binding", async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/config")) {
        return Response.json({
          appPublicBase: "https://example.com",
          repoDeploy: {
            enabled: true,
            audience: "https://portal.example.com",
            serverUrl: "https://github.com",
          },
        });
      }
      if (url.startsWith("https://pipelines.example/")) return Response.json({ value: "t" });
      return Response.json(
        { error: { code: "forbidden", message: "this token may not deploy to this app" } },
        { status: 403 },
      );
    });
    await expect(
      deployCommand(new PortalClient("http://localhost:3001"), config(), {}, ACTIONS_ENV),
    ).rejects.toThrow(/helix ci show/);
  });
});
