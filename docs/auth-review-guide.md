# Reviewer's guide: M3 auth

This is a hand-off doc for reviewing the **M3 (local half) auth** work. It is the
most security-sensitive code in the platform, and the project plan calls for a
dedicated review pass before anything builds on it (project plan §6, architecture
Appendix A.3). Read this first; it tells you what the code is trying to do, where
the load-bearing pieces are, the invariants that must hold, and what to attack.

**Background you need:** `docs/platform-architecture.md` §4.2 (Authentication) and
**Appendix A** (the full flow, step by step). This guide assumes you've read
Appendix A — it references its step numbers.

---

## 1. The one-paragraph model

Apps are untrusted static files on per-app subdomains (`<slug>.azx-labs.com`;
`<slug>.localtest.me` in dev). The edge terminates auth so apps ship zero auth
code. A user with no session is bounced to a **central** auth host
(`auth.<base>`) because Entra allows only one registered callback — so auth
completes on the *wrong* host and a **one-time handoff token** carries the
authenticated state across to the app's own host, where a host-scoped
`__Host-session` cookie is finally minted. The handoff token is the crux:
**signed, 30 s, single-use, audience-bound**. Get its state validation, burning,
and audience checks exactly right and the design holds; get any one wrong and it
breaks.

Two separate auth surfaces, don't conflate them:

| | Who authenticates | Mechanism | Lives in |
|---|---|---|---|
| **Edge app-user auth** | end users of hosted apps | OIDC → handoff → `__Host-session` cookie + server-side session | `apps/edge/src/auth/` |
| **Portal API auth** | the CLI / SPA (operators) | stateless bearer **JWT** over JWKS | `apps/portal/src/auth/` |

Cookies are the *edge* mechanism. The portal has no cookies or sessions.

---

## 2. Trust boundaries and the "two-router" rule

The edge answers three host classes (`apps/edge/src/routing/hosts.ts`,
`classifyHost`): `app`, `auth`, `platform`. The rule that must never break:
**control-plane handlers are unreachable on app hosts, and vice versa.** A bug
here (e.g. `/start` answering on an app host, or `/_auth/complete` answering on
the auth host) is a real vulnerability, not a cosmetic routing slip.

Dispatch is explicit per-kind in `apps/edge/src/app.ts` (no Fastify host
constraints — the fallback semantics are too subtle to trust). When reviewing
`app.ts`, check the host-kind guard on **every** route, and that `/_auth/*` and
`/_api/*` are reserved from the asset fallthrough (`isReservedAppPath`) so an app
can never ship a file that shadows them.

---

## 3. Suggested reading order

Read the primitives before the orchestration, then the enforcement, then the
tests:

1. **`apps/edge/src/config.ts`** — what's configured, the fail-closed stances
   (auth block all-or-nothing; HTTPS-only / TLS-required-in-dev), and
   `publicOrigin` (URLs are built from config, **never** from request headers —
   this matters for redirect/audience integrity).
2. **`apps/edge/src/auth/secrets.ts`** — one `EDGE_AUTH_SECRET` → HKDF → two
   purpose-bound keys. Domain separation is why a flow token can't be replayed as
   a handoff token.
