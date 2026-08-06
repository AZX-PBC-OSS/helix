import { CSP_REPORT_PATH } from "./csp.js";

/**
 * The platform-owned service worker (ADR-0035) — the offline capability.
 *
 * Service workers are refused platform-wide (`assets.ts`) because a root-scoped
 * worker observes the handoff token on `/_auth/complete` before the edge does.
 * The offline grant is the one exception, and it is narrow in three ways:
 *
 *  1. **The worker is ours, not the app's.** The app declares a scope and ships
 *     no worker code; the edge serves this script and injects its registration.
 *     So "never cache `/_api/*`", "honour the version pointer" and "unregister
 *     when told to" are properties by construction, not app promises.
 *  2. **The scope is confined and validated** — never root, never a `_`-prefixed
 *     platform namespace (`isValidServiceWorkerScope`, re-checked in the
 *     projection). The worker provably cannot reach `/_auth/*` or `/_api/*`.
 *  3. **Revocation is a tombstone, not a 404** — see {@link buildTombstoneScript}.
 *
 * What the capability buys is **cold boot** and nothing more: the document and
 * its static assets answer with no network. Durable state, large-asset caching
 * and queued-work drain are ordinary page JS every app already has ungranted.
 */

/** Reserved edge path the worker is served from (see app.ts `isReservedAppPath`). */
export const SW_PATH = "/_helix/sw.js";

/**
 * Query parameter carrying the registration's scope on the worker script URL.
 *
 * The scope has to travel in the URL because of how the spec's **Update**
 * algorithm works: `Service-Worker-Allowed` is re-read from the script response
 * on *every* update check, not just at registration, and absent it the maximum
 * scope falls back to the script's own directory — `/_helix/`. A registration
 * scoped `/app/` then fails the max-scope test with a `SecurityError` and the
 * response is never installed.
 *
 * That is fatal for the tombstone specifically ({@link buildTombstoneScript}),
 * which by definition is served when the grant is *gone* and there is no scope
 * left to read off the manifest. Without a self-describing URL, revocation and
 * archive silently do nothing: the old worker stays installed and keeps serving
 * its cache. So the registration bakes its scope into the script URL, and the
 * route echoes it back — the tombstone needs no stored state at all.
 *
 * It is safe because the value is never trusted: the route runs it through
 * `isValidServiceWorkerScope` before emitting it (so it can neither be root, a
 * `_` platform namespace, nor carry a header-injection payload), and the *real*
 * worker is served only when it matches the app's granted scope. A request
 * naming any other scope gets the tombstone, which unregisters itself.
 */
export const SW_SCOPE_PARAM = "scope";

/** Reserved path for the page-side registration, injected into `<head>`. */
export const SW_REGISTER_PATH = "/_helix/sw-register.js";

/**
 * Path prefixes the worker must never handle. `/_auth/*` is the reason the ban
 * exists; `/_api/*` must stay unprecachable so it can serve as an app's
 * reachability probe (a precached URL cannot measure reachability); `/_helix/*`
 * is the worker and shim themselves.
 *
 * Belt and braces: a confined scope already excludes all of these, since they
 * are root-level and the scope never is. The check stays because it is the
 * property we actually care about, and it must not depend on scope validation
 * being correct somewhere else.
 */
const RESERVED_PREFIXES = ["/_auth/", "/_api/", "/_helix/"];

/** Cache-name prefix, so `activate` can recognize and evict our own old caches. */
const CACHE_NS = "helix";

/** Bound on the page-supplied first-visit URL list (see the registration snippet). */
const MAX_PRECACHE_URLS = 200;

/** Milliseconds a navigation waits on the network before falling back to cache. */
const NAV_TIMEOUT_MS = 3000;

export interface ServiceWorkerOptions {
  /** Validated scope prefix, e.g. `/app/`. */
  scope: string;
  /**
   * The live version's blob prefix. Baked into the cache name, so a promote or
   * rollback changes these bytes → the browser installs the new worker →
   * `activate` drops the stale cache. That is what preserves ADR-0018's
   * pointer-flip contract without any extra endpoint.
   */
  cacheVersion: string;
}

/**
 * Build the per-app worker. Hand-written and dependency-free, like everything
 * else in the trusted path (ADR-0003) — this is code we ship into every granted
 * app's origin, so it stays small enough to read in one sitting.
 */
