# AZX App Platform — Architecture Design Doc

**Status:** Draft v2 · June 2026 (v2: dedicated `azx-labs.com` domain, Git builds deferred to v2 phase, auth appendix added). Implementation is at **M4.5 (local)** — all three planes, the gateway, secret-backed connections, and the approval workflow run locally; Azure deploy + a real Entra registration are the remaining tail (project plan §4, §5).
**Scope:** Secure hosting for vibe-coded AI apps. Self-hosted, Azure first (we are customer #0), portable to other clouds later.

---

## 1. Summary

A platform that hosts untrusted, vibe-coded frontend apps behind SSO by default, and gives those apps superpowers through a centrally governed API/MCP gateway. v1 supports static frontends only; all dynamic capability (LLM calls, storage, integrations) flows through platform APIs. This keeps the attack surface small and makes the gateway — our main value add — the single choke point for identity, authorization, quotas, and audit.

**The core security stance: every hosted app is untrusted code.** Vibe-coded apps may contain injected or hallucinated logic, leaked prompts, or supply-chain malware. The design assumes this and contains the blast radius per app, rather than trying to verify app code.

---

## 2. Goals and non-goals

**Goals (v1)**

- Host static frontend apps (SPA bundles) at `<app>.azx-labs.com` — a dedicated apps domain, deliberately separate from the corporate domain (§4.1)
- SSO by default via Microsoft Entra ID; per-app override to public or password-protected
- Deploy by uploading a built bundle (CLI or portal). Git-connected builds are deferred — see §5
- Platform API + MCP gateway giving apps governed access to LLMs, storage, and integrations
- Per-app scoped data storage so most apps need no custom backend
- Tens of apps, one org, low ops burden

**Non-goals (v1)**

- Arbitrary containers or custom backends (phase 2 at earliest)
- In-platform app builder (assume apps built elsewhere with Lovable/Cursor/Claude Code etc.)
- Multi-org tenancy (but avoid decisions that block it — see §9)

---

## 3. System overview

```
 app users ── HTTPS ──▶ ┌─────────────────────────────────────────────┐
 *.azx-labs.com         │ azx-edge — data/policy plane (stateless)    │
                        │ host routing · sessions + OIDC handoff      │
                        │ CSP injection · asset serving from Blob     │
                        │ /_api/* gateway: LLM proxy · app data ·     │
                        │ fetch-proxy policy · quotas · metering·audit│
                        └──┬───────────┬───────────┬──────────────┬───┘
                           ▼           ▼           ▼              ▼ attested
                      Blob storage  LLM vendors  Postgres     instruction
                      (versioned   (Azure OpenAI (registry·   (signed; no
                       bundles)     Anthropic…)   app data·    secrets cross)
                                                  sessions·        │
                                                  audit)           ▼
                                          ┌──────────────────────────────────────┐
                                          │ azx-egress — mechanism plane          │
                                          │ (its own network egress zone)         │
                                          │ secret injection · SSRF controls ·    │
                                          │ outbound HTTP to third-party APIs     │
                                          └──────────────┬─────────────┬──────────┘
                                                         ▼             ▼
                                                   third-party    Key Vault /
                                                   APIs           secret store

 app owners ── HTTPS ─▶ ┌─────────────────────────────────────────────┐
 portal.azx-labs.com    │ azx-portal — control plane (privileged)     │
                        │ portal UI + API · deploy endpoint           │
                        │ registry writes · capability approvals      │
                        │ scheduled jobs: usage rollups · audit       │
                        │ shipping · ACME cert renewal                │
                        └─────────────────────────────────────────────┘
                        portal writes Postgres + Blob; edge reads a
                        cached registry projection (§7)
```

Three deployable containers plus managed storage:

- **`azx-edge` — the data/policy plane.** Terminates all `*.azx-labs.com` traffic: host routing, session auth + the OIDC handoff, CSP injection, asset serving from Blob, and the `/_api/*` gateway (LLM proxy, app data, the fetch-proxy *policy* — identity, authz, quota, audit). Runs with a read-only registry projection, **no app-connection-secret read** (no grant on `app_secrets`), and **no _arbitrary_ outbound route** (only egress can reach the open internet). Boring by design; rarely redeployed. (It is not literally secretless or stateless: it holds its own operational keys — auth/instruction/OIDC, plus today an over-broad Blob key ([ADR-0001](adr/0001-three-runtime-split.md)) — and keeps in-memory rate-limit/projection state ([ADR-0011](adr/0011-in-memory-rate-limiting.md)).)
- **`azx-portal` — the control plane.** Privileged: portal UI + API, deploy endpoint, registry writes, capability approvals, secret writes, audit log UI. Not routable from app subdomains. Background work (usage rollups, audit shipping to immutable blob, ACME DNS-01 renewal) runs as scheduled jobs it owns — no standing workers.
- **`azx-egress` — the mechanism plane.** The one component that makes governed outbound HTTP for the fetch-proxy (§6.1): it resolves connection secrets to plaintext, injects credentials server-side, and enforces SSRF controls. It runs in its **own network egress zone** (the only component with a route to the public internet) and holds the secret-read capability the edge deliberately lacks. It never terminates app-user traffic and never re-authenticates the end user — it trusts a signed attested instruction `(app, user, capability, origin, connection, request-id)` minted by the edge.

**Why three — not two, not four.** The split follows the trust boundary. The data plane faces untrusted app users (eventually anonymous internet traffic); the control plane holds the privileged verbs — grants, secrets, approvals; the mechanism plane holds the two capabilities that are dangerous to co-locate with a public-facing process — *plaintext third-party secrets* and *unrestricted outbound network*. In one process, a bug in the public-facing path exposes control-plane memory and identity, and every portal deploy restarts the data path, killing in-flight LLM streams — the portal iterates constantly while the edge should be boring. The egress split is the one gateway extraction that *isn't* ceremony: a generic gateway service would only buy an internal hop (it shares the edge's request path, session store, and registry cache), but egress genuinely needs a *different* posture — its own network zone so an SSRF bug in the edge reaches nothing, and custody of secrets the edge must never hold. Building egress in-process and extracting later would mean shipping that blast radius first; we draw the boundary from day one instead. (A standalone build service appears only if Git-connect lands, §5.)

