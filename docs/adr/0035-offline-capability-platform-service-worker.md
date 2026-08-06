# ADR-0035 — Offline capability: a platform-owned, scope-confined service worker

## Status

Proposed. Reverses the platform-wide service-worker ban recorded in
`docs/platform-architecture.md` §4.4 and Appendix A.3, replacing it with a narrow,
approval-gated exception. Relates to [ADR-0004](0004-auth-model.md) (the handoff
token the ban protects), [ADR-0009](0009-relaxed-csp.md),
[ADR-0016](0016-capability-manifest-approval-classifier.md),
[ADR-0018](0018-deploy-model-immutable-versions.md) (the pointer flip this must not
break), [ADR-0020](0020-static-only-apps-v1.md).

## Context

Service workers are refused platform-wide today: `apps/edge/src/serving/assets.ts`
403s any request carrying the `Service-Worker` registration header, before the
registry lookup and before the session gate.

The reason is specific and correct. `/_auth/complete?token=…` is a root-level
navigation carrying a bearer credential in its URL (Appendix A.3). A root-scoped
worker is a persistent same-origin network proxy: it observes that navigation
*before the edge does*, and can redeem the token into a durable headless
server-side session. The token's ~30 s TTL, single-use burn and audience binding
bound the damage from a leak, but audience binding explicitly does not protect the
token from the target app itself. Binding the token to an `HttpOnly __Host-` nonce
cookie does not help either — a worker is same-origin, so
`fetch('/_auth/complete?token=…', {credentials:'include'})` has the cookie attached
by the browser without the worker ever reading it.

What forces the question is an app that must **cold-boot with no network**: open the
document offline, having visited it online before. That is not something an app can
build for itself — intercepting a navigation requires a service worker, and that is
exactly what is banned.

The observation that makes a generic answer possible is that cold boot is *all* such
an app needs a worker for. Durable local state (IndexedDB), large-asset caching
(the Cache API), and queueing work until connectivity returns are all page JS,
already available to every app with no grant at all. The worker's entire job is to
answer the document and its static assets when the network is gone. That is generic
platform behaviour, identical for every app, and it contains no app-specific policy
worth letting an app author write.

## Decision

1. **A new manifest capability, `capabilities.offline`.** Presence is the grant;
   its `scope` field (a URL path prefix, e.g. `/app/`) is the confinement. It
   projects to the registry entry alongside the existing grants, parsed fail-closed
   like the others. No schema migration — capabilities are a JSON column.

2. **The worker is platform-authored, never app-authored.** The edge serves a
   platform worker from a reserved path (`/_helix/sw.js`, alongside the existing
   fetch shim); apps ship no worker code and no registration code. The
   `Service-Worker: script` → 403 in `assets.ts` stays exactly as it is for every
   other path and every app without the grant — the ban remains the default and
   this is a named exception to it.

   The alternative — allowing an *app-authored* worker confined to a subdirectory by
   a path rule — was rejected. It is more flexible, but it puts untrusted code in a
   position that survives revocation, and it makes correctness (never caching
   `/_api/*`, honouring the version pointer, unregistering when told to) depend on
   app code we have no way to review. A platform worker gets those properties by
   construction. It remains available later as a strictly larger grant if an app
   genuinely needs custom worker logic.

3. **Scope is validated, and never root.** The declared prefix must normalize
   through `normalizeRequestPath` (inheriting the traversal defense), start and end
   with `/`, and contain at least one non-empty segment. Any prefix whose first
   segment begins with `_` is refused — stated as a rule rather than as an
   enumeration of `_auth` / `_api` / `_helix` / `_csp-report`, so it stays correct
   when a namespace is added. Root scope is not offered; the worker therefore
   provably cannot reach the platform namespaces, and the handoff flow is not
   touched at all.

