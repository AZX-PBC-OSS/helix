# Edge serving

**What it is.** The data plane (`apps/edge` — azx-edge) terminates all untrusted app-user
traffic: it routes a request to an app by hostname, serves that app's static assets straight
from Blob, injects the platform CSP on every response, and answers `404`/`410` uniformly so
the registry can't be enumerated. It is **stateless** and **dependency-minimal** — every npm
package here is code inside the trusted path (project plan §1), so there is no ORM (hand-written
SQL), no Azure SDK (hand-rolled Blob signing over undici), and no LLM SDK.

See [`apps/edge/README.md`](../../apps/edge/README.md) for the full request flow and config.

## How it works

### Host classification (the two-router discipline)

Every request is classified **once** at an `onRequest` hook into `app` / `auth` / `platform`,
and the two worlds never mix — platform handlers are unreachable on app hosts and vice versa
(architecture §3, decision 12). `apps/edge/src/app.ts:156` decorates `req.hostClass`;
`apps/edge/src/routing/hosts.ts` does the parsing. Reserved subdomains (`auth`, `portal`,
`api`, `www`) are protected; an unmatched slug falls through to `platform`.

A consequence worth knowing: `/health` returns the platform health JSON on platform/auth hosts,
but on an app host it serves the app's own `/health` file (or the SPA fallback) — see
`apps/edge/src/app.ts:161`. Likewise `/start`, `/callback`, `/_auth/*`, `/_api/*` are real
endpoints on the auth/app hosts but just asset paths an app may ship on its own.

### Registry projection (LISTEN/NOTIFY)

The edge never queries the registry per request. It holds an **in-memory slug → entry map**
loaded with hand-written SQL from `apps` + `versions`, and refreshes it on Postgres
`LISTEN/NOTIFY` (debounced ~100 ms) with a reconcile reload every ~60 s as a safety net.

- `apps/edge/src/registry/projection.ts` — the map + loader. Parses `capabilities` JSONB
  fail-closed (`llm`/`data` → null on bad data). Serves the previous copy on a load error
  (fail-static, never fail-open).
- `apps/edge/src/registry/listener.ts` — the LISTEN connection with exponential-backoff
  reconnect.

The projection is read-only by DB grant (see [authentication.md](./authentication.md) and the
role split below) — the edge cannot write the registry.

### Blob asset streaming

Assets are **streamed, never buffered**, directly from Blob using undici with a hand-rolled
Azure SharedKey signature (no Azure SDK).

- `apps/edge/src/blob/client.ts` — undici pool reader, signed GET/HEAD.
- `apps/edge/src/blob/signing.ts` — the Azure SharedKey HMAC-SHA256 canonical string.
- `apps/edge/src/serving/assets.ts` — the asset handler: runs the session gate, composes
  `{version.blobPrefix}{relPath}`, sets cache headers, injects CSP, and does the SPA fallback.
- `apps/edge/src/serving/paths.ts` — path-traversal defense (reject `..`, backslashes, NULs;
  pre- and post-percent-decode).

Behaviors to know:

- **SPA fallback** — an HTML-accepting miss serves `index.html` (deep links work); a non-HTML
  miss stays a hard 404.
- **Cache headers** — HTML is `Cache-Control: no-cache` (pointer flips are visible immediately);
  other assets get `private, max-age=300` with ETag/304.
- **Service-Worker ban** — a request with `Service-Worker: script` is refused `403`, so an app
  can't register a SW that observes the handoff token on `/_auth/complete`. Plain web workers
  are allowed (`worker-src 'self' blob:`).

### CSP injection (§4.4)

`apps/edge/src/serving/csp.ts` sets the policy on **every** app response (not just HTML — SVG/
XML can execute script). The split:

- **Strict / data-flow** (containment): `connect-src 'self'` (the gateway is same-origin at
  `/_api/*`), `form-action 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`.
- **Relaxed / code-provenance** (vibe-coded apps inline/eval freely): `script-src`/`style-src`
  with `'unsafe-inline' 'unsafe-eval'` + a curated CDN allowlist (cdnjs, jsDelivr, unpkg, esm.sh,
  tailwind, Google Fonts). `img-src https: data: blob:` stays open — an acknowledged exfil-via-
  navigation trade-off (§4.4).

An app's declared `externalOrigins` (from its manifest) extend `connect-src`.

### 404 / 410 semantics

- **404** — unknown slug, no live version, rejected path, and missing asset all answer the
  same way (plain text, `Cache-Control: no-store`), so the registry isn't enumerable.
- **410 Gone** — an archived app, checked before the session gate, returns `410` with
  `Clear-Site-Data: "cache", "storage"` to evict cached UI and storage.

`apps/edge/src/errors.ts` holds the 403/404/410 responders.

### DB role split (containment)

The edge connects as the least-privilege `helix_edge` role: `SELECT` on `apps`/`versions`
(the projection), `SELECT`+`INSERT` on `gateway_calls` (metering), `INSERT`-only on
`app_collection_items` (write-only collections), and RLS-partitioned access to `app_data`.
It cannot write the registry, run DDL, or read collections. An edge RCE is contained to that
footprint. Asserted in `apps/edge/src/registry/role-split.integration.test.ts`; grants live in
the portal migration `20260616000001_edge_role_grants` (see
[app-data-gateway.md](./app-data-gateway.md)).

## Planned / not yet built

- **Production TLS** terminates at ingress; in dev the edge terminates TLS itself with mkcert
  (the platform is HTTPS-only — it refuses to boot without TLS, because `__Host-` cookies need
  `Secure` and app crypto APIs need a secure context).
- **Azure Blob** in production; dev uses Azurite. The signing/stream path is provider-shaped
  already.
- A `public` visibility short-circuit exists in serving; `password` visibility still fails closed
  (see [authentication.md](./authentication.md)).
