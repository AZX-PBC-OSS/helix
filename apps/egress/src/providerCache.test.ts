import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionProvider } from "@azx-pbc/shared";

import { ProviderCache, type ProviderQuerier, type ProviderRow } from "./providerCache.js";

/**
 * The cache's own contract, on a fake querier: wholesale replacement per
 * revision (a reader holding an entry across a reconcile keeps a complete,
 * unmutated snapshot), fail-closed row parsing, serve-stale on a failed load,
 * and the serialized/dirty load discipline that collapses NOTIFY bursts.
 */

function providerRow(over: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: randomUUID(),
    ref: "asana",
    kind: "rest-delegated",
    displayName: "Asana",
    authorizeEndpoint: "https://vendor.example/authorize",
    tokenEndpoint: "https://vendor.example/token",
    requestedScopes: [],
    apiOrigins: ["https://app.example.com"],
    tokenPlacement: { kind: "header-bearer" },
    env: "prod",
    clientIdMaterial: "sealed-client-id",
    clientSecretMaterial: "sealed-client-secret",
    revision: 1,
    // pg hands timestamp columns back as Date objects.
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-02T03:04:05Z"),
    ...over,
  };
}

/** A querier over a mutable row list — tests swap `holder.rows` between loads. */
function querier(holder: { rows: ProviderRow[] }): ProviderQuerier & { calls: number } {
  const q = {
    calls: 0,
    query: (sql: string) => {
      q.calls += 1;
      expect(sql).toContain("connection_providers");
      return Promise.resolve({ rows: holder.rows });
    },
  };
  return q;
}

/** A querier seam that delegates to one the test can swap out mid-flight. */
function swappable(initial: ProviderQuerier): {
  seam: ProviderQuerier;
  set(next: ProviderQuerier): void;
} {
  const state: { current: ProviderQuerier } = { current: initial };
  return {
    seam: {
      query: (sql) => state.current.query(sql),
    },
    set: (next) => {
      state.current = next;
    },
  };
}

