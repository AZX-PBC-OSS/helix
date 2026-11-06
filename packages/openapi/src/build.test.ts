import { describe, expect, it } from "vitest";
import { appContracts, portalContracts, type RouteContract } from "@azx-pbc/shared/contracts";
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
});
