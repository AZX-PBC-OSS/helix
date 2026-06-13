# M3 Auth — adversarial security review (combined + verified)

Two engines reviewed the M3 auth surface independently — Claude (interactive deep
read + live pentest) and Codex (`codex exec`, see `review-codex.md`). Findings were
merged and **every one was verified against the running stack** (a gate-enabled edge
on `:8443`, the portal on `:3001`, the dev-idp on `:3002`, real Postgres). This is a
source + runtime audit of the code as it stands on `main`, not a diff review.

## Bottom line

The core handoff design is **sound and the hard invariants hold under live attack.**
I confirmed, against a real server + Postgres, that all of these are correctly
enforced: single-use burn (incl. a 20-way concurrent-redeem race → exactly one
winner), audience binding at both the JWS and SQL layers, rejection of forged tokens
(alg=none, wrong key, wrong `typ`, expired `exp`, ancient `iat`/future `exp`, missing
temporal claims), open-redirect `rd` vectors, two-router host isolation, cookie
tossing, session fixation, logout origin-check + immediate revocation, Host-header /
`X-Forwarded-Host` independence of redirect targets, and the portal JWT verifier's
alg/iss/aud pinning (alg=none, HS256-confusion, attacker-key, wrong-aud all rejected).
The existing adversarial suite (100 edge-auth tests) is genuinely comprehensive and
passes.

The findings below are **not breaks of the cross-app isolation model** — that holds.
They are (a) one containment gap that matters now and more in M4, (b) two operator/CLI
control-plane hardening gaps, and (c) several defense-in-depth items. Severities are
**my verified ratings**; where I diverge from Codex's I say so and why.

| #   | Finding                                                      | Codex    | Verified            | Status                                   |
| --- | ------------------------------------------------------------ | -------- | ------------------- | ---------------------------------------- |
| 1   | App service worker can read the URL-borne handoff token      | Critical | **High**            | Confirmed (enabling conditions live)     |
| 2   | CSP not sent on active non-HTML docs (SVG/XML)               | High     | **High**            | Confirmed live                           |
| 3   | CLI bearer token not bound to portal origin                  | High     | **High**            | Confirmed reachable                      |
| 4   | Portal JWT verifier accepts tokens with no `exp`             | High     | **Medium**          | Confirmed live                           |
| 5   | Refresh-due sessions keep serving fetches to hard expiry     | Medium   | **Medium**          | Confirmed (partly by-design)             |
| 6   | Portal OIDC issuer/JWKS not forced HTTPS in prod             | Medium   | **Medium**          | Confirmed (code)                         |
| 7   | `/start` redirect lacks `Referrer-Policy`                    | Low      | **Low (mitigated)** | Confirmed, but browser defaults blunt it |
| 8   | Encoded reserved paths (`/_api%2fme`) fall through to assets | Low      | **Low**             | Confirmed live                           |
| 9   | `assets.ts` `..` bug-trap 500s on legit filenames            | —        | **Low**             | Confirmed live (Claude-only)             |
| 10  | Dev-token compared non-constant-time                         | —        | **Info**            | Confirmed (code)                         |

---

## 1. High — an app's service worker can read the handoff token from the URL

**`apps/edge/src/auth/routes/authHost.ts:180`, `apps/edge/src/serving/csp.ts:37`.**
The handoff token is delivered to the app origin in the query string
(`/_auth/complete?token=…`), and app CSP permits same-origin service workers
(`worker-src 'self'`). A malicious hosted app can register a root-scoped service
worker; on a later login/silent-refresh navigation to `…/_auth/complete?token=…`, the
worker sees `event.request.url` — including the token — before the edge does, and can
exfiltrate it and redeem it server-side.

**Verified enabling conditions (live):** app CSP ships `worker-src 'self' blob:`; no
`Service-Worker-Allowed` or registration-blocking header is sent on assets; the token
is in the URL. Service-worker interception of same-origin navigations is standard
browser behavior. (I did not stand up a headless browser to register the worker — no
Playwright here — but every precondition is confirmed and the behavior is well-defined.)

