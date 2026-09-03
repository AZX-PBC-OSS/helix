import { describe, expect, it } from "vitest";
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
