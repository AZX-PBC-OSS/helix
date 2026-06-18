# AZX App Platform — Project Plan

**Status:** Draft v1 · June 2026
**Companion to:** `platform-architecture.md` (the *what and why*; this doc is the *with what and in what order*)
**How to use:** each milestone below is sized to be one or a few Claude Code planning-mode sessions. Low-level design happens there, not here.

---

## 1. Tech stack (decided)

- **TypeScript everywhere, Node LTS.** One language across edge, portal, frontend, CLI, and deploy skill. Boring and reviewable beats fast and exotic — the edge contains the most security-sensitive code in the platform, and we can only safely merge what we can deeply read.
- **`azx-edge`:** Fastify + `undici` (streaming proxy, asset serving), `openid-client` + `jose` (OIDC, handoff tokens), `pg` with hand-written SQL (sessions, registry projection). **Hard rule: dependency-minimal.** Every npm package in the edge is code inside the trusted path; the libraries named here are roughly the whole list. No ORM. Never block the event loop — pipe streams, never buffer LLM responses.
- **`azx-portal` API:** Fastify + Prisma. The portal owns the Postgres schema and all migrations (`prisma migrate`); the edge only reads. The API is a deliberate, versioned REST surface with zod-validated request/response schemas — the portal SPA, the `azx` CLI, and coding agents are all consumers, so no tRPC/framework-coupled endpoints.
- **Portal frontend:** Vite + React SPA, TanStack Query for server state, React Router. Served statically by the portal container. No SSR/meta-framework — internal authenticated tool, nothing to gain.
- **Shared contract:** zod schemas in a shared package (app manifest, registry types, API request/response shapes). Runtime validation at every boundary; inferred types everywhere.
- **Testing:** Vitest throughout; Playwright for portal e2e when the UI warrants it.
- **Tooling:** pnpm workspaces monorepo; VS Code dev container (config pillaged from an existing project).

## 2. Monorepo layout

```
helix/
  apps/
    edge/            # azx-edge data plane
    portal/          # azx-portal API
    portal-web/      # Vite + React SPA
  packages/
    shared/          # zod schemas: manifest, registry, API contracts
    cli/             # azx CLI (npm-distributed; `azx deploy` etc.)
    deploy-skill/    # agent skill bundle (v1)
  examples/          # reference apps to `azx deploy`; built dist/ is committed
  infra/             # IaC for Azure (minimal at first)
  .devcontainer/
```

## 3. Local-first Azure strategy

Every Azure dependency must work in three modes: **local dev**, **integration test against real Azure**, and **production**. Two patterns depending on whether an emulator exists:

| Dependency | Local | Real | Approach |
|------------|-------|------|----------|
| Blob Storage | **Azurite** (official emulator, same SDK) | Blob Storage | Same Azure SDK both ways; thin `BlobStore` wrapper for testability |
| Postgres | Docker container | Azure Database for PostgreSQL | Same engine; no abstraction needed |
| Key Vault | `SecretStore` interface → env/file impl | Key Vault impl | No emulator exists; interface + dual implementation |
| Entra ID | Local OIDC issuer (`oidc-provider` npm) | Real Entra app registration in a dev tenant | OIDC is a standard; the edge speaks generic OIDC (which we want anyway for IdP-agnostic customers) |
| LLM APIs | `LlmProvider` interface → fake/echo provider | Azure OpenAI / Anthropic impls | Interface + dual implementation; fake provider streams canned tokens for testing quota/stream handling |

Config selects implementations per environment. CI runs against local/emulated; a separate integration suite runs against a real Azure dev resource group.

**Local wildcard subdomains:** use `*.localtest.me` (resolves to 127.0.0.1) so subdomain-per-app routing and host-keyed routers work locally, with mkcert for a local wildcard cert — required because `__Host-` cookies demand `Secure`, and the whole isolation model must be exercisable in dev, not just in Azure.

## 4. v0 milestones (in order)

Goal: one pilot app, end to end, on Azure. Definition of done is §12 v0 in the architecture doc. v0 may ship both modules as a single binary/container if that's faster — but with two routers strictly keyed by hostname from day one (architecture §3, decision 12).

