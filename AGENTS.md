# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

> **New to the repo? Start with [`TOUR.md`](TOUR.md)** — a high-level map of what's here, why there are three runtimes, and where to read next. This file (`AGENTS.md`) is the working reference: commands, environment, conventions.

**Helix** is the AZX App Platform: secure hosting for vibe-coded AI apps. The whole design rests on one stance — **every hosted app is untrusted code** — and contains the blast radius per app rather than trying to verify app code. Read `docs/platform-architecture.md` (the _what & why_) and `docs/platform-project-plan.md` (the _with what & in what order_) before making non-trivial decisions; section references like "§4.2" or "project plan §6" throughout the code point into these. `docs/adr/` records the significant architecture decisions one-per-file (Context → Decision → Consequences), and is the canonical record of _why_ — where an ADR and older prose disagree, the ADR wins. `docs/features/` holds up-to-date per-feature docs (what & how, today), and `docs/design/app-data-storage.md` is the app-data design. `docs/` is sorted by _kind_ — decisions in `adr/`, designs ahead of the code in `design/`, what's true today in `features/`, dated snapshots in `reviews/`, procedures in `runbooks/` — and [`docs/README.md`](docs/README.md) is the map; put a new doc in the directory matching the job it does rather than loose at the top level. Open follow-up work distilled from the ADRs lives in [`TODO.md`](TODO.md).

**Current status: deployed on Azure (M5); feature work at M4.5 — Egress & Connections.** The three planes run in production on Container Apps against real Entra OIDC, wildcard TLS, and a live Key Vault — `infra/azure` (Bicep) is the source of truth for the topology, and `infra/azure/README.md` is the operational reference. The outstanding M5 residual is a real pilot app end to end. **Everything still runs fully locally** — `apps/dev-idp` stands in for Entra, the dev AES-GCM envelope for Key Vault, Azurite for Blob — so treat "local" below as the development path, not the only deployment. **Where a doc says something is "local only", treat it as stale unless it agrees with this line.**

What has landed, and where the maintained detail lives — prefer these over prose here; they are kept current, a status paragraph is not:

- **Auth** (§4.2/Appendix A) — central callback on `auth.<base>`, one-time handoff token, `__Host-session` cookies, the app-host session gate, group re-checks, silent refresh, and `password` visibility for shared-password apps: `docs/features/authentication.md`, `apps/edge/README.md`. Real Entra in the deployed platform, `apps/dev-idp` locally — the flow is identical either way, the issuer is one env-level swap.
- **The `/_api/*` gateway** (§6.1) — LLM proxy and app-data in three scopes (per-user RLS, write-only collections, app-shared): `docs/features/`, `docs/design/app-data-storage.md`.
- **Fetch-proxy + secret-backed connections** (M4.5) — edge authorizes and mints a signed attested instruction, `apps/egress` verifies it, injects the connection secret, and applies SSRF controls: ADR-0005, ADR-0006, ADR-0035, `apps/egress/src/ssrf.ts`.
- **Portal SPA** (`apps/portal-web` — Vite + React 19 + Mantine + TanStack Query + React Router; the one package on `moduleResolution: bundler`): every screen is real and wired. The single remaining `PreviewBadge` marks per-app RBAC (owner/editor/viewer), a not-yet-built v1 sub-feature — not mock data, never silently faked. Authorization posture is [ADR-0007](docs/adr/0007-portal-authz-v0.md); the BOLA half is closed by the `ownsApp` preHandler, RBAC is not. See `docs/features/portal-web.md`.

Constraints from that work that outlive any status line:

- The SPA's **only build-time config is the portal origin.** Deployment topology comes from the public `GET /api/v1/config` at runtime, and every app the API returns carries a control-plane-computed `url`. Never reintroduce a `VITE_*` domain var or derive the apps host from `window.location`.
- **`packages/secret-store` stays zero-dependency** — it is consumed by the mechanism plane.
- **`helix_edge` has no grant on `app_secrets` at all**, so an edge RCE can't dump a single key. `role-split.integration.test.ts` is what holds that line.

## Commands (from repo root)

