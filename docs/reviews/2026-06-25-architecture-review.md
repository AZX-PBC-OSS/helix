# Architecture & Implementation Review — Helix backend trusted path

**Date:** 2026-06-25
**Scope:** `apps/edge`, `apps/portal`, `apps/egress`, `packages/shared`, `packages/secret-store` (backend trusted path; `portal-web`, `dev-idp`, `cli` excluded).
**Method:** 6 practice-area workflows × 5 independent external models (GLM 5.1, DeepSeek v4 Pro, Kimi k2.7, Qwen 3.7, MiniMax m3) = 30 reviews, under read-only agents. Best-practice claims grounded with Brave web search; every Critical verified directly against source. Agreement tags `[n/5]` count how many models in that area flagged it; `Brave ✓/✗` = grounding verdict.
**Ground truth:** typecheck/tests not run (`node_modules` absent in this checkout) — findings are from source reading, not tool output.

> Tags legend: `[n/5]` = cross-model agreement within the area's panel · `Brave ✗` = best-practice grounding contradicts current code · `verified` = confirmed by direct code read.

---

## Verdict

The containment architecture is **sound and faithfully implemented.** Reviewers verified the positives, not just hunted negatives: the Postgres role split is real (`FORCE RLS`, `NOBYPASSRLS`, zero `app_secrets` grant to `helix_edge`, parameterized `set_config`), the auth core is tight (atomic single-use handoff, `__Host-` invariants, pinned JWS alg, OIDC state/nonce/PKCE), SSRF IP-pinning genuinely defeats DNS-rebind, and fail-closed posture is consistent.

The material risks are: (1) **one unhardened seam** — edge→egress trust is a single symmetric secret with no broker-side authorization; and (2) a cluster of **"documented v0" shortcuts** that must close before the platform serves more than one app owner (M5/multi-tenant).

---

## ADR-candidate — egress trust model (the central architectural decision)

**Today:** the edge mints an `HS256` attested instruction off a single shared `HELIX_INSTRUCTION_SECRET`; egress verifies the signature and executes — it does **not** re-authorize the instruction's claims against the registry/grants, the secret name is **not app-scoped**, and there is **no `aud`** and **no replay burn (`jti`)**. Consequence: the headline claim *"an edge RCE reaches no secret"* is too strong. A compromised edge cannot **exfiltrate** plaintext (egress injects server-side) but **can use any connection's credential** and read the upstream response.

**Reviewer split (not resolved by vote):** Kimi = Critical "boundary broken"; MiniMax = important (add egress-side defense-in-depth); DeepSeek/GLM/Qwen = signing "sound, hardening only."

**Best-practice grounding (`Brave ✗` on the current design):**
- Shared symmetric HMAC across services is an explicit anti-pattern — *"any compromised service can forge tokens for the entire system"* (Ping Identity, WorkOS). Prefer asymmetric (edge private / egress public) or per-app-derived keys.
- Helix's egress is the textbook **credential-broker** pattern (SANS IETF `draft-hartman-credential-broker-4-agents`, Anthropic vault-proxy, Cloudflare Outbound Workers). The broker is supposed to **authorize each action** (per-app scope), **validate `aud` / forbid token passthrough**, and issue **short-lived one-time** capabilities. Helix has the shape but is missing those three controls.
- The literature names Helix's exact residual: a compromised deputy *can use but not read* the credential → mitigate with **per-action scope** at the broker, not just signature verification.

**Recommended direction (per maintainer): harden the seam.**
1. Add `jti` one-time-use burn + `aud: "azx-egress"` now (cheap, closes replay/passthrough).
2. Make egress **authorize**, not just verify: check the instruction's `(appId, connection)` against the grant table before resolving the secret; scope `helix_egress` `SELECT` on `app_secrets` by the attested app where possible.
3. Plan asymmetric or per-app-derived instruction keys (likely post-M5) so an edge compromise can't forge cross-app instructions.

---

## CRITICAL — verified, breaks a stated invariant

