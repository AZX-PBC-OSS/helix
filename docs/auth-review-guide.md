# Reviewer's guide: the auth & authorization surface

This is a hand-off doc for reviewing **authentication and authorization** across the
platform. It started life as the M3 handoff-token review and has grown with the surface:
the OIDC handoff is still the crux, but the gate now fronts the `/_api/*` gateway, there is
a second same-origin front door (shared-password apps), an anonymous tier for public apps,
and a signed trust hop from the edge to `azx-egress`. This is the most security-sensitive
code in the platform, and the project plan calls for a dedicated review pass before things
build on it (project plan §6, architecture Appendix A.3). Read this first; it tells you
what the code is trying to do, where the load-bearing pieces are, the invariants that must
hold, and what to attack.

**Background you need:** `docs/platform-architecture.md` §4.2 (Authentication), §6
(the gateway), and **Appendix A** (the full flow, step by step). The feature-level
companion is `docs/features/authentication.md`. This guide assumes you've read Appendix A —
it references its step numbers.

---

## 1. The one-paragraph model

Apps are untrusted static files on per-app subdomains (`<slug>.azx.helix.azxlabs.io`;
`<slug>.local.helix.azxlabs.io` in dev). The edge terminates auth so apps ship zero auth code. A user
with no session is bounced to a **central** auth host (`auth.<base>`) because Entra allows
only one registered callback — so auth completes on the *wrong* host and a **one-time
handoff token** carries the authenticated state across to the app's own host, where a
host-scoped `__Host-session` cookie is finally minted. The handoff token is the crux:
**signed, 30 s, single-use, audience-bound**. Get its state validation, burning, and
audience checks exactly right and the design holds; get any one wrong and it breaks.

Three separate auth surfaces; don't conflate them:

| | Who authenticates | Mechanism | Lives in |
|---|---|---|---|
| **Edge app-user auth** | end users of hosted apps | OIDC → handoff → `__Host-session` cookie + server-side session, **or** a same-origin shared-password challenge | `apps/edge/src/auth/` |
| **Gateway authorization** | (no new principal) every `/_api/*` call | the session gate's `Caller`, an Origin/CSRF check, and per-app capability enforcement | `apps/edge/src/auth/gate.ts` + `apps/edge/src/gateway/` |
| **Portal API auth** | the CLI / SPA (operators) | stateless bearer **JWT** over JWKS | `apps/portal/src/auth/` |

Cookies are the *edge* mechanism. The portal has no cookies or sessions. The fourth hop —
the edge handing a signed instruction to `azx-egress` — is **not** an auth surface for a
user (egress never re-authenticates anyone); it's a service-to-service attestation, covered
in §11.

---

## 2. Trust boundaries and the "two-router" rule

The edge answers three host classes (`apps/edge/src/routing/hosts.ts`, `classifyHost`):
`app`, `auth`, `platform`. The rule that must never break: **control-plane handlers are
unreachable on app hosts, and vice versa.** A bug here (e.g. `/start` answering on an app
host, or `/_auth/complete` answering on the auth host) is a real vulnerability, not a
cosmetic routing slip.

Dispatch is explicit per-kind in `apps/edge/src/app.ts` (no Fastify host constraints — the
fallback semantics are too subtle to trust). When reviewing `app.ts`, check the host-kind
guard on **every** route, and that `/_auth/*`, `/_api/*`, and the shim path
`/_helix/fetch-shim.js` are reserved from the asset fallthrough (`isReservedAppPath`) so an
app can never ship a file that shadows them.

---

## 3. Suggested reading order

Read the primitives before the orchestration, then the enforcement, then the tests:

1. **`apps/edge/src/config.ts`** — what's configured, the fail-closed stances (auth block
   all-or-nothing; HTTPS-only / TLS-required-in-dev), and `publicOrigin` (URLs are built
   from config, **never** from request headers — this matters for redirect/audience/Origin
   integrity).
2. **`apps/edge/src/auth/secrets.ts`** — one `EDGE_AUTH_SECRET` → HKDF → purpose-bound
   keys (`flowKey`, `handoffKey`). Domain separation is why a flow token can't be replayed
   as a handoff token. (The egress instruction key is derived the same way from a
   *separate* secret — §11.)