| Command                                           | What                                                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev:edge`                                   | Run helix-edge (`:8080`, **https** in dev — apps at `https://<slug>.local.helix.azxlabs.io:8080`, login on `auth.local.helix.azxlabs.io`, platform `GET /health`)                   |
| `pnpm dev:egress`                                 | Run helix-egress (`:8081`, mechanism plane — the fetch-proxy `POST /proxy` + secret injection; needs `helix_egress` role + the dev KEK)                                             |
| `pnpm dev:portal`                                 | Run helix-portal (`:3001`, registry + deploy API)                                                                                                                                   |
| `pnpm dev:idp`                                    | Run the local OIDC issuer (`:3002`, `apps/dev-idp` — fixture users + clients; dev only, never deployed)                                                                             |
| `pnpm dev:web`                                    | Run the portal SPA dev server (`:5173`, Vite; proxies `/api` + `/health` to :3001). `pnpm --filter @azx-pbc/portal-web build` makes the portal serve it at :3001                    |
| `pnpm --filter @azx-pbc/portal db:migrate`        | Create/apply a Prisma migration (dev). Also `db:deploy`, `db:reset`, `db:generate`                                                                                                  |
| `pnpm --filter @azx-pbc/helix-cli helix -- <cmd>` | Run the `helix` CLI (`deploy`, `create`, `versions`, `promote`, `rollback`). Runs in `packages/cli`; for real deploys run it from an app dir instead — see `packages/cli/README.md` |
| `./check-and-lint.sh`                             | Poor-man's CI: typecheck + lint + format check + tests in one pass (add `--fix` to auto-fix first)                                                                                  |

The portal API lives under `/api/v1`. Mutating routes take a bearer token through the verifier chain — an IdP-minted JWT (`helix login`) or `$PORTAL_DEV_TOKEN` (CI/dev fallback); reads now require the same token (only `/health` + the auth-config bootstrap stay public). Deploys land as `preview` versions — promotion to live is a separate step (architecture §5.1).

The standard workspace scripts (`install`, `typecheck`, `lint`, `format`, `test`) are in the root `package.json`. Per-package scripts also run via `pnpm --filter @azx-pbc/edge <script>`.

**Required before calling any change finished: run `./check-and-lint.sh` (or `--fix`) from the repo root and get a clean pass.** This is the same gate CI runs — typecheck + lint + **format check** + the full test suite — and it catches what per-package or per-file checks miss (a Prettier format failure is a red CI build even when types, lint, and the tests you ran are all green). Targeted `pnpm --filter … typecheck`/`test` runs are fine _while iterating_, but they are not a substitute: do not commit, open a PR, or report a change as done until the full script passes. If it fails, fix it and re-run — don't commit the failure and patch it after.

## Environment

Work inside the **dev container** (VS Code: _Reopen in Container_). It provides Node 24, pnpm, and the `db` (Postgres 18) + `azurite` (Blob) services, with `DATABASE_URL`, `AZURE_STORAGE_CONNECTION_STRING`, and the M3 auth env (`EDGE_OIDC_*`, `EDGE_AUTH_SECRET`, `EDGE_TLS_*`, `PORTAL_OIDC_*`) already set. The local IdP is **not** a compose service — it runs in the workspace container (`pnpm dev:idp`) so its issuer URL (`http://localhost:3002`) reads identically from the host browser and from in-container back-channels. mkcert TLS certs for `*.local.helix.azxlabs.io` are generated by post-create into `.devcontainer/certs/` (gitignored). `pnpm install` runs on create. Node 24 LTS is required (`engines.node >=24`).

## Architecture

The system is **three deployable containers plus managed storage**, split along the trust boundary (architecture §3):

