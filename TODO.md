# TODO

Follow-up work extracted from the Architecture Decision Records in [`docs/adr/`](docs/adr/). Each item cites the ADR it came from and, where one exists, the filed issue number and the gating condition (when the work must land). Items are ordered so you can work roughly top-to-bottom: security-critical first, then milestone-gated, then deferred and hygiene.

Everything here is open. Finished work is **deleted** from this file rather than checked off — the ADR it came from is the durable record of what was decided, the feature docs record what shipped, and `git log -p TODO.md` still has the write-up that was attached to the item. When a completed item leaves behind work that is genuinely still open, that residual is promoted to its own entry above instead of living inside a done-note.

Legend for gating conditions:

- **P0** — security-critical, do now.
- **Pre-M5** — was gated on the M5 production deploy. **That deploy has happened**, so anything still open under this label is now a gap in a _running_ system rather than a chore ahead of one. Re-read these as overdue, not scheduled.
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
- [ ] **Per-app RBAC (owner/editor/viewer) + owner-scoped read filtering.** The BOLA half is closed — `ownsApp` (owner-or-admin, fail-closed on a null `ownerId`) guards every app-scoped mutating route and the credential-returning password read. What remains is the roles model: **reads are still authenticated-only** (any signed-in principal can list and read any app), and the portal SPA still renders mutate controls for apps the caller doesn't own, with the server 403 as the only boundary. This is the last `PreviewBadge` in the SPA (Settings tab). Note for whoever builds it: dev-mode's dev-token mint routes must adopt `ownsApp` from their first commit. Also unblocks ADR-0031 decision 12's `groups` dimension. — ADR-0007, issue #9 (residual)
- [ ] **Move the handoff token off the query string.** Log redaction closes our own logs, but the browser history of every app user still holds the (spent) `/_auth/complete?token=…` URL, and nothing in a log serializer can erase that. Killing it means a flow change — POST form-post or a fragment carrying the token — not a logging fix. Bounded meanwhile: single-use, 30 s TTL, audience-bound to one app + one session row, `no-referrer` + `no-store` on both legs. — issue #20 residual (a)
- [ ] _(Consider)_ **The redaction guarantee is scoped to the `req.url` log field.** `@azx-pbc/shared/logging` replaces the `req` serializer, so anything that doesn't go through it is unprotected: Fastify interpolates a raw URL into two of its own `%s` messages (both need a double-send bug in our handlers to fire), and any hand-rolled log call has to pass `redactUrl` itself. Making that mechanical — a lint rule, or a serializer-level catch — is the durable version. — issue #20 residual (b)

---

## Pre-M5 — now live in production

> The platform is deployed on Azure. Every unchecked item below was written as "before we go
> to production" and is now running without it. Nothing here is theoretical any more.