3. **`apps/edge/src/auth/cookies.ts`** — the hand-rolled parser/serializers.
   `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, no `Domain`. Note the
   deliberate choice: a cookie name sent twice with conflicting values is treated
   as **absent** (not "first wins"), so attacker-injected duplicates can't smuggle
   a value past the parser.
4. **`apps/edge/src/auth/handoff.ts`** — mint/verify the handoff JWS. **The single
   most important file.** See §4 below.
5. **`apps/edge/src/auth/flow.ts`** — the `__Host-oidc-flow` cookie that carries
   OIDC round-trip state (`state`, `nonce`, PKCE verifier, target app, `rd`).
6. **`apps/edge/src/auth/validate.ts`** — `validateReturnPath` (the open-redirect
   defense) and `resolveAppForAuth` / `visibilityAllows`.
7. **`apps/edge/src/auth/sessions.ts`** — the server-side session store; the
   atomic redeem is the single-use guarantee (§5).
8. **`apps/edge/src/auth/oidc.ts`** — the openid-client wrapper (discovery, code
   exchange, ID-token validation). Thin on purpose.
9. **`apps/edge/src/auth/routes/authHost.ts`** — `/start` and `/callback`
   (Appendix A steps 2–7). **The orchestration of the dangerous path.**
10. **`apps/edge/src/auth/routes/appHost.ts`** — `/_auth/complete` (step 8),
    `/_api/me`, `/_auth/logout`.
11. **`apps/edge/src/auth/gate.ts`** — the per-request session gate in front of
    asset serving; navigation-vs-fetch behavior and the per-request visibility
    re-check.
12. **Portal side:** `apps/portal/src/auth/verifier.ts`,
    `apps/portal/src/plugins/auth.ts`, `apps/portal/src/routes/auth.ts`.
13. **CLI side:** `packages/cli/src/auth/{deviceFlow,tokenStore,session}.ts`.

Files 4, 5, 6, 9, 10 are the **dedicated-review surface** — the handoff path.
Spend the most time there.

---

## 4. The handoff token — what every property defends

`apps/edge/src/auth/handoff.ts`. Claims are deliberately minimal — `jti`
(= the pending session id), `aud` (= the **appId**, a UUID, not the slug), `rd`,
plus `iat`/`exp`. **No user PII ever travels in the URL.**

Verify each guarantee is actually enforced, not just intended:

- **Signed (HS256, key from HKDF):** `jwtVerify` pins `algorithms: ["HS256"]` —
  reject `alg: none` and asymmetric confusion. The `typ` header
  (`helix-handoff+jwt`) is checked, so a flow-cookie token can't be presented as
  a handoff token. Confirm the key is the *handoff* derived key, not the raw
  secret or the flow key.
- **~30 s TTL:** `exp` is enforced **and** `maxTokenAge` bounds `iat` — so a
  token with a doctored far-future `exp` but old `iat`, or a not-yet-issued
  token, both fail. jose only enforces `exp`/`iat` when present, so the code
  explicitly rejects their absence. `clockTolerance` is 5 s.
- **Single-use:** burned at redemption by the session store (§5), not here.
- **Audience-bound:** verified **twice**, on purpose (defense in depth). (a) The
  JWS `aud` must equal the appId the registry maps for the request's host
  (`appHost.ts`). (b) The redeem SQL also predicates on `appId`
  (`sessions.ts`). Either alone defeats audience confusion; both must stay.

Why `aud` is the appId and not the slug: slugs could in principle be recycled
across apps; appIds never are. Check nothing downstream re-derives audience from
the slug.

---

## 5. The session store and the single-use burn

`apps/edge/src/auth/sessions.ts`. The lifecycle:

1. `/callback` inserts a **pending** row (`tokenHash = NULL`, `id` = the handoff
   `jti`) *before* minting the token. The token is worthless unless this exact
   row redeems.
2. `/_auth/complete` calls `redeem(id, appId, tokenHash)` — a **single** SQL
   statement:
   ```sql
   UPDATE sessions SET "tokenHash" = $1, "activatedAt" = now()
   WHERE id = $2 AND "appId" = $3 AND "tokenHash" IS NULL AND "expiresAt" > now()
   ```
   `rowCount === 1` means we won; `0` means already-redeemed (replay),
   expired-pending, or audience mismatch → 403, no cookie. **This atomic UPDATE
   is the single-use property of the entire handoff design.** The concurrency
   test in `sessions.integration.test.ts` fires N concurrent redeems and asserts
   exactly one wins — that test is load-bearing; treat changes to it as changes
   to a security guarantee.

Other things to confirm:

- The `__Host-session` cookie value is **fresh random** (`newSessionToken`),
  never the URL-borne handoff token. The DB stores `sha256(cookie)`
  (`hashSessionToken`), so a DB read-leak yields no usable cookies.
- Session lookup is one indexed SELECT per request (`lookup`), scoped to the
  app — **no in-memory cache**, so revocation (logout / disable) is real on the
  next request (architecture A.4). If someone proposes a cache, push back: it
  needs an invalidation story.
- The pending row is created with the user's identity + **group snapshot** taken
  at login; the snapshot is re-taken on silent refresh.

---

## 6. The open-redirect defense

`apps/edge/src/auth/validate.ts`, `validateReturnPath`. `rd` (where to send the
user after login) is the classic open-redirector vector — and it's attacker-
controlled at `/start`. The function accepts only a same-origin **absolute path**:
starts with exactly one `/`, no `//`, no `/\`, no control chars or spaces, length
bounded, and it must survive `new URL(rd, base)` without changing origin. A bad
`rd` is a hard 400 at `/start`, never silently rewritten (silence hides attack
attempts). `rd` also rides *inside* the signed handoff, so it can't be tampered
with between `/callback` and `/_auth/complete`, and it's re-validated again at
redemption.

The corpus in `validate.test.ts` and the open-redirect block in
`adversarial.test.ts` are where to add any vector you can think of. If you can
get `validateReturnPath` to return a value that navigates off-origin, that's a
finding.

---

## 7. The session gate (enforcement)

`apps/edge/src/auth/gate.ts`, wired into `apps/edge/src/serving/assets.ts`. Per
request:

- **No/invalid/expired session:** top-level **navigations** 302 to the login
  flow; **fetches/subresources** get 401 `no-store`. The distinction uses
  `Sec-Fetch-Mode: navigate` (primary) with an `Accept: text/html` fallback.
  Misclassification must fail safe (a 401'd navigation is an error page, never a
  leaked asset). Check the ordering: the 404/410 registry ladder answers
  *before* the gate, so unknown/archived apps don't reveal auth state.
