# Authentication

> **Related ADRs:** [ADR-0004](../adr/0004-auth-model.md) (edge-terminated auth) · [ADR-0024](../adr/0024-portal-cli-bearer-jwt-jwks.md) (portal/CLI JWT) · [ADR-0019](../adr/0019-subdomain-per-app-isolation.md) (subdomain isolation) · [ADR-0011](../adr/0011-in-memory-rate-limiting.md) (in-memory rate limiting) · [ADR-0007](../adr/0007-portal-authz-v0.md) (portal authz v0).

There are **two** auth paths, deliberately separate:

1. **App-user auth** (the edge) — how a person signing into a hosted app gets a session. This
   is the platform's most security-sensitive code (architecture §4.2 / Appendix A) and carries
   a dedicated adversarial test suite.
2. **Portal/CLI auth** (the control plane) — how a deploy or registry mutation is authorized,
   via a bearer JWT verified statelessly over the issuer's JWKS.

Both run against the local OIDC issuer in dev (see [dev-idp.md](./dev-idp.md)); production
runs against **real Entra** — the swap was config-only, as designed. See the
[Entra registration runbook](../runbooks/entra-app-registration.md).

---

## App-user auth (the edge)

**What it is.** A central OIDC callback on `auth.<base>` does the code exchange once; a
single-use **handoff token** carries the result to the app subdomain, which mints a
`__Host-session` cookie backed by a server-side, revocable session row. Every asset and
`/_api/*` call on an app host then passes a per-request **session gate**.

### The flow (Appendix A, steps 1–8)

1. **`GET /start?app=<slug>&rd=<path>&silent=1`** on the auth host
   (`apps/edge/src/auth/routes/authHost.ts`) — validates the slug + return path (no open
   redirects), generates state/nonce/PKCE, stashes them in a signed `__Host-oidc-flow` cookie
   (10 min), and redirects to the IdP (`prompt=none` when silent-refreshing).
2. **`GET /callback`** on the auth host — verifies and burns the flow cookie, re-resolves the
   app (it may have been archived mid-flow), does the PKCE code exchange, extracts `oid` /
   `displayName` / `groups`, runs the **visibility check** (`visibilityAllows`), creates a
   **pending** session row (no `tokenHash` yet), mints the handoff JWS (`jti=sessionId`,
   `aud=appId`, ~30 s), and redirects to `<slug>/_auth/complete?token=…`.
3. **`GET /_auth/complete?token=…`** on the app host (`apps/edge/src/auth/routes/appHost.ts`) —
   verifies the handoff JWS (audience = appId, signature, expiry), then **atomically redeems**
   it: `UPDATE sessions SET tokenHash = $1 WHERE id = $2 AND appId = $3 AND tokenHash IS NULL`.
   The cookie value is freshly random (never the URL-borne token); it's stored only as a SHA-256
   hash. Sets `__Host-session` (HttpOnly, Secure, SameSite=Lax) and redirects to the original
   path.

Single-use is enforced two ways (defense in depth): the JWS `aud` check **and** the store's
atomic `appId`+`tokenHash IS NULL` predicate — either alone defeats replay and audience
confusion.

### The session gate (`apps/edge/src/auth/gate.ts`)

One indexed `SELECT` per request — no cache, so revocation is immediate (Appendix A.4). Key
behaviors:

- **Navigation vs. fetch.** `Sec-Fetch-Mode` is authoritative (Accept sniff as fallback). No
  session → a navigation **302s** to `/start`; a fetch gets **401** `{code: "unauthorized"}`.
  Misclassification fails safe.
- **Per-request visibility re-check.** `visibilityAllows(entry, session.groups)` runs against
  the **live** registry entry, so tightening an app from private → group bites immediately
  (bounded by snapshot staleness). A silent refresh re-snapshots groups at the IdP.
- **Silent refresh.** Past `refreshDueAt`, navigations take the `/start?silent=1` detour;
  `/_api/*` fetches get **401** `{code: "refresh_required"}` (the stale group snapshot is an
  authorization boundary, not a hint); passive assets stay lenient until hard expiry.
- **The `Caller` seam.** `makeCallerResolver` wraps the gate with the `public`-app
  short-circuit: `public` apps yield an unauthenticated caller (`ANON_USER_OID = "anon"`) and
  skip the gate, while every other mode goes through it. This is the single identity seam the
  gateway keys off (see [llm-gateway.md](./llm-gateway.md), [app-data-gateway.md](./app-data-gateway.md)).