- [ ] **Confirm `deployFirewall` is on in the live deployments.** It defaults `true` and is operator-optional for cost (~$900/mo, `infra/azure/README.md`), but with it off the app subnets keep default internet egress — which removes what ADR [0005](docs/adr/0005-ssrf-egress-controls.md) names the **primary** SSRF/egress control and demotes the whole outbound posture to the app-level `ssrf.ts` denylist that ADR calls defense-in-depth. The reason to check rather than assume: with the firewall absent everything still works, so nothing surfaces the difference. If it is deliberately off, record that as an accepted risk against ADR-0005 rather than leaving the ADR asserting a control that isn't there. — ADR-0005 deployment note (2026-07-23)
- [ ] **Deploy a real pilot app end to end** (`helix deploy` → SSO login → app calls the LLM gateway). The last M5 exit criterion, and the only evidence that isn't self-referential — everything else is the platform testing itself. — project plan §4
- [ ] **Verify the ACA ingress emits no per-request access log with query strings.** The log-serializer redaction (`@azx-pbc/shared/logging`, issue #20) closes the container's own stdout, which is the retention surface `infra/azure` actually configures (`appLogsConfiguration` → Log Analytics, 30 days). The claim that nothing _upstream_ persists the handoff token rests on an Azure platform default: no ingress access-log setting appears anywhere in `infra/azure`, so this is asserted, not verified. Check it directly against the live environment (a request with a marker query string, then a Log Analytics query across the ingress/system tables) and attribute the result with a date — the same discipline the `EDGE_TRUST_PROXY` entry uses, and for the same reason: ingress properties are per-deployment (ADR-0028) and change underneath you. The docs are currently softened to "as configured today, no access log we can see". — issue #20 residual (c)
- [ ] **Assert the _negative_ half of Key Vault custody against the live vault: the edge identity is refused by `kv-connections`.** The positive path is verified in the deployment (2026-07-30) — portal seals, egress opens, real managed identities, real vault. The negative is not, and it is the half that carries the security property: the boundary is **grant-absence** (`rbac.bicep` deliberately gives the edge identity no role on `kv-connections`), so an accidental role assignment breaks nothing, changes no behaviour, and passes every test that isn't specifically looking for it — including the local suite, where both stores share one stub `getToken` against a fake vault that ignores the authorization header. Check it directly: `az role assignment list --scope <kv-connections>` shows no edge principal, and an edge-identity data-plane read returns 403. Worth re-running after any `rbac.bicep` change, not once. — ADR-0002, ADR-0006 amendment, ADR-0031 §16
- [ ] **Build egress's two pools through a shared factory so they get a `statement_timeout`.** `apps/egress/src/burn.ts` and `secrets.ts` call `new Pool(...)` directly rather than going through anything like the edge's `createEdgePool`, so neither gets the per-query ceiling ADR-0002 ISSUE-05 / issue #12 exists for — a slow or stuck query there can pin a pooled connection indefinitely on the plane that holds plaintext connection secrets. They now have `'error'` listeners (so a dropped client no longer kills the process), which was the urgent half; this is the remaining one. Either export the edge's factory from a shared place or give egress its own three-line equivalent. — ADR-0002, ADR-0025 review
- [ ] **Create the Log Analytics alert rule that consumes the registry staleness events.** The edge emits `registry.load_failed` / `registry.never_loaded` / `registry.load_recovered` with `consecutiveLoadFailures` / `staleForMs` / `lastSuccessfulLoadAt`, and `apps/edge/README.md` ("Health and staleness") carries a ready KQL snippet — but nothing consumes it, so a projection serving stale forever is still only visible to a human who goes looking. Same for the `/health` `registry-projection` sub-check: nothing probes it. The observability exists; the alerting does not. — ADR-0025 (residual)

---

## Pre-GA — before external app owners / customer URLs commit

- [ ] **Host untrusted apps on a separate registrable domain.** Apps currently share one eTLD+1 with the control plane; move untrusted apps to e.g. `*.azx-apps.<tld>` and keep portal/auth on `azx.helix.azxlabs.io`. Closes cookie-bomb DoS, Safe-Browsing/reputation blast radius, same-site coupling with the auth host, and storage-partitioning residuals (PSL submission only partially closes cookie vectors). Cheap now, painful after customer URLs commit — treat as a pre-GA prerequisite, not an M5 blocker. — ADR-0019, issue #16
- [ ] **Add the CI gate that refuses co-deploy when `NODE_ENV=production`.** The _trigger_ question is resolved — the Azure deploy provisions edge, portal and egress as three separate container apps, so the boundary collapse doesn't exist in the live topology (ADR-0012 Resolution). What's missing is the gate that keeps it that way: today the split is a property of the current Bicep, not a guarantee, and co-deploy remains reachable in code. — ADR-0012
- [ ] **Finish the `azx-*` → `helix-*` service rename in code.** ADR-0032 aligned the docs prose (and the images and DB roles were already `helix-*`), but the runtime still self-identifies as the old names: `SERVICE_NAME` in `apps/edge/src/app.ts` and `apps/portal/src/app.ts` — asserted in `app.test.ts` and `spa.test.ts` and returned by `/health` — plus the edge's startup log, the `.devcontainer/devcontainer.json` port labels, and `.vscode/tasks.json` details. Deliberately excluded from ADR-0032's docs-only sweep because `/health.service` is a consumed value, not prose. Decide whether anything (dashboards, probes, alert rules) keys off it before changing, then do it in one pass. **Not in scope:** the `aud: "azx-egress"` instruction audience and the `azx-cli` OIDC client_id — those are wire identifiers on a coordinated-deploy path. — ADR-0032

---

## Egress trust model (ADR-0013, Proposed)

- [ ] **Step 2 residual — make `method` + `path` required claims on the instruction.** Both are stamped by the edge and re-checked by egress, but the check is **assert-when-present**: an instruction arriving without them passes. That was deliberate for rolling-deploy safety (edge and egress ship together, instructions live 30 s), so it should become a hard requirement once a fleet is reliably past deploy — otherwise the weaker path stays reachable indefinitely. — ADR-0013, issue #6
- [ ] **Step 3 — post-M5:** Move from the shared symmetric secret to asymmetric (Ed25519) signing modeled on IETF Transaction Tokens. Larger change (key management, rotation); deferred until after prod cutover. — ADR-0013
- [ ] **Open question — needs sign-off:** Choose the long-tail key strategy: (a) symmetric + broker-side per-app authz, or (b) asymmetric / per-app-derived keys; decide whether (b) is required before onboarding external app owners or can wait until post-M5. **Note:** the `HKDF(master, appId)` per-app-key fix is unsound (both planes hold the master) and must not be adopted as written. — ADR-0013
- [ ] _(Orthogonal)_ **Channel-level defense: mTLS / workload identity** for the edge→egress hop. — ADR-0013, issue #5

---

## Connection injection recipes

- [ ] **Per-binding `(method, path)` allowlist on a proxied origin.** Today `capabilities.fetch.origins` is origin-granular, so binding an app to an origin grants it **every** endpoint there — for a typical CRUD API that includes the destructive verbs. This is the honest, unblocked subset of [ADR-0031](docs/adr/0031-connection-providers-delegated-auth.md) decision 12: dropping the `groups` dimension drops the dependency on per-app RBAC (ADR-0007), which is what actually blocks that decision. Both enforcement points already exist — the edge binds `method` + `path` into the attested instruction and egress re-checks them (ADR-0013 step 2) — so the missing piece is only the list to check against. First thing to revisit after the first tenant-key integration ships.
- [ ] **Deferred `hmac-timestamp` knobs.** Algorithm, digest encoding, and timestamp format are fixed (SHA-256 / lowercase hex / ISO-8601-with-ms). Each would carry a default and the column is schemaless JSON, so adding one is purely additive with no migration — add when a second vendor actually needs it, and keep the algorithm enum closed (never sha1 without a review). — secrets design §10 q2
- [ ] **Rotate panel takes the raw JSON blob for `hmac-timestamp`.** Create splits the credential pair into two inputs; rotate is still a single `PasswordInput` with a hint, because the two secret cards model rotation state differently. The portal's write-time validation is what catches a malformed paste (400, not a silently broken credential) — so this is ergonomics, not correctness.

---

## Threat-model & open questions to document/decide

- [ ] **CSP supply-chain hardening.** Consider SRI or versioned-script pinning for the CDN allowlist; add `object-src 'none'`; decide whether the CDN list should be per-app / opt-in rather than global. Record the third-party stored-XSS exposure on public / shared-write apps in the threat model. — ADR-0009 (DEC-03)
- [ ] **Anonymous shared-writes threat model.** Decide whether `sharedWrite` should require authentication (make `public` + `sharedWrite` an explicit, approval-gated opt-in); separate/attribute the anonymous write budget so a flood can't self-DoS the app's authenticated writes; consider a sentinel GUC value instead of `""`. Document the anonymous-write threat model. — ADR-0010 (DEC-02)

---

## Secret custody (ADR-0006)

- [ ] **Design a real erasure path for connection secrets.** `destroy()` under `kv-connections` is a _soft_ delete — purge protection + 90-day retention mean the value stays recoverable and cannot be purged early, so crypto-shredding is not achievable through the seam. Needs its own design alongside the metering crypto-shred item below. — ADR-0006 amendment §3
- [ ] **Reconcile plaintext dwell with the `open()` cache.** The store holds opened plaintext for a 5-minute TTL (bounded LRU, version-pinned so it cannot go stale, swept on insert, dropped on `destroy()` even mid-read). What the TTL bounds is how long an entry is **served**, not held: a quiet process still retains up to 512 values until the next miss, so a revoked credential stops being served immediately but may still sit in the egress heap where a core dump would find it. Decide dwell as a _policy_ — a target, and whether egress should flush on idle. — ADR-0006 amendment §5

---

## Offline capability (ADR-0035)

- [ ] **Lint a web app manifest whose `<link>` omits `crossorigin="use-credentials"`.** Browsers fetch a manifest with credentials mode **omit**, so on any app that is not `public` the request reaches the edge with no `__Host-session` cookie and the gate answers `401` — correctly. The app looks completely fine and is silently not installable. That is worse here than on an ordinary host: PWA install is the _documented mitigation_ for the one gap confined scope accepts (`/` is outside the worker's scope, so an offline visit to the bare domain reaches neither the worker nor the edge), so the failure quietly removes the answer to a known hole. It cost a real debugging round on the first deployed offline app, which is the evidence that reading the docs isn't sufficient. Mechanically detectable in the uploaded HTML at deploy time, and it fits the existing **courtesy-warning** pattern exactly — the CSP lint (architecture §4.4, "the feedback loop is the real UX") already warns about runtime-only breakage rather than gating on it. Two caveats to design around: visibility can change _after_ deploy (a `public` app going private turns a clean bundle into a broken one, so the warning can't be a hard gate and ideally re-surfaces on the visibility change), and it must not fire for `public` apps. Docs already carry the rule (`packages/deploy-skill/SKILL.md`, `examples/offline/README.md`); this is about catching the ones who didn't read it. — ADR-0035, found deploying `examples/offline` (2026-08-06)
- [ ] **Decide whether an operator kill switch needs its own projected flag.** The tombstone (ADR-0035 §8) fires on two triggers, both derived from state the registry already projects: the app is archived, or the offline grant is withdrawn. Withdrawing the grant in the portal is a one-click kill, so a dedicated switch is _mostly_ redundant — deliberately deferred at planning time rather than overlooked. What it would buy is a break-glass that does not require editing an app's manifest (and so does not touch the approval trail, or race an owner re-adding the grant). Cost is a column on `apps`, a Prisma migration, a projection field and a portal admin control. Revisit if an incident ever wants to kill offline serving for an app the operator does not own. — ADR-0035 §8

  **This claim was false when first written.** The tombstone was served without `Service-Worker-Allowed`, and the max-scope check runs on every _update_ check, not just registration — so the response failed with a `SecurityError` and was never installed. Neither trigger fired, and the feature shipped with no working kill switch at all. Fixed by putting the scope in the script URL (dual review finding #1). Worth remembering when weighing the switch: the value of a break-glass depends entirely on the primary path being exercised, and this one was not, by anything, until a reviewer read the spec. A periodic "revoke and confirm the worker actually dies" check is arguably worth more than the extra column.

---

## Deferred / v2

- [ ] **Metering ledger tamper-evidence (fast-follow before any external audit).** Hash chain + Merkle + external anchoring to a write-only sink — append-only-by-grant is not tamper-proof; `helix_portal` can rewrite history. Plus GDPR: crypto-shredding for content/PII rows and a documented Art. 17(3) retention basis for the metering tuple. — ADR-0021, issue #17
- [ ] **Registry projection — multi-replica / scale hardening (can land with M5).** Cold-start when the DB is down (a cold replica 503s all apps while `/health` may read green — emit `registry-load-pending` and/or bootstrap from a durable snapshot); connection budget + pooler caveat (~3 sessions/replica caps ~30 replicas; use session-pooling mode or a reserved direct LISTEN connection); scale ceiling (single global channel forces a full-table reload per commit per replica — add a `last_modified_at` cursor for delta reloads before ~10⁵ apps). — ADR-0025 (items 3–5)
- [ ] **Hosted-build isolation prerequisites (launch gates, not v2.x follow-ups).** When hosted builds ship they must clear: (1) credential-free builder — the load-bearing control (build container holds no platform/git/registry/cloud secret; clone happens outside the build zone); (2) ephemeral by construction (one container per build, destroyed after; no warm pools); (3) network-restricted install (registry allowlist/mirror, block lifecycle-script egress; `--ignore-scripts` is defense-in-depth only); (4) build provenance as a launch gate (SLSA / in-toto / signed attestation). Open question: confirm the milestone label (v2 vs "M6") and decide whether provenance must also cover the author-CI upload path (a bundled-output/chalk-debug-class payload rides in regardless of hosted builds). — ADR-0026, closes ADR-0018's trusted-on-intake gap
- [ ] **Custom backends / arbitrary containers.** Out of scope for v1; a later isolation tier (see `docs/design/custom-backends.md`). — ADR-0020
- [ ] **Multi-org tenancy.** Deferred; adding `orgId` later is an additive migration (app-id partitioning is already in place), and `platform-admin` becomes org-scoped when it lands. — ADR-0023

---

## Explicitly rejected (recorded so they aren't re-proposed)

- Moving the OIDC RP credential off the edge — standard BFF/confidential-client pattern; not warranted. (ADR-0001)
- Physical DB isolation (schema/DB-per-app) — not warranted; the role split + RLS is the control. (ADR-0002)
- Sandboxed iframe without `allow-same-origin` for app isolation — category error, breaks the same-origin `/_api/*` gateway (ADR-0014). Still the right control _only_ if the portal ever embeds an unpromoted app for preview. (ADR-0019)
- The `HKDF(master, appId)` per-app-key step-1 fix for the egress seam — unsound; both planes hold the master. (ADR-0013)