- **Visibility re-checked every request** against the live registry entry, not
  just at login — tightening an app from `private` to `group` bites within the
  refresh interval. A non-member navigation is sent through silent re-auth
  (which re-snapshots groups and ends on the callback's 403 if they truly lack
  access — confirm this can't loop).
- **The dev bypass** (`EDGE_DEV_ALLOW_UNAUTHENTICATED`) skips *only* this gate,
  is refused under `NODE_ENV=production`, and never relaxes TLS.

---

## 8. Portal API auth (a separate, smaller surface)

`apps/portal/src/auth/verifier.ts`. Stateless: a bearer JWT is verified over the
issuer's JWKS with **strict `iss`, `aud`, `exp`, and an asymmetric alg pin**
(`["RS256","ES256"]` — HS256/none confusion dies). Verifiers form a chain; OIDC
first, then the **demoted** dev token (`createDevTokenVerifier`, which *refuses to
construct* under production). Things to confirm:

- `aud` is checked against a fixed value (`PORTAL_OIDC_AUDIENCE`) — a token minted
  for another audience by the same issuer must be rejected.
- `authenticate`/`requireActor` keep their M1 signatures, so route code didn't
  change; the actor's `sub` prefers email for human-readable audit attribution.
- v0 authorization is intentionally flat: any authenticated portal-audience
  principal may mutate (same trust as the old shared token, now attributed).
  Per-app RBAC is a v1 item — not a gap to flag.

---

## 9. Run the adversarial suite

The suite lands *with* the code (working agreement §6). Start here:

```bash
pnpm test apps/edge/src/auth/adversarial.test.ts     # the named attacks, unit-level
pnpm test apps/edge/src/auth                          # + handoff/flow/validate/gate/cookies/secrets
pnpm test apps/edge/src/auth/flow.integration.test.ts # full flow vs real oidc-provider + Postgres
pnpm test apps/portal/src/auth                         # JWT verifier + real device-flow e2e
```

`adversarial.test.ts` names each attack it kills: handoff replay (incl. a
concurrent-redeem race in the integration twin), audience confusion (both the
JWS-`aud` and row-`appId` layers, broken independently), open redirect, cookie
tossing, state/nonce tampering, expired/skewed/alg-confused tokens, session
fixation. The integration tests drive a real `oidc-provider` (in-process,
ephemeral port — see `apps/dev-idp/src/testing.ts`) through the genuine
PKCE/nonce/code exchange and a real `prompt=none` silent refresh.

**A good review extends this suite.** If you suspect a gap, the highest-value
output is a failing test that demonstrates it.

---

## 10. Deliberate decisions (not findings)

Call these out only if you disagree with the *decision*, not as bugs:

- **HS256, not asymmetric.** Mint and verify are the same deployment (the auth
  host and app-host proxy are one process answering on different hostnames,
  Appendix A.2), so a keypair buys nothing. If the auth service ever splits out,
  swap to EddSA inside `handoff.ts` alone.
- **Hand-rolled cookies, no `@fastify/cookie`.** The edge is dependency-minimal
  (project plan §1, §6); exactly two cookies exist. The parser is ~30 lines with
  its own corpus.
- **Per-request DB lookup, no session cache.** Revocation correctness over
  micro-optimization at tens-of-apps scale.
- **Concurrent-login cookie race:** two logins in two tabs last-writer-win the
  flow cookie; the loser gets a clean "restart sign-in" page. Documented nuisance.
- **`/_api/me` returns id + displayName only** — no email, no groups. Hosted apps
  are untrusted and don't get the directory profile.
- **dev-idp `conformIdTokenClaims: false`** is intentional: it keeps `groups` in
  the ID token (Entra parity; the edge never calls userinfo).

---

## 11. Out of scope for this milestone

- **Real Entra** verification — the M3 tail; the seams are env-only by design.
- **`/_api/*` gateway** (LLM proxy, quotas, CSRF on the gateway) — M4.
- **password / public visibility modes** — v1; auth fails closed on them today
  (`resolveAppForAuth` → `unsupported-mode`).
- **Admin session revocation UI, audit-log UI** — v1 control-plane.

---

## 12. A reviewer's checklist

- [ ] No route in `app.ts` answers on the wrong host class; `/_auth/*` `/_api/*`
      can't be shadowed by app assets.
- [ ] Handoff verify pins alg + typ, enforces `exp` **and** `iat`/`maxTokenAge`,
      and rejects missing temporal claims.
- [ ] Audience is checked at both the JWS and the SQL layers; neither was
      weakened to "fix" something.
- [ ] The redeem is a single atomic statement; the concurrency test still asserts
      exactly-one-wins.
- [ ] The session cookie is fresh-random and only its hash is stored; the
      handoff token never becomes the cookie.
- [ ] `validateReturnPath` rejects every off-origin form you can construct.
- [ ] The gate's 404/410 ladder runs before auth; navigation/fetch split fails
      safe; visibility is re-checked per request.
- [ ] Portal JWT verify pins asymmetric algs and checks iss/aud/exp; the dev
      verifier refuses production.
- [ ] No secret, token, or PII is logged or placed in a URL that lands in
      history/referrers (`Referrer-Policy: no-referrer` + `Cache-Control:
      no-store` on the token-bearing redirects).
- [ ] Any gap you found is captured as a failing test.