export function buildServiceWorkerScript(opts: ServiceWorkerOptions): string {
  return `(function () {
  "use strict";
  var SCOPE = ${JSON.stringify(opts.scope)};
  var CACHE = ${JSON.stringify(`${CACHE_NS}:${opts.cacheVersion}`)};
  var RESERVED = ${JSON.stringify([...RESERVED_PREFIXES, CSP_REPORT_PATH])};
  var MAX_PRECACHE = ${MAX_PRECACHE_URLS};
  var NAV_TIMEOUT = ${NAV_TIMEOUT_MS};

  // Only same-origin GETs inside the scope, and never a platform namespace.
  // Falling through (rather than proxying) for cross-origin is load-bearing,
  // not tidiness: this worker runs under the app's CSP, so a passthrough fetch
  // of a curated-CDN URL would be judged against \`connect-src 'self'\` and
  // blocked. Left alone, the request is the page's and its CSP applies.
  function handles(request) {
    if (request.method !== "GET") return false;
    var url;
    try {
      url = new URL(request.url);
    } catch (e) {
      return false;
    }
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.indexOf(SCOPE) !== 0) return false;
    for (var i = 0; i < RESERVED.length; i++) {
      if (url.pathname === RESERVED[i] || url.pathname.indexOf(RESERVED[i]) === 0) return false;
    }
    return true;
  }

  // Never persist a partial, opaque, redirected or explicitly uncacheable
  // response — serving one of those from cache later would be worse than a
  // network error, because the app cannot tell it apart from a real answer.
  function storable(response) {
    if (!response || response.status !== 200 || response.type !== "basic") return false;
    if (response.redirected) return false;
    var cc = response.headers.get("cache-control") || "";
    return cc.indexOf("no-store") === -1;
  }

  function put(request, response) {
    if (!storable(response)) return;
    var copy = response.clone();
    caches.open(CACHE).then(function (c) {
      return c.put(request, copy);
    }).catch(function () {});
  }

  self.addEventListener("install", function () {
    self.skipWaiting();
  });

  self.addEventListener("activate", function (event) {
    event.waitUntil(
      caches.keys().then(function (names) {
        return Promise.all(
          names.map(function (n) {
            // Ours and stale → drop. An app's own caches are left alone: apps
            // are expected to cache large assets themselves, ungranted.
            var ours = n.indexOf(${JSON.stringify(`${CACHE_NS}:`)}) === 0;
            return ours && n !== CACHE ? caches.delete(n) : null;
          }),
        );
      }).then(function () {
        return self.clients.claim();
      }),
    );
  });

  self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (!handles(request)) return; // no respondWith — the browser proceeds normally

    // Documents are network-first with a short timeout. This is what keeps the
    // pointer flip honest: an online client always gets the live version, the
    // same guarantee \`Cache-Control: no-cache\` on HTML gives today. Cache is
    // strictly a fallback for when the network is gone or too slow.
    if (request.mode === "navigate") {
      event.respondWith(
        new Promise(function (resolve) {
          var settled = false;
          var timer = setTimeout(function () {
            if (settled) return;
            settled = true;
            caches.match(request).then(function (hit) {
              resolve(hit || fetch(request));
            });
          }, NAV_TIMEOUT);
          fetch(request).then(
            function (response) {
              clearTimeout(timer);
              put(request, response);
              if (!settled) {
                settled = true;
                resolve(response);
              }
            },
            function (err) {
              clearTimeout(timer);
              if (settled) return;
              settled = true;
              caches.match(request).then(function (hit) {
                // Fall back to the scope root: a deep link opened offline
                // should still boot the shell (the edge does the same thing
                // online with its SPA fallback).
                resolve(hit || caches.match(SCOPE).then(function (root) {
                  if (root) return root;
                  throw err;
                }));
              });
            },
          );
        }),
      );
      return;
    }

    // Everything else in scope is cache-first: assets under an immutable
    // version prefix don't change, and the cache name already carries the
    // version, so a stale hit is impossible across a promote.
    event.respondWith(
      caches.match(request).then(function (hit) {
        if (hit) return hit;
        return fetch(request).then(function (response) {
          put(request, response);
          return response;
        });
      }),
    );
  });

  self.addEventListener("message", function (event) {
    var data = event.data;
    if (!data || typeof data !== "object") return;

    // First-visit backfill. A worker does not control the page that registers
    // it, so that page's document and subresources bypass us entirely and
    // \`clients.claim()\` does not retroactively cache them — without this,
    // offline boot would only work from the SECOND visit. The page tells us
    // what it loaded; we re-fetch and store it.
    //
    // The page is untrusted, so the list is filtered by the same \`handles\`
    // rule as live traffic and capped. Worst case an app names its own
    // in-scope assets, which is exactly what it is for.
    if (data.type === "helix:precache" && Array.isArray(data.urls)) {
      var requests = [];
      for (var i = 0; i < data.urls.length && requests.length < MAX_PRECACHE; i++) {
        if (typeof data.urls[i] !== "string") continue;
        var req;
        try {
          req = new Request(data.urls[i], { credentials: "same-origin" });
        } catch (e) {
          continue;
        }
        if (handles(req)) requests.push(req);
      }
      event.waitUntil(
        caches.open(CACHE).then(function (c) {
          return Promise.all(
            requests.map(function (r) {
              // Skip what we already hold, so a repeat visit is nearly free.
              return c.match(r).then(function (hit) {
                if (hit) return null;
                return fetch(r).then(function (response) {
                  return storable(response) ? c.put(r, response) : null;
                }).catch(function () { return null; });
              });
            }),
          );
        }),
      );
      return;
    }

    // Status, as a deliberate platform contract. The Cache API is origin-shared,
    // so without this apps would read \`caches.keys()\` and hard-code the
    // internal \`helix:<blobPrefix>\` naming — freezing an implementation detail
    // we could then never change. Answering authoritatively is cheaper than
    // accidentally making the cache-name format public API.
    if (data.type === "helix:status") {
      var port = event.ports && event.ports[0];
      event.waitUntil(
        caches.open(CACHE).then(function (c) {
          return c.keys();
        }).then(function (keys) {
          var urls = keys.map(function (r) {
            return new URL(r.url).pathname;
          }).sort();
          var reply = {
            type: "helix:status",
            version: ${JSON.stringify(opts.cacheVersion)},
            scope: SCOPE,
            entries: urls.length,
            urls: urls,
          };
          if (port) port.postMessage(reply);
          else if (event.source) event.source.postMessage(reply);
        }).catch(function () {}),
      );
    }
  });
})();
`;
}

