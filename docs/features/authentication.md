# Authentication

There are **two** auth paths, deliberately separate:

1. **App-user auth** (the edge) — how a person signing into a hosted app gets a session. This
   is the platform's most security-sensitive code (architecture §4.2 / Appendix A) and carries
   a dedicated adversarial test suite.
2. **Portal/CLI auth** (the control plane) — how a deploy or registry mutation is authorized,
   via a bearer JWT verified statelessly over the issuer's JWKS.

Both run against the local OIDC issuer in dev (see [dev-idp.md](./dev-idp.md)); production
points at Entra (config-only, the M3 tail).

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
  groups), so visitors get isolated `user`-scope storage. No silent refresh — the session
  hard-expires and re-prompts. `visibilityAllows` returns `true` for a password session (the
  password was the proof); the gate redirects password-app navigations to the same-origin
  `/_auth/login` instead of the OIDC `/start`.

Tests: `apps/edge/src/auth/password-login.test.ts` + `loginThrottle.test.ts`,
`apps/portal/src/routes/access-password.test.ts` + `access/password.test.ts`.

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

**What it is.** Portal mutating routes (`/api/v1/...`) require a bearer token run through a
**verifier chain** in `apps/portal/src/auth/verifier.ts`; the first verifier that accepts wins.
Reads are open. Built from env in `apps/portal/src/plugins/auth.ts` (the `authenticate`
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

**Authorization model (v0):** any authenticated portal-audience principal may mutate — the same
level as the old shared token, now attributed in the audit log. Per-app RBAC is a v1 feature.

## Planned / not yet built

- **Real Entra registration** — the remaining M3 tail; the flow is designed to be config-only
  (issuer/client swap), already exercised end-to-end against the local issuer.
- **`public` visibility** — wired through the `Caller` seam (anonymous, no `user`-scope data);
  serving/gateway honor it now.
- **Per-app RBAC / ownership** on the portal side (v1).
