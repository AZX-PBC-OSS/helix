import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import { RequestValidationError, parseRequest, defineRoute } from "@azx-pbc/shared/contracts";
import { errorsPlugin } from "./errors.js";

const contract = defineRoute({
  id: "testEcho",
  api: "portal",
  method: "POST",
  path: "/echo",
  auth: "none",
  tags: [],
  summary: "echo",
  body: { content: { "application/json": { schema: z.object({ name: z.string() }) } } },
  responses: {},
});

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(errorsPlugin);
  app.post("/echo", async (req) => parseRequest(contract, req).body);
  // A handler whose own response breaks its schema.
  app.get("/drift", async () => z.object({ id: z.string() }).parse({ id: 42 }));
  app.get("/request-error", async () => {
    throw new RequestValidationError("query", []);
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("portal error mapping", () => {
  it("answers 400 validation_failed when the request breaks its contract", async () => {
    const res = await app.inject({ method: "POST", url: "/echo", payload: { name: 1 } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
    expect(res.json().error.details[0].path).toEqual(["name"]);
  });

  it("answers 400 for a RequestValidationError from any request part", async () => {
    const res = await app.inject({ method: "GET", url: "/request-error" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("answers 500 internal when a handler's own value breaks its schema", async () => {
    const res = await app.inject({ method: "GET", url: "/drift" });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toEqual({ code: "internal", message: "internal server error" });
  });

  it("answers 400 for a malformed JSON body instead of a 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_failed");
  });

  it("passes through the framework's own client status", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/x-unknown" },
      payload: "x",
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("validation_failed");
  });
});
