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

### M4 — Gateway v0: LLM proxy
`/_api/llm/*` on the edge: streaming proxy via the `LlmProvider` interface, per-app model allowlist, token budgets with finish-in-flight/block-new semantics, metering + audit records per call. Origin validation on `/_api/*` (CSRF — §4.2). Test quota edge cases against the fake provider; verify streaming against a real vendor.

### M5 — Azure + pilot
Minimal IaC: resource group, two ACA apps (or one, if consolidated), Postgres flexible server, Blob, Key Vault, Entra app registration, wildcard DNS + cert on `azx-labs.com`. Deploy a real vibe-coded pilot app end to end: `azx deploy` → SSO login → app calls LLM through the gateway. **v0 done.**

## 5. v1 backlog (rough order, re-plan after v0)

1. **Portal SPA** — app list/detail, deploy history + rollback button, manifest editing. (Until here the portal is API + CLI only.)
2. **Capabilities manifest + approvals** — per-app grants, baseline vs admin-approved, enforcement in the gateway.
3. **App data API** — app-scoped and user-scoped KV (`/_api/data/*`), Postgres JSONB.
4. **CSP feedback loop** — `report-to` endpoint, violation reports surfaced in portal as click-to-request origin grants; deploy-time courtesy lint.
5. **Deploy skill + preview/promote** — agent skill bundle (no embedded credentials; device-code flow), preview deploys by default, human promote action (architecture §5.1).
6. **Password/public visibility modes** — password gate, anonymous tier, per-IP limits, admin approval flag for public.
7. **Session management** — admin session revocation, audit log UI.
8. **Audit hardening + usage** — audit shipping to immutable blob (scheduled job), per-app usage views.

v1.x and beyond (fetch-proxy, MCP-as-REST, secret-backed connections, Git-connect builds) stay in the architecture doc §12; don't plan them yet.

## 6. Working agreements

- Each milestone starts as a Claude Code planning session against this doc + the architecture doc.
- The edge dependency budget is enforced at review time: adding a package to `apps/edge` requires justification.
- Anything touching M3 auth code gets adversarial tests with it, not after.
- Architecture doc is the source of truth for *why*; when implementation diverges from it, update the doc in the same change.