3. **`apps/edge/src/auth/cookies.ts`** — the hand-rolled parser/serializers. `__Host-`
   prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`. Note the deliberate choice: a
   cookie name sent twice with conflicting values is treated as **absent** (not "first
   wins"), so attacker-injected duplicates can't smuggle a value past the parser.
4. **`apps/edge/src/auth/handoff.ts`** — mint/verify the handoff JWS. **The single most
   important file.** See §4.
5. **`apps/edge/src/auth/flow.ts`** — the `__Host-oidc-flow` cookie that carries OIDC
   round-trip state (`state`, `nonce`, PKCE verifier, target app, `rd`, `silent`).
6. **`apps/edge/src/auth/validate.ts`** — `validateReturnPath` (the open-redirect defense)
   and `resolveAppForAuth` / `visibilityAllows`.
7. **`apps/edge/src/auth/sessions.ts`** — the server-side session store; the atomic redeem
   is the single-use guarantee (§5), and `createActive` is the password path's direct mint.
8. **`apps/edge/src/auth/oidc.ts`** — the openid-client wrapper (discovery, code exchange,
   ID-token validation, `prompt=none` silent refresh). Thin on purpose.
9. **`apps/edge/src/auth/routes/authHost.ts`** — `/start` and `/callback` (Appendix A steps
   2–7). **The orchestration of the dangerous path.**
10. **`apps/edge/src/auth/routes/appHost.ts`** — `/_auth/complete` (step 8), `/_api/me`,
    `/_auth/logout`.
11. **`apps/edge/src/auth/routes/passwordLogin.ts`** + **`password.ts`** +
    **`loginThrottle.ts`** — the same-origin shared-password front door (§8).
12. **`apps/edge/src/auth/gate.ts`** — the per-request session gate and the `Caller` seam in
    front of asset serving **and** the gateway; navigation-vs-fetch behavior, the
    per-request visibility re-check, and the `public`-app short-circuit (§7).
13. **`apps/edge/src/gateway/`** — how the gateway consumes the `Caller`, the Origin/CSRF
    check, and per-app capability/quota enforcement (§10); `apps/edge/src/gateway/ipRateLimiter.ts`
    for the anonymous tier.
14. **The egress hop:** `packages/shared/src/instruction.ts`,
    `apps/edge/src/gateway/instruction.ts` (mint), `apps/egress/src/instruction.ts` (verify) (§11).
15. **Portal side:** `apps/portal/src/auth/verifier.ts`, `apps/portal/src/plugins/auth.ts`,
    `apps/portal/src/routes/auth.ts` (§12).
16. **CLI side:** `packages/cli/src/auth/{deviceFlow,tokenStore,session}.ts` (§13).

Files 4, 5, 6, 9, 10 are the **dedicated-review surface** — the handoff path. Spend the most
time there; 8 (sessions), 11 (password), and 14 (instruction) are the next tier.

---

## 4. The handoff token — what every property defends

`apps/edge/src/auth/handoff.ts`. Claims are deliberately minimal — `jti` (= the pending
session id), `aud` (= the **appId**, a UUID, not the slug), `rd`, plus `iat`/`exp`. **No
user PII ever travels in the URL.**

Verify each guarantee is actually enforced, not just intended:

- **Signed (HS256, key from HKDF):** `jwtVerify` pins `algorithms: ["HS256"]` — reject
  `alg: none` and asymmetric confusion. The `typ` header (`helix-handoff+jwt`) is checked,
  so a flow-cookie token can't be presented as a handoff token. Confirm the key is the
  *handoff* derived key, not the raw secret or the flow key.
- **~30 s TTL:** `exp` is enforced **and** `maxTokenAge` bounds `iat` — so a token with a
  doctored far-future `exp` but old `iat`, or a not-yet-issued token, both fail. jose only
  enforces `exp`/`iat` when present, so the code explicitly rejects their absence.
  `clockTolerance` is 5 s.
- **Single-use:** burned at redemption by the session store (§5), not here.
- **Audience-bound:** verified **twice**, on purpose (defense in depth). (a) The JWS `aud`
  must equal the appId the registry maps for the request's host (`appHost.ts`). (b) The
  redeem SQL also predicates on `appId` (`sessions.ts`). Either alone defeats audience
  confusion; both must stay.

Why `aud` is the appId and not the slug: slugs could in principle be recycled across apps;
appIds never are. Check nothing downstream re-derives audience from the slug.

---

## 5. The session store and the single-use burn

`apps/edge/src/auth/sessions.ts`. The OIDC lifecycle:

1. `/callback` inserts a **pending** row (`tokenHash = NULL`, `id` = the handoff `jti`)
   *before* minting the token. The token is worthless unless this exact row redeems.
2. `/_auth/complete` calls `redeem(id, appId, tokenHash)` — a **single** SQL statement:
   ```sql
   UPDATE sessions SET "tokenHash" = $1, "activatedAt" = now()
   WHERE id = $2 AND "appId" = $3 AND "tokenHash" IS NULL AND "expiresAt" > now()
   ```
   `rowCount === 1` means we won; `0` means already-redeemed (replay), expired-pending, or
   audience mismatch → 403, no cookie. **This atomic UPDATE is the single-use property of
   the entire handoff design.** The concurrency test in `sessions.integration.test.ts` fires
   N concurrent redeems and asserts exactly one wins — that test is load-bearing; treat
   changes to it as changes to a security guarantee.

Other things to confirm:

- The `__Host-session` cookie value is **fresh random** (`newSessionToken`), never the
  URL-borne handoff token. The DB stores `sha256(cookie)` (`hashSessionToken`), so a DB
  read-leak yields no usable cookies.
- Session lookup is one indexed SELECT per request (`lookup`), scoped to the app — **no
  in-memory cache**, so revocation (logout / disable) is real on the next request
  (architecture A.4). If someone proposes a cache, push back: it needs an invalidation story.
- The pending row is created with the user's identity + **group snapshot** taken at login;
  the snapshot is re-taken on silent refresh.
- **The password path skips this dance** (`createActive`, §8): there is no handoff to burn,
  so the row is inserted already-active. Confirm that path can never mint a session for an
  app that isn't in `password` mode.

---

## 6. The open-redirect defense

`apps/edge/src/auth/validate.ts`, `validateReturnPath`. `rd` (where to send the user after
login) is the classic open-redirector vector — and it's attacker-controlled at `/start`.
The function accepts only a same-origin **absolute path**: starts with exactly one `/`, no
`//`, no `/\`, no control chars or spaces, length bounded, and it must survive
`new URL(rd, base)` without changing origin. A bad `rd` is a hard 400 at `/start`, never
silently rewritten (silence hides attack attempts). `rd` also rides *inside* the signed
handoff, so it can't be tampered with between `/callback` and `/_auth/complete`, and it's
re-validated again at redemption.

