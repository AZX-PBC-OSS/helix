import { describe, expect, it } from "vitest";
import { buildServiceWorkerScript, buildTombstoneScript } from "./serviceWorker.js";

/**
 * Behavioural tests for the generated service worker, run in a hand-rolled
 * service-worker global scope.
 *
 * The rest of the suite asserts on the script as a *string*, which is enough to
 * pin that a branch exists but blind to what it does — the dual review found
 * three worker bugs (a global `caches.match()` that searched the app's own
 * caches, a backfill that could never cache the document, a cap that bounded
 * nothing) and no string assertion would have caught any of them. A browser
 * would be better still; this at least exercises the logic.
 *
 * Node 24 supplies real `Request`/`Response`/`Headers`, so only the SW-specific
 * surface is faked: `caches`, `clients`, `registration`, and the event objects.
 */

// ── the fake ─────────────────────────────────────────────────────────────────

const ORIGIN = "https://app.local.helix.azxlabs.io";

class FakeCache {
  entries = new Map<string, Response>();
  match(req: Request | string): Promise<Response | undefined> {
    const key = typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
    return Promise.resolve(this.entries.get(key));
  }
  put(req: Request | string, res: Response): Promise<void> {
    const key = typeof req === "string" ? new URL(req, ORIGIN).href : req.url;
    this.entries.set(key, res);
    return Promise.resolve();
  }
  keys(): Promise<Request[]> {
    return Promise.resolve([...this.entries.keys()].map((u) => new Request(u)));
  }
}

class FakeCacheStorage {
  caches = new Map<string, FakeCache>();
  open(name: string): Promise<FakeCache> {
    let c = this.caches.get(name);
    if (!c) {
      c = new FakeCache();
      this.caches.set(name, c);
    }
    return Promise.resolve(c);
  }
  keys(): Promise<string[]> {
    return Promise.resolve([...this.caches.keys()]);
  }
  delete(name: string): Promise<boolean> {
    return Promise.resolve(this.caches.delete(name));
  }
  /**
   * The global `caches.match()` — queries EVERY cache in creation order, which
   * is exactly the trap the worker must not fall into. Faithfully implemented
   * so a regression to it fails a test rather than passing one.
   */
  async match(req: Request | string): Promise<Response | undefined> {
    for (const c of this.caches.values()) {
      const hit = await c.match(req);
      if (hit) return hit;
    }
    return undefined;
  }
}

interface Harness {
  caches: FakeCacheStorage;
  /** Dispatch a fetch event; resolves to the response, or null if not handled. */
  fetchEvent(request: Request): Promise<Response | null>;
  message(data: unknown): Promise<void>;
  activate(): Promise<void>;
  /** URLs the worker went to the network for. */
  network: string[];
  unregistered: boolean;
}

function runWorker(
  script: string,
  opts: { respond?: (req: Request) => Response | Promise<Response> } = {},
): Harness {
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const cacheStorage = new FakeCacheStorage();
  const network: string[] = [];
  const state = { unregistered: false };

  const respond =
    opts.respond ??
    ((req: Request) =>
      new Response(`body:${new URL(req.url).pathname}`, {
        status: 200,
        headers: { "content-type": "text/html" },
      }));

  const fakeFetch = async (input: Request | string): Promise<Response> => {
    const req = typeof input === "string" ? new Request(new URL(input, ORIGIN)) : input;
    network.push(new URL(req.url).pathname);
    const res = await respond(req);
    // `type` is readonly on a real Response; the worker's `storable()` reads it.
    Object.defineProperty(res, "type", { value: "basic", configurable: true });
    return res;
  };

  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, fn: (e: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
    },
    skipWaiting() {},
    clients: { claim: () => Promise.resolve(), matchAll: () => Promise.resolve([]) },
    registration: {
      scope: `${ORIGIN}/app/`,
      unregister: () => {
        state.unregistered = true;
        return Promise.resolve(true);
      },
    },
  };

  // The worker is a generated string; running it is the whole point here.
  new Function("self", "caches", "fetch", script)(self, cacheStorage, fakeFetch);

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    const e = { ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) };
    for (const fn of listeners.get(type) ?? []) fn(e);
    await Promise.all(waits);
  };

  return {
    caches: cacheStorage,
    network,
    get unregistered() {
      return state.unregistered;
    },
    async fetchEvent(request: Request): Promise<Response | null> {
      let responded: Promise<Response> | null = null;
      const e = {
        request,
        respondWith: (p: Promise<Response>) => {
          responded = p;
        },
        waitUntil: () => {},
      };
      for (const fn of listeners.get("fetch") ?? []) fn(e);
      return responded === null ? null : await responded;
    },
    message: (data: unknown) => dispatch("message", { data, ports: [], source: null }),
    activate: () => dispatch("activate", {}),
  };
}