### ISSUE-01 — Egress response-header blocklist omits credential headers → injected secret echo-back
- **Where:** `packages/shared/src/fetch.ts:53` (`RESPONSE_HEADER_BLOCKLIST`) → `apps/egress/src/proxy.ts:158`
- **Signal:** `[3/5: Qwen, GLM, Kimi]`, Kimi=Critical · `Brave ✓` (secret-leak class)
- **Problem:** `authorization` / `www-authenticate` (and recipe-specific creds like `x-api-key`) are not in the response blocklist. A malicious or compromised upstream that echoes the injected `Authorization: Bearer <secret>` back in a response header has it forwarded by egress → edge → app. Breaks "the app never sees the credential."
- **Fix:** switch to a response-header **safelist**, or at minimum add `authorization`, `www-authenticate`, and dynamically strip the specific injected header name. Add an adversarial test for response-side secret echo.

### ISSUE-02 — Response/request body size caps bypassable on chunked transfer (both planes)
- **Where:** `apps/egress/src/proxy.ts:148-152` (response); `apps/egress/src/proxy.ts:144` + `apps/edge/src/app.ts:413-429` / `gateway/fetch.ts:205` (request)
- **Signal:** egress response `[5/5]` (Qwen=Critical); edge fetch-proxy body `[4/5]` · `verified`
- **Problem:** the response cap only reads `content-length`; a chunked / CL-absent upstream streams **unbounded** bytes through to the app (`reply.send(upstream.body)` with no running counter — verified). The fetch sub-scope registers `addContentTypeParser("*", …)` with **no `bodyLimit`**, so the request side egress re-streams is bounded only by Fastify's global default.
- **Fix:** add a byte-counting `Transform` that destroys the stream past `maxBodyBytes`, independent of framing, on **both** request and response sides; set an explicit `bodyLimit` on the fetch scope.

---

## IMPORTANT — concrete, ranked by leverage

### ISSUE-03 — Legacy LLM provider is a fail-open key-custody breach
- **Where:** `apps/edge/src/server.ts:147-152`
- **Signal:** `[5/5]`, Kimi=Critical · `verified` (no prod guard)
- **Problem:** when egress/instruction-key are absent but `EDGE_LLM_ANTHROPIC_KEY` is set, the edge loads the vendor key and calls Anthropic directly — the edge holds a secret. No `NODE_ENV` guard distinguishes this from the egress path; a prod misdeploy silently downgrades containment.
- **Fix:** refuse to select `AnthropicProvider` when `NODE_ENV==="production"` (mirror the `EDGE_DEV_ALLOW_UNAUTHENTICATED` boot guard); fail closed (503) instead.

### ISSUE-04 — Attested instruction has no replay burn (`jti`) and no `aud`
- **Where:** `apps/edge/src/gateway/instruction.ts:31-43`, `apps/egress/src/instruction.ts:35-53`
- **Signal:** `[5/5]` · `Brave ✓` (one-time-use + audience are standard for sensitive service tokens)
- **Problem:** `requestId` is a correlation id, not a dedup key; a captured instruction is replayable for the full 30s TTL, re-triggering metered LLM spend or a secret-backed fetch. No `aud` means any consumer sharing the secret accepts it (token passthrough).
- **Fix:** `setJti()` at mint + bounded seen-`jti` LRU (or `used_instructions` table) at egress; `setAudience("azx-egress")` and assert it in `jwtVerify`. (See ADR above.)

### ISSUE-05 — No `statement_timeout` / `idle_in_transaction_session_timeout` on edge pg pools
- **Where:** `apps/edge/src/gateway/data.ts:67`, `gateway/usage.ts:82` (repo-wide grep: none)
- **Signal:** `[5/5]`
- **Problem:** a slow/blocked query (incl. unbounded `SUM`/`COUNT` over `gateway_calls`) pins a pool connection indefinitely → pool-exhaustion DoS on the trusted path.
- **Fix:** set `statement_timeout`, `idle_in_transaction_session_timeout`, `lock_timeout` on the pool (or `SET LOCAL` inside `#withPartition`); add `LIMIT` to `listUserKeys`.