- **`apps/edge` — helix-edge, the data/policy plane.** Stateless. Terminates all untrusted app-user traffic (`*.local.helix.azxlabs.io` in dev, `*.azx.helix.azxlabs.io` in prod): host routing, session auth + OIDC handoff, CSP injection, asset serving from Blob, and the `/_api/*` gateway — the LLM proxy, app-data (user/collection/shared), and the **fetch-proxy policy** (authz/quota/audit, then a signed instruction to egress). Runs as the least-privilege `helix_edge` role: a read-only registry projection, INSERT-only metering/collections, RLS-partitioned app-data — **no registry-write and no secret-read** access.
- **`apps/portal` — helix-portal, the control plane.** Privileged: portal UI/API, deploy endpoint, registry writes, capability approvals, secret writes. Not routable from app subdomains. Owns the Postgres schema and all migrations (Prisma 7, pg driver adapter); the edge only reads a cached projection.
- **`apps/egress` — helix-egress, the mechanism plane.** The only component holding plaintext connection secrets or a route to the public internet. Internal-only (`POST /proxy`, never app-user-facing): verifies the edge's attested instruction, resolves+injects the secret under the `helix_egress` role, enforces SSRF controls, and streams the outbound call back. Its own network egress zone in prod; built as its own container from day one rather than extracted later.
- **`packages/secret-store` — `@azx-pbc/secret-store`.** The `seal`/`open`/`destroy` custody seam shared by the portal (write) and egress (read): dev AES-GCM envelope / prod Key Vault behind one interface. **Zero runtime dependencies** — it is consumed by the mechanism plane, so the Key Vault impl is hand-rolled data-plane REST over global `fetch` with the credential injected as a one-function `GetVaultToken` seam (egress hand-rolls the managed-identity call; the portal injects `DefaultAzureCredential`). Keep it dependency-free.
- **`packages/shared` — `@azx-pbc/shared`.** The zod schemas validated at every boundary. Note it exports `./src/index.ts` directly — **no build step**, so consumers get the TypeScript source.

`packages/cli` — `@azx-pbc/helix-cli`, the `helix` CLI — landed in M1 (zips a build dir or a prebuilt bundle and drives the deploy API) and is **published to public npm** (`npm i -g @azx-pbc/helix-cli`) from `.github/workflows/release-cli.yml` on a `cli-v*` tag, via trusted publishing (OIDC, no `NPM_TOKEN`) with provenance — ADR-0032. It is the only non-`private` package in the repo and the only one that emits JS. And `apps/portal-web` (the React SPA) is real and wired (see above). `packages/deploy-skill` is the **agent skill bundle** — a templated `SKILL.md` teaching an agent how to build and deploy a Helix app, rendered for this deployment and handed out by the portal SPA's **How to develop** modal (`docs/features/onboarding.md`). `infra/azure` (Bicep) is the deployed Azure topology and the source of truth for it — see `infra/azure/README.md`.

### The edge is the trusted path

**Hard rule: `apps/edge` is dependency-minimal.** Every npm package there is code inside the trusted path, so adding a runtime dependency requires justification at review time (project plan §6). No ORM in the edge — hand-written SQL. Never block the event loop; pipe streams, never buffer LLM responses.

### App boot and the `/health` contract

Every service splits `buildApp()` (pure, no listen) from `server.ts`, so tests build the app and inject requests rather than binding a port. The `/health` endpoint validates its own response through `HealthStatusSchema` so the contract is identical across services. That contract is a three-state roll-up (`ok`/`degraded`/`error`) plus an optional generic `checks[]` array, not a liveness boolean — the edge reports its registry projection's freshness there (ADR-0025). **It always answers HTTP 200**, in every state: the body carries the degradation, because a non-200 would let a liveness probe restart a replica that is serving correctly from a stale copy. Portal and egress report liveness only (no `checks`).

## Conventions

- **TypeScript everywhere, ESM, Node 24.** Strict `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`), extended per package. Because of `verbatimModuleSyntax`, type-only imports must be written as `import type` / `import { type X }`. ESM import specifiers use `.js` extensions even for `.ts` sources (`nodenext`).
- **Versions via the pnpm catalog** in `pnpm-workspace.yaml` — packages reference `catalog:` instead of pinning; bump in one place.
- **zod at every boundary** (`@azx-pbc/shared`); inferred types travel with the schemas.
- **Tests** are colocated `*.test.ts` under each package's `src/`; Vitest runs them in the `node` environment (single project for now — a jsdom project splits off when the React SPA lands).
- **Anything touching M3 auth code gets adversarial tests with it, not after** (project plan §6). The OIDC handoff is the most security-sensitive code in the platform and gets a dedicated review pass.
