import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { HealthStatusSchema } from "@azx-pbc/shared";
import { buildApp } from "./app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("GET /health returns a valid health status for helix-portal", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });

  expect(res.statusCode).toBe(200);
  const parsed = HealthStatusSchema.parse(res.json());
  expect(parsed.service).toBe("helix-portal");
});

/**
 * The SPA's OIDC redirect URI is `/auth/callback?code=…` on this origin, so the
 * portal handles the same URL-borne credential the edge does. `spaDist: null`
 * forces the no-SPA path, where that request reaches the 404 envelope — the one
 * place the portal echoes a request URL back out (issue #20).
 */
it("does not echo an authorization code into the 404 envelope", async () => {
  const noSpa = buildApp({ spaDist: null });
  await noSpa.ready();
  try {
    const res = await noSpa.inject({
      method: "GET",
      url: "/auth/callback?code=SENTINEL_AUTHZ_CODE&state=xyz",
    });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("SENTINEL_AUTHZ_CODE");
    expect(res.json().error.message).toBe(
      "route GET /auth/callback?code=REDACTED&state=xyz not found",
    );
  } finally {
    await noSpa.close();
  }
});
