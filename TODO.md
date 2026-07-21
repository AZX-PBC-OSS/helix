# TODO

Follow-up work extracted from the Architecture Decision Records in [`docs/adr/`](docs/adr/). Each item cites the ADR it came from and, where one exists, the filed issue number and the gating condition (when the work must land). Items are ordered so you can work roughly top-to-bottom: security-critical first, then milestone-gated, then deferred and hygiene.

Legend for gating conditions:

- **P0** — security-critical, do now.
- **Pre-M5** — must land before the M5 production pilot.
- **Pre-GA** — cheap now, painful once customer URLs / external owners commit.
- **Before multi-tenant** — required before the platform serves more than one trusted operator.
- **Before multi-replica** — required before the edge runs more than one replica.
- **Deferred / v2** — explicitly out of scope for now; recorded so it isn't lost.

---

## Postgres role split / RLS hardening

- [x] **Boot-fail when the edge role DSN is absent.** `EDGE_DATABASE_URL ?? DATABASE_URL` silently connects the edge as schema owner, defeating the split — fail startup instead of falling back. — ADR-0002 _(Done: in production `loadConfig` refuses the `DATABASE_URL` fallback and requires `EDGE_DATABASE_URL`; the fallback stays only outside prod. `apps/edge/src/config.ts`, tests in `config.test.ts`.)_
- [x] **Realize `helix_portal` or correct the Decision text.** The portal connects as schema owner (no `PORTAL_DATABASE_URL`), so the `helix_portal` grants are dead code. — ADR-0002 _(Done: the portal runtime now connects as `helix_portal` via `PORTAL_DATABASE_URL` — `resolvePortalRuntimeUrl` in `apps/portal/src/db/client.ts`, wired in the dev compose, required in prod with the owner-DSN fallback refused (mirrors the edge). Migrations stay on the `helix` owner. ADR-0002 Decision text corrected; grants are now live. Tests in `client.test.ts`.)_
- [x] **Add `statement_timeout` on the edge pools.** No timeout today → pool-exhaustion DoS. — ADR-0002 (ISSUE-05) / ADR-0003, issue #12 _(Done: every edge pg pool is now built through one `createEdgePool` helper (`apps/edge/src/db/pool.ts`) that applies a per-query `statement_timeout` — a server-side setting Postgres enforces even under a starved event loop — so a slow/stuck query can't hold a pooled connection open and exhaust the pool. Configurable via `EDGE_STATEMENT_TIMEOUT_MS` (`config.statementTimeoutMs`, default 10 s); covers all five stores + the registry listener's pool and LISTEN client. Tests in `pool.test.ts` / `config.test.ts`.)_
- [x] **Put RLS on `gateway_calls` and `app_collection_items`.** `gateway_calls` had global SELECT and `app_collection_items` no RLS (ISSUE-12/13). — ADR-0002 _(Done: migration `20260721033820_rls_gateway_calls_collection_items` adds the same `app.app_id`-partitioned FORCE RLS as `app_data` — a `WITH CHECK` on both, keyed on the GUC the edge sets via the shared `withPartition` helper (`apps/edge/src/db/partition.ts`; `usage.ts` + `data.ts`). Role-scoped: a permissive `*_portal_all` policy keeps the control plane's cross-app reads (usage rollups, collection drain) working since `helix_portal` is non-owner / no BYPASSRLS. Tests: `usage.rls.integration.test.ts`, `data.integration.test.ts`, `portal-rls.integration.test.ts`. **Framing:** this is a fail-closed backstop against bugs + a no-GUC smash-and-grab — NOT RCE containment (an RCE sets the GUC itself); the RCE boundary is grant-absence, unchanged. The original "cross-tenant read under edge RCE" wording was corrected in ADR-0002.)_
- [x] **Put RLS on `sessions` (deferred from the item above).** `sessions` had full DML and no RLS. — ADR-0002 (ISSUE-12) _(Done: migration `20260721035543_rls_sessions_definer_lookup` adds `app.app_id`-partitioned RLS (`ENABLE`, not `FORCE` — see the ADR for why the owner must stay exempt). The write paths set the GUC via `withPartition`; the two paths that can't be partition-scoped read through `SECURITY DEFINER` functions instead: `session_lookup(tokenHash, appId)` (the gate's per-request hot path — one round-trip, no txn) and `session_sweep()` (the global GC sweeper — a `FOR DELETE` carve-out can't work since the sweep's WHERE triggers SELECT-policy gating). Both are `search_path`-pinned, `EXECUTE`-only to `helix_edge`. `apps/edge/src/auth/sessions.ts`, tests in `sessions.rls.integration.test.ts`.)_
- [x] **Make `NOBYPASSRLS` explicit on `helix_edge` in the prod role bootstrap.** — ADR-0002 _(Done: all three runtime roles are now created `NOINHERIT NOBYPASSRLS` in the dev bootstrap (`.devcontainer/db-init/01-roles.sql`) and a new committed **prod** bootstrap (`infra/azure/sql/01-roles.sql`), wired into `infra/azure/README.md` step 4 in place of the old inline-comment placeholder; `postgres.bicep`'s pointer updated. `NOBYPASSRLS` is already the `CREATE ROLE` default, so this is documentary hygiene — it pins the property the partition-RLS backstop relies on so a later edit can't silently flip it, and covers `helix_portal` (whose cross-app reads go through the permissive `*_portal_all` policies, valid only if it doesn't bypass). Also wired the **prod portal runtime to `helix_portal`**: `main.bicep` now builds `portalDbConn` from a new `portalDbPassword` param and sets the container's `PORTAL_DATABASE_URL` (was `DATABASE_URL` = admin owner, which under `NODE_ENV=production` would have crashed on boot via `resolvePortalRuntimeUrl`'s owner-fallback refusal). The admin DSN no longer reaches any container or kv-platform — migrations run as admin out-of-band in README step 4.)_
- [x] **Add a lint / banned-import forbidding raw `app_data` queries outside `withPartition`.** — ADR-0002 _(Done: an ESLint `no-restricted-syntax` rule (`eslint.config.mjs`) fails the build on SQL (`FROM`/`INTO`/`UPDATE`/`JOIN`) against the four RLS-partitioned tables (`app_data`, `gateway_calls`, `app_collection_items`, `sessions`) anywhere in `apps/edge/src` **except** the three store modules that wrap them in `withPartition` (`gateway/data.ts`, `gateway/usage.ts`, `auth/sessions.ts`) and test scaffolding. This is the cheap, coarse "Option A": it trusts those files internally rather than proving each query sits inside a `withPartition` call — a stronger structural fix (encapsulate the pool so the raw client is unreachable) is deferred until the area grows. Framing unchanged from the RLS items above: a forgotten GUC already **fails closed** (zero rows / `WITH CHECK` fails), so this catches that correctness bug at build time — it is not the RCE boundary, which stays grant-absence.)_

---

## Dependency-minimal edge — filed defects

- [ ] **Harden the LLM SSE parser.** No per-event byte cap and LF-only: a CRLF stream causes unbounded buffering and a trailing `\r` leaks into the payload. — ADR-0003, issue #12
- [ ] **Count the app-data size cap in bytes, not UTF-16 code units.** — ADR-0003, issue #12
- [ ] _(Consider)_ **Trim `openid-client` to a JWKS-only verifier.** Heaviest trusted-path dependency. — ADR-0003
- [ ] _(Consider)_ **Add a CI dependency-allowlist** to make the dependency-minimal rule mechanical. — ADR-0003

---

## Auth hardening

- [ ] **Raise scrypt cost.** Currently `N=2^14`, 8× below OWASP's `2^17`. — ADR-0004 (ISSUE-08)
- [ ] **Add an admin-kill / session-revocation path.** None exists today; group-revocation is stale until refresh (≤ 60 min). — ADR-0004 (ISSUE-11)
- [ ] **Restrict `password` visibility to explicit demo-only / no-production-data.** Today it's soft "demo convenience" with no data-class ban. — ADR-0004
- [ ] **Fix the login-throttle TOCTOU** (check-then-increment is non-atomic; multiplies under replicas) — see the multi-replica item below. — ADR-0004 (ISSUE-15), issue #13

---

## Pre-M5 — before the production pilot

- [ ] **Revoke `helix_portal` `UPDATE`/`DELETE` on `gateway_calls`.** One line; the portal role can currently rewrite/delete metering history, contradicting the append-only claim (`schema.prisma:187`). — ADR-0021, issue #17
- [ ] **Fix the in-memory throttle for the shipped multi-replica infra.** Infra ships `minReplicas=1, maxReplicas=3`, so the N× throttle weakening is live. Before M5: pin `maxReplicas=1` **or** land a shared atomic counter (DB `UPDATE … RETURNING` / Redis); schedule `loginThrottle.sweep()` on an interval (ISSUE-07, currently never scheduled → unbounded map growth); configure `trustProxy` correctly (`req.ip` may collapse or be XFF-spoofable). — ADR-0011 / ADR-0004, issue #13
- [ ] **Make `ownsApp` an M5 exit criterion (BOLA/IDOR).** Secrets and app-scoped mutating routes perform no ownership check — any authenticated principal can rotate/delete another app's secrets. `ownerId` already exists; interim gate is a ~3-line `ownsApp` preHandler (handle nullable legacy `ownerId`). Test: a second operator cannot write another's app. — ADR-0007, issue #9 (DEC-01)
- [ ] **Registry projection: staleness observability.** Expose `lastSuccessfulLoadAt` + `consecutiveLoadFailures`, degrade `/health` past a staleness threshold, emit a load-failure metric, promote the first failure to `error`-level. Closes the "serves stale forever, silently" edge (flagged by all 5 reviewers). — ADR-0025 (must-do)
- [ ] **Registry projection: jitter the reconcile poll.** Wrap the fixed `setInterval` in a jittered `setTimeout` chain (±20%) to avoid a synchronized DB herd across replicas. — ADR-0025

---

## Pre-GA — before external app owners / customer URLs commit

- [ ] **Host untrusted apps on a separate registrable domain.** Apps currently share one eTLD+1 with the control plane; move untrusted apps to e.g. `*.azx-apps.<tld>` and keep portal/auth on `azx-labs.com`. Closes cookie-bomb DoS, Safe-Browsing/reputation blast radius, same-site coupling with the auth host, and storage-partitioning residuals (PSL submission only partially closes cookie vectors). Cheap now, painful after customer URLs commit — treat as a pre-GA prerequisite, not an M5 blocker. — ADR-0019, issue #16
- [ ] **Decide the trigger for making the edge/portal split physical, and add a CI gate.** Document v0 co-deploy as a time-boxed boundary collapse; add a CI check that refuses co-deploy when `NODE_ENV=production` (or revoke co-deploy when the first non-employee owner onboards). — ADR-0012

---

## Egress trust model (ADR-0013, Proposed)

- [ ] **Step 1 — now:** Add a `jti` one-time-use burn (bounded seen-set/table at egress) and assert `aud: "azx-egress"` in `jwtVerify`. Closes replay and token-passthrough. — ADR-0013 (ISSUE-04), issue #3
- [ ] **Step 2 — before multi-tenant:** Extend per-action authorization to the `llm`/platform path and bind `method` + `path` into the instruction (the fetch path already scopes by `appId` + grants). — ADR-0013, issue #6
- [ ] **Step 3 — post-M5:** Move from the shared symmetric secret to asymmetric (Ed25519) signing modeled on IETF Transaction Tokens. Larger change (key management, rotation); deferred until after prod cutover. — ADR-0013
- [ ] **Open question — needs sign-off:** Choose the long-tail key strategy: (a) symmetric + broker-side per-app authz, or (b) asymmetric / per-app-derived keys; decide whether (b) is required before onboarding external app owners or can wait until post-M5. **Note:** the `HKDF(master, appId)` per-app-key fix is unsound (both planes hold the master) and must not be adopted as written. — ADR-0013
- [ ] _(Orthogonal)_ **Channel-level defense: mTLS / workload identity** for the edge→egress hop. — ADR-0013, issue #5

---

## Threat-model & open questions to document/decide

- [ ] **CSP supply-chain hardening.** Consider SRI or versioned-script pinning for the CDN allowlist; add `object-src 'none'`; decide whether the CDN list should be per-app / opt-in rather than global. Record the third-party stored-XSS exposure on public / shared-write apps in the threat model. — ADR-0009 (DEC-03)
- [ ] **Anonymous shared-writes threat model.** Decide whether `sharedWrite` should require authentication (make `public` + `sharedWrite` an explicit, approval-gated opt-in); separate/attribute the anonymous write budget so a flood can't self-DoS the app's authenticated writes; consider a sentinel GUC value instead of `""`. Document the anonymous-write threat model. — ADR-0010 (DEC-02)

---

## Secret custody (ADR-0006)

- [ ] **Mark KEK rotation explicitly deferred.** No KEK rotation / rekey path exists — record it as a known deferral. — ADR-0006
- [ ] **State plainly that the dev AES-GCM envelope is not a security boundary.** — ADR-0006
- [ ] **Spec a timeout/retry for the prod Key Vault `open()` hot path.** Currently an unwired stub with no timeout/retry (Key Vault wired in M5). — ADR-0006

---

## Other

- [ ] Config point to completely disable "public" apps. It should disappear from the webapp, and the edge should refuse to serve public apps

---

## Deferred / v2

- [ ] **Metering ledger tamper-evidence (fast-follow before any external audit).** Hash chain + Merkle + external anchoring to a write-only sink — append-only-by-grant is not tamper-proof; `helix_portal` can rewrite history. Plus GDPR: crypto-shredding for content/PII rows and a documented Art. 17(3) retention basis for the metering tuple. — ADR-0021, issue #17
- [ ] **Registry projection — multi-replica / scale hardening (can land with M5).** Cold-start when the DB is down (a cold replica 503s all apps while `/health` may read green — emit `registry-load-pending` and/or bootstrap from a durable snapshot); connection budget + pooler caveat (~3 sessions/replica caps ~30 replicas; use session-pooling mode or a reserved direct LISTEN connection); scale ceiling (single global channel forces a full-table reload per commit per replica — add a `last_modified_at` cursor for delta reloads before ~10⁵ apps). — ADR-0025 (items 3–5)
- [ ] **Hosted-build isolation prerequisites (launch gates, not v2.x follow-ups).** When hosted builds ship they must clear: (1) credential-free builder — the load-bearing control (build container holds no platform/git/registry/cloud secret; clone happens outside the build zone); (2) ephemeral by construction (one container per build, destroyed after; no warm pools); (3) network-restricted install (registry allowlist/mirror, block lifecycle-script egress; `--ignore-scripts` is defense-in-depth only); (4) build provenance as a launch gate (SLSA / in-toto / signed attestation). Open question: confirm the milestone label (v2 vs "M6") and decide whether provenance must also cover the author-CI upload path (a bundled-output/chalk-debug-class payload rides in regardless of hosted builds). — ADR-0026, closes ADR-0018's trusted-on-intake gap
- [ ] **Custom backends / arbitrary containers.** Out of scope for v1; a later isolation tier (see `docs/platform-custom-backends-and-apis.md`). — ADR-0020
- [ ] **Multi-org tenancy.** Deferred; adding `orgId` later is an additive migration (app-id partitioning is already in place), and `platform-admin` becomes org-scoped when it lands. — ADR-0023

---

## Explicitly rejected (recorded so they aren't re-proposed)

- Moving the OIDC RP credential off the edge — standard BFF/confidential-client pattern; not warranted. (ADR-0001)
- Physical DB isolation (schema/DB-per-app) — not warranted; the role split + RLS is the control. (ADR-0002)
- Sandboxed iframe without `allow-same-origin` for app isolation — category error, breaks the same-origin `/_api/*` gateway (ADR-0014). Still the right control _only_ if the portal ever embeds an unpromoted app for preview. (ADR-0019)
- The `HKDF(master, appId)` per-app-key step-1 fix for the egress seam — unsound; both planes hold the master. (ADR-0013)