### M0 — Skeleton
Monorepo scaffold (pnpm workspaces), dev container, lint/format/test wiring, `packages/shared` with first zod schemas (app, version, manifest), empty Fastify apps for edge and portal that boot and health-check. Docker compose for Postgres + Azurite.

### M1 — Registry + deploys (control plane core)
Postgres schema via Prisma (apps, versions, audit), portal API: create app, upload bundle (zip validation, static-files-only check, store to Blob via Azurite), version pointer + rollback. Minimal `azx` CLI: `azx deploy`. No UI yet — API + CLI only.

### M2 — Edge serving
Host routing on `*.localtest.me`, registry projection (cached read from Postgres, refresh on change), asset streaming from Blob, version pointer resolution, 404/410 + `Clear-Site-Data` on archived apps. Baseline CSP header injection (the §4.4 policy, statically configured). No auth yet — a dev-only bypass flag.

### M3 — Auth (the careful one)
The §4.2 / Appendix A flow: central callback on the auth host, OIDC against local `oidc-provider`, one-time handoff token (signed, 30 s, single-use, audience-bound), `__Host-session` cookies, server-side sessions in Postgres, `/_api/me`, group-based visibility checks, silent refresh. **This milestone gets adversarial tests** (replay, audience confusion, open-redirect attempts, cookie tossing) **and a dedicated review pass before anything builds on it.** Then: real Entra app registration in the dev tenant, verify the same flow against reality.