**Why High, not Critical:** the stolen token is **audience-bound to the worker's own
app** and the worker runs only on that origin, so there is **no cross-app/cross-tenant
escalation** — the platform's per-app blast-radius model is intact. The real impact is
that an untrusted app can convert a user's _in-browser_ login into a **durable,
headless server-side session for that same app** (≤ session TTL, default 8h), carrying
the user's identity + group snapshot. The app already controls all of its own client
surface for that user, so this is an escalation in _form_ (out-of-browser, persistent),
not in _reach_. It becomes materially worse once M4 ships the `/_api/*` gateway (LLM
proxy, quotas, app data), where a headless user-session can burn quota / act as the
user away from the browser. The architecture doc already reasons about persistent
service workers (subdomain quarantine, A.1) — this is the gap in that analysis.

**Fix options:** (a) drop `'self'` from `worker-src` so apps can't register service
workers (kills a legit capability — product call); or (b) move the handoff off the
URL into a mechanism the app-origin worker can't observe; or (c) accept it explicitly
as within the per-app trust model and document it. Whatever the choice, decide it
**before M4**. Add a browser-level test asserting `navigator.serviceWorker.register`
is blocked if you go with (a).

## 2. High — CSP containment is skipped for active non-HTML documents

**`apps/edge/src/serving/assets.ts:95,118`.** CSP is attached only when the stored
content type starts with `text/html`. **Verified live:** `index.html` returns the full
`APP_CSP`; any non-HTML response returns none. But a browser-active document such as a
top-level **SVG** (`image/svg+xml`) or XML can carry script — and the deployed
`hello-world` app already references `favicon.svg`, so SVGs are in play. Navigating to
an app-shipped `/x.svg` executes its script in the app origin with **no CSP**, so the
directives `csp.ts` itself calls "the containment that doesn't bend" —
`connect-src 'self'`, `form-action 'self'`, `frame-ancestors 'none'` — do not apply.

**Impact:** today the SVG's script can read same-origin `/_api/me` and exfiltrate
`id`/`displayName` to any origin (the data-flow boundary the platform relies on is
bypassed). In M4 the same hole lets app code call same-origin gateway APIs and ship the
results anywhere. It also compounds #1: an SVG document could register a service worker
even if HTML registration were blocked.

**Fix:** send `APP_CSP` on **every** app response (CSP on inert assets is harmless), or
at minimum on all browser-active document types (`text/html`,
`application/xhtml+xml`, `image/svg+xml`, XML variants). Add a test that an app-served
SVG carries the strict data-flow CSP.

## 3. High — CLI bearer tokens are not bound to the portal origin

**`packages/cli/src/auth/session.ts:49`, `tokenStore.ts:19`, `config.ts:48`.** The
token cache is keyed by **issuer only** (`byIssuer`), and the CLI sends the cached
token to whatever `portalUrl` is configured — which **resolves from repo-controlled
`azx.json`** (`flags ?? AZX_PORTAL_URL ?? file.portalUrl ?? default`, verified).

**Attack (verified reachable):** a planted `azx.json` (or a prompt-injected
`--portal-url`) points the CLI at `https://evil.example`; that host serves
`/api/v1/auth/config` echoing the **real** issuer; `makeTokenProvider` finds the
victim's cached real-issuer token and sends it as `Authorization: Bearer …` to
`evil.example`, which replays it against the real portal — mutating the control plane
as the victim until token expiry. This sits squarely in the platform's coding-agent
threat model.

**Fix:** key stored tokens by **portal origin** (normalized `portalUrl`) in addition to
issuer; require an explicit `azx login` per portal origin before sending cached tokens;
ideally exclude `portalUrl` from repo-controlled `azx.json` for authenticated commands
(or trust-on-first-use). Have `/api/v1/auth/config` advertise the expected audience and
include it in the cache key.

## 4. Medium — portal JWT verifier accepts tokens with no `exp`

**`apps/portal/src/auth/verifier.ts:69`.** `jwtVerify` is called with `issuer`,
`audience`, and an asymmetric alg pin, but `exp` is never required, and `jose` only
enforces `exp` when present. **Verified live:** an RS256 token with `iss`/`aud`/`sub`
and **no `exp`** is accepted (`-> ACCEPTED as nobody@evil.com`); the with-`exp` and
expired-`exp` controls behaved correctly. This contradicts the reviewer guide's stated
`iss`/`aud`/`exp` invariant for operator auth, and it diverges from the **edge** handoff
verifier, which explicitly rejects missing `exp`/`iat`.

