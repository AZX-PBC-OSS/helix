import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { testAuthConfig, testEdgeConfig } from "../test/config.js";
import { FakeBlobReader, FakeOidcClient, FakeRegistry, FakeSessionStore } from "../test/fakes.js";
import type { OperatorSettingsReader } from "../registry/projection.js";

function buildEdge(operator: OperatorSettingsReader | null = null) {
  return buildApp({
    config: testEdgeConfig({ auth: testAuthConfig(), allowUnauthenticated: false }),
    registry: new FakeRegistry([]),
    blob: new FakeBlobReader(),
    sessions: new FakeSessionStore(),
    oidc: new FakeOidcClient(),
    operator,
  });
}

describe("GET / on the platform and auth hosts", () => {
  it.each(["local.helix.azxlabs.io", "auth.local.helix.azxlabs.io", "www.local.helix.azxlabs.io"])(
    "%s serves the about page instead of a bare 404",
    async (host) => {
      const res = await buildEdge().inject({ method: "GET", url: "/", headers: { host } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.body).toContain("Private app hosting");
      expect(res.body).toContain("It is not an email or account service.");
      expect(res.body).not.toContain("<form");
    },
  );

  it("includes the operator identity when one is set", async () => {
    const operator = {
      operatorSettings: () => ({
        name: "Example Co",
        description: "Client deliverables.",
        contactUrl: "https://example.com/contact",
      }),
    };
    const res = await buildEdge(operator).inject({
      method: "GET",
      url: "/",
      headers: { host: "local.helix.azxlabs.io" },
    });
    expect(res.body).toContain("<title>Private app hosting · Example Co</title>");
    expect(res.body).toContain("Operated by Example Co. Client deliverables.");
    expect(res.body).toContain('href="https://example.com/contact"');
  });

  it("keeps every other platform path a plain 404", async () => {
    const res = await buildEdge().inject({
      method: "GET",
      url: "/anything",
      headers: { host: "local.helix.azxlabs.io" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe("Not found\n");
  });
});