**The same boundary is enforced again in Postgres.** The three-plane split would be theatre if a compromise of one process could simply reach into shared data, so each plane is meant to connect as a distinct least-privilege role and the database refuses what the trust model forbids ([ADR-0002](adr/0002-postgres-role-split-rls.md) — with the caveat that the split isn't fully realized yet: the portal currently connects as the schema owner rather than `helix_portal`, and the edge falls back to the owner DSN if its role DSN is unset; both tracked to be hardened before M5):

- `helix_portal` — full DML; it owns the schema and every privileged verb.
- `helix_edge` — **explicit per-table grants only, no blanket grant**: read the registry projection, append metering, INSERT-only on collections, RLS-partitioned app-data. It has **no grant on `app_secrets` at all**, so an edge RCE cannot read a single connection secret, and no registry-write, so it cannot grant itself a capability.
- `helix_egress` — `SELECT` on secrets + `UPDATE` on one `lastUsedAt` column; nothing else.

So the runtime split (process + network zone) and the role split (database authority) say the same thing in two enforcement layers — a defence-in-depth that survives an in-process compromise. Asserted in `role-split.integration.test.ts`.

**v0 consolidation option:** the edge and portal modules may still ship as a single binary/container if it accelerates the pilot — with two routers strictly keyed by hostname, and control-plane handlers never mounted on app-subdomain hosts. Built with that discipline, the later edge/portal process split is a deploy-config change; built without it, it's a rewrite. Split at the latest before the first public app ships. ([ADR-0012](adr/0012-edge-portal-codeploy.md): the challenge review found the split scaffolding is not actually in place today — the `platform` HostClass is unused — so treat the "deploy-config change" as a goal to protect with a CI gate, not a delivered property.) **`azx-egress` is the exception: it ships as its own container from the start** — its network-zone and secret-custody isolation is the entire point, and folding it into either module would forfeit it.

All three containers run on Azure Container Apps for v1 (AKS if/when needed), keeping the stack portable. Egress sits in its own egress-permitted network zone; the edge and portal run with no outbound internet route.

---

## 4. App hosting and identity at the edge

### 4.1 Routing and TLS

- Apps live on a **dedicated domain** (`azx-labs.com`), not the corporate domain. Three reasons: (a) *reputation* — vibe-coded apps never carry the weight of the main brand, and an embarrassing or compromised app doesn't taint `azx.io`; (b) *security* — complete cookie/session isolation from corporate properties: nothing an app does on `azx-labs.com` can touch `azx.io` cookies, and corporate CSP/HSTS policy stays independent; (c) *phishing hygiene* — users learn a clean rule: real company sites are on `azx.io`, hosted apps are on `azx-labs.com`, and credentials are only ever typed on the Entra domain.
- Wildcard DNS `*.azx-labs.com` → edge proxy; wildcard cert via ACME (DNS-01) or Azure-managed cert.
- Each app gets its own subdomain. **Subdomains are the isolation boundary**: separate browser origin per app means no shared DOM, storage, or cookies between apps. This is the single most important security decision in the design.

### 4.2 Authentication

The edge proxy terminates auth so apps never implement it:

- **Private (default):** OIDC against Entra ID. Unauthenticated users are redirected to login; the proxy sets a session cookie **host-scoped to that app's subdomain only** (never a parent-domain cookie — a parent-domain cookie would let any hosted app steal sessions for all others).

  Host-only cookies are necessary but not sufficient, because sibling subdomains are *same-site* in browsers. Three additional controls are required:
  - **`__Host-` cookie prefix** on the session cookie — blocks cookie-tossing/session-fixation, where a malicious app sets a `Domain=.azx-labs.com` cookie that shadows the session cookie on every other app.
  - **Origin-header validation at the gateway** plus `form-action 'self'` in CSP — `SameSite` does not protect one app's `/_api/*` from cross-subdomain form POSTs riding the user's session on another app, and `form-action` does not fall back to `default-src`, so it must be set explicitly.
  - **Submit `azx-labs.com` to the Public Suffix List** once stable, making app subdomains cross-site to each other for cookie purposes. (Consequence: nothing can set domain-wide cookies under `azx-labs.com` — which is the point. Platform services like `auth.` and `portal.` use host-only cookies and are unaffected.)

  **OIDC mechanics:** Entra ID does not allow wildcard redirect URIs, so per-app callbacks don't work. Use a central callback at `auth.azx-labs.com`, then a one-time signed handoff (short-lived, single-use, audience-bound to the target app) to mint the host-scoped cookie on the app subdomain. The return-URL parameter must be validated against the app registry (open-redirect risk). This handoff is the most security-sensitive code in the platform; it gets a dedicated design review. **Appendix A walks through the full flow.**

  Sessions are short (hours, not weeks) with silent re-auth against Entra on refresh; group membership is re-checked at refresh, so a user removed from a group or disabled in Entra loses access within the session TTL. Per-user session revocation is a v1 control-plane feature.
- **Group-restricted:** same, plus an Entra group check (e.g. only `eng-team` can open the app).
- **Password-protected:** shared password gate at the proxy (for external demos). Gateway calls from these sessions carry a pseudonymous per-session identity, not a verified user — same tier as public apps (§6.4). Note: this is the one mode where users type a credential on an app subdomain rather than the Entra domain; the password form is platform-rendered with distinct branding to keep it visually separate from real login.
- **Public:** no gate. Requires an explicit owner action plus a platform-admin approval flag, since public apps can still call platform APIs (see §6.4).

Apps learn who's logged in via a `/_api/me` endpoint (static apps can't read auth headers); the gateway attributes every API call to the session's verified user.