### ISSUE-06 — SSE relay ignores backpressure
- **Where:** `apps/edge/src/gateway/llm.ts:75-77`
- **Signal:** `[3/5]`, Qwen=Critical · `verified` (`reply.raw.write` return ignored; `reply.hijack()` removes framework backpressure) · `Brave ✓`
- **Problem:** a slow client lets Node's writable buffer grow unbounded across thousands of SSE deltas while upstream keeps spending tokens. (Bounded only by the `req.raw` close→abort path, which must stay wired.)
- **Fix:** await `drain` when `write()` returns `false`, or pipe a `Transform` to `reply.raw`. Also bound the upstream SSE parse buffer (`provider.ts:201` accumulates a string with no cap — O(n²)).

### ISSUE-07 — `loginThrottle.sweep()` is never scheduled
- **Where:** `apps/edge/src/auth/loginThrottle.ts:64`; `server.ts:186` only sweeps `anonRateLimiter`
- **Signal:** `[4/5]`
- **Problem:** under rotating source IPs the bucket `Map` grows unbounded → per-process memory leak / DoS.
- **Fix:** `setInterval(() => loginThrottle.sweep(), windowMs).unref()` next to the anon sweep; `clearInterval` on close.

### ISSUE-08 — scrypt cost is 8× below the OWASP minimum
- **Where:** `apps/portal/src/access/password.ts:29`, `apps/edge/src/auth/password.ts:44` (Node default `N=16384`)
- **Signal:** `[3/5]` · **`Brave ✗`** — OWASP Password Storage Cheat Sheet mandates scrypt `N=2^17 (131072), r=8, p=1`
- **Problem:** a ~4-word xkcd passphrase under `N=2^14` is GPU-forcible if the projected hash leaks; the throttled online path is the only other defense.
- **Fix:** raise to `N=2^17, r=8, p=1` (store params with the hash for future agility) on both sides.

### ISSUE-09 — SSRF blocklist IPv6 gaps
- **Where:** `apps/egress/src/ssrf.ts:59-68`
- **Signal:** `[4/5]` · `Brave ✓` (cover 127/8,10/8,172.16/12,192.168/16,169.254/16 + `::1`,`fc00::/7`,`fe80::/10`)
- **Problem:** `fe80::/10` check only matches `fe80::/16`; misses 6to4 `2002::/16`, NAT64 `64:ff9b::/96`, full-form loopback `0:0:…:1`, `ff00::/8` multicast, and hex-form IPv4-mapped `::ffff:7f00:1`. (Note: IP-pinning correctly defeats DNS-rebind — that part is sound.)
- **Fix:** parse to a 128-bit address and check prefixes numerically; re-extract embedded IPv4 from any mapped/translated form and re-run the v4 blocklist. Add a `ssrf.test.ts` covering these literals.

### ISSUE-10 — Redirect suppression is implicit; `Location` is forwarded
- **Where:** `apps/egress/src/proxy.ts:141` (no `maxRedirections`), `:158` (`Location` not blocked)
- **Signal:** `[4/5]` · `Brave ✓` (302→IMDS is the canonical bypass)
- **Problem:** "no redirect-follow" relies on undici's current default; a version/dispatcher change silently enables it. Worse, the upstream's `Location` header is forwarded to the app, so the **browser's** default `redirect: follow` re-issues `302 → http://169.254.169.254/` outside egress entirely.
- **Fix:** set `maxRedirections: 0` explicitly; add `location` to the response blocklist (or re-validate + re-stream redirects through egress). Add an adversarial test.

### ISSUE-11 — Group-revocation staleness
- **Where:** `apps/edge/src/auth/gate.ts:194`
- **Signal:** `[4/5]` (documented)
- **Problem:** per-request visibility re-checks the cached `session.groups` snapshot; a user removed from a group keeps access until silent refresh (≤ `EDGE_SESSION_REFRESH_MS`, default 60 min). Passive asset requests don't even trigger refresh.
- **Fix:** shorten `refreshAfterMs`, and require refresh/401 on asset requests past `refreshDueAt`, not just navigations.

