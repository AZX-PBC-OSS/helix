import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildTestApp, type TestApp } from "../test/harness.js";

let t: TestApp;

beforeAll(async () => {
  t = buildTestApp();
  await t.app.ready();
});

afterAll(async () => {
  await t.close();
});

describe("GET /api/v1/openapi.json", () => {
  it("serves the committed portal spec without a token", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/v1/openapi.json" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    const committed = readFileSync(
      new URL("../../../../packages/openapi/spec/portal-api.json", import.meta.url),
      "utf8",
    );
    expect(res.body).toBe(committed);
    const doc = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths["/api/v1/openapi.json"]).toBeDefined();
  });
});