/**
 * The revocation worker: served at {@link SW_PATH} when the app is archived, has
 * no offline grant, or is unknown.
 *
 * A 200 carrying an unregister rather than a 404 because browsers differ on
 * whether a 404 during an update check unregisters the worker or merely fails
 * the update and leaves the old one installed. Relying on the latter would make
 * revocation silently do nothing — deterministic beats clever here.
 */
export function buildTombstoneScript(): string {
  return `(function () {
  "use strict";
  self.addEventListener("install", function () {
    self.skipWaiting();
  });
  self.addEventListener("activate", function (event) {
    event.waitUntil(
      caches.keys().then(function (names) {
        return Promise.all(
          names.filter(function (n) {
            return n.indexOf(${JSON.stringify(`${CACHE_NS}:`)}) === 0;
          }).map(function (n) {
            return caches.delete(n);
          }),
        );
      }).then(function () {
        return self.registration.unregister();
      }).then(function () {
        return self.clients.matchAll();
      }).then(function (clients) {
        // Reload any open tab so it stops being served by a worker that no
        // longer exists — otherwise the shell lingers until the next manual load.
        clients.forEach(function (c) {
          if (typeof c.navigate === "function") c.navigate(c.url);
        });
      }).catch(function () {}),
    );
  });
})();
`;
}

/**
 * The page-side registration, injected into `<head>` at serve time so adopting
 * the capability is a manifest change and nothing else (the same mechanism the
 * fetch shim uses — see `shim.ts`).
 *
 * `updateViaCache: "none"` keeps the browser from serving the worker script out
 * of the HTTP cache on update checks, which is what makes the tombstone
 * converge promptly.
 */
export function buildRegistrationSnippet(scope: string): string {
  const scriptUrl = `${SW_PATH}?${SW_SCOPE_PARAM}=${encodeURIComponent(scope)}`;
  return `(function () {
  if (!("serviceWorker" in navigator)) return;
  var SCOPE = ${JSON.stringify(scope)};

  // The scope rides in the script URL — see SW_SCOPE_PARAM. The browser refetches
  // this exact URL on every update check, which is what lets the route emit a
  // correct \`Service-Worker-Allowed\` even after the grant is withdrawn and there
  // is no scope left to look up. Without it the tombstone can never install.
  var registered = navigator.serviceWorker.register(${JSON.stringify(scriptUrl)}, {
    scope: SCOPE,
    updateViaCache: "none",
  }).then(function () {
    return navigator.serviceWorker.ready;
  });

  // Wait for \`load\`, not just \`ready\`. This snippet is a parser-blocking script
  // in <head>, and on a fresh install \`ready\` resolves after a purely local
  // install→activate with no network — so it routinely wins the race against the
  // page's own subresources, and PerformanceResourceTiming only lists resources
  // that have *finished*. Gating on \`ready\` alone would post a near-empty list,
  // nondeterministically, with no visible symptom.
  var loaded = new Promise(function (resolve) {
    if (document.readyState === "complete") resolve();
    else addEventListener("load", function () { resolve(); }, { once: true });
  });

  Promise.all([registered, loaded]).then(function (results) {
    // Hand the worker what this page already loaded. See the "helix:precache"
    // branch in the worker: the registering page's own requests bypassed it, so
    // without this the first visit primes nothing and offline boot needs two.
    var registration = results[0];
    var target = registration.active || navigator.serviceWorker.controller;
    if (!target || typeof performance === "undefined") return;
    var urls = [];
    try {
      performance.getEntriesByType("resource").forEach(function (e) {
        if (e.name) urls.push(e.name);
      });
    } catch (e) {}
    // The document travels separately: it needs an HTML \`Accept\` to resolve
    // through the edge's SPA fallback, which subresources must NOT have.
    target.postMessage({ type: "helix:precache", urls: urls, document: location.href });
  }).catch(function () {
    // A failed registration must never break the app — it just means no
    // offline boot. Same posture as the shim: ergonomics, not a boundary.
  });
})();
`;
}