### ISSUE-12 — `gateway_calls` global SELECT + `sessions` full DML, no RLS
- **Where:** `migrations/20260616000001_edge_role_grants` (grants `helix_edge`)
- **Signal:** `[3/5]`, Kimi=Critical
- **Problem:** an edge RCE can read every app's metering ledger (user OIDs, model, tokens) and all session metadata. Needed for budget SUMs, but the grant is table-wide.
- **Fix:** RLS on `gateway_calls` scoped to `app.app_id`; consider security-barrier views; add explicit `ALTER ROLE helix_edge NOBYPASSRLS NOCREATEROLE NOSUPERUSER`.

### ISSUE-13 — `app_collection_items` has no RLS → cross-app write pollution
- **Where:** `migrations/20260616231730_app_collection_items` (no RLS), `apps/edge/src/gateway/data.ts:176`
- **Signal:** `[1/5: DeepSeek]` (additive, plausible)
- **Problem:** INSERT-only prevents reads, but a compromised edge can insert items into **any** app's collections (cross-app write pollution).
- **Fix:** add RLS `WITH CHECK (appId = current_setting('app.app_id', true)::uuid)`.

### ISSUE-14 — Edge has no `setErrorHandler`; 503 leaks env-var names
- **Where:** `apps/edge/src/app.ts` (no handler), `serving/assets.ts:76`
- **Signal:** `[3/5]`
- **Problem:** unhandled exceptions fall through to Fastify's default handler (may surface SQL/internal detail); the auth-unconfigured 503 advertises `EDGE_OIDC_*` / `EDGE_DEV_ALLOW_UNAUTHENTICATED` to anonymous probes.
- **Fix:** add a `setErrorHandler` returning generic 500s (log detail server-side); replace the 503 body with a fixed ops message.

### ISSUE-15 — Per-process login throttle + check-then-increment TOCTOU
- **Where:** `apps/edge/src/auth/loginThrottle.ts:30,49-56`, `passwordLogin.ts:176`
- **Signal:** `[5/5]` (documented v0)
- **Problem:** in-memory per-process state ⇒ N replicas × limit; concurrent requests pass `isBlocked()` before any `recordFailure()`. Combined with ISSUE-08 this is the weakest auth link at scale.
- **Fix:** shared atomic counter (DB `UPDATE … RETURNING` / Redis) before the password path goes multi-replica.

### ISSUE-16 — Config falls back to schema-owner `DATABASE_URL`
- **Where:** `apps/edge/src/config.ts:304`, `apps/egress/src/config.ts:35`
- **Signal:** `[1/5: Kimi]` fail-open
- **Problem:** when `EDGE_DATABASE_URL`/`EGRESS_DATABASE_URL` is unset, the runtime connects with the full-grant owner role, silently defeating the role split.
- **Fix:** refuse to boot without the role-specific URL; never fall back to the owner DSN.

### ISSUE-17 — Boundary-validation cluster (zod / size caps)
- **Where:** `packages/shared/src/secrets.ts:81` (`value` no `.max()`), `apps/edge/src/gateway/data-handler.ts:212` (`JSON.stringify().length` counts UTF-16 units not bytes — 64KiB cap → ~192KiB), `apps/edge/src/serving/cspReport.ts:59` (`as` casts, no zod), `apps/portal/src/routes/apps.ts:48` (password no max), `manifest.ts:79` (`CapabilitiesSchema` non-`.strict()`)
- **Signal:** `[3–4/5]` across area 6
- **Fix:** add `.max()` to secret/password values; use `Buffer.byteLength(...,"utf8")` for the byte cap; define zod schemas for CSP report shapes; `.strict()` on the capabilities schema so unknown keys surface at the write-gate.

---

## DECISIONS TO SURFACE — documented v0, not bugs (gate multi-tenant / M5)

### DEC-01 — Portal mutating routes have no per-app ownership
- **Where:** `apps/portal/src/routes/apps.ts`, `routes/secrets.ts` (`preHandler: authenticate` only); model documented in `apps/portal/src/plugins/auth.ts:20-23`
- **Signal:** Kimi=Critical, **verified documented v0** ("per-app RBAC is a v1 feature"); reads now admin-gated (`cba50cf`)
- **Concern:** any authenticated portal principal can retarget/archive/set-password on **any** app and manage **any** app's secrets. Contradicts per-app containment the moment >1 owner uses the portal; the **secrets** routes are the sharp edge.
- **Action:** land an `ownsApp`/`requireAdmin` gate on the app-scoped secret routes before the portal is opened beyond a single trusted operator.