describe("ProviderCache", () => {
  it("serves parsed rows by id and by (ref, env)", async () => {
    const row = providerRow();
    const cache = new ProviderCache(querier({ rows: [row] }));
    expect(cache.isLoaded()).toBe(false);

    await cache.load();
    expect(cache.isLoaded()).toBe(true);

    const byId = cache.get(row.id);
    const byRef = cache.getByRef("asana", "prod");
    expect(byId).toBe(byRef); // one entry, two indexes
    // The stored-row parse: sealed material carried for exchange/renewal to open.
    expect(byId).toMatchObject({
      id: row.id,
      ref: "asana",
      kind: "rest-delegated",
      revision: 1,
      env: "prod",
      clientIdMaterial: "sealed-client-id",
      clientSecretMaterial: "sealed-client-secret",
      tokenPlacement: { kind: "header-bearer" },
      // Date columns normalized into the ISO strings the schema demands.
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T03:04:05.000Z",
    });
    expect(cache.getByRef("asana", "dev")).toBeUndefined();
    expect(cache.get(randomUUID())).toBeUndefined();
  });

  it("replaces entries wholesale per revision — a held snapshot is never mutated in place", async () => {
    const holder = { rows: [providerRow()] };
    const cache = new ProviderCache(querier(holder));

    await cache.load();
    const before = cache.getByRef("asana", "prod") as ConnectionProvider;
    expect(before.revision).toBe(1);

    // The sensitive edit lands as a new row from the DB (new object, new revision).
    holder.rows = [providerRow({ id: before.id, revision: 2, displayName: "Asana (edited)" })];
    await cache.load();

    const after = cache.getByRef("asana", "prod") as ConnectionProvider;
    expect(after.revision).toBe(2);
    expect(after.displayName).toBe("Asana (edited)");
    // The snapshot a reader held across the reconcile is untouched: revision
    // keying means the old entry is a complete, stable view — never an object
    // whose fields changed underneath a concurrent flow.
    expect(before.revision).toBe(1);
    expect(before.displayName).toBe("Asana");
    expect(cache.get(before.id)).toBe(after);
  });

  it("drops old revisions and deleted rows on replacement — the cache stays bounded", async () => {
    const a = providerRow({ ref: "asana" });
    const b = providerRow({ ref: "github", displayName: "GitHub" });
    const holder = { rows: [a, b] };
    const cache = new ProviderCache(querier(holder));
    await cache.load();

    // Provider `a` deleted (hard DELETE), `b` re-saved at a new revision.
    holder.rows = [providerRow({ id: b.id, ref: "github", revision: 7 })];
    await cache.load();

    expect(cache.get(a.id)).toBeUndefined();
    expect(cache.getByRef("asana", "prod")).toBeUndefined();
    expect(cache.getByRef("github", "prod")?.revision).toBe(7);
  });

  it("fails closed on a row that fails the shared parse — dropped, reported, never cached", async () => {
    const onRowDropped = vi.fn();
    const good = providerRow({ ref: "github" });
    const cache = new ProviderCache(
      querier({
        rows: [
          // Zero API destinations: `ApiOriginsSchema` requires at least one —
          // unbindable dead configuration must not masquerade as a servable row.
          providerRow({ apiOrigins: [] }),
          // An unknown kind cannot be served by this build (PROVIDER_KINDS).
          providerRow({ ref: "legacy", kind: "graphql-delegated" }),
          // An unknown env is not a tier the platform can resolve.
          providerRow({ ref: "staging", env: "staging" }),
          good,
        ],
      }),
      { onRowDropped },
    );
    await cache.load();

    expect(cache.isLoaded()).toBe(true);
    expect(cache.get(good.id)).toBeDefined();
    expect(cache.getByRef("legacy", "prod")).toBeUndefined();
    expect(cache.getByRef("staging", "prod")).toBeUndefined();
    expect(onRowDropped).toHaveBeenCalledTimes(3);
    // The report names schema paths, never values: a rejected row sits beside
    // credential material, and a log is a retained backend.
    for (const call of onRowDropped.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain("sealed");
    }
  });

  it("keeps the previous snapshot when a load fails, and reports failure then recovery", async () => {
    const row = providerRow();
    const failing: ProviderQuerier = { query: () => Promise.reject(new Error("db down")) };
    const swap = swappable(failing);
    const onLoadFailure = vi.fn();
    const onLoadRecovered = vi.fn();
    const cache = new ProviderCache(swap.seam, { onLoadFailure, onLoadRecovered });

    await cache.load();
    expect(cache.isLoaded()).toBe(false);
    expect(cache.get(row.id)).toBeUndefined();
    expect(onLoadFailure).toHaveBeenCalledTimes(1);
    expect(onLoadFailure.mock.calls[0]?.[0]).toMatchObject({
      consecutiveLoadFailures: 1,
      neverLoaded: true,
    });

    // Swap in a working querier; the next load recovers.
    swap.set(querier({ rows: [row] }));
    await cache.load();
    expect(cache.get(row.id)).toBeDefined();
    expect(onLoadRecovered).toHaveBeenCalledTimes(1);
    expect(onLoadRecovered.mock.calls[0]?.[0].failures).toBe(1);

    // And a failure after a success reports neverLoaded: false (serving stale).
    swap.set(failing);
    await cache.load();
    expect(cache.isLoaded()).toBe(true); // stale beats down
    expect(cache.get(row.id)).toBeDefined();
    expect(onLoadFailure.mock.calls[1]?.[0]).toMatchObject({
      consecutiveLoadFailures: 1,
      neverLoaded: false,
    });
  });

  it("collapses a burst of loads into one query plus at most one follow-up", async () => {
    const row = providerRow();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const cache = new ProviderCache({
      query: () => {
        calls += 1;
        return gate.then(() => ({ rows: [row] }));
      },
    });

    const first = cache.load();
    const second = cache.load();
    const third = cache.load();
    // While the first load is in flight, the burst piggybacks: one query, no
    // stacked reconciles.
    expect(calls).toBe(1);
    release?.();
    await Promise.all([first, second, third]);
    // Drain the microtask chain so the dirty follow-up (if any) has run.
    await new Promise((r) => setImmediate(r));
    expect(calls).toBe(2);

    // And once settled, a load is a fresh query again.
    await cache.load();
    expect(calls).toBe(3);
  });
});