The corpus in `validate.test.ts` and the open-redirect block in `adversarial.test.ts` are
where to add any vector you can think of. If you can get `validateReturnPath` to return a
value that navigates off-origin, that's a finding.

---

## 7. The session gate and the `Caller` seam (enforcement)

`apps/edge/src/auth/gate.ts`, wired into `apps/edge/src/serving/assets.ts` **and** the
gateway. Per request:

- **No/invalid/expired session:** top-level **navigations** 302 to the login flow;
  **fetches/subresources** get 401 `no-store`. The distinction uses `Sec-Fetch-Mode:
  navigate` (primary) with an `Accept: text/html` fallback. Misclassification must fail safe
  (a 401'd navigation is an error page, never a leaked asset). Check the ordering: the
  404/410 registry ladder answers *before* the gate, so unknown/archived apps don't reveal
  auth state.
- **Visibility re-checked every request** against the live registry entry, not just at login
  — tightening an app from `private` to `group` bites within the refresh interval. A
  non-member navigation is sent through silent re-auth (which re-snapshots groups and ends
  on the callback's 403 if they truly lack access — confirm this can't loop).
- **Silent refresh.** Past `refreshDueAt`, navigations take the `/start?silent=1` detour;
  `/_api/*` fetches get **401 `{code: "refresh_required"}`** — the stale group snapshot is
  an *authorization boundary*, not a hint, so the gateway must not serve on a stale session.
  Confirm the refresh decision can't be skipped for `/_api/*`.
- **The `Caller` seam.** `makeCallerResolver` wraps the gate with the `public`-app
  short-circuit: a `public` app yields an **unauthenticated caller** (`ANON_USER_OID =
  "anon"`) and skips the gate; every other mode goes through it. This one seam is the
  identity every gateway capability keys off (§10) — so its correctness is the gateway's
  authz correctness. A bug that yields an authenticated-looking caller on a private app, or
  an anon caller on a non-public app, is a direct authorization break.
- **The dev bypass** (`EDGE_DEV_ALLOW_UNAUTHENTICATED`) skips *only* this gate, is refused
  under `NODE_ENV=production`, and never relaxes TLS.

---

## 8. Shared-password auth (the second front door)

`apps/edge/src/auth/routes/passwordLogin.ts`, `password.ts`, `loginThrottle.ts`. A single
shared password on an app, for external demos (hand out URL + password at a conference
without making the app `public`). The key review fact: this is **entirely same-origin on the
app host** — no auth host, no handoff, no OIDC — so it does **not** touch the §4–§6 surface.
Review it as its own small front door:

- **Credential custody.** Only `passwordHash`/`passwordSalt` (scrypt) reach the edge via the
  registry projection; the AES-GCM ciphertext for owner re-display stays portal-side
  (`apps/portal/src/access/password.ts`). Confirm the edge holds nothing decryptable and the
  password never appears in any projection field, log, or open read.
- **The challenge.** `GET /_auth/login` renders a whitelabeled form under its own strict
  CSP; `POST /_auth/login` is **Origin-checked** (login-CSRF), **throttled**
  (`loginThrottle.ts`, 429 — a per-IP×app fixed-window backoff), and verifies with **async
  scrypt + `timingSafeEqual`** (fail-closed). Check: a wrong password re-renders the form and
  counts against the throttle; the verify is constant-time; the throttle key can't be
  bypassed by spoofable headers (it must derive the client IP the same trusted way the rest
  of the edge does).
  > **Resolved — [ADR-0004](adr/0004-auth-model.md)/[ADR-0011](adr/0011-in-memory-rate-limiting.md), issue #13.**
  > This review previously flagged four weaknesses here; all four are fixed, so don't re-file them.
  > The throttle is now a **shared PG counter** (`PgCounterStore`, `rate_counters`) rather than an
  > in-memory per-process map, so it holds under `maxReplicas>1`; the atomic upsert makes it
  > reserve-first, closing the check-then-increment TOCTOU; one interval sweep in `server.ts` GCs it;
  > `EDGE_TRUST_PROXY` is verified against the live ingress and set, so the key derives the real
  > client IP; and scrypt is at OWASP's `N=2^17`. The remaining judgement call is the *policy* —
  > window and threshold — not the mechanism.
- **The session it mints.** On success `SessionStore.createActive` inserts an **active**
  session directly (no pending/redeem) with a fresh pseudonym (`pw_<random>`,
  `displayName: "Guest"`, **no groups**), so each visitor gets isolated `user`-scope storage.
  `refreshDueAt == expiresAt`, so a password session never silently refreshes — it
  hard-expires and re-prompts. Confirm a password session can never be promoted to carry
  real groups.
- **SSO is also accepted on a password app.** `resolveAppForAuth` admits `password` apps into
  the OIDC flow (only `public` is excluded), and the callback's `visibilityAllows` lets any
  authenticated user through — the password is for externals; internal users just sign in.
  Review the branch logic: a **cold** navigation on a password app goes to the same-origin
  `/_auth/login`, but refresh/visibility redirects (which only happen for an SSO session on
  that app) target the auth host. Make sure these can't be confused into sending an OIDC
  flow to the password form or vice versa.

Tests: `password-login.test.ts`, `loginThrottle.test.ts`, plus the portal twins
`access-password.test.ts`, `access/password.test.ts`.

---

## 9. Logout and `/_api/me`

`apps/edge/src/auth/routes/appHost.ts`.

- **`POST /_auth/logout`** — **Origin-checked** (SameSite=Lax already blocks the cross-site
  form POST, Origin is defense in depth), **deletes the session row** (immediate revocation,
  not a tombstone or async GC), and clears the cookie. Confirm it can't be driven
  cross-origin and that a GET can't trigger it.
- **`GET /_api/me`** — returns `{user: {id, displayName}}` **only** — no email, no groups,
  no directory profile (Appendix A.6; hosted apps are untrusted). A fetch with no session
  gets 401, not a redirect. Confirm nothing leaks the group snapshot or email here.

---

## 10. The gateway authorization seam

`apps/edge/src/gateway/` (was "out of scope, M4" in the original guide; now in scope). The
gateway is the platform's value-add and its authorization is built from three independent
checks — verify each is present on **every** capability (`llm`, `data`, `fetch`):

- **Identity** comes from the §7 `Caller` (verified user, or the anon sentinel on public
  apps). Authorization is the pair *app X, on behalf of user Y, wants capability Z* — so a
  capability handler must never trust an app-supplied identity, only the `Caller`.
- **Origin/CSRF.** `/_api/*` is same-origin by design, so a mutation must carry an `Origin`
  that equals the app's **own** origin — and that origin is built from config
  (`publicOrigin` + the registry's slug), **never** from request headers. `SameSite=Lax`
  does not stop a *sibling* subdomain's form/fetch riding the session, so this check (plus
  `form-action 'self'` in CSP) is what does. Confirm it's enforced before any state change
  and can't be satisfied by a missing/empty Origin.
- **Capability + quota.** Per-app manifest allowlist (e.g. LLM model allowlist) and per-app
  daily budgets, enforced at admission with **finish-in-flight / block-new** semantics. The
  anonymous tier additionally hits `ipRateLimiter.ts` (per IP×app fixed window, `429
  rate_limited`); authenticated callers answer to per-app budgets instead. Every call is
  metered to `gateway_calls` (append-only by DB grant — see §11 on what that does and
  doesn't guarantee).

A useful adversarial frame: try to make a capability call that (a) runs with someone else's
identity, (b) rides a session cross-subdomain, or (c) exceeds a budget by racing admission.

---

## 11. The attested instruction (edge → egress)

`packages/shared/src/instruction.ts`, `apps/edge/src/gateway/instruction.ts` (mint),
`apps/egress/src/instruction.ts` (verify). The fetch-proxy splits policy (edge) from
mechanism (egress): the edge does all the §10 authorization, then mints a short-lived signed
**attested instruction** `(appId, userOid, capability, origin, connection, requestId)` and
forwards the call to egress, which **trusts it and never re-authenticates the user**. That
trust is the whole design, so the attestation must be airtight:

- **Same primitives as the handoff** — a JWS, `algorithms: ["HS256"]` pinned, `typ`
  (`helix-instruction+jwt`) checked, ~30 s TTL with `exp` + `iat`/`maxTokenAge` both
  enforced, key HKDF-derived from a **separate** secret (`HELIX_INSTRUCTION_SECRET`, not
  `EDGE_AUTH_SECRET`). Confirm the derivation is byte-identical on both sides and that egress
  returns null (never throws/serves) on any verification failure.
- **The secret never crosses this boundary.** The instruction names a *connection*; egress
  resolves it to plaintext under the `helix_egress` role. The edge has **no grant** on
  `app_secrets` at all, so it can never *read* a key directly. Verify the egress secret
  resolver scopes by `appId` (app-scoped first, then granted-global).
  > **Correction — [ADR-0013](adr/0013-egress-trust-model.md) (Proposed).** Do **not** treat
  > this seam as containing an edge compromise. The instruction is signed with a **shared
  > symmetric secret** that *both* planes hold, so a compromised edge can **forge** an
  > instruction for any `appId` and have egress *use* any app's connection — the `appId` claim
  > is not an isolation boundary today. There is also no `jti` replay-burn or `aud` check, and
  > `method`/`path` are unbound. This is a known gap being hardened (jti/aud burn now — issue
  > #3; per-action authz + method/path binding before multi-tenant — issue #6; asymmetric
  > signing post-M5). Flag regressions against that plan; the seam is *not* airtight yet.
- **SSRF is egress-side** (`apps/egress/src/ssrf.ts`): resolve the host, validate **every**
  returned address (block private/loopback/link-local/IMDS), pin the validated IP against
  rebind, no redirect-follow, a request-header safelist and a response-header **blocklist**
  (per [ADR-0005](adr/0005-ssrf-egress-controls.md) the blocklist has gaps — omits
  `authorization`/`www-authenticate` (#7), body caps read only `content-length` (#8), and the
  injection path still accepts `http://` (#11)). This is a network-layer boundary, not an auth
  one, but it's part of the same trust hop — see the egress adversarial suite.

This is service-to-service attestation, not user auth — but it earns a review pass because a
weakness here converts an edge bug into secret disclosure or SSRF.

---

## 12. Portal API auth (a separate, smaller surface)

`apps/portal/src/auth/verifier.ts`. Stateless: a bearer JWT is verified over the issuer's
JWKS with **strict `iss`, `aud`, `exp`, and an asymmetric alg pin** (`["RS256","ES256"]` —
HS256/none confusion dies). Verifiers form a chain; OIDC first, then the **demoted** dev
token (`createDevTokenVerifier`, which *refuses to construct* under production). Things to
confirm:

- `aud` is checked against a fixed value (`PORTAL_OIDC_AUDIENCE`) — a token minted for
  another audience by the same issuer must be rejected.
- `authenticate`/`requireActor` keep their signatures, so route code didn't change; the
  actor's `sub` prefers email for human-readable audit attribution.
- **Admin authorization is real for approvals.** `requireAdmin` checks the admin group claim
  (`PORTAL_ADMIN_GROUP_ID`); `PORTAL_ALLOW_SELF_APPROVE` is a dev escape hatch refused in
  prod. The approval write-gate (elevated capability/visibility changes) depends on this —
  confirm a non-admin principal can't approve, and that `/api/v1/approvals` decisions are
  separation-of-duty enforced.
- v0 *mutation* authorization is otherwise intentionally flat ([ADR-0007](adr/0007-portal-authz-v0.md),
  "authenticated == authorized"): any authenticated portal-audience principal may mutate any
  app and manage any app's secrets (same trust as the old shared token, now attributed).
  Per-app RBAC (owner/editor/viewer) is a v1 item. **Reviewer note:** the *deliberate* flatness
  is accepted for v0, but the app-scoped **secrets** and mutating routes doing no `ownsApp`
  check is a live BOLA/IDOR — treat it as a tracked gap (issue #9, an M5 exit criterion), not
  "nothing to see here." A second operator being able to write another's app *is* in scope to
  flag until that check lands.

---

## 13. CLI auth

`packages/cli/src/auth/`. The `azx` CLI authenticates with the **OIDC device flow**
(`deviceFlow.ts`, RFC 8628) and caches tokens in an XDG path (`tokenStore.ts`), keyed on
portal origin + issuer. Review points:

- **No long-lived secret in a repo or agent context** — the device flow is the design's
  answer to "a deploy token is code execution in front of every user" (architecture §5.1).
- `session.ts` precedence: `AZX_TOKEN` / `--token` wins (headless/CI), else the cache, with
  auto-refresh near expiry. The cache is **bound to the portal origin + issuer**, so a
  planted `portalUrl` in an `azx.json` can't replay a token at a different host. Confirm that
  binding holds.

---

## 14. Run the adversarial suite

The suite lands *with* the code (working agreement §6). Start here:

```bash
pnpm test apps/edge/src/auth/adversarial.test.ts      # the named attacks, unit-level
pnpm test apps/edge/src/auth                           # + handoff/flow/validate/gate/cookies/secrets/password
pnpm test apps/edge/src/auth/flow.integration.test.ts # full flow vs real oidc-provider + Postgres
pnpm test apps/egress/src/adversarial.test.ts          # SSRF: rebind, redirect-to-IMDS, header smuggling
pnpm test apps/portal/src/auth                          # JWT verifier + real device-flow e2e
```

`adversarial.test.ts` names each attack it kills: handoff replay (incl. a concurrent-redeem
race in the integration twin), audience confusion (both the JWS-`aud` and row-`appId` layers,
broken independently), open redirect, cookie tossing, state/nonce tampering,
expired/skewed/alg-confused tokens, session fixation. The integration tests drive a real
`oidc-provider` (in-process, ephemeral port — `apps/dev-idp/src/testing.ts`) through the
genuine PKCE/nonce/code exchange and a real `prompt=none` silent refresh. The password and
egress paths carry their own suites (§8, §11).

**A good review extends this suite.** If you suspect a gap, the highest-value output is a
failing test that demonstrates it.

---

## 15. Deliberate decisions (not findings)

Call these out only if you disagree with the *decision*, not as bugs:

- **HS256, not asymmetric.** Mint and verify are the same deployment (the auth host and
  app-host proxy are one process answering on different hostnames, Appendix A.2), so a
  keypair buys nothing. Same reasoning for the egress instruction (edge mints, egress
  verifies — but both are platform-operated). If the auth/egress services ever split across
  trust domains, swap to EdDSA inside the one mint/verify file.
- **Hand-rolled cookies, no `@fastify/cookie`.** The edge is dependency-minimal (project
  plan §1, §6); exactly two cookies exist. The parser is ~30 lines with its own corpus.
- **Per-request DB lookup, no session cache.** Revocation correctness over micro-optimization
  at tens-of-apps scale.
- **The password path mints a session with no handoff.** Same-origin proof-of-password is
  the credential; there's no cross-host gap to bridge, so the handoff dance would be
  ceremony. The trade-off is a second session-minting path — reviewed in §8.
- **`/_api/me` returns id + displayName only** — no email, no groups. Hosted apps are
  untrusted and don't get the directory profile.
- **dev-idp `conformIdTokenClaims: false`** is intentional: it keeps `groups` in the ID
  token (Entra parity; the edge never calls userinfo).

---

## 16. Out of scope for this review

- **Real Entra** verification — now live in the deployed platform (the swap was env-only, as
  designed). This guide's walkthrough still uses the local issuer, which exercises the identical
  flow.
- **Admin per-user *session* revocation UI** — the `sessions` table is migrated but there is
  no revoke route/UI yet (project plan §5.7). (Logout and app-disable already revoke; this is
  the admin-initiated kill of a *specific* live session.)
- **Per-app RBAC** (owner/editor/viewer roles) on the portal side — a v1 feature, out of
  scope here. But note ([ADR-0007](adr/0007-portal-authz-v0.md)) the flat v0 authz means
  app-scoped **secrets** and mutating routes do no ownership check — the resulting BOLA/IDOR
  (issue #9) *is* in scope to flag, and is an M5 exit criterion, even though full RBAC is not.
- **Audit tamper-evidence.** `gateway_calls` is append-only *by DB grant* (the edge has
  INSERT, not UPDATE/DELETE) but is **not** cryptographically tamper-evident — no hash chain
  or signature. Audit shipping to an immutable sink is a planned hardening (project plan §5.8);
  don't file the absence as an auth finding, but know the property's true boundary.

---

## 17. A reviewer's checklist

- [ ] No route in `app.ts` answers on the wrong host class; `/_auth/*`, `/_api/*`, and the
      shim path can't be shadowed by app assets.
- [ ] Handoff verify pins alg + typ, enforces `exp` **and** `iat`/`maxTokenAge`, and rejects
      missing temporal claims.
- [ ] Audience is checked at both the JWS and the SQL layers; neither was weakened to "fix"
      something.
- [ ] The redeem is a single atomic statement; the concurrency test still asserts
      exactly-one-wins.
- [ ] The session cookie is fresh-random and only its hash is stored; the handoff token
      never becomes the cookie.
- [ ] `validateReturnPath` rejects every off-origin form you can construct.
- [ ] The gate's 404/410 ladder runs before auth; navigation/fetch split fails safe;
      visibility + refresh are re-checked per request, including for `/_api/*`.
- [ ] The `Caller` seam yields anon **only** for `public` apps and a verified user for every
      other mode — no path produces the wrong one.
- [ ] The password path is Origin-checked, throttled, constant-time, mints only `pw_*`
      pseudonyms with no groups, and can't be invoked for a non-`password` app.
- [ ] Logout is Origin-checked and deletes the row; `/_api/me` leaks no email/groups.
- [ ] Every gateway capability enforces identity + Origin/CSRF + per-app quota; the
      anonymous tier is IP-rate-limited.
- [ ] The egress instruction pins alg/typ/TTL off its own secret; egress fails closed on bad
      instructions and resolves secrets scoped to the instruction's `appId`.
- [ ] Portal JWT verify pins asymmetric algs and checks iss/aud/exp; `requireAdmin` gates
      approvals; the dev verifier refuses production.
- [ ] The CLI token cache is bound to portal origin + issuer.
- [ ] No secret, token, or PII is logged or placed in a URL that lands in history/referrers
      (`Referrer-Policy: no-referrer` + `Cache-Control: no-store` on the token-bearing
      redirects).
- [ ] Any gap you found is captured as a failing test.
