import { describe, expect, it } from "vitest";
import { Validator } from "@seriousme/openapi-schema-validator";
import {
  appContracts,
  portalContracts,
  toOpenApiPath,
  type RouteContract,
} from "@azx-pbc/shared/contracts";
import type { z } from "zod";
import { buildDocument } from "./build.js";

const sets: [string, readonly RouteContract[]][] = [
  ["portal", portalContracts],
  ["app", appContracts],
];

describe.each(sets)("%s contracts", (api, contracts) => {
  it("have unique operation ids across both APIs", () => {
    const ids = [...portalContracts, ...appContracts].map((c) => c.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("have one contract per method and path", () => {
    const keys = contracts.map((c) => `${c.method} ${c.path}`);
    expect(keys.length).toBe(new Set(keys).size);
  });

  it("all belong to this API and sit under its prefix", () => {
    const prefix = api === "portal" ? "/api/v1/" : "/_api/";
    for (const c of contracts) {
      expect(c.api, c.id).toBe(api);
      expect(c.path.startsWith(prefix), c.id).toBe(true);
    }
  });

  it("declare a params schema with exactly the path's parameters", () => {
    for (const c of contracts) {
      const inPath = [...c.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      if (c.path.endsWith("*")) inPath.push("*");
      const declared = c.params ? Object.keys(c.params.shape) : [];
      expect(declared.sort(), c.id).toEqual(inPath.sort());
    }
  });

  it("describe every non-empty response with a media type", () => {
    for (const c of contracts) {
      for (const [status, r] of Object.entries(c.responses)) {
        expect(r.description.length, `${c.id} ${status}`).toBeGreaterThan(0);
        if (r.content)
          expect(Object.keys(r.content).length, `${c.id} ${status}`).toBeGreaterThan(0);
      }
    }
  });

  it("generate a document with every operation and resolvable component refs", () => {
    const doc = buildDocument(api as "portal" | "app");
    const ops = Object.values(doc.paths ?? {}).flatMap((item) => Object.keys(item ?? {}));
    expect(ops.length).toBe(contracts.length);

    const schemas = new Set(Object.keys(doc.components?.schemas ?? {}));
    const refs = [...JSON.stringify(doc).matchAll(/"#\/components\/schemas\/([^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const ref of refs) expect(schemas.has(ref!), ref).toBe(true);
  });

  it("is a valid OpenAPI 3.1 document under the official JSON Schema", async () => {
    const doc = JSON.parse(JSON.stringify(buildDocument(api as "portal" | "app")));
    const result = await new Validator().validate(doc);
    expect(result.errors, String(JSON.stringify(result.errors)).slice(0, 2000)).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("marks a parameter required only when omitting it is refused", () => {
    // The published `required` flag comes from the schema's input type, so a
    // schema that accepts an omitted value through `.catch()` would still be
    // published as required. Check the flag against the runtime behaviour.
    const doc = buildDocument(api as "portal" | "app");
    for (const c of contracts) {
      const item = doc.paths?.[toOpenApiPath(c.path)];
      const op = item?.[c.method.toLowerCase() as "get"];
      const parameters = (op?.parameters ?? []) as {
        in: string;
        name: string;
        required?: boolean;
      }[];
      for (const p of parameters.filter((p) => p.in === "query")) {
        const field = c.query?.shape[p.name] as z.ZodType | undefined;
        const omittable = field?.safeParse(undefined).success ?? false;
        expect(p.required ?? false, `${c.id} ?${p.name}`).toBe(!omittable);
      }
    }
  });
});

describe("app API security", () => {
  // Jobs refuse anonymous callers even on a public app, so the published
  // security must not offer the empty (anonymous) alternative.
  it("requires a session on every jobs operation", () => {
    const doc = buildDocument("app");
    const jobs = Object.entries(doc.paths ?? {}).filter(([path]) => path.startsWith("/_api/jobs/"));
    expect(jobs.length).toBeGreaterThan(0);
    for (const [path, item] of jobs) {
      for (const [method, op] of Object.entries(item ?? {})) {
        const security = (op as { security?: object[] }).security;
        expect(security, `${method} ${path}`).toEqual([{ session: [] }]);
      }
    }
  });
});