const WORKER = buildServiceWorkerScript({ scope: "/app/", cacheVersion: "apps/x/1/" });
const CACHE = "helix:apps/x/1/";
const req = (path: string, init?: RequestInit) => new Request(new URL(path, ORIGIN), init);

/**
 * A navigation request. `mode: "navigate"` is rejected by the `Request`
 * constructor — only the browser mints those — so this is the minimal shape the
 * worker actually reads (`method`, `url`, `mode`), which is also all the fake
 * `fetch` and `Cache` need.
 */
const navReq = (path: string) =>
  ({
    method: "GET",
    url: new URL(path, ORIGIN).href,
    mode: "navigate",
    headers: new Headers(),
  }) as unknown as Request;

// ── the tests ────────────────────────────────────────────────────────────────

describe("worker: what it will and will not handle", () => {
  it("ignores the platform namespaces even though they reach the fetch event", async () => {
    const h = runWorker(WORKER);
    for (const path of ["/_api/me", "/_auth/complete?token=x", "/_helix/sw.js"]) {
      expect(await h.fetchEvent(req(path)), path).toBeNull();
    }
  });

  it("ignores anything outside the scope, cross-origin, or non-GET", async () => {
    const h = runWorker(WORKER);
    expect(await h.fetchEvent(req("/elsewhere/x"))).toBeNull();
    expect(await h.fetchEvent(new Request("https://cdn.example.com/lib.js"))).toBeNull();
    expect(await h.fetchEvent(req("/app/x", { method: "POST" }))).toBeNull();
  });

  it("handles an in-scope GET", async () => {
    const h = runWorker(WORKER);
    expect(await h.fetchEvent(req("/app/main.js"))).not.toBeNull();
  });
});

describe("worker: cache reads never escape the versioned cache (review #3)", () => {
  it("does not serve an app-owned cache entry for an in-scope URL", async () => {
    // The app's own cache is invisible to `activate`'s eviction (it only drops
    // `helix:*`) but WOULD be visible to a global `caches.match()`. If it were
    // consulted, an app-written entry would be served cache-first forever —
    // across promotes and rollbacks — and un-shipping an asset on that device
    // would become impossible.
    const h = runWorker(WORKER);
    const appCache = await h.caches.open("demo-payload");
    await appCache.put(req("/app/payload.json"), new Response("POISONED"));

    const res = await h.fetchEvent(req("/app/payload.json"));
    expect(await res?.text()).toBe("body:/app/payload.json");
    expect(h.network).toContain("/app/payload.json");
    // And the global lookup really would have found it — the fake is faithful.
    expect(await (await h.caches.match(req("/app/payload.json")))?.text()).toBe("POISONED");
  });

  it("serves a second request for the same asset from its own cache", async () => {
    const h = runWorker(WORKER);
    await h.fetchEvent(req("/app/main.js"));
    await h.fetchEvent(req("/app/main.js"));
    expect(h.network.filter((p) => p === "/app/main.js")).toHaveLength(1);
  });
});