Candidate implementation: Envoy or Caddy + an oauth2-proxy-style sidecar, or a thin custom Go service. Avoid Azure Front Door/App Gateway for auth logic — it works, but it's the part other customers can't take to their own cloud.

### 4.3 Serving

Static assets live in Azure Blob Storage, addressed as `apps/<app-id>/<version>/...`. The proxy serves them only after the auth check — no public blob endpoints, no CDN in front of private apps in v1 (tens of apps doesn't need one). Deploys are immutable versions; "deploy" = flip a pointer in the app registry; rollback = flip it back.

### 4.4 Browser-side containment (CSP)

The proxy injects a Content-Security-Policy on every app response. The design principle: **classic CSP defends a trusted app against injected script; our threat model is inverted — the app itself is untrusted.** That splits the directives into two groups with opposite postures.

**Strict — data-flow directives.** These control where data can go and what the app can touch; they are the containment and they don't bend:

- `connect-src 'self'` — apps cannot call arbitrary third-party APIs from the browser. The gateway is same-origin at `/_api/*`, so platform capabilities need no exception. Additional origins are a declared, owner-requested, auditable capability.
- `form-action 'self'` (see §4.2 — required for cross-app CSRF protection)
- `frame-ancestors 'none'` (no embedding apps in other apps)

**Relaxed — code-provenance directives.** Blocking inline scripts in an app whose external scripts we also don't trust buys nothing: either way it's vibe-coded code we assume may be hostile. So the platform allows by default what vibe-coded apps actually produce:

- Inline scripts, inline styles, event-handler attributes, and `eval` are permitted. A single-file Claude-generated HTML app deploys and runs untouched.
- A **platform-curated CDN allowlist** (cdnjs, jsdelivr, unpkg, esm.sh, Google Fonts, Tailwind CDN, …) is in script/style/font sources by default. Yes, some of these serve arbitrary packages — but "untrusted code runs in the app's origin" is already the baseline assumption; the boundary is data flow, not code provenance.
- `img-src https: data: blob:` — open. Honest trade-off: image URLs are an exfiltration channel, but CSP cannot stop navigation-based exfil (`location.href=...`) anyway, so hermetic sealing was never on the table. The goal is funneling routine data flow through the gateway, not perfection.
- `wasm-unsafe-eval` and `worker-src 'self' blob:` available without ceremony — not a real boundary under this threat model. **Service workers are the one exception:** the edge refuses any request carrying the `Service-Worker` registration header, so apps cannot install one. A root-scoped service worker is a persistent same-origin network proxy — it would observe the handoff token on `/_auth/complete` (A.3) and could convert a user's in-browser visit into a headless server-side session. Plain web workers are unaffected; offline/PWA support could return later as a per-app declared capability.

**The feedback loop is the real UX.** App authors are assumed to know nothing about CSP, and the deploy skill won't always be in the loop. So:

- `report-to` points violation reports at the platform. The portal turns them into plain-English, actionable messages: "Your app tried to call `api.weather.com` and was blocked — request this origin?" One click files the capability request. Silent breakage becomes a guided fix.
- Deploy-time linting still runs, but as a courtesy warning ("your app references `api.example.com`; it will be blocked until granted"), not a gate.
- The gateway's fetch-proxy (§6.1) gives blocked third-party calls an on-platform answer — route through `/_api/fetch` and get auditing, metering, and server-side secrets instead of a CSP exception.

Residual honesty, unchanged: CSP raises the bar against exfiltration but does not prevent it — navigation exfil, open img-src, and granted channels (LLM prompts, approved origins) remain — see §10.

---

## 5. Deploy (v1: upload only)

v1 has exactly one path into the platform: **upload of a pre-built bundle** (zip of `dist/`) via CLI or portal. The deploy endpoint (part of the control plane) validates the artifact (static files only, size/type sanity checks), runs the CSP courtesy lint (§4.4), stores it as an immutable version in Blob, and updates the registry pointer.

**Git-connected builds are deliberately out of scope for v1.** Running builds means operating a CI system and sandboxing arbitrary code execution (`npm install` runs whatever the lockfile says) — ephemeral builders, credential isolation, egress controls. That's a lot of yak to shave, and none of it blocks the core platform. The long-term direction is still to push app authors toward Git as the source of truth; when Git-connect lands (target: v2), the builder design is already sketched:

- Ephemeral container per build, destroyed after; no platform credentials inside — artifacts leave via a one-way, scoped upload token
- Egress allowlisted to package registries, acknowledging it's leaky (git deps, tarball URLs, postinstall scripts) — the credential-free environment is the real defense
- Build output enters the same upload pipeline as manual deploys, so validation and CSP linting are shared

Until then, a thin CLI (`azx deploy`) keeps the workflow one command, and teams who want CI can run the CLI from their own GitHub Actions — Git-based workflow, zero platform build infrastructure.

### 5.1 Agent-driven deploys (the deploy skill)

Most app authors work inside coding agents (Claude Code, Cursor, etc.), so the deploy path should meet the agent where it is. On app creation, the portal offers a downloadable **deploy skill** — an agent-agnostic bundle of prompts + scripts that teaches any agent the deploy API: push a bundle, check status, list versions, roll back.

**The skill contains no credentials.** A deploy token is effectively code execution in front of every user of the app, with all of the app's granted capabilities — and a skill is a file that gets committed to repos, shared between people, and held in agent context windows and transcript logs. Embedding a long-lived bearer token in exactly that artifact is the classic leak shape, and it would contradict the platform's credential posture everywhere else (short sessions, single-use handoffs). Instead:

- First deploy triggers an **Entra device-code flow**; the script caches a short-lived, per-user × per-app, deploy-scoped token in the OS keychain — outside the repo, outside agent context. Subsequent deploys refresh silently.
- Attribution and revocation come free: every deploy is audited as (user, app), and a departing user's deploy access dies with their Entra account.
- Deploy tokens are deploy-plane only — they can never call gateway APIs or read app data.
- If headless use cases later demand static tokens (expect this argument), they must be deploy-only, expiring, shown once, and prefixed (`azxd_...`) so secret scanners catch them, with anomaly alerts on use from new IPs. Default stance: don't.

**Preview-then-promote guardrail.** An agent holding deploy authority means anything that hijacks the agent — prompt injection from a README, a poisoned dependency doc — can ship code to users with no human in the loop. So agent deploys land on a **preview version** by default (cheap: deploys are already immutable versions behind a pointer), and promoting to live takes a human action in the portal. Agents iterate at full speed; production gets one click of supervision. Per-app configurable, so a trusted solo tool can opt out.

---

## 6. The API/MCP gateway (the value add)

Apps get capabilities by calling the platform gateway — same-origin path `/_api/*` on the app's own subdomain, proxied by the edge (avoids CORS entirely and keeps the session cookie usable).

### 6.1 Service catalog

- **LLM inference:** chat/completions/embeddings proxied to Azure OpenAI / Anthropic etc. Platform holds the vendor keys; apps never see them. Per-app model allowlists, token budgets, and rate limits. Quota enforcement: in-flight requests (including streams) run to completion; new requests are blocked once the budget is hit — no mid-stream cutoffs. The vendor key is a `platform`-scoped connection secret resolved by `azx-egress`, not held by the edge: the edge keeps all the policy (allowlist, budget, metering, SSE relay) and mints an `llm` attested instruction, and egress injects the key and streams the response back — the same policy/mechanism split as the fetch-proxy (see `docs/design/secrets-and-connections.md`). ([ADR-0008](adr/0008-llm-key-via-egress.md): a legacy direct `AnthropicProvider` path reading `EDGE_LLM_ANTHROPIC_KEY` still exists as an **ungated** dev fallback when egress is unconfigured — to be removed from runtime selection and made fail-closed, issue #10.)
- **App data (shipped):** KV/document storage at `/_api/data/...` in **three scopes** — per-user (RLS-partitioned by the authenticated user, so apps cannot read one user's data on behalf of another), app-`shared`, and write-only `collections` (the app appends but cannot read or enumerate; the owner drains them through the portal export API — a contact-form pattern where the app must not be able to harvest its own submissions). Backed by Postgres (JSONB) internally. This is what removes the need for custom backends: most vibe-coded apps need "save my stuff" and nothing more. Design: `docs/design/app-data-storage.md`.
- **File storage:** scoped blob upload/download for user files.
- **Fetch-proxy (shipped, M4.5):** governed outbound HTTP at `/_api/fetch/<url>` for third-party APIs, so a blocked `connect-src` call has an on-platform answer — audited, metered, with secrets injected server-side where configured. The edge enforces the *policy* (identity, authz, quota, audit) and hands a signed attested instruction to **`azx-egress`**, which performs the call under SSRF hardening: isolated egress zone, private/link-local ranges blocked, no redirect-follow, per-app origin allowlist. An **opt-in transparent shim** (`capabilities.fetch.shim`) goes further: the edge injects a one-line script into the app's HTML at serve time that monkeypatches `fetch`/`XMLHttpRequest`, so a vibe-coded `fetch('https://api.github.com/…')` routes through the proxy **unedited**. Design: `docs/design/fetch-proxy.md`.
- **MCP passthrough (v1.x):** platform-registered MCP servers (internal tools, SaaS connectors) exposed to apps as governed endpoints — **wrapped as REST**, since plain HTTP is what vibe-coded frontends can actually call. Apps speaking MCP directly to the gateway is deferred until demand materializes. The app declares which MCP servers it needs; the gateway enforces the grant.
- **Secret-backed connections (shipped, M4.5):** when an app needs a third-party API requiring a secret, the secret lives in the platform (Key Vault in prod — wired in M5; an envelope-encrypted store in dev) and is read only by `azx-egress`, which injects credentials server-side on the outbound hop. Secrets never reach the browser, and never the edge (`helix_edge` has no grant on the secrets table). Design: `docs/design/secrets-and-connections.md`.

### 6.2 Request identity

Every gateway request carries two identities:

- **User:** from the edge session (who is clicking) — a verified Entra identity for private/group apps; a pseudonymous session identity for password/public apps
- **App:** from the app's registered ID bound to its subdomain (which code is calling)

Authorization is evaluated against the pair: *app X, on behalf of user Y, wants capability Z*. This is what makes per-app blast-radius containment real — a malicious app can only abuse the capabilities it was granted, attributed to the users who actually used it.

### 6.3 Capabilities model

Each app has a manifest (editable in the portal, versioned):

```yaml
app: cost-explorer
visibility: private            # private | group | password | public
capabilities:
  llm: { models: [claude-fable-5, claude-opus-4-8], tokensPerDay: 2000000 }
  data: { user: true, shared: true, collections: [contact] }
  fetch: { shim: true, origins: [{ origin: https://api.github.com, connection: github }] }
  mcp: []                      # MCP servers (REST-wrapped, v1.x)
  externalOrigins: []          # extra CSP connect-src/img-src origins
```
(Illustrative; the authoritative zod schema is `packages/shared/src/manifest.ts`.)

Grants above a baseline require platform-admin approval, and this **is enforced** (it is not a courtesy): a `classifyChange` classifier (`packages/shared/src/approval.ts`) splits a requested manifest change into **baseline deltas** — committed immediately — and **elevated deltas** (a non-curated LLM model, a budget above threshold, any MCP server, a new proxied origin, going `public`), which are bundled into a pending `ApprovalRequest` and applied only when a platform admin approves. The `apps` row holds only the *effective* state, so the edge never sees a pending change. Everything is logged: every gateway call gets an audit record of (app, user, capability, outcome, cost) in the append-only `gateway_calls` ledger. Design: `docs/design/approvals.md`.

### 6.4 Public apps

Public apps still get gateway access but with an anonymous user identity, much tighter default quotas, and mandatory abuse controls (per-IP rate limits, no user-scoped storage). Anonymous means **fully stateless** — no cookie-based pseudonymous IDs, no notion of a public-app "user" — until concrete use cases demand otherwise. Making an app public is the highest-risk action in the system; the approval flag exists for this reason.

---

## 7. Control plane (`azx-portal`)

Portal + REST API:

- **App registry:** create app, subdomain, visibility, manifest, deploy history, rollback
- **RBAC:** platform admins approve elevated grants (built — §6.3). App owners/editors/viewers mapped to Entra users and groups is a v1 item, not yet enforced. Note ([ADR-0007](adr/0007-portal-authz-v0.md)) that until then the v0 posture is **authenticated == authorized**: any authenticated principal can mutate any app and manage any app's secrets. The app-scoped secrets/mutating routes performing no ownership check is a live BOLA to close before M5 (issue #9), not merely a missing convenience feature
- **Observability:** per-app usage (requests, LLM tokens, storage), gateway audit log search, deploy logs
- **Lifecycle:** archive/disable apps — proxy returns 410 with `Clear-Site-Data`, capabilities revoked immediately at the gateway (a cached service worker can keep serving the UI, but its API calls die instantly). Retired subdomains are quarantined, not reused, to avoid stale cookies/service workers leaking to a new occupant

The registry is the source of truth (Postgres). The edge proxy and gateway read a cached projection of it (refresh on change, sub-second), so the data path doesn't depend on the portal being up.

---

## 8. Azure mapping (v1)

- **Compute:** Azure Container Apps — two apps (`azx-edge`, `azx-portal`) plus scheduled ACA jobs; builders only if Git-connect lands
- **Assets/files:** Blob Storage
- **Registry + app data:** Azure Database for PostgreSQL (flexible server)
- **Secrets:** Key Vault (platform vendor keys, app connection secrets)
- **Identity:** Entra ID (OIDC); platform itself uses managed identities between components
- **LLM:** Azure OpenAI + Anthropic API as first providers behind the LLM service
- **Logs/metrics:** Azure Monitor for ops; audit log in Postgres (it's product data, not just telemetry)

Portability rule: **Azure services may appear only behind internal interfaces** (object store, SQL, secrets, OIDC). The data-path components are plain containers + Postgres + S3-compatible-able storage, so an AWS/GCP port is config + Terraform, not a rewrite.

---

## 9. Decisions and trade-offs

| # | Decision | Alternative | Why |
|---|----------|-------------|-----|
| 1 | Static-only apps in v1 | Containers per app | Removes server-side untrusted code entirely; gateway becomes the only dynamic surface. Cuts isolation work (no per-app sandboxes, network policy, runtime patching) by an order of magnitude. |
| 2 | Subdomain per app, host-only cookies | Path-based routing (`azx-labs.com/<app>`) | Path routing puts all apps in one origin — any XSS or malicious app reads every other app's storage and session. Non-negotiable. |
| 3 | Auth at the edge proxy | Per-app auth SDKs | Apps are vibe-coded; assume auth code in them is wrong. Centralizing makes SSO-by-default actually default. |
| 4 | Same-origin `/_api/*` gateway path | Separate `api.azx-labs.com` origin | No CORS, no token-in-JS handoff; session cookie just works. Slightly more proxy complexity. |
| 5 | CSP strict on data flow (`connect-src`), relaxed on code provenance (inline/eval/CDNs) | Uniformly strict CSP | The app is untrusted either way, so blocking inline script buys nothing; blocking it breaks every single-file vibe-coded app. Containment lives at the data-flow boundary, where violations become a click-to-request flow instead of silent breakage. |
| 6 | Self-hosted proxy/auth, not Front Door | Azure-native edge | Other customers must run this on their clouds; the edge is core IP, not infra to outsource. |
| 7 | Postgres-backed KV for app data | Cosmos DB | Portability and operational familiarity; Cosmos is Azure-only and overkill at this scale. |
| 8 | One org, but app-id partitioning everywhere | Multi-tenant now | Every row/blob/audit record keyed by app ID from day one; adding an org ID above it later is additive, not a migration. |
| 9 | Dedicated apps domain (`azx-labs.com`) | Subdomain of corporate domain (`apps.azx.io`) | Reputation and security isolation from the main brand (§4.1): an ugly or compromised app can't taint `azx.io`, and app-domain cookies/policies are fully separated from corporate properties. Cost: one more domain to own and explain. |
| 10 | Upload-only deploys in v1 | Git-connect + hosted builds | Hosted builds = operating a CI system + sandboxing arbitrary code execution; high effort, blocks nothing. `azx deploy` from the user's own CI gives a Git workflow without platform build infra. Revisit at v2. |
| 11 | No custom domains | Per-app domains (`tool.example.com`) | Breaks wildcard-cert simplicity, and hosting apps on the corporate domain would undo the separation rationale of decision 9. Apps live at `<app>.azx-labs.com`, full stop. |
| 12 | Three containers: `azx-edge` + `azx-portal` + `azx-egress` | One monolith, or 4+ services | Split follows the trust boundary: untrusted-facing data plane runs unprivileged and rarely restarts; privileged control plane iterates fast without killing in-flight LLM streams; the egress mechanism plane isolates the two things dangerous to co-locate with a public-facing process — plaintext secrets and outbound network — in its own network zone. One process = shared fate and blast radius; a *generic* gateway split would be internal hops for nothing, but egress earns its split with a genuinely different posture (§3). Edge/portal may still ship as one binary in v0; egress is its own container from day one. |

---

## 10. Threat model (abridged)

| Threat | Mitigation |
|--------|-----------|
| Malicious/compromised app code exfiltrates data | CSP `connect-src 'self'` raises the bar (navigation-based exfil, open `img-src`, and granted channels remain — see residual risk); capability grants are explicit and audited; violation reports surface attempts |
| App steals or rides another app's session/data | Per-subdomain origins; `__Host-` host-only cookies (theft + tossing); Origin validation at gateway + `form-action 'self'` (CSRF riding); PSL listing; gateway scopes data by app ID |
| App abuses LLM budget / runs up cost | Per-app quotas, metering, kill switch (disable app) |
| Supply-chain attack in app dependencies | v1: builds happen on the author's machine/CI, so the platform never executes them; uploaded output is static and can only run client-side under CSP. When hosted builds land: ephemeral credential-free builders (primary), registry egress allowlist (leaky, secondary) |
| Public app abused by internet traffic | Admin approval to go public, anonymous-tier quotas, per-IP limits |
| Hijacked coding agent ships malicious code (prompt injection) | No credentials in the deploy skill (device-code auth, keychain-cached short-lived tokens); agent deploys land on preview by default, human promotes to live (§5.1) |
| Phishing within SSO (app mimics login) | Entra login only ever happens on the Entra domain (password-gate forms are platform-rendered with distinct branding — §4.2); dedicated apps domain gives users a clean rule — credentials never get typed on `azx-labs.com`; consider a platform-standard header bar on hosted apps |
| Platform compromise (gateway holds vendor keys) | Keys in Key Vault, managed identities, least-privilege between components (the Postgres role split, §3, is the in-DB layer of this); audit log shipped to a write-only external sink (e.g. immutable blob) so the gateway's own DB credentials can't rewrite history — *planned, project plan §5.8; today `gateway_calls` is append-only by DB grant but not yet externally sealed* |

Residual risk to name explicitly: a granted capability can still be misused *within its scope* (an app granted the `azure-billing` MCP can misrepresent billing data to its users). Governance reduces blast radius; it does not make app code trustworthy.

---

## 11. Open questions

1. **When does phase 2 (serverless functions) trigger?** Proposed criterion: the third real app that can't ship on static + gateway APIs. Until then, resist.

Resolved since draft v1 (decisions folded into the sections above): MCP is exposed as REST wrappers, not direct MCP (§6.1); LLM quota enforcement lets in-flight requests finish and blocks subsequent ones (§6.1); public apps are fully stateless — no pseudonymous user identity unless concrete use cases demand it (§6.4); custom domains are rejected outright (§9, decision 11).

---

## 12. Phasing sketch

Status as of June 2026 — most of this is built **locally**; M5 (Azure) is the gate to production (project plan §4, §5):

- **v0 (done, local):** proxy + OIDC (incl. central-callback handoff, `__Host-` cookies, baseline CSP — the isolation model ships day one, not retrofitted), upload deploys, blob serving, app registry, LLM proxy with quotas. Runs against the local OIDC issuer; a real Entra registration and the Azure pilot are the M5 tail.
- **v1 (mostly done, local):** `azx deploy` CLI ✅, app data API ✅, capabilities manifest + **enforced** approvals ✅, audit/usage UI ✅, password/public modes ✅, CSP violation reporting with click-to-request origins ✅ (§4.4). _Remaining:_ the agent deploy **skill bundle** (`packages/deploy-skill`), and admin per-user **session revocation**.
- **M4.5 (done, local):** the `azx-egress` mechanism plane + the fetch-proxy (incl. the transparent shim) and secret-backed connections built on it (§3, §6.1). Egress ships as its own container from day one (the policy/mechanism split is physical, not deferred).
- **M5 (next):** Azure IaC, the three planes on Container Apps, real Entra (single-tenant; authz via App Roles — see the [Entra runbook](runbooks/entra-app-registration.md)), prod Key Vault, wildcard cert on `azx-labs.com`, one real pilot app end to end.
- **v1.x:** MCP passthrough (REST-wrapped), richer usage dashboards (latency/error dimensions), audit shipping to an immutable sink.
- **v2 candidates:** Git-connect + sandboxed build service, per-app serverless functions, multi-org tenancy, app builder.

---

## Appendix A: The auth flow in detail

This expands §4.2. The actors: the browser; the edge proxy answering on the app's host (`appA.azx-labs.com`); the auth service (`auth.azx-labs.com`); and Entra ID. The proxy and auth service are the same deployment answering on different hostnames — the separation is logical, not physical.

### A.1 The login sequence

1. Browser requests `appA.azx-labs.com/page`. No `__Host-session` cookie → the proxy 302s to the auth service.
2. Browser hits `auth.azx-labs.com/start?app=appA&rd=/page`. The auth service validates both parameters against the app registry — `rd` validation is what prevents the flow being abused as an open redirector.
3. Auth service 302s to Entra's authorize endpoint with `state`, PKCE challenge, and `nonce`.
4. User signs in at Entra (SSO, MFA, conditional access — all Entra policy, none of it ours).
5. Entra redirects back with an authorization code to the **single registered callback**, `auth.azx-labs.com/callback`.
6. Auth service exchanges the code for an ID token over the back channel, validates signature and nonce, and checks the app's visibility rule (e.g. Entra group membership).
7. Auth service mints a **handoff token** and 302s the browser to `appA.azx-labs.com/_auth/complete?token=...`.
8. The proxy (now answering on appA's host) verifies the handoff token, burns it, mints the `__Host-session` cookie, and 302s to the original `/page`.
9. All subsequent requests — assets and `/_api/*` — carry the session cookie.

### A.2 Why the central callback exists

Entra requires every redirect URI to be registered exactly; no wildcards. Per-app callbacks would mean an Entra registry write on every app creation — slow, racy, and capped (Entra limits URIs per registration). So Entra knows exactly one callback. The cost: authentication completes on the wrong host, since `auth.azx-labs.com` cannot set a host-only cookie for a sibling subdomain. The handoff token exists purely to move the authenticated state across that gap.

### A.3 The handoff token

A bearer credential meaning "this user, authenticated, destined for appA" that travels through the browser in a URL — so it can leak via history, logs, or referrers. Each property kills a specific attack:

- **~30-second TTL** — limits the leak window
- **Single-use** (the proxy records and rejects replays) — kills replay
- **Audience-bound to the target app** — a token captured by a malicious app is worthless on any other subdomain
- **Signed by the auth service** — nobody else can mint one

Audience binding does not protect the token from *the target app itself*: a service worker registered by the app would see the `/_auth/complete` request URL — token included — before the edge does, and could exfiltrate it for a headless redemption. That is why service-worker registration is blocked at the edge (§4.4); the residual risk of URL transport is then bounded by the TTL + single-use properties above.

This is the most security-sensitive code path in the platform: every guarantee depends on a small amount of code getting state validation, token burning, and audience checks exactly right. It gets a dedicated design review and adversarial tests.

### A.4 The session

After redemption, the proxy holds a server-side session record (user object ID, display name, group snapshot, app ID, expiry) keyed by an opaque ID in the `__Host-session` cookie. Server-side rather than a self-contained JWT so that revocation is real — killing a session or disabling an app takes effect on the next request, with no signed blob remaining valid until expiry. The cookie is `HttpOnly` (app JS can never read it), `Secure`, and `SameSite=Lax`.

### A.5 Authorization and refresh

Authentication establishes *who you are* once; *whether you may see this app* is checked at session creation and at every refresh. Sessions are short (hours). Refresh runs a silent OIDC re-auth (`prompt=none`) against Entra — invisible to the user, but it re-evaluates group membership, account status, and conditional access. Removing a user from an app's Entra group therefore takes effect within the session TTL, with Entra remaining the single source of truth.

### A.6 What the app sees

Nothing of the above. Apps are static files and ship zero auth code. An app that wants to display the current user calls `/_api/me`. This is deliberate twice over: vibe-coded auth is the failure mode the design exists to avoid, and IdP swap (Okta, Google) for future customers requires no change to any hosted app.
