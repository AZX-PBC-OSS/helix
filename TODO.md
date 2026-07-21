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

## Dependency-minimal edge — filed defects

- [ ] _(Consider)_ **Trim `openid-client` to a JWKS-only verifier.** Heaviest trusted-path dependency. — ADR-0003
- [ ] _(Consider)_ **Add a CI dependency-allowlist** to make the dependency-minimal rule mechanical. — ADR-0003

---

## Auth hardening

- [ ] **Add an admin-kill / session-revocation path.** None exists today; group-revocation is stale until refresh (≤ 60 min). — ADR-0004 (ISSUE-11)
- [ ] **Restrict `password` visibility to explicit demo-only / no-production-data.** Today it's soft "demo convenience" with no data-class ban. — ADR-0004

---

## Pre-M5 — before the production pilot

- [ ] **Verify + configure `EDGE_TRUST_PROXY` for the Container Apps ingress.** The shared-counter throttle above holds across replicas, but its key is `${req.ip}:${appId}` and `EDGE_TRUST_PROXY` defaults **off** — behind the external Envoy ingress `req.ip` may be the ingress hop, collapsing all clients into one bucket per app (and a too-trusting value makes `x-forwarded-for` spoofable). Determine the correct hop count against the live deployment, set `EDGE_TRUST_PROXY`, and confirm `req.ip` resolves to the real client before relying on per-client limits. — ADR-0011, issue #13 (residual)
- [ ] **Strip the handoff token from access logs.** Default request logging / upstream proxies capture the `/_auth/complete?token=…` query string. Single-use + 30 s TTL bounds it, but prod log retention shouldn't persist it — add a log serializer that redacts `?token=` on that route (or a documented ops note). — issue #20 (part 3, not covered by the throttle fix)
- [ ] **Make `ownsApp` an M5 exit criterion (BOLA/IDOR).** Secrets and app-scoped mutating routes perform no ownership check — any authenticated principal can rotate/delete another app's secrets. `ownerId` already exists; interim gate is a ~3-line `ownsApp` preHandler (handle nullable legacy `ownerId`). Test: a second operator cannot write another's app. — ADR-0007, issue #9 (DEC-01)
- [ ] **Registry projection: staleness observability.** Expose `lastSuccessfulLoadAt` + `consecutiveLoadFailures`, degrade `/health` past a staleness threshold, emit a load-failure metric, promote the first failure to `error`-level. Closes the "serves stale forever, silently" edge (flagged by all 5 reviewers). — ADR-0025 (must-do)
- [ ] **Registry projection: jitter the reconcile poll.** Wrap the fixed `setInterval` in a jittered `setTimeout` chain (±20%) to avoid a synchronized DB herd across replicas. — ADR-0025

---

## Pre-GA — before external app owners / customer URLs commit

- [ ] **Host untrusted apps on a separate registrable domain.** Apps currently share one eTLD+1 with the control plane; move untrusted apps to e.g. `*.azx-apps.<tld>` and keep portal/auth on `azx-labs.com`. Closes cookie-bomb DoS, Safe-Browsing/reputation blast radius, same-site coupling with the auth host, and storage-partitioning residuals (PSL submission only partially closes cookie vectors). Cheap now, painful after customer URLs commit — treat as a pre-GA prerequisite, not an M5 blocker. — ADR-0019, issue #16
- [ ] **Decide the trigger for making the edge/portal split physical, and add a CI gate.** Document v0 co-deploy as a time-boxed boundary collapse; add a CI check that refuses co-deploy when `NODE_ENV=production` (or revoke co-deploy when the first non-employee owner onboards). — ADR-0012

---

## Egress trust model (ADR-0013, Proposed)

- [x] **Step 1 — now:** Add a `jti` one-time-use burn (bounded seen-set/table at egress) and assert `aud: "azx-egress"` in `jwtVerify`. Closes replay and token-passthrough. — ADR-0013 (ISSUE-04), issue #3 _(done: the edge stamps `jti` (= the per-call `requestId`) + `aud: "azx-egress"` on mint (`gateway/instruction.ts`); egress asserts `aud` in `jwtVerify` and burns the `jti` in a shared `instruction_jti` table before resolving the secret (`apps/egress/src/burn.ts`, `proxy.ts` → 409 `replay` on re-use). Covers both fetch and LLM (one `/proxy` choke point). Interval sweep in the egress `server.ts` (egress had no scheduler before). Replay/aud coverage in `adversarial.test.ts` + `burn.integration.test.ts`.)_
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
