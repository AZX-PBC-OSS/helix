# offline

An AZX app holding the **offline** capability (ADR-0035): the platform serves a
scope-confined service worker at `/app/` and injects its registration, so the app
cold-boots with no network.

The app ships **no service worker**. There is no `sw.js` in this bundle and no
`navigator.serviceWorker.register` call in `src/`. That is the design: service
workers are refused platform-wide because a root-scoped one would observe the
handoff token on `/_auth/complete`, and the grant is an exception where the
platform owns the worker rather than trusting the app's.

## What the capability actually buys

**Cold boot, and nothing else** — the document and its static assets answer when
the network is gone. It does *not* make an app work offline. That half is still
yours: not falling over when `/_api/*` fails, holding your own durable state, and
draining queued work when connectivity returns. Probes 4 and 5 below are that
half, and neither needs a grant of any kind.

| # | Probe | Exercises |
| - | ----- | --------- |
| 1 | Worker registration | registered by the platform, confined to `/app/`, controlling the page |
| 2 | `helix:status` | what the worker holds — asked over a message, not by reading `caches.keys()` |
| 3 | asset vs `/_api/me` | the asset answers from cache offline; `/_api/*` is structurally unprecachable, which is what makes it a reachability probe |
| 4 | the app's own cache | how you hold a large payload offline — ungranted, and separate from the platform's cache |
| 5 | IndexedDB | durable state surviving an offline cold boot: the shape of a capture-now-sync-later outbox |
| 6 | cache version | keyed to the live version's blob prefix, so a promote rotates it and drops the old one |

## Why this app is served from `/app/`

Service-worker scope is a path prefix, and the platform never grants root — a
root-scoped worker is exactly the thing the ban exists to prevent. So the app
lives under a prefix, and **two build settings follow** (see `vite.config.ts`):

- `base: "./"` — relative asset URLs, so they resolve under the prefix.
- `build.outDir: "dist/app"` — the bundle physically nests.

That second one is the easy mistake. The edge maps a URL path **literally** onto
a blob key: `/app/main.js` reads `<version-prefix>app/main.js`. Set `base` alone
and every URL comes out looking right and 404s.

The web app manifest needs `crossorigin="use-credentials"` on its `<link>`.
Manifests are fetched with credentials omitted, so on any app that isn't `public`
the request arrives without a session cookie and the edge answers `401` — the app
works, and is quietly not installable. Since PWA install is the answer to
offline entry from the bare domain, that failure matters more here than it looks.

`scripts/emit-root-redirect.mjs` writes a two-line `dist/index.html` redirecting
`/` into `/app/`. The platform deliberately does not do this for you — it would
make the edge care about your internal layout, and some apps legitimately want a
landing page at the root. Note it only helps *online*: offline, `/` is outside
the worker's scope and reaches neither the worker nor the edge. Installing the
PWA (`start_url: /app/`) is the answer to that.

## Deploy

```bash
cd examples/offline
pnpm install --ignore-workspace   # standalone install (not the root workspace)
pnpm build                        # regenerate dist/ (committed to git)
helix deploy
```

Then grant the capability in the portal's **Capabilities** tab:

```yaml
offline:
  scope: /app/
```

It is an elevated grant, so it opens an approval request — approve it at
`/admin/approvals`. Until then the worker route serves a tombstone and nothing
caches.

## Verifying it

**In dev, trust the mkcert CA on your host first.** A service worker requires a
secure context, and clicking through the browser's certificate warning does not
create one — the exception is per-tab UI state, not a trust decision, so
registration still fails with *"An SSL certificate error occurred when fetching
the script."* Import the CA once:

```bash
CAROOT=<repo>/.devcontainer/certs/caroot mkcert -install
```

Then **fully quit the browser** (⌘Q / not just the window) — Chromium caches
trust per-process. On macOS this covers Edge and Chrome, which both use the
system keychain. None of this applies to a real deployment, where the wildcard
certificate is publicly trusted.

1. Open `https://offline.<base>/app/`. **Probe 1** should show the worker
   registered at scope `/app/`. On the very first load it is still installing and
   does not control the page, so **probe 2** only answers after one reload — but
   the cache is primed on that first visit regardless, which is what makes step 2
   work without one.
2. DevTools → Network → **Offline**, then hard-reload. The page still loads. In
   **probe 3** the asset succeeds and `/_api/me` fails — that asymmetry is the
   whole point, and it is why `/_api/me` works as a connectivity probe.
3. Click **Append an entry** a few times, go offline, hard-reload: **probe 5**
   still has them.
4. Click **Cache a payload**, then look at **probe 4** — your cache and the
   platform's `helix:` cache sit side by side, and the worker never touches
   yours.
5. Back online, deploy and promote a new version, then reload. **Probe 6**'s
   version changes and the old cache is gone: documents are network-first, so an
   online client always gets the live version.
6. Archive the app in the portal. Within a day (browsers throttle worker update
   checks to ~24h) the tombstone installs, unregisters, and clears the caches.

## What to look at

- `src/main.ts` — the six probes. Probes 1, 2 and 6 inspect something this app
  did not build; 4 and 5 are ordinary browser storage.
- `vite.config.ts` — the prefix layout, explained above.
- `docs/adr/0035-offline-capability-platform-service-worker.md` — the decision,
  including what it costs.
