import "./style.css";

/**
 * Six probes against the platform's offline capability (ADR-0035).
 *
 * The app ships **no service worker** — the platform serves one at
 * `/_helix/sw.js` and injects its registration into this document's `<head>` at
 * serve time. So probes 1, 2 and 6 inspect something the app did not build,
 * while 4 and 5 are ordinary browser storage that needs no grant at all. That
 * split is the point: the platform takes the part an app cannot safely build
 * (intercepting navigations), and the app keeps the part the platform could
 * never review.
 */

const APP_CACHE = "demo-payload";
const PAYLOAD_URL = "./payload.json";
const IDB_NAME = "offline-demo";
const IDB_STORE = "entries";

function out(id: string, text: string): void {
  const el = document.querySelector<HTMLElement>(`#${id} .out`);
  if (el) el.textContent = text;
}

function fmt(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ── 1 · registration ─────────────────────────────────────────────────────────

async function probeRegistration(): Promise<void> {
  if (!("serviceWorker" in navigator)) {
    out("probe-registration", "unsupported: no navigator.serviceWorker");
    return;
  }
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) {
    out(
      "probe-registration",
      "no worker registered.\n\nEither the app does not hold the offline grant, or the grant was withdrawn and the tombstone has run.",
    );
    return;
  }
  out(
    "probe-registration",
    fmt({
      scope: new URL(reg.scope).pathname,
      script: reg.active ? new URL(reg.active.scriptURL).pathname : null,
      state: reg.active?.state ?? "installing",
      controllingThisPage: navigator.serviceWorker.controller !== null,
    }),
  );
}

// ── 2 · what the worker holds ────────────────────────────────────────────────

interface WorkerStatus {
  type: "helix:status";
  version: string;
  scope: string;
  entries: number;
  urls: string[];
}

/** Ask the worker over a MessageChannel; resolve null if it never answers. */
function askWorker(timeoutMs = 2000): Promise<WorkerStatus | null> {
  return new Promise((resolve) => {
    const target = navigator.serviceWorker?.controller;
    if (!target) {
      resolve(null);
      return;
    }
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), timeoutMs);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      resolve(event.data as WorkerStatus);
    };
    target.postMessage({ type: "helix:status" }, [channel.port2]);
  });
}

async function probeStatus(): Promise<void> {
  const status = await askWorker();
  if (!status) {
    out(
      "probe-status",
      "no controlling worker yet.\n\nOn the very first load the worker is installing and does not control this page — reload once.",
    );
    return;
  }
  const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
  out(
    "probe-status",
    fmt({
      version: status.version,
      scope: status.scope,
      entries: status.entries,
      urls: status.urls,
      quota: estimate
        ? { usageBytes: estimate.usage ?? null, quotaBytes: estimate.quota ?? null }
        : "unavailable",
    }),
  );
}

// ── 3 · asset vs /_api/me ────────────────────────────────────────────────────

async function probeReachability(): Promise<void> {
  const results: Record<string, string> = {};

  // An in-scope asset: cache-first, so this survives the network going away.
  try {
    const res = await fetch("./favicon.svg", { cache: "no-store" });
    results["GET ./favicon.svg"] = `${res.status} ${res.ok ? "ok" : "failed"}`;
  } catch (err) {
    results["GET ./favicon.svg"] = `network error — ${(err as Error).message}`;
  }

  // Root-level platform namespace: outside the worker's scope by construction,
  // so it can never be answered from cache. That is what makes it a probe.
  try {
    const res = await fetch("/_api/me", { cache: "no-store" });
    const body = (await res.json()) as { user?: { displayName?: string } };
    results["GET /_api/me"] = `${res.status} — ${body.user?.displayName ?? "(no user)"}`;
  } catch (err) {
    results["GET /_api/me"] = `network error — ${(err as Error).message}`;
  }

  results["navigator.onLine"] = String(navigator.onLine);
  out("probe-reachability", fmt(results));
}

// ── 4 · the app's own cache ──────────────────────────────────────────────────

async function renderAppCache(): Promise<void> {
  const names = await caches.keys();
  const mine = await caches.open(APP_CACHE);
  const keys = await mine.keys();
  out(
    "probe-appcache",
    fmt({
      allCachesOnThisOrigin: names,
      thisAppsCache: APP_CACHE,
      entries: keys.map((r) => new URL(r.url).pathname),
      note: "the helix:* cache is the platform's; this one is the app's. The worker reads only its own versioned cache, so an entry you write here is never served in its place — which is what keeps a promote or rollback able to un-ship an asset.",
    }),
  );
}

async function cachePayload(): Promise<void> {
  try {
    const cache = await caches.open(APP_CACHE);
    await cache.add(new Request(PAYLOAD_URL, { cache: "reload" }));
  } catch (err) {
    out("probe-appcache", `could not cache the payload — ${(err as Error).message}`);
    return;
  }
  await renderAppCache();
}

// ── 5 · durable state ────────────────────────────────────────────────────────

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function renderEntries(): Promise<void> {
  const db = await openDb();
  const store = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE);
  const all = await done(store.getAll() as IDBRequest<{ at: string }[]>);
  out(
    "probe-idb",
    fmt({
      entries: all.length,
      items: all.slice(-5),
      note: "survives a reload with the network off — the platform never sees this",
    }),
  );
}

async function appendEntry(): Promise<void> {
  const db = await openDb();
  const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
  await done(store.add({ at: new Date().toISOString(), online: navigator.onLine }));
  await renderEntries();
}

async function clearEntries(): Promise<void> {
  const db = await openDb();
  const store = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
  await done(store.clear());
  await renderEntries();
}

// ── 6 · cache version ────────────────────────────────────────────────────────

async function probeVersion(): Promise<void> {
  const status = await askWorker();
  const helixCaches = (await caches.keys()).filter((n) => n.startsWith("helix:"));
  out(
    "probe-version",
    fmt({
      activeVersion: status?.version ?? "(no controlling worker yet)",
      helixCaches,
      note:
        helixCaches.length > 1
          ? "more than one — a promote just happened and activate has not run yet"
          : "exactly one: the previous version's cache was dropped on activate",
    }),
  );
}

// ── wiring ───────────────────────────────────────────────────────────────────

async function whoami(): Promise<void> {
  const el = document.querySelector<HTMLElement>("#whoami");
  if (!el) return;
  try {
    const res = await fetch("/_api/me", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { user?: { displayName?: string } };
    el.textContent = body.user?.displayName ?? "signed in";
  } catch {
    el.textContent = "offline — /_api/me unreachable";
  }
}

function renderNet(): void {
  const el = document.querySelector<HTMLElement>("#net");
  if (el) el.textContent = navigator.onLine ? "● online" : "○ offline";
}

async function refreshAll(): Promise<void> {
  renderNet();
  await Promise.all([
    whoami(),
    probeRegistration(),
    probeStatus(),
    probeReachability(),
    renderAppCache(),
    renderEntries(),
    probeVersion(),
  ]);
}

document.querySelector("#refresh-btn")?.addEventListener("click", () => void refreshAll());
document.querySelector("#appcache-btn")?.addEventListener("click", () => void cachePayload());
document.querySelector("#appcache-clear")?.addEventListener("click", () => {
  void caches.delete(APP_CACHE).then(renderAppCache);
});
document.querySelector("#idb-btn")?.addEventListener("click", () => void appendEntry());
document.querySelector("#idb-clear")?.addEventListener("click", () => void clearEntries());
window.addEventListener("online", renderNet);
window.addEventListener("offline", renderNet);

void refreshAll();