**Why Medium, not High:** exploitability requires the issuer to ever emit a no-`exp`
portal-audience token — Entra and the dev-idp always set `exp`, so this is a
defense-in-depth gap rather than a live bypass. The fix is one line and should match the
edge:

```ts
if (typeof payload.exp !== "number") return null; // and consider iat + maxTokenAge
```

Add verifier tests for missing `exp`/`iat` and excessive age.

## 5. Medium — refresh-due sessions keep serving fetches/subresources to hard expiry

**`apps/edge/src/auth/gate.ts:100`.** Silent refresh fires only for navigations;
`fetch`/subresource requests on a refresh-due session are served on the **stale group
snapshot** until hard `expiresAt` (default 8h). The per-request visibility re-check uses
`session.user.groups` (the snapshot), not live IdP membership — so a user removed from a
group at the IdP keeps passing background `fetch`/`/_api/*` calls for up to 8h if their
tab never navigates. This is currently locked in by a test and is partly intended
(navigations carry the refresh bound), but it weakens the "tightening bites within the
refresh interval" model and matters for M4 gateway calls (which are fetches).

**Fix:** treat `refreshDueAt` as an authorization boundary for `/_api/*` — return
`401 no-store` with a `refresh_required` code for fetches once refresh is due (let
passive assets stay lenient if desired) — or document the hard TTL as the real
revocation bound.

## 6. Medium — portal OIDC discovery / JWKS isn't forced to HTTPS in production

**`apps/portal/src/auth/verifier.ts:55`, `plugins/auth.ts:44`.** The portal fetches
discovery from `PORTAL_OIDC_ISSUER` and trusts the returned `jwks_uri` with **no scheme
check and no production refusal** — unlike the edge, which rejects a non-https issuer
unless an explicit insecure-dev flag is set (`config.ts:165`). A prod misconfig with an
`http://` issuer (or a discovery doc pointing at an `http://` JWKS) lets a network
attacker supply signing keys and mint portal-audience tokens.

**Fix:** at boot, require `https:` for the issuer (and the discovered `jwks_uri`) unless
`NODE_ENV !== "production"` + an explicit insecure flag; validate the discovery
document's `issuer` equals the configured issuer.

## 7. Low — `/start` redirect has no `Referrer-Policy` (largely mitigated)

**`apps/edge/src/auth/routes/authHost.ts:99`.** The `/start → IdP` redirect sets
`Cache-Control: no-store` but not `Referrer-Policy` (the token-bearing `/complete`
redirect does set `no-referrer`). **Verified:** the header is absent. In practice the
leak Codex describes (full `/start?app=…&rd=…` reaching the IdP via `Referer`) is
blunted by the modern browser default `strict-origin-when-cross-origin`: the IdP is
cross-origin (and in dev a https→http downgrade), so browsers send only the origin — or
nothing — not the path/query. Still worth adding `Referrer-Policy: no-referrer` to
`/start` and the silent-refresh restart (`:145`) for consistency and older clients.

## 8. Low — encoded reserved-namespace paths fall through to app assets

**`apps/edge/src/app.ts:201`.** `isReservedAppPath` checks the **raw** URL, but asset
serving later percent-decodes, so `/_api%2fme` isn't treated as reserved and is resolved
as the app asset `_api/me`. **Verified live:** `/_api%2fme → 404` (no such asset; would
be served if the app shipped one) while literal `/_api/me → 200` (platform handler). It
is **not an auth bypass** — encoded variants never reach the platform handler, and any
served asset is still behind the gate — but it's a namespace-hygiene gap that could
confuse logs/proxies/future routing.

**Fix:** run the reserved-prefix check on the same normalized/decoded path
`normalizeRequestPath` produces, before `serveAsset`. Add tests for `/_api%2fme`,
`/%5fapi/me`, `/_auth%2fcomplete`.

## 9. Low — `getUnderPrefix` `..` trap 500s on legitimate filenames (Claude-only)

**`apps/edge/src/serving/assets.ts:139`.** The bug-trap `key.includes("..")` is broader
than the traversal check that precedes it: `normalizeRequestPath` lawfully passes a
segment like `foo..bar.js` (it only rejects the exact `.`/`..` segments), but the trap
then throws → **500**. **Verified live:** `/foo..bar.js → 500`, control
`/normal-missing.js → 404`. Fails closed (no asset leak), so it's robustness not
security, but a deployed app with a `..`-containing filename (`vendor..min.js`,
`file..bak.js`) would 500. Tighten the trap to detect an actual `../` escape (e.g.
`key.includes("/../") || key.endsWith("/..")`) rather than any `..`.

