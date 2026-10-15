import { describe, expect, it } from "vitest";
import { JobsGenerationSchema } from "@azx-pbc/shared";
import {
  RegistryProjection,
  type ProjectionClock,
  type ProjectionQuerier,
  type RegistryLoadFailure,
  type RegistryLoadRecovery,
} from "./projection.js";

/**
 * Controllable clock so freshness assertions don't need fake timers. The two
 * hands move independently on purpose — that's how the "wall clock went
 * backwards" case is expressed.
 */
function fakeClock(startMs = 1_000): ProjectionClock & {
  advance(ms: number): void;
  setWallClock(iso: string): void;
} {
  let mono = startMs;
  let iso = "2026-07-30T12:00:00.000Z";
  return {
    monotonicMs: () => mono,
    wallClockIso: () => iso,
    advance(ms) {
      mono += ms;
    },
    setWallClock(next) {
      iso = next;
    },
  };
}

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
  visibility_mode: "internal",
  visibility_group_ids: [],
  capabilities: {},
  jobs_generation: 1,
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
          { ...ROW, id: "4", slug: "team", visibility_mode: "group", visibility_group_ids: ["g1"] },
        ],
      ]),
    );
    await projection.load();
    expect(projection.getApp("demo")).toEqual({
      appId: ROW.id,
      slug: "demo",
      archived: false,
      blobPrefix: ROW.blob_prefix,
      visibilityMode: "internal",
      visibilityGroupIds: [],
      llm: null,
      data: null,
      externalOrigins: [],
      fetch: { connections: new Map(), requestsPerDay: null, shim: false },
      offline: null,
      shim: null,
      jobs: null,
      jobsGeneration: "1",
    });
    expect(projection.getApp("old")?.archived).toBe(true);
    expect(projection.getApp("new")?.blobPrefix).toBeNull();
    expect(projection.getApp("team")?.visibilityMode).toBe("group");
    expect(projection.getApp("team")?.visibilityGroupIds).toEqual(["g1"]);
    expect(projection.getApp("nope")).toBeUndefined();
  });

  it("parses the capabilities.llm grant, and fails closed to null on junk", async () => {
    const projection = new RegistryProjection(
      querierFor([
        [
          {
            ...ROW,
            slug: "granted",
            capabilities: { llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 } },
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
      dollarsPerDay: 10,
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
            capabilities: {
              // The write prefix carries its bound (ADR-0042 review finding 3):
              // the schema refuses one without the other, and this parse is
              // that same schema — fail-closed below.
              data: {
                user: true,
                collections: ["contacts"],
                sharedWritePrefixes: ["record:"],
                writesPerDay: 5000,
              },
            },
          },
          { ...ROW, slug: "no-data", capabilities: { llm: { models: [] } } },
          { ...ROW, slug: "bad-json", capabilities: "not-an-object" },
          { ...ROW, slug: "bad-data", capabilities: { data: { collections: "nope" } } },
          // ADR-0042: a prefix element that violates the key rules fails the
          // whole data parse — the projection hands the gateway `null` and every
          // data verb 403s, rather than serving a grant the schema refused.
          {
            ...ROW,
            slug: "bad-prefix",
            capabilities: { data: { sharedReadPrefixes: [""] } },
          },
          // ADR-0043: same fail-closed path for a non-printable-ASCII grant —
          // a row the portal can no longer write (a homoglyph or bidi control
          // in a grant string), projected closed rather than served.
          {
            ...ROW,
            slug: "non-ascii-grant",
            capabilities: { data: { sharedRead: ["設定"] } },
          },
          // A write prefix without its writesPerDay bound fails the same way —
          // a row the portal can no longer write, projected closed.
          {
            ...ROW,
            slug: "unbounded-write-prefix",
            capabilities: { data: { sharedWritePrefixes: ["record:"] } },
          },
        ],
      ]),
    );
    await projection.load();
    expect(projection.getApp("granted")?.data).toEqual({
      user: true,
      collections: ["contacts"],
      sharedRead: [],
      sharedWrite: [],
      sharedReadPrefixes: [],
      sharedWritePrefixes: ["record:"],
      writesPerDay: 5000,
    });
    expect(projection.getApp("no-data")?.data).toBeNull();
    expect(projection.getApp("bad-json")?.data).toBeNull();
    expect(projection.getApp("bad-data")?.data).toBeNull();
    expect(projection.getApp("bad-prefix")?.data).toBeNull();
    expect(projection.getApp("non-ascii-grant")?.data).toBeNull();
    expect(projection.getApp("unbounded-write-prefix")?.data).toBeNull();
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

  it("a jobs grant rides the whole-capabilities parse without degrading any other grant", async () => {
    // `parseExternalOrigins` is the one parser that reads the WHOLE capabilities
    // blob through the shared schema, so the jobs block's acceptability there is
    // load-bearing: a schema drift that stopped accepting a stored grant would
    // fail the whole parse and silently zero this app's CSP origins. A valid
    // grant — including a withdrawn type no deployment offers, the state
    // preservation exists to protect — must project with every other grant
    // intact, and only a MALFORMED block may degrade (fail-closed), never the
    // load itself.
    const projection = new RegistryProjection(
      querierFor([
        [
          {
            ...ROW,
            slug: "jobs-and-grants",
            capabilities: {
              llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 },
              data: { user: true },
              externalOrigins: ["https://api.foo.com"],
              fetch: { shim: false, origins: [{ origin: "https://proxy.example.com" }] },
              offline: { scope: "/app/" },
              jobs: { types: ["jobs:fetch"] },
            },
          },
          {
            ...ROW,
            slug: "withdrawn-type",
            capabilities: {
              externalOrigins: ["https://api.foo.com"],
              jobs: { types: ["legacy:thing"] },
            },
          },
          {
            ...ROW,
            slug: "malformed-jobs",
            capabilities: {
              externalOrigins: ["https://api.foo.com"],
              jobs: { types: [] },
            },
          },
        ],
      ]),
    );
    await projection.load();
    const granted = projection.getApp("jobs-and-grants");
    expect(granted?.llm).toEqual({ models: ["claude-opus-4-8"], dollarsPerDay: 10 });
    expect(granted?.data).toEqual({
      user: true,
      collections: [],
      sharedRead: [],
      sharedWrite: [],
      sharedReadPrefixes: [],
      sharedWritePrefixes: [],
    });
    expect(granted?.externalOrigins).toEqual(["https://api.foo.com"]);
    expect(granted?.fetch.connections.get("https://proxy.example.com")).toEqual({
      kind: "keyless",
    });
    expect(granted?.offline).toEqual({ scope: "/app/" });
    expect(projection.getApp("withdrawn-type")?.externalOrigins).toEqual(["https://api.foo.com"]);
    // The malformed block fails the whole-blob parse: the origins degrade to []
    // (fail-closed, the documented posture for junk) and the load survives.
    expect(projection.getApp("malformed-jobs")?.externalOrigins).toEqual([]);
  });

  // The jobs grant's own projection (the effective grant the jobs gateway and
  // the callback fence read): present-as-stored, null when absent or refused,
  // never load-failing.
  describe("jobs grant", () => {
    it("projects the stored grant, preserving withdrawn types, and fails closed to null on junk", async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            // A granted block rides as stored — including a withdrawn type no
            // deployment offers, the state grant preservation exists to protect.
            {
              ...ROW,
              slug: "granted",
              capabilities: { jobs: { types: ["jobs:fetch", "legacy:thing"] } },
            },
            { ...ROW, slug: "absent", capabilities: {} },
            { ...ROW, slug: "bad-json", capabilities: "not-an-object" },
            // Malformed variants — each must deny (null), never open:
            { ...ROW, slug: "empty-types", capabilities: { jobs: { types: [] } } },
            // No budget/capacity field exists; a stored one is a row the portal
            // can no longer write, projected closed rather than shed.
            {
              ...ROW,
              slug: "budget-field",
              capabilities: { jobs: { types: ["jobs:fetch"], jobsPerDay: 5 } },
            },
            // Grants name types, never patterns.
            { ...ROW, slug: "wildcard", capabilities: { jobs: { types: ["jobs:*"] } } },
            { ...ROW, slug: "wrong-shape", capabilities: { jobs: { types: "nope" } } },
            // A malformed jobs block must not degrade an unrelated grant's
            // projection — each capability parses independently.
            {
              ...ROW,
              slug: "others-intact",
              capabilities: {
                llm: { models: ["claude-opus-4-8"], dollarsPerDay: 10 },
                jobs: { types: "nope" },
              },
            },
          ],
        ]),
      );
      await projection.load();
      expect(projection.getApp("granted")?.jobs).toEqual({
        types: ["jobs:fetch", "legacy:thing"],
      });
      for (const slug of [
        "absent",
        "bad-json",
        "empty-types",
        "budget-field",
        "wildcard",
        "wrong-shape",
      ]) {
        expect(projection.getApp(slug)?.jobs, slug).toBeNull();
      }
      expect(projection.getApp("others-intact")?.jobs).toBeNull();
      expect(projection.getApp("others-intact")?.llm).toEqual({
        models: ["claude-opus-4-8"],
        dollarsPerDay: 10,
      });
    });
  });

  // The lifecycle generation: the portal's authority carried in its one shared
  // wire form — a canonical decimal string, exactly what `JobsGenerationSchema`
  // signs and compares. A drifted row fences closed ("0") rather than being
  // repaired into a plausible value.
  describe("jobs generation", () => {
    it("projects the integer column as the canonical decimal string", async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            { ...ROW, slug: "initial", jobs_generation: 1 },
            { ...ROW, slug: "bumped", jobs_generation: 7 },
            { ...ROW, slug: "large", jobs_generation: 123456 },
          ],
        ]),
      );
      await projection.load();
      expect(projection.getApp("initial")?.jobsGeneration).toBe("1");
      expect(projection.getApp("bumped")?.jobsGeneration).toBe("7");
      expect(projection.getApp("large")?.jobsGeneration).toBe("123456");
    });

    it('fails closed to "0" — a generation matching nothing — on an unusable value', async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            // "007" is a second wire form of 7, so it is malformed, not a value
            // to repair (the shared schema refuses it the same way).
            { ...ROW, slug: "padded", jobs_generation: "007" },
            { ...ROW, slug: "negative", jobs_generation: -3 },
            { ...ROW, slug: "fractional", jobs_generation: 1.5 },
            { ...ROW, slug: "null", jobs_generation: null },
            { ...ROW, slug: "string", jobs_generation: "many" },
          ],
        ]),
      );
      await projection.load();
      for (const slug of ["padded", "negative", "fractional", "null", "string"]) {
        expect(projection.getApp(slug)?.jobsGeneration, slug).toBe("0");
      }
      // The fail-closed value is itself schema-canonical: a fence can put it
      // through the shared generation schema without a special case.
      expect(
        JobsGenerationSchema.safeParse(projection.getApp("padded")?.jobsGeneration).success,
      ).toBe(true);
    });

    it("carries the column's real boundaries: int4 max stays canonical, a drifted 0 or beyond-safe value fences closed", async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            // The largest value the real INTEGER column can deliver — a
            // projection that wrapped bitwise or truncated would corrupt
            // exactly here while every small value kept passing.
            { ...ROW, slug: "int4-max", jobs_generation: 2147483647 },
            // 0 is below every real generation (the initial one is 1): whether
            // it arrives as drift or a direct UPDATE, it must project the
            // sentinel — never be "repaired" into a plausible "1".
            { ...ROW, slug: "zero", jobs_generation: 0 },
            // Past MAX_SAFE_INTEGER the number itself is untrustworthy.
            { ...ROW, slug: "beyond-safe", jobs_generation: 2 ** 53 },
          ],
        ]),
      );
      await projection.load();
      expect(projection.getApp("int4-max")?.jobsGeneration).toBe("2147483647");
      expect(
        JobsGenerationSchema.safeParse(projection.getApp("int4-max")?.jobsGeneration).success,
      ).toBe(true);
      expect(projection.getApp("zero")?.jobsGeneration).toBe("0");
      expect(projection.getApp("beyond-safe")?.jobsGeneration).toBe("0");
    });
  });

  // One row the parsers cannot read must degrade that row's capabilities and
  // nothing else — not fail the whole load. This is the shared mechanism behind
  // every per-capability fail-closed matrix above: the capabilities column is
  // NOT NULL in the portal's schema, so a NULL here is only reachable through
  // drift (an older build, a migration), which is exactly when the projection
  // must keep serving every other app.
  it("a row whose capabilities column is NULL projects every capability closed, and still loads", async () => {
    const projection = new RegistryProjection(
      querierFor([[{ ...ROW, slug: "null-caps", capabilities: null }]]),
    );
    await projection.load();
    expect(projection.isLoaded()).toBe(true);
    expect(projection.getApp("null-caps")).toEqual({
      appId: ROW.id,
      slug: "null-caps",
      archived: false,
      blobPrefix: ROW.blob_prefix,
      visibilityMode: "internal",
      visibilityGroupIds: [],
      llm: null,
      data: null,
      externalOrigins: [],
      fetch: { connections: new Map(), requestsPerDay: null, shim: false },
      offline: null,
      shim: null,
      jobs: null,
      // The generation is a separate column: it must project normally even
      // when the capabilities blob is unreadable.
      jobsGeneration: "1",
    });
  });

  it("parses capabilities.offline, and fails closed to null on anything illegal", async () => {
    // The portal already refuses these on write. This asserts the edge refuses
    // them again on read (ADR-0035): a row written by an older build, a
    // migration, or a direct UPDATE must never hand the worker root scope or a
    // platform namespace, because this value becomes a response header.
    const projection = new RegistryProjection(
      querierFor([
        [
          { ...ROW, slug: "granted", capabilities: { offline: { scope: "/app/" } } },
          { ...ROW, slug: "none", capabilities: {} },
          { ...ROW, slug: "bad-json", capabilities: "not-an-object" },
          { ...ROW, slug: "root", capabilities: { offline: { scope: "/" } } },
          { ...ROW, slug: "auth-ns", capabilities: { offline: { scope: "/_auth/" } } },
          { ...ROW, slug: "api-ns", capabilities: { offline: { scope: "/_api/" } } },
          { ...ROW, slug: "traversal", capabilities: { offline: { scope: "/app/../" } } },
          { ...ROW, slug: "encoded", capabilities: { offline: { scope: "/app%2f/" } } },
          { ...ROW, slug: "no-slash", capabilities: { offline: { scope: "/app" } } },
          { ...ROW, slug: "wrong-type", capabilities: { offline: { scope: 42 } } },
          { ...ROW, slug: "empty", capabilities: { offline: {} } },
        ],
      ]),
    );
    await projection.load();
    expect(projection.getApp("granted")?.offline).toEqual({ scope: "/app/" });
    for (const slug of [
      "none",
      "bad-json",
      "root",
      "auth-ns",
      "api-ns",
      "traversal",
      "encoded",
      "no-slash",
      "wrong-type",
      "empty",
    ]) {
      expect(projection.getApp(slug)?.offline, slug).toBeNull();
    }
  });

  // The fetch grant's parse: the widened credential view —
  // keyless | secret name | provider binding — is manifest data only, fails
  // closed, and leaves the keyless/secret/shim meanings exactly as before.
  describe("fetch grant", () => {
    it("projects each origin's credential source: keyless, secret-bound, or provider-bound", async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            {
              ...ROW,
              slug: "mixed",
              capabilities: {
                fetch: {
                  origins: [
                    // Provider binding with the display metadata the manifest
                    // declares (the `required` dependency hint)…
                    { origin: "https://api.asana.com", provider: "asana", required: true },
                    // …and without — normalized to `false`, never undefined.
                    { origin: "https://gitlab.example.com", provider: "gitlab" },
                    // Keyless stays a keyless proxied origin.
                    { origin: "https://api.github.com" },
                    // Secret-bound keeps its secret name.
                    { origin: "https://api.stripe.com", connection: "stripe" },
                  ],
                },
              },
            },
          ],
        ]),
      );
      await projection.load();
      expect(projection.getApp("mixed")?.fetch).toEqual({
        connections: new Map([
          ["https://api.asana.com", { kind: "provider", provider: "asana", required: true }],
          ["https://gitlab.example.com", { kind: "provider", provider: "gitlab", required: false }],
          ["https://api.github.com", { kind: "keyless" }],
          ["https://api.stripe.com", { kind: "secret", connection: "stripe" }],
        ]),
        requestsPerDay: null,
        shim: false,
      });
    });

    it("carries the shim flag through the legacy boolean unchanged", async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            { ...ROW, slug: "on", capabilities: { fetch: { shim: true, origins: [] } } },
            { ...ROW, slug: "off", capabilities: { fetch: { origins: [] } } },
          ],
        ]),
      );
      await projection.load();
      expect(projection.getApp("on")?.fetch.shim).toBe(true);
      expect(projection.getApp("off")?.fetch.shim).toBe(false);
    });

    it("never represents both credential sources for one origin — the schema refuses it, the grant degrades to empty", async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            {
              ...ROW,
              slug: "both",
              capabilities: {
                fetch: {
                  origins: [
                    { origin: "https://api.asana.com", connection: "s", provider: "asana" },
                  ],
                },
              },
            },
          ],
        ]),
      );
      await projection.load();
      expect(projection.getApp("both")?.fetch).toEqual({
        connections: new Map(),
        requestsPerDay: null,
        shim: false,
      });
    });

    it("degrades to an empty grant on malformed capabilities without failing the load", async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            { ...ROW, slug: "bad-json", capabilities: "not-an-object" },
            { ...ROW, slug: "bad-fetch", capabilities: { fetch: { origins: "nope" } } },
            // A malformed provider ref fails the strict origin schema, so the
            // whole grant degrades closed — never a half-parsed binding.
            {
              ...ROW,
              slug: "bad-provider-ref",
              capabilities: {
                fetch: { origins: [{ origin: "https://api.asana.com", provider: "NOT_A_REF" }] },
              },
            },
          ],
        ]),
      );
      await projection.load();
      expect(projection.isLoaded()).toBe(true);
      for (const slug of ["bad-json", "bad-fetch", "bad-provider-ref"]) {
        expect(projection.getApp(slug)?.fetch, slug).toEqual({
          connections: new Map(),
          requestsPerDay: null,
          shim: false,
        });
      }
    });

    it("keeps requestsPerDay on the widened shape", async () => {
      const projection = new RegistryProjection(
        querierFor([
          [
            {
              ...ROW,
              slug: "budgeted",
              capabilities: { fetch: { origins: [], requestsPerDay: 5000 } },
            },
          ],
        ]),
      );
      await projection.load();
      expect(projection.getApp("budgeted")?.fetch.requestsPerDay).toBe(5000);
    });
  });

  it("keeps serving the previous map when a reload fails", async () => {
    const failures: RegistryLoadFailure[] = [];
    const projection = new RegistryProjection(querierFor([[ROW], new Error("db down")]), {
      onLoadFailure: (info) => failures.push(info),
    });
    await projection.load();
    await projection.load(); // fails
    expect(failures).toHaveLength(1);
    expect((failures[0]?.err as Error).message).toBe("db down");
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

// ADR-0025 item 1: the state that makes "serves stale forever, silently"
// impossible. Serving behaviour above is unchanged — this is purely the signal.
describe("RegistryProjection freshness", () => {
  it("reports nothing loaded before the first load", () => {
    const projection = new RegistryProjection(querierFor([[ROW]]), { clock: fakeClock() });
    expect(projection.freshness()).toEqual({
      loaded: false,
      lastSuccessfulLoadAt: null,
      staleForMs: null,
      consecutiveLoadFailures: 0,
      lastLoadFailureAt: null,
    });
  });

  it("stamps both clocks on a successful load and ages the copy monotonically", async () => {
    const clock = fakeClock();
    const projection = new RegistryProjection(querierFor([[ROW]]), { clock });
    await projection.load();
    expect(projection.freshness()).toMatchObject({
      loaded: true,
      lastSuccessfulLoadAt: "2026-07-30T12:00:00.000Z",
      staleForMs: 0,
      consecutiveLoadFailures: 0,
    });
    clock.advance(90_000);
    expect(projection.freshness().staleForMs).toBe(90_000);
  });

  it("counts consecutive failures and resets the counter on the next success", async () => {
    const clock = fakeClock();
    const projection = new RegistryProjection(
      querierFor([[ROW], new Error("down"), new Error("down"), [ROW]]),
      { clock },
    );
    await projection.load();
    clock.advance(60_000);
    await projection.load();
    expect(projection.freshness().consecutiveLoadFailures).toBe(1);
    clock.advance(60_000);
    await projection.load();
    expect(projection.freshness()).toMatchObject({
      consecutiveLoadFailures: 2,
      staleForMs: 120_000, // still aging off the last SUCCESS, not the last attempt
      lastSuccessfulLoadAt: "2026-07-30T12:00:00.000Z",
    });
    clock.advance(60_000);
    await projection.load(); // recovers
    expect(projection.freshness()).toMatchObject({
      consecutiveLoadFailures: 0,
      staleForMs: 0,
    });
    // The failure timestamp survives recovery — it's the "when did this last go
    // wrong" an operator reads after the fact.
    expect(projection.freshness().lastLoadFailureAt).not.toBeNull();
  });

  it("hands onLoadFailure the counter and the last-good stamp, for the log event", async () => {
    const clock = fakeClock();
    const failures: RegistryLoadFailure[] = [];
    const projection = new RegistryProjection(
      querierFor([[ROW], new Error("db down"), new Error("db down")]),
      { clock, onLoadFailure: (info) => failures.push(info) },
    );
    await projection.load();
    clock.advance(61_000);
    await projection.load();
    await projection.load();
    expect(failures.map((f) => f.consecutiveLoadFailures)).toEqual([1, 2]);
    expect(failures[0]).toMatchObject({
      staleForMs: 61_000,
      lastSuccessfulLoadAt: "2026-07-30T12:00:00.000Z",
    });
  });

  it("fires onLoadRecovered once, with the failure count and how long it was stale", async () => {
    const clock = fakeClock();
    const recoveries: RegistryLoadRecovery[] = [];
    const projection = new RegistryProjection(
      querierFor([[ROW], new Error("down"), new Error("down"), [ROW], [ROW]]),
      { clock, onLoadRecovered: (info) => recoveries.push(info) },
    );
    await projection.load(); // first load: not a "recovery", nothing preceded it
    expect(recoveries).toHaveLength(0);
    await projection.load();
    await projection.load();
    clock.advance(300_000);
    await projection.load(); // recovers
    await projection.load(); // a second clean load must NOT re-announce
    expect(recoveries).toEqual([{ failures: 2, staleForMs: 300_000 }]);
  });

  // A reporting hook must never be able to change the load's outcome — it is the
  // freshness state that /health and the whole alert ladder grade against.
  it("does not turn a successful load into a reported failure when the log sink throws", async () => {
    const failures: RegistryLoadFailure[] = [];
    const projection = new RegistryProjection(querierFor([[ROW], new Error("db down"), [ROW]]), {
      clock: fakeClock(),
      onLoadFailure: (info) => failures.push(info),
      onLoadRecovered: () => {
        throw new Error("logger destination failed");
      },
    });
    await projection.load(); // succeeds
    await projection.load(); // fails
    await expect(projection.load()).resolves.toBeUndefined(); // recovers; sink throws

    // The recovery genuinely happened, so the counters must say so.
    expect(projection.freshness()).toMatchObject({
      loaded: true,
      consecutiveLoadFailures: 0,
      staleForMs: 0,
    });
    // Pre-fix this was [1, 2]: the throw fell into the catch and reported a
    // second failure for a load that had already swapped the map successfully.
    expect(failures.map((f) => f.consecutiveLoadFailures)).toEqual([1]);
    expect(projection.getApp("demo")).toBeDefined();
  });

  it("does not reject load() when the failure sink throws", async () => {
    const projection = new RegistryProjection(querierFor([[ROW], new Error("db down")]), {
      clock: fakeClock(),
      onLoadFailure: () => {
        throw new Error("logger destination failed");
      },
    });
    await projection.load();
    // Pre-fix this rejected — which rejects LiveRegistry.start() on the boot
    // path and becomes an unhandled rejection on the timer paths.
    await expect(projection.load()).resolves.toBeUndefined();
    expect(projection.freshness().consecutiveLoadFailures).toBe(1);
    expect(projection.getApp("demo")).toBeDefined(); // still serving the stale copy
  });

  it("does not wedge the in-flight latch when an observer throws", async () => {
    const querier = querierFor([[ROW], new Error("db down"), [ROW]]);
    const projection = new RegistryProjection(querier, {
      clock: fakeClock(),
      onLoadFailure: () => {
        throw new Error("logger destination failed");
      },
    });
    await projection.load();
    await projection.load(); // fails, observer throws
    const before = querier.calls;
    await projection.load(); // must still issue a query
    expect(querier.calls).toBeGreaterThan(before);
  });

  it("ages the copy off the monotonic clock even when the wall clock jumps back", async () => {
    const clock = fakeClock();
    const projection = new RegistryProjection(querierFor([[ROW]]), { clock });
    await projection.load();
    // An NTP step drags wall-clock time backwards while real time moves forward.
    clock.advance(120_000);
    clock.setWallClock("2026-07-30T09:00:00.000Z");
    // Staleness must not be negative, zero, or otherwise flattered by the jump.
    expect(projection.freshness().staleForMs).toBe(120_000);
  });
});