4. **`Service-Worker-Allowed` is emitted, on exactly one route.** A worker's maximum
   scope is the script URL's own directory unless the script response widens it.
   Because the script is platform code at `/_helix/sw.js`, its default maximum is
   `/_helix/` — so controlling `/app/` *requires* the header. The prior invariant
   ("the edge never emits `Service-Worker-Allowed`") is replaced by:

   > The edge emits `Service-Worker-Allowed` on exactly one route, only for apps
   > holding the offline grant, with a value equal to the validated manifest scope
   > prefix — never on a response carrying app-controlled bytes. Service-worker
   > registration remains refused by default everywhere else.

   This is not a weakening. Under an app-owned worker the *app* picks its scope by
   where it places a file and the platform can only veto after the fact; here the
   platform computes the scope from a validated manifest field, and emits it from a
   route where `isReservedAppPath` guarantees no app content is ever served.

   Rejected alternative: serve the platform worker *inside* the app's prefix
   (`{scope}_helix-sw.js`) so the default scope suffices and no header is needed.
   That preserves the old invariant, but makes reserved-path checking dynamic and
   per-app instead of a static root-level prefix test — more logic in the trusted
   path — introduces a filename-collision class with app bundles, and gives every
   app a different worker URL, which the revocation path (8) would then have to
   special-case per app.

5. **Runtime caching only; no precache manifest.** The worker caches what it
   actually serves. Documents are **network-first with a short timeout, falling back
   to cache**; other same-origin assets are cache-first. Network-first documents are
   what preserve the ADR-0018 pointer-flip contract: an online client always gets
   the live version, exactly as `Cache-Control: no-cache` on HTML delivers today.
   The cache name is keyed to the version's `blobPrefix`, so a promote or a rollback
   lands in a fresh cache and the previous one is dropped on activate.

   A deploy-time precache manifest is deliberately deferred. It is cheap to add
   later — `validateBundle` already produces the full file list at deploy time, it
   is simply not persisted — but "precache everything" is wrong at the tail (an app
   with bundled media would pull hundreds of megabytes on first visit), and choosing
   the cap is not urgent. An app that wants a specific asset cached can fetch it
   once and put it in the Cache API itself, with no grant.

6. **The worker handles same-origin `GET` only.** Everything else falls through
   without `respondWith`. This is the structural bypass for `/_auth/*`, `/_api/*`,
   `/_helix/*` and every mutating request — the worker never inspects them — and it
   is also load-bearing for cross-origin requests: the worker runs under the app's
   CSP (7), so a passthrough `fetch()` of a curated-CDN script URL from inside the
   worker would be evaluated against `connect-src 'self'` and blocked, breaking
   every app that uses the CDN allowlist. Falling through leaves those requests to
   the page's own CSP, where they belong.

7. **The worker script response is ungated, `no-cache`, and carries the app CSP**;
   registration passes `updateViaCache: 'none'`.

   *Ungated* is a correctness requirement, not a convenience: behind the session
   gate, an update check with an expired session receives a 302 to the auth host,
   and a redirect during a service-worker script fetch is a spec-level error. The
   update would fail silently and the old worker would stay installed — breaking the
   kill switch precisely when it is needed. The existing `/_helix/fetch-shim.js`
   route is already ungated; this follows it. The script contains no app content.

   *Carrying the CSP* matters because for a worker the policy delivered with the
   script governs the worker's own execution context. The shim route sets no CSP
   header today; a worker served the same way would run with no CSP at all — its
   `fetch()` unbounded by `connect-src 'self'`. Combined with (6), attaching the app
   CSP keeps the worker inside the same data-flow containment as the page.

8. **Revocation serves a tombstone, not a 404.** When the app is archived, the grant
   is withdrawn, or an operator kills it, the worker route serves a platform-authored
   self-unregistering worker that clears its caches. Browsers differ on whether a 404
   during an update check unregisters the worker or merely fails the update and
   leaves it installed; a 200 carrying an unregister is deterministic. The existing
   410 + `Clear-Site-Data: "cache", "storage"` on app paths stays and is
   complementary — it fires when a request reaches the edge, the tombstone fires on
   the worker's own update check.

9. **Registration is injected at serve time, not written by the app.** The existing
   `injectShimTag` path in `apps/edge/src/serving/shim.ts` already rewrites `<head>`
   for opt-in apps; the offline grant injects a registration snippet the same way.
   Adopting the capability is a manifest change and nothing else.

   The snippet also closes the **first-visit gap**. A worker does not control the
   page that registers it, so the document and every subresource of that first visit
   bypass it, and `clients.claim()` does not retroactively cache them: with pure
   runtime caching, offline boot would work only from the *second* visit. The
   injected snippet posts `performance.getEntriesByType('resource')` to the worker on
   load, which caches those URLs — restoring "cold-boots offline after one online
   visit" with no deploy-time file list and no app input.

