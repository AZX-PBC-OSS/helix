import { afterAll, beforeAll, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { HealthStatusSchema } from "@helix/shared";
import { buildApp } from "./app.js";

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

it("GET /health returns a valid health status for azx-edge", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });

  expect(res.statusCode).toBe(200);
  const parsed = HealthStatusSchema.parse(res.json());
  expect(parsed.service).toBe("azx-edge");
});
