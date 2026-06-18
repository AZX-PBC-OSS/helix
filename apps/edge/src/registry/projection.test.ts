import { describe, expect, it } from "vitest";
import { RegistryProjection, type ProjectionQuerier } from "./projection.js";

function querierFor(rowSets: Array<Array<Record<string, unknown>> | Error>): ProjectionQuerier & {
  calls: number;
} {
  let call = 0;
  return {
    get calls() {
      return call;
    },
    query() {
      const result = rowSets[Math.min(call++, rowSets.length - 1)];
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve({ rows: result as never });
    },
  };
}

const ROW = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "demo",
  archived: false,
  blob_prefix: "apps/11111111-1111-4111-8111-111111111111/3/",
  visibility_mode: "private",
  visibility_group_id: null,
  capabilities: {},
};

describe("RegistryProjection", () => {
  it("is not loaded before the first successful load", async () => {
    const projection = new RegistryProjection(querierFor([[]]));
    expect(projection.isLoaded()).toBe(false);
    await projection.load();
    expect(projection.isLoaded()).toBe(true);
  });

  it("maps rows to entries, including archived and pointer-less apps", async () => {
    const projection = new RegistryProjection(
      querierFor([
        [
          ROW,
          { ...ROW, id: "2", slug: "old", archived: true },
          { ...ROW, id: "3", slug: "new", blob_prefix: null },
          { ...ROW, id: "4", slug: "team", visibility_mode: "group", visibility_group_id: "g1" },
        ],
      ]),
    );
    await projection.load();
    expect(projection.getApp("demo")).toEqual({
      appId: ROW.id,
      slug: "demo",
      archived: false,
      blobPrefix: ROW.blob_prefix,
      visibilityMode: "private",
      visibilityGroupId: null,
      llm: null,
      data: null,
      externalOrigins: [],
    });
    expect(projection.getApp("old")?.archived).toBe(true);
    expect(projection.getApp("new")?.blobPrefix).toBeNull();
    expect(projection.getApp("team")?.visibilityMode).toBe("group");
    expect(projection.getApp("team")?.visibilityGroupId).toBe("g1");
    expect(projection.getApp("nope")).toBeUndefined();
  });

  it("parses the capabilities.llm grant, and fails closed to null on junk", async () => {
    const projection = new RegistryProjection(
      querierFor([
        [
          {
            ...ROW,
            slug: "granted",
            capabilities: { llm: { models: ["claude-opus-4-8"], tokensPerDay: 1000 } },
          },
          { ...ROW, slug: "no-llm", capabilities: { data: { user: true } } },
          { ...ROW, slug: "bad-json", capabilities: "not-an-object" },
          { ...ROW, slug: "bad-llm", capabilities: { llm: { models: "nope" } } },
        ],
      ]),
    );
    await projection.load();
    expect(projection.getApp("granted")?.llm).toEqual({
      models: ["claude-opus-4-8"],
      tokensPerDay: 1000,
    });
    expect(projection.getApp("no-llm")?.llm).toBeNull();
    expect(projection.getApp("bad-json")?.llm).toBeNull();
    expect(projection.getApp("bad-llm")?.llm).toBeNull();
  });

  it("parses the capabilities.data grant, and fails closed to null on junk", async () => {
    const projection = new RegistryProjection(
      querierFor([
        [
          {
            ...ROW,
            slug: "granted",
            capabilities: { data: { user: true, collections: ["contacts"] } },
          },
          { ...ROW, slug: "no-data", capabilities: { llm: { models: [] } } },
          { ...ROW, slug: "bad-json", capabilities: "not-an-object" },
          { ...ROW, slug: "bad-data", capabilities: { data: { collections: "nope" } } },
        ],
      ]),
    );
    await projection.load();
    expect(projection.getApp("granted")?.data).toEqual({
      user: true,
      collections: ["contacts"],
      sharedRead: [],
      sharedWrite: [],
    });
    expect(projection.getApp("no-data")?.data).toBeNull();
    expect(projection.getApp("bad-json")?.data).toBeNull();
    expect(projection.getApp("bad-data")?.data).toBeNull();
  });

  it("parses capabilities.externalOrigins, failing closed to [] on junk", async () => {
    const projection = new RegistryProjection(
      querierFor([
        [
          { ...ROW, slug: "granted", capabilities: { externalOrigins: ["https://api.foo.com"] } },
          { ...ROW, slug: "none", capabilities: {} },
          { ...ROW, slug: "bad-json", capabilities: "not-an-object" },
        ],
      ]),
    );
    await projection.load();
    expect(projection.getApp("granted")?.externalOrigins).toEqual(["https://api.foo.com"]);
    expect(projection.getApp("none")?.externalOrigins).toEqual([]);
    expect(projection.getApp("bad-json")?.externalOrigins).toEqual([]);
  });

  it("keeps serving the previous map when a reload fails", async () => {
    const errors: unknown[] = [];
    const projection = new RegistryProjection(querierFor([[ROW], new Error("db down")]), {
      onLoadError: (err) => errors.push(err),
    });
    await projection.load();
    await projection.load(); // fails
    expect(errors).toHaveLength(1);
    expect(projection.isLoaded()).toBe(true);
    expect(projection.getApp("demo")).toBeDefined(); // stale, not gone
  });

  it("drops entries that disappear from the source", async () => {
    const projection = new RegistryProjection(querierFor([[ROW], []]));
    await projection.load();
    await projection.load();
    expect(projection.getApp("demo")).toBeUndefined();
  });

  it("collapses loads requested during an in-flight load into one follow-up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const querier: ProjectionQuerier = {
      async query() {
        calls++;
        if (calls === 1) await gate;
        return { rows: [] };
      },
    };
    const projection = new RegistryProjection(querier);
    const first = projection.load();
    const second = projection.load(); // piggybacks, marks dirty
    const third = projection.load(); // collapses into the same follow-up
    release();
    await Promise.all([first, second, third]);
    await projection.load(); // let the dirty follow-up settle deterministically
    expect(calls).toBeLessThanOrEqual(3); // never one query per request
  });
});
