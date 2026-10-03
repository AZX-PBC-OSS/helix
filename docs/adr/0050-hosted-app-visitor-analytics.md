# 0050. Visitor analytics for hosted apps

**Status:** Accepted _(recorded 2026-10-02)_
**Related:** ADR [0037](0037-platform-observability-otlp-boundary.md) decision 11 (per-app telemetry for hosted apps, deferred); ADR [0021](0021-metering-ledger.md) (the metering ledger, not reused); ADR [0035](0035-offline-capability-platform-service-worker.md) (service-worker loads); `docs/features/visitor-analytics.md`; `apps/edge/src/serving/visits.ts`; `apps/portal/src/routes/visitors.ts`; `apps/portal/src/geo/resolver.ts`

## Context

App owners want to know whether anyone opens their app, how often, and roughly from where. This matters most for `public` and `password` apps, which are shared by link with people the owner cannot see in the directory. The platform recorded nothing about page loads: the metering ledger counts gateway calls only, and request logs expire after 30 days in Log Analytics, where an owner cannot read them.

ADR-0037 decision 11 deferred "per-app telemetry for hosted apps" because it is "a product surface with a tenancy model, not an operations concern". This ADR is that product surface, scoped to visits, unique visitors and coarse location.

## Decision

1. **Product data in Postgres, not OTLP.** The edge appends one row to a new `app_visits` table for each top-level HTML document it serves past the session gate. The owner reads aggregates in the portal. The OTLP pipeline gets one operational counter, `helix.app.visits{appId, outcome}`, so a run of failed writes is alertable; it is never the source of the owner's numbers.

2. **No raw IP is stored.** A row holds:
   - `visitorHash`: HMAC-SHA256 of `appId|ip` truncated to 128 bits. The key is HKDF-derived from `EDGE_AUTH_SECRET` under its own label (`helix-visitor-hash-v1`). A bare SHA-256 would be reversible by enumerating the IPv4 space, so the hash is keyed. Including `appId` keeps one visitor's hash different in each app, so rows cannot be joined across apps.
   - `ipPrefix`: the address truncated to /24 (IPv4) or /48 (IPv6). That is enough for a region-level lookup and not enough to name a host.

   There is no user identity, path or user agent in the row, even for authenticated apps. Paths can carry app-chosen keys (ADR-0042).

3. **What counts.** A load is recorded only when all of these hold:
   - it is a `GET` with `Sec-Fetch-Dest: document` and no `Sec-Purpose` or `Purpose` header
   - it passed the session gate (or the app is `public`)
   - the response is an HTML document: a 200 with an HTML content type, or a 304 on an `.html` or extensionless path

   Requests without `Sec-Fetch-Dest` are not counted. Every current browser sends it, and most scanners and scripted clients don't, so the header doubles as a cheap bot filter. Speculative loads (prefetch, prerender) carry `Sec-Purpose` and are not counted, because the user may never open the page. Subresources, iframe embeds, HEAD requests, `/_api/*` calls and gate redirects to login are never counted.

   The write is bounded before it reaches the database. A repeat load by the same visitor within 60 seconds on the same replica is skipped, because the 30-minute grouping makes it redundant. Past 64 writes in flight, a visit is dropped. The pool gives up on a connection after 2 seconds instead of queueing. Each case is counted on `helix.app.visits`.

4. **A visit is computed at query time.** It is a run of loads by one `visitorHash` with no gap longer than 30 minutes. A reload therefore doesn't inflate the count. A load with no hash (an edge without an auth secret) counts as its own visit and as no visitor. A **unique visitor** is a distinct hash, so people behind one NAT count once and one person on two networks counts twice. A visit counts in the window and on the day where it starts. A visitor counts in every window and day they loaded the app in, so a visit that straddles a boundary can leave a window with visitors and no visit.

5. **Geolocation runs in the portal, from an offline file.** The portal resolves the distinct prefixes at read time with an in-process reader over a DB-IP City Lite `.mmdb` (`mmdb-lib`, no runtime dependencies), behind a `GeoResolver` seam. There is no runtime API call, and no address leaves the portal.
   - The edge stays free of a 130 MB database and a new package; it remains dependency-minimal.
   - The file is downloaded when the portal image is built and refreshed by rebuilding.
   - DB-IP Lite is CC-BY 4.0, so the SPA shows its attribution beside the location table.
   - An operator may supply a GeoLite2 file instead (`PORTAL_GEOIP_DB_PATH`); the attribution follows the file.
   - With no file, the resolver reports itself unavailable as a value, and the view shows counts without location.

6. **Owner or admin only.** `GET /api/v1/apps/:slug/visitors` takes `ownsApp`, like the per-call feed, rather than the bare authentication of the aggregate gateway summary. Who opens an app is the owner's business.

7. **Grants and retention.**
   - `helix_edge` holds `INSERT` only, under FORCE RLS pinned to `app.app_id` and `env = 'prod'`, so it can append a visit but never read one back.
   - `helix_dev` and `helix_egress` have no grant, since the dev surfaces don't serve documents.
   - The portal deletes rows older than 180 days in an hourly sweep. That is the 90-day maximum range plus its comparison window.
   - Unlike the ledger, this table is erasable by design.

## Consequences

- **Undercounts are expected.** A document served by the offline capability's service worker (ADR-0035) never reaches the edge. Client-side route changes in a single-page app aren't page loads. Browsers that strip `Sec-Fetch-*` aren't counted. The view states what a visit is so the number isn't over-read.
- **Counts can be inflated, and row volume is bounded only by rate.** `Sec-Fetch-Dest` is client-settable, and app-host serving has no per-IP throttle. Per-replica dedupe absorbs a flood from one address, and the in-flight cap bounds write pressure from many. A client rotating through many addresses can still add rows at the cap's rate. That volume is accepted: it is bounded by the cap and the 180-day sweep, and adding a throttle to document serving would be a separate decision about the serving path.
- **Rotating `EDGE_AUTH_SECRET` resets unique-visitor continuity.** Visits before and after the rotation hash differently, so a returning visitor counts twice in a window that spans it. That is accepted rather than adding a second long-lived secret.
- **`visitorHash` is pseudonymous personal data.** It is stable per app for as long as the key lives. The 180-day sweep bounds it, the portal can delete any row, and the edge cannot read any. It is not a direct identifier, and nothing joins it to a session or a principal.
- **Location is approximate and labelled so.** Region-level accuracy from IP is materially worse than country-level. VPNs, mobile carriers and corporate egress place visitors wrongly. Private and CGNAT networks, which are all a dev edge sees, are reported as unresolved.
- **The portal holds the database in memory** (about 130 MB with DB-IP City Lite). A country-only file is a drop-in swap if that matters for a deployment; the view then shows countries without regions.
- **Not in scope:** per-page breakdowns, referrers, user agents, bot classification beyond the header test, per-user visit history for authenticated apps, and an app-facing analytics API. Each is a new decision, because each widens what a row holds.