- **`public` visibility — anonymous tier.** Going public is a high-risk change that routes through
  the approval queue (`docs/design/approvals.md` §6.3); the portal **Settings → Visibility** card
  is the real switcher for it (reductions apply immediately, public opens a request). At the
  gateway the anonymous tier is **per-IP rate-limited** — `apps/edge/src/gateway/ipRateLimiter.ts`,
  a fixed-window limiter over the shared `CounterStore` (`counterStore.ts`) it shares with
  `loginThrottle.ts`, caps every anonymous `/_api/*`
  call per IP+app (`429 rate_limited`; `EDGE_ANON_RATE_LIMIT`/`EDGE_ANON_RATE_WINDOW_MS`).
  Authenticated callers are never limited here — they answer to per-app budgets.

### Other app-host endpoints

- **`GET /_api/me`** — returns only `{user: {id, displayName}}` (Appendix A.6); a fetch with no
  session gets 401, not a redirect.
- **`POST /_auth/logout`** — Origin-checked, deletes the session row (immediate revocation,
  no async GC), clears the cookie.

### Shared-password visibility (`password`)

A single shared password on an app, for external demos — the URL + password are handed out (e.g.
at a conference) without making the app `public`. Unlike SSO this is **entirely same-origin on the
app host** (no auth host, no handoff), so the OIDC review surface is untouched.

- **Storage (portal).** The owner manages the credential through authenticated routes —
  `POST/GET/DELETE /api/v1/apps/:slug/access/password` and `…/rotate` (`apps/portal/src/routes/apps.ts`).
  Enabling flips visibility to `password` and mints an xkcd-style passphrase
  (`correct-horse-battery-staple`, `apps/portal/src/access/`). Two representations are stored
  (`apps/portal/src/access/password.ts`): `passwordHash`/`passwordSalt` (scrypt) and `passwordEnc`
  (AES-256-GCM under `PORTAL_SECRET`, decryptable for re-display). The password **never** appears in
  `toApp`/`toManifest` or any open read.
- **Projection.** Only `passwordHash`/`passwordSalt` reach the edge (registry projection); the edge
  holds nothing decryptable.
- **Challenge (edge).** `apps/edge/src/auth/routes/passwordLogin.ts` serves `GET /_auth/login` (a
  whitelabeled form under its own strict CSP) and verifies `POST /_auth/login`: Origin-checked
  (login-CSRF), brute-force throttled (`loginThrottle.ts` — 429), and the password re-derived with
  async scrypt + `timingSafeEqual` (`password.ts`, fail-closed). On success it inserts an **active**
  session directly (`SessionStore.createActive` — no pending/redeem) and sets `__Host-session`.
- **Identity.** Each login mints a fresh pseudonym (`pw_<random>`, `displayName: "Guest"`, no
  groups), so visitors get isolated `user`-scope storage. No silent refresh for a password
  session — the session hard-expires and re-prompts. `visibilityAllows` returns `true` for a
  password session (the password was the proof); a cold navigation goes to the same-origin
  `/_auth/login` instead of the OIDC `/start`.
- **SSO is also accepted.** A `password` app is *the shared password **or** any SSO user* — the
  password is for externals; internal users just sign in. So `resolveAppForAuth` admits password
  apps into the OIDC flow (only `public` is excluded — it has no session), the callback's
  `visibilityAllows` lets any authenticated user through, and the login page links to
  `auth.<base>/start?app=…`. An SSO session on a password app behaves like any other (real
  identity + groups, silent refresh): the gate's refresh/visibility redirects target the auth
  host, while only the *cold* redirect picks the password form — a password session never reaches
  a refresh (its `refreshDueAt == expiresAt`).

Tests: `apps/edge/src/auth/password-login.test.ts` + `loginThrottle.test.ts`,
`apps/portal/src/routes/access-password.test.ts` + `access/password.test.ts`.