> **Implementation notes (local half, June 2026).** The local IdP is `apps/dev-idp`, run inside the workspace container (`pnpm dev:idp`) rather than as a compose service — an OIDC issuer is one string enforced by every client, and only `localhost:3002` + port forwarding reads identically from the host browser and in-container back-channels. The edge terminates TLS in dev (mkcert, §3) so `__Host-` cookies are real locally. Scope grew deliberately: the **portal API** moved off the dev-token stub onto stateless bearer-JWT verification (issuer JWKS, fixed audience — cookie sessions are the *edge* mechanism, not the portal's; the Entra swap is env-only), and the **CLI** gained `azx login`/`logout`/`whoami` via the OIDC device flow with an XDG token cache. `PORTAL_DEV_TOKEN` survives as a demoted CI fallback, refused in production. The Entra verification tail remains open.

### M4 — Gateway v0: LLM proxy
`/_api/llm/*` on the edge: streaming proxy via the `LlmProvider` interface, per-app model allowlist, token budgets with finish-in-flight/block-new semantics, metering + audit records per call. Origin validation on `/_api/*` (CSRF — §4.2). Test quota edge cases against the fake provider; verify streaming against a real vendor.

### M5 — Azure + pilot
Minimal IaC: resource group, two ACA apps (or one, if consolidated), Postgres flexible server, Blob, Key Vault, Entra app registration, wildcard DNS + cert on `azx-labs.com`. Deploy a real vibe-coded pilot app end to end: `azx deploy` → SSO login → app calls LLM through the gateway. **v0 done.**

## 5. v1 backlog (rough order, re-plan after v0)

Most of this was pulled forward against the local stack — M4/M5 (Azure deploy) buy little before there's a product people want to host, so v1 features came first. Status as of June 2026:

1. **Portal SPA** — **done.** `apps/portal-web` (Vite + React 19 + Mantine + TanStack Query): app list/detail, version history with promote/rollback, create app, zip-upload deploy (CSP lint warnings rendered), archive/unarchive, a real capability-manifest editor, and browser sign-in (code+PKCE). Served statically by the portal; the unbuilt M4+ surfaces ship as labelled `PreviewBadge` mocks rather than silent fakes.
2. **Capabilities manifest + approvals** — **done** (`docs/design/approvals.md`). Manifest is real and enforced (`GET`/`PUT /api/v1/apps/:slug/manifest`; the gateway enforces the per-app model allowlist + daily token budget on every LLM call). The baseline-vs-admin-approved **approval workflow** landed on top: a pure `classifyChange` classifier + policy thresholds in `@helix/shared` split a requested change into baseline deltas (committed immediately, as before) and elevated deltas (bundled into one pending request); an `ApprovalRequest` table holds the typed pending change (the `apps` row keeps only effective state — the edge is untouched); `PUT /manifest` and a new `POST /apps/:slug/visibility` route through that write-gate; `/api/v1/approvals` serves the admin queue and `approve`/`deny`/`needs_changes`/`withdraw` with apply-on-approve (snapshot conflict-check → `needs_changes`, separation-of-duty, idempotency). Admin is a group claim (`requireAdmin`, `PORTAL_ADMIN_GROUP_ID`; `PORTAL_ALLOW_SELF_APPROVE` is the refused-in-prod dev escape hatch). The portal Approvals screen is now real (the `PreviewBadge` is gone).
3. **App data API** — **done (scope grew).** `/_api/data/*` in three scopes — per-user (RLS-partitioned via `SET LOCAL` GUCs from the verified session), write-only `collections` (no app-facing read; owner drains via the export API), and app-`shared` keys — backed by the `helix_edge` Postgres role split (INSERT-only metering/collections, RLS app-data, no registry write). Broader than the original app-/user-scoped JSONB KV sketch.
4. **CSP feedback loop** — **done** (`docs/design/approvals.md` §6.2). Deploy-time courtesy lint (warnings on upload + in the SPA), the edge violation sink (`report-uri` → `POST /_csp-report` → the `csp_reports` table on an INSERT-only `helix_edge` grant — the edge appends but can never enumerate them), and `capabilities.externalOrigins` → per-app CSP `connect-src`/`img-src` widening at serve time all landed. The portal **Violations** screen is real and turns a blocked origin into a one-click origin-grant request through the #2 approval spine. `examples/github-stars` exercises the whole loop end to end (it fetches a public API directly, so the CSP blocks it until the origin is approved).
5. **Deploy skill + preview/promote** — **partial.** Preview-by-default deploys + human promote/rollback are done (control plane + `azx` CLI), and the device-code flow exists (`azx login`/`logout`/`whoami`, XDG token cache). _Remaining:_ the `packages/deploy-skill` agent bundle (does not exist yet).
6. **Password/public visibility modes** — **done.** `password` visibility is done end to end (portal mints/stores an xkcd passphrase; edge serves a throttled same-origin `/_auth/login` challenge minting a pseudonymous `pw_<random>` session). `public` apps resolve to an anonymous caller in the gate, and **going public flows through the approval queue** — a high-risk `visibility → public` delta gated by `requireAdmin` (`docs/design/approvals.md` §6.3). The portal **Settings → Visibility** card is now a real switcher (`POST /apps/:slug/visibility` via `useSetVisibility`): reductions (→ private/group) apply immediately, going public opens a confirm-with-reason approval request, and leaving `password` defers to the password card's Disable. The **anonymous tier is per-IP rate-limited** at the gateway (`apps/edge/src/gateway/ipRateLimiter.ts` — a fixed-window in-memory limiter mirroring the password-login throttle; `EDGE_ANON_RATE_LIMIT`/`EDGE_ANON_RATE_WINDOW_MS`), keyed per IP+app across every anonymous `/_api/*` call (LLM + data), returning `429 rate_limited`; authenticated callers answer to per-app budgets instead. _Remaining (deferred knobs):_ `bytesPerDay` and total-collection-size caps — see the app-data design doc §7.
7. **Session management** — **partial.** A real gateway audit read-side exists (`/api/v1/gateway/audit` + the portal Audit page over `gateway_calls`). _Remaining:_ **admin session revocation** — the portal migrates the `sessions` table but has no revoke route/UI.
8. **Audit hardening + usage** — **partial.** Per-app and platform usage views are real and wired (`/api/v1/apps/:slug/usage`, `/api/v1/gateway/usage` + the Usage/Platform pages reading `gateway_calls`). _Remaining:_ **audit shipping to an immutable blob** (scheduled job).

v1.x and beyond (fetch-proxy, MCP-as-REST, secret-backed connections, Git-connect builds) stay in the architecture doc §12; don't plan them yet.

## 6. Working agreements

- Each milestone starts as a Claude Code planning session against this doc + the architecture doc.
- The edge dependency budget is enforced at review time: adding a package to `apps/edge` requires justification.
- Anything touching M3 auth code gets adversarial tests with it, not after.
- Architecture doc is the source of truth for *why*; when implementation diverges from it, update the doc in the same change.