## 10. Info — portal dev-token compared non-constant-time

**`apps/portal/src/auth/verifier.ts:98`.** `token !== expected` is not constant-time. The
dev token is CI/dev-only and refused in production, so impact is negligible; use
`crypto.timingSafeEqual` if you want to close it.

---

## Verified-correct (attacked, held)

Handoff JWS (alg/`typ`/`aud`/`exp`+`iat`/`maxTokenAge`); single-use atomic burn incl.
live 20-way concurrent race (exactly one winner); audience confusion at both JWS and SQL
layers; `validateReturnPath` against every off-origin form tried; two-router host
isolation (auth routes 404 on app/platform hosts and vice versa, live); cookie tossing
(duplicate-conflict → absent); session fixation (preset cookie ignored, fresh random
minted, only its hash stored); logout origin-check + immediate revocation; redirect
targets built from config not `Host`/`X-Forwarded-Host`; `/_api/me` minimal
(`id`+`displayName` only, gated even under the dev bypass); portal JWT alg=none /
HS256-confusion / attacker-key / wrong-aud all rejected; dev token refused in production.

## How to turn findings into tests (per working agreement §6)

Highest-value next step is a failing test per finding: an edge test that an
`image/svg+xml` response carries `APP_CSP` (#2); a portal `verifier.test.ts` case for a
no-`exp` token (#4); a CLI `session.test.ts` case asserting a token cached for portal A
is not sent to portal B (#3); edge tests for `/_api%2fme` (#8) and `/foo..bar.js` (#9).

---

## Remediation (2026-06-13) — all 10 findings fixed, each pinned by a test

| #   | Fix                                                                                                                                                                                                                                                     | Pinned by                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | Product call: service-worker registration blocked platform-wide — the edge 403s any request carrying the `Service-Worker` header (`assets.ts`); web workers unaffected. Documented in csp.ts, architecture §4.4 + A.3                                   | `app.test.ts` "refuses service-worker registration fetches"                                                       |
| 2   | `APP_CSP` sent on every app response (200 and 304), any content type (`assets.ts`)                                                                                                                                                                      | `app.test.ts` "full app CSP on … SVG"                                                                             |
| 3   | Token cache rekeyed to **portal origin** (file format v2; v1 reads as logged out), entry also bound to the advertised issuer; `/api/v1/auth/config` now advertises `audience`, stored alongside                                                         | `session.test.ts` "never sends a token cached for portal A to portal B"; `tokenStore.test.ts` origin/issuer cases |
| 4   | Portal verifier requires `exp` **and** `iat` post-`jwtVerify`, matching the edge handoff verifier                                                                                                                                                       | `verifier.test.ts` no-`exp` / no-`iat` cases                                                                      |
| 5   | Product call: `refreshDueAt` is an authz boundary for `/_api/*` — refresh-due fetches there get `401 {code: "refresh_required"}`; passive assets stay lenient (`gate.ts`)                                                                               | `gate.test.ts` "401s refresh-due /\_api/\* fetches"                                                               |
| 6   | `createOidcVerifier` refuses a non-https issuer unless `PORTAL_OIDC_ALLOW_INSECURE=true` (flag itself refused in production); discovery doc's `issuer` must match and `jwks_uri` must be https. Dev flag added to devcontainer compose (rebuild needed) | `verifier.test.ts` "transport security" suite                                                                     |
| 7   | `Referrer-Policy: no-referrer` on the `/start` redirect and the silent-refresh restart (`authHost.ts`)                                                                                                                                                  | `adversarial.test.ts` /start + restart assertions                                                                 |
| 8   | Reserved-namespace check also runs on the percent-decoded path (`app.ts` uses `normalizeRequestPath`)                                                                                                                                                   | `app.test.ts` `/_api%2fme`, `/%5fapi/me`, `/_auth%2fcomplete`                                                     |
| 9   | Bug trap detects an actual `..` segment (`/../` or trailing `/..`), not the substring (`assets.ts`)                                                                                                                                                     | `app.test.ts` "filenames containing `..`"                                                                         |
| 10  | Dev-token compare uses `crypto.timingSafeEqual`                                                                                                                                                                                                         | existing exact-match test                                                                                         |