> **Throttle status (ADR-0004 / ADR-0011, issue #13).** The login/anonymous throttle is now
> backed by a **shared Postgres counter** (`rate_counters`, `gateway/counterStore.ts`): the limit
> holds across replicas (no more per-process N×), the atomic `INSERT … ON CONFLICT … RETURNING`
> makes the login throttle **reserve-first** (closing the check-then-increment TOCTOU), and one
> interval sweep in `server.ts` GCs it (the old never-scheduled `sweep()` is gone). Scrypt cost is
> at OWASP's `N=2^17` (ISSUE-08). **One residual:** `trustProxy` is now a config knob
> (`EDGE_TRUST_PROXY`, default off) but the correct Container Apps ingress hop count must still be
> verified against the live deployment before per-client limits can be trusted — until then
> `req.ip` may collapse to the ingress address (tracked under issue #13).

### Crypto + key material

- `apps/edge/src/auth/flow.ts` — the signed `__Host-oidc-flow` cookie (HS256, 10 min).
- `apps/edge/src/auth/handoff.ts` — the one-time handoff JWS.
- `apps/edge/src/auth/sessions.ts` — random cookie value, stored as SHA-256 hash; the atomic
  redeem; lookup scoped to `appId`.
- `apps/edge/src/auth/secrets.ts` — HKDF-derives separate `flowKey` + `handoffKey` from
  `EDGE_AUTH_SECRET` (≥32 bytes). Auth env vars are set together or not at all; missing them
  fails closed.

### The adversarial suite (project plan §6)

Anything touching this path changes its tests **in lockstep**:

- `apps/edge/src/auth/adversarial.test.ts` and `handoff.test.ts` — replay, audience confusion,
  open-redirect, cookie tossing, state/nonce tampering, expired/alg-confused tokens, fixation.
- `apps/edge/src/auth/flow.integration.test.ts` and `sessions.integration.test.ts` — the real
  flow against an ephemeral dev-idp, including the concurrent-redeem race and `prompt=none`.

---

## Portal / CLI auth (the control plane)

**What it is.** Portal `/api/v1/...` routes — reads and mutations alike — require a bearer
token run through a **verifier chain** in `apps/portal/src/auth/verifier.ts`; the first verifier
that accepts wins. Only `/health` and the auth-config bootstrap endpoint stay public (so the SPA
can sign in). Built from env in `apps/portal/src/plugins/auth.ts` (the `authenticate`
preHandler).

1. **OIDC verifier** — an IdP-minted JWT verified statelessly over the issuer's JWKS (`jose`).
   Discovers `.well-known/openid-configuration`, enforces `https://` issuer + JWKS, asymmetric
   algs only (RS256/ES256), checks issuer/audience/exp/iat with 5 s clock tolerance. Configured
   by `PORTAL_OIDC_ISSUER` + `PORTAL_OIDC_AUDIENCE`.
2. **Dev-token verifier** — a timing-safe compare against `PORTAL_DEV_TOKEN` for CI/scripts,
   attributed to `PORTAL_DEV_ACTOR`. **Refused in production** (throws at startup).

Supporting routes: **`GET /api/v1/auth/config`** (public — issuer + client IDs for the CLI/web
to bootstrap) and **`GET /api/v1/me`** (echoes the authenticated actor `{sub, via, name?,
email?}`, powering `azx whoami`). Tested in `apps/portal/src/auth/oidc.integration.test.ts`.

**Authorization model (v0):** authz is **flat** — any authenticated portal-audience principal may
mutate ("authenticated == authorized"), the same level as the old shared token, now attributed in
the audit log. The **BOLA** (broken object-level authorization) half of that is now closed: an
`ownsApp` owner-or-admin gate guards every app-scoped mutating and secret route, fail-closed on a
null `ownerId` (ADR-0007, issue #9). What remains is per-app **RBAC** — reads are still
authenticated-only, so any authenticated principal can see any app's metadata. That is the v1 fix,
not merely a nice-to-have.

## Planned / not yet built

- **Per-app RBAC** on the portal side (v1). The BOLA half is done (`ownsApp`); what's left is
  owner/editor/viewer roles and owner-scoped **reads**, which are still authenticated-only
  (ADR-0007, issue #9).
- Per-app **group visibility** (`visibility: group`) is built but deferred in practice until a
  pilot app needs it; pilot apps use `private`/`password`.

**Since shipped — real Entra registration.** Production now authenticates against a real Entra
app registration; the swap was config-only (issuer/client), exactly as designed, and the local
issuer had already exercised the flow end to end. The step-by-step setup is the
[Entra registration runbook](../runbooks/entra-app-registration.md). Two decisions are baked in
there: authorization rides **Entra App Roles** (the `roles` claim carries human-readable values
like `platform-admin` — no GUIDs, no Graph, no group-overage), and the portal audience is
`api://<guid>` rather than the dev `urn:helix:portal`.