### DEC-02 — Anonymous writes to `shared` keys on `public` apps
- **Where:** `apps/edge/src/gateway/data.ts:153`, `data-handler.ts:375` (`putShared` sets `app.user_oid=""`, no `requireUser`)
- **Concern:** anonymous visitors can write any manifest-declared `sharedWrite` key (gated only by allowlist + `writesPerDay`).
- **Action:** decide whether `sharedWrite` should require authentication; document the threat model explicitly either way.

### DEC-03 — CSP `script-src` ships `unsafe-inline`/`unsafe-eval` + CDN allowlist, no SRI
- **Where:** `apps/edge/src/serving/csp.ts:73`
- **Concern:** documented "relaxed because app code is hostile anyway," but the 5-CDN allowlist is a supply-chain dependency (CDN compromise → script exec in every app); missing `object-src 'none'`.
- **Action:** consider SRI or versioned-script pinning; add `object-src 'none'`.

---

## MINOR (selected)
- `apps/edge/src/registry/listener.ts:94` — `LISTEN ${REGISTRY_CHANNEL}` is the one interpolated identifier; safe (constant) but breaks the no-interpolation rule — double-quote it. `[3/5]`
- `apps/edge/src/auth/secrets.ts:26` — HKDF uses an empty salt; add a per-deployment salt. `[2/5]`
- `apps/edge/src/auth/validate.ts:101` — `isSameOriginFormPost` fails **open** when both `Origin` and `Sec-Fetch-Site` are absent (inconsistent with `isSameOrigin`). `[2/5]`
- `apps/edge/src/auth/routes/appHost.ts:163` — logout is per-device only (no "log out everywhere"). `[1/5]`
- `apps/edge/src/serving/shim.ts:79` — `/<head[^>]*>/i` matches `<header>`; use `/<head(?:\s[^>]*)?>/i`. `[3/5]`
- `apps/edge/src/gateway/provider.ts:161` — error path buffers the full upstream body before truncating. `[2/5]`
- undici `Pool`s (`provider.ts:141`, `blob/client.ts:57`) have no explicit `headers`/`body`/`connect` timeouts. `[3/5]`
- `apps/edge/src/blob/client.ts:75` — no `AbortSignal`; client disconnect doesn't cancel the Azure fetch. `[1/5]`
- `apps/egress/src/proxy.ts:163` — per-call dispatcher cleanup is skipped if `reply.send` throws synchronously (use try/finally). `[1/5]`
- `pw_<random>` principal uses 9 bytes (~72 bits); raise to 16. `[1/5]`

---

## Test-coverage gaps reviewers flagged
- `role-split.integration.test.ts` under-asserts the **deny** cases that are the actual boundary: missing `UPDATE`/`DELETE` deny on `app_collection_items`, missing `INSERT`/`DELETE` deny on `app_secrets` for `helix_egress`, and the suite **skips silently** when roles aren't provisioned (a CI without `db-init` would pass a broken grant). `[≥3/5]`
- No `apps/egress/src/ssrf.test.ts` for `isBlockedAddress` edge cases; adversarial suite lacks response-header echo, redirect, and chunked-body tests.

---

## Method notes
- 30/30 reviews dispatched; 26 read in full (areas 1/2/3/6 at full 5/5; area 4 at 5/5; area 5 at 4/5 — the unread were corroborative in the saturated streaming area). No fabricated coverage.
- One contested finding was **refuted by direct code read**: "egress socket not pinned to the validated IP" — `connectUrlFor()` dials the IP literal, so DNS-rebind is actually defeated.
- The egress-trust decision (ADR section) was grounded in a second Brave round at the maintainer's request; the symmetric-shared-key design is `Brave ✗` against current service-auth guidance.
