# Visitor analytics

> **Related ADRs:** [ADR-0050](../adr/0050-hosted-app-visitor-analytics.md) (the decision) · [ADR-0037](../adr/0037-platform-observability-otlp-boundary.md) decision 11 (why this is not OTLP).

The app-detail **Usage** tab opens with a **Visitors** section for the app's owner and for platform admins. It answers whether anyone opens the app, how often, and roughly from where. It works the same for every visibility mode, and matters most for `public` and `password` apps, whose visitors the owner cannot otherwise see.

## What the owner sees

For a 7-, 30- or 90-day window:

- **Visits**, **unique visitors** and **visits per visitor**, each compared with the window of the same length just before it.
- A daily chart of visits and of distinct visitors per day.
- **Approximate location**: the top ten regions by unique visitors, an "Other locations" row for the rest, and an "Unresolved or private network" row. The DB-IP attribution link sits under the table.

Definitions:

- A **visit** is one or more page loads by the same visitor with no gap longer than 30 minutes. Reloads within a visit don't add to the count.
- A **unique visitor** is a distinct IP address within the app. People behind one NAT or corporate proxy count once; one person on two networks counts twice.

## How it works

1. **The edge records a load.** `apps/edge/src/serving/assets.ts` calls the recorder from `apps/edge/src/serving/visits.ts` when all of these hold:
   - the request is a `GET` with `Sec-Fetch-Dest: document` and no `Sec-Purpose` or `Purpose` header
   - it passed the session gate (or the app is `public`)
   - the response is an HTML document: a 200 with an HTML content type (including the SPA fallback), or a 304 on an `.html` or extensionless path

   The write is not awaited and cannot fail or delay the response. It is also bounded: a repeat load by the same visitor within 60 seconds on the same replica is skipped, at most 64 writes are in flight, and a write waits at most 2 seconds for a connection.
2. **The row is anonymised before it is written.** An `app_visits` row holds the app id, `visitorHash` (an HMAC of `appId|ip`, keyed from `EDGE_AUTH_SECRET`) and `ipPrefix` (/24 for IPv4, /48 for IPv6). It never holds the IP, a user, a path or a user agent.
3. **The portal aggregates.** `GET /api/v1/apps/:slug/visitors?range=7d|30d|90d` (`apps/portal/src/routes/visitors.ts`) runs the 30-minute grouping in SQL. It then resolves each distinct prefix through the `GeoResolver` (`apps/portal/src/geo/resolver.ts`) and rolls the results up to country and region. The route takes `ownsApp`. Only `prod` rows are read.
4. **Retention.** The portal deletes rows older than 180 days every hour (`apps/portal/src/visits/retention.ts`).

## What is not counted

- Subresources, iframe embeds, `HEAD`, `/_api/*` calls, and 404s.
- A gated app's unauthenticated load that redirects to login: the visit is counted once the visitor reaches the app.
- Requests without `Sec-Fetch-Dest`. Browsers send it; scanners, `curl` and most bots don't.
- Speculative loads: prefetch and prerender send `Sec-Purpose` (or `Purpose`) even if the page is never opened.
- A reload within 60 seconds of the same visitor's last recorded load. It would be part of the same visit anyway.
- Documents served by the offline capability's service worker (ADR-0035), and client-side route changes inside a single-page app.

## Geolocation database

Location comes from an offline DB-IP City Lite `.mmdb` file, read in process by `mmdb-lib`. No visitor address leaves the portal, and there is no runtime API.

| Setting | Meaning |
| --- | --- |
| `PORTAL_GEOIP_DB_PATH` | Path to the `.mmdb` file. The portal image sets it to the file downloaded at build time. Unset or unreadable means visitor counts work and location reports itself unavailable. |
| `GEOIP_DB_MONTH` (image build arg) | Empty takes this month, else last month; a failed download warns and the image ships without location. `YYYY-MM` pins a release and fails the build if it can't be downloaded. `skip` builds without it. CI skips it on pull requests. |
| `GEOIP_CACHE_KEY` (image build arg) | Changes the download layer's cache key without pinning a release. CI passes the current month. |

- **Local setup:** none. The dev container's `post-create.sh` downloads the file to `apps/portal/geo/` (gitignored), and `docker-compose.yml` sets `PORTAL_GEOIP_DB_PATH` to it. If that download failed, re-run `pnpm --filter @azx-pbc/portal geo:fetch`. The test suite pins the variable empty so test-built portals don't load the file. A local edge only sees loopback and private addresses, which always show as unresolved.
- **Licence:** DB-IP Lite is CC-BY 4.0. The attribution the SPA shows is a licence condition, not decoration. A GeoLite2 file also works, and its own notice is shown instead.
- **Updates:** the database changes monthly. CI's monthly cache key makes the first pushed build of a month download the new release. The downloader checks that the file ends in an MMDB metadata section before it replaces anything.

## Telemetry

The edge counts `helix.app.visits{appId, outcome}` with `outcome` of `recorded`, `failed`, `dropped` (the in-flight cap) or `deduplicated` (a repeat within 60 seconds). It is operational only. A sustained `failed` or `dropped` rate means visits are being lost: a slow database, or a flood of loads. The owner's numbers come from `app_visits`, not from this counter. No span carries the IP or the prefix.

## Known gaps

- **Unique-visitor continuity resets** when `EDGE_AUTH_SECRET` is rotated.
- **An edge with no auth configured** records visits with no hash. Those count as visits but not as visitors.
- **The geolocation database refreshes only with an image build.** An install that doesn't rebuild the portal keeps its old file (tracked in `TODO.md`). A failed unpinned download is cached under that month's key until the next month or a rebuild with a new key.