describe("worker: first-visit backfill (review #4, #7)", () => {
  it("caches the document with an HTML Accept, so one visit is enough", async () => {
    // A plain `new Request(url)` sends `*/*`; for a scoped app the document URL
    // is the scope root, which the edge only resolves for an HTML-accepting
    // request. Without a distinct Accept the one URL that matters 404s and cold
    // boot silently needs a second visit.
    const seen: string[] = [];
    const h = runWorker(WORKER, {
      respond: (r) => {
        seen.push(r.headers.get("accept") ?? "");
        return new Response("shell", { status: 200 });
      },
    });
    await h.message({ type: "helix:precache", urls: [], document: `${ORIGIN}/app/` });

    const cache = await h.caches.open(CACHE);
    expect(await cache.match(`${ORIGIN}/app/`)).toBeTruthy();
    expect(seen[0]).toContain("text/html");
  });

  it("keeps */* for subresources, so an asset miss cannot cache the shell", async () => {
    const accepts = new Map<string, string>();
    const h = runWorker(WORKER, {
      respond: (r) => {
        accepts.set(new URL(r.url).pathname, r.headers.get("accept") ?? "");
        return new Response("x", { status: 200 });
      },
    });
    await h.message({
      type: "helix:precache",
      urls: [`${ORIGIN}/app/main.js`],
      document: `${ORIGIN}/app/`,
    });
    expect(accepts.get("/app/")).toContain("text/html");
    expect(accepts.get("/app/main.js")).not.toContain("text/html");
  });

  it("filters the page-supplied list by the same rules as live traffic", async () => {
    const h = runWorker(WORKER);
    await h.message({
      type: "helix:precache",
      urls: [`${ORIGIN}/_api/me`, `${ORIGIN}/elsewhere/x`, "https://evil.example.com/x", 42],
    });
    expect(h.network).toEqual([]);
  });

  it("runs at most once per lifetime, so a loop cannot unbound the cap", async () => {
    const h = runWorker(WORKER);
    await h.message({ type: "helix:precache", urls: [`${ORIGIN}/app/a.js`] });
    await h.message({ type: "helix:precache", urls: [`${ORIGIN}/app/b.js`] });
    expect(h.network).toEqual(["/app/a.js"]);
  });

  it("drops absurdly long URLs", async () => {
    const h = runWorker(WORKER);
    await h.message({
      type: "helix:precache",
      urls: [`${ORIGIN}/app/${"x".repeat(3000)}.js`],
    });
    expect(h.network).toEqual([]);
  });
});

describe("worker: offline behaviour", () => {
  const offline = () => Promise.reject(new Error("offline"));

  it("serves a cached document when the network is gone", async () => {
    const h = runWorker(WORKER);
    await h.message({ type: "helix:precache", urls: [], document: `${ORIGIN}/app/` });

    const dead = runWorker(WORKER, { respond: offline });
    // Same backing store, as a real origin would have.
    dead.caches.caches.set(CACHE, h.caches.caches.get(CACHE)!);
    const res = await dead.fetchEvent(navReq("/app/"));
    expect(res?.status).toBe(200);
  });

  it("falls back to the scope root for an offline deep link", async () => {
    const h = runWorker(WORKER);
    await h.message({ type: "helix:precache", urls: [], document: `${ORIGIN}/app/` });

    const dead = runWorker(WORKER, { respond: offline });
    dead.caches.caches.set(CACHE, h.caches.caches.get(CACHE)!);
    const res = await dead.fetchEvent(navReq("/app/review/123"));
    expect(res?.status).toBe(200);
  });

  it("never stores a non-200, redirected or no-store response", async () => {
    const cases: Response[] = [
      new Response("nope", { status: 404 }),
      new Response("nope", { status: 200, headers: { "cache-control": "no-store" } }),
    ];
    for (const canned of cases) {
      const h = runWorker(WORKER, { respond: () => canned.clone() });
      await h.fetchEvent(req("/app/x.js"));
      const cache = await h.caches.open(CACHE);
      expect(await cache.keys()).toHaveLength(0);
    }
  });
});

describe("worker: activate evicts only its own stale caches", () => {
  it("drops previous helix versions and leaves app caches alone", async () => {
    const h = runWorker(WORKER);
    await h.caches.open("helix:apps/x/0/"); // a previous version
    await h.caches.open(CACHE);
    await h.caches.open("demo-payload"); // the app's own
    await h.activate();
    expect(await h.caches.keys()).toEqual([CACHE, "demo-payload"]);
  });
});

describe("tombstone", () => {
  it("clears every helix cache, unregisters, and leaves app caches alone", async () => {
    const h = runWorker(buildTombstoneScript());
    await h.caches.open("helix:apps/x/0/");
    await h.caches.open(CACHE);
    await h.caches.open("demo-payload");
    await h.activate();
    expect(await h.caches.keys()).toEqual(["demo-payload"]);
    expect(h.unregistered).toBe(true);
  });

  it("installs no fetch handler at all", async () => {
    const h = runWorker(buildTombstoneScript());
    expect(await h.fetchEvent(req("/app/main.js"))).toBeNull();
  });
});