10. **The SPA fallback becomes scope-aware.** `assets.ts` currently falls back to
    `{blobPrefix}index.html` — the *bundle* root. An app whose content lives under
    its scope prefix has no root `index.html`, so every deep link into the prefix
    404s. The fallback for a path under the declared scope must target
    `{blobPrefix}{scope}index.html`. This is latent today (nothing is served from a
    subdirectory) and becomes real the moment a prefix is blessed.

11. **Elevated in the approval classifier, risk `med`.** It is a privilege increase,
    so it gates; `med` rather than `high` because the marginal exposure is modest —
    see the first two consequences below.

## Consequences

- **Offline bypasses the visibility gate, by construction.** A user whose group
  membership is revoked still cold-boots the shell and reads whatever their device
  holds. The gate is per-request (`gate.ts`, one indexed SELECT, no cache) precisely
  so revocation is immediate; offline, there is no request. Note the *marginal*
  exposure is narrower than it first appears: IndexedDB and the Cache API already
  persist without any grant, so what this capability adds is the shell **rendering**
  after deauthorization, not the data surviving it. Worth stating in the approval UI
  in plain words rather than leaving it to be inferred.

- **Un-shipping still works for online clients, and only for them.** Network-first
  documents (5) mean a device with signal always gets the live version, so rollback
  and archive behave as they do today. The residual is an offline device, which
  converges on the tombstone within roughly a day of coming back online. This is the
  one genuine reduction in the platform's safety story, and it is the reason the
  capability is approval-gated at all.

- **A prefixed app's bare `/` 404s** unless the app ships its own root `index.html`.
  `relPath` resolves to `index.html`, misses at the bundle root, and the SPA fallback
  is skipped because it is already the fallback target. A platform redirect from `/`
  to the declared scope was considered and rejected: it would make the platform care
  about an app's internal layout in a second place and become a compatibility
  surface for apps that legitimately want a landing page outside the worker's scope.
  An app that wants the redirect ships two lines of HTML. Note this does *not* remove
  the need for (10), which is about deep links and is independent.

- **Offline entry from the bare domain remains unavailable.** `/` is outside any
  confined scope, so an offline navigation there reaches neither the worker nor the
  edge. PWA `start_url` pointing at the scope is the mitigation, which makes install
  the primary entry path for an app that depends on offline boot. The web app
  manifest and icons stay app-side — the checkbox does not provide them.

- **"Works offline" is two different things, and the docs must say so.** The
  capability delivers cold boot: the document and its static assets return with no
  network. It does not make an app work offline. The app still owns not falling over
  when `/_api/*` fails, its own durable state, and draining queued work when
  connectivity returns. The platform takes the part an app cannot safely build; the
  app keeps the part the platform could never review.

- **Two existing claims are wrong and should be corrected regardless of this ADR.**
  First, `csp.ts` and architecture §4.4 justify `worker-src 'self' blob:` *by* the
  service-worker ban. That reasoning is unsound: a `blob:` URL can never register a
  service worker (registration requires a same-origin http(s) script URL), so the
  relaxation was never propped up by the ban and lifting the ban does not endanger
  it. Second, "banned platform-wide" is not literally true — the check lives in
  `assetHandler`, not globally, so `/_helix/fetch-shim.js` serves today with a
  `Service-Worker` header present. Harmless in practice (default scope `/_helix/`,
  no header widening it, nothing sensitive under that prefix), but the check should
  become explicit per-route now that a second reserved script path exists.

- **Six places assert the ban** and change with this: `apps/edge/src/serving/assets.ts`,
  `apps/edge/src/serving/csp.ts`, `docs/platform-architecture.md` (§4.4 and
  Appendix A.3), `docs/features/edge-serving.md`, `apps/edge/README.md`, and
  `packages/deploy-skill/SKILL.md`.

- **Adversarial tests ship in the same commits**, per project plan §6 — this touches
  the surface that rule exists for. At minimum: registration refused without the
  grant; refused for a root scope; refused for a scope whose first segment starts
  with `_`; `Service-Worker-Allowed` absent on every response except the worker
  route; the worker route's CSP present; the tombstone served on archive and on
  grant withdrawal; and a test pinning that a session whose refresh is due still
  gets `refresh_required` on `/_api/*`, which is what bounds background credentialed
  execution by a worker to the refresh window rather than the session TTL.

- **Deferred:** app-authored workers; root scope; a deploy-time precache manifest;
  push and background sync (both ride the worker and neither is granted here); and
  platform-served PWA manifests.
