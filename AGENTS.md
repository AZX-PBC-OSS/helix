# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Helix** is the AZX App Platform: secure hosting for vibe-coded AI apps. The whole design rests on one stance — **every hosted app is untrusted code** — and contains the blast radius per app rather than trying to verify app code. Read `docs/platform-architecture.md` (the _what & why_) and `docs/platform-project-plan.md` (the _with what & in what order_) before making non-trivial decisions; section references like "§4.2" or "project plan §6" throughout the code point into these.

**Current status: M1 — Registry + deploys (control plane core).** The portal owns a Postgres schema (apps, versions, audit) via Prisma 7 and exposes a versioned REST API: create/list/get apps, upload a bundle (zip validation + static-files-only check + CSP courtesy lint + store to Blob), list versions, and promote/rollback the live pointer. The `azx` CLI (`packages/cli`) drives deploys. Auth is a dev-token stub on mutating routes (real OIDC/Entra is M3); the edge, registry projection, and gateway are still M2–M4 (see project plan §4).

## Commands (from repo root)

| Command                                  | What                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm install`                           | Install all workspace deps                                                                         |
| `pnpm typecheck`                         | `tsc --noEmit` across every package (`pnpm -r typecheck`)                                          |
| `pnpm lint` / `pnpm lint:fix`            | ESLint (flat config + typescript-eslint)                                                           |
| `pnpm format` / `pnpm format:check`      | Prettier write / verify                                                                            |
| `pnpm test`                              | Vitest run across the workspace                                                                    |
| `pnpm test:watch`                        | Vitest watch mode                                                                                  |
| `pnpm dev:edge`                          | Run azx-edge (`:8080`, `GET /health`)                                                              |
| `pnpm dev:portal`                        | Run azx-portal (`:3001`, registry + deploy API)                                                    |
| `pnpm --filter @helix/portal db:migrate` | Create/apply a Prisma migration (dev). Also `db:deploy`, `db:reset`, `db:generate`                 |
| `pnpm --filter @helix/cli azx -- <cmd>`  | Run the `azx` CLI (`deploy`, `create`, `versions`, `promote`, `rollback`)                          |
| `./check-and-lint.sh`                    | Poor-man's CI: typecheck + lint + format check + tests in one pass (add `--fix` to auto-fix first) |

The portal API lives under `/api/v1`. Mutating routes require `Authorization: Bearer $PORTAL_DEV_TOKEN` (dev stub); reads are open. Deploys land as `preview` versions — promotion to live is a separate step (architecture §5.1).

Run a single test file or filter by name:

```bash
pnpm test apps/edge/src/app.test.ts      # one file
pnpm test -t "health"                      # filter by test name
```

Per-package scripts (`dev`, `start`, `typecheck`) also run via `pnpm --filter @helix/edge <script>`.

## Environment

Work inside the **dev container** (VS Code: _Reopen in Container_). It provides Node 24, pnpm, and the `db` (Postgres 18) + `azurite` (Blob) services, with `DATABASE_URL` and `AZURE_STORAGE_CONNECTION_STRING` already in the environment. `pnpm install` runs on create. Node 24 LTS is required (`engines.node >=24`).

## Architecture

The system is **two deployable containers plus managed storage**, split along the trust boundary (architecture §3):

- **`apps/edge` — azx-edge, the data plane.** Stateless. Will terminate all `*.azx-labs.com` (untrusted app-user) traffic: host routing, session auth + OIDC handoff, CSP injection, asset serving from Blob, and the entire `/_api/*` gateway (LLM proxy, app data, quotas, metering, audit). Runs with a read-only registry projection and no secret-write access.
- **`apps/portal` — azx-portal, the control plane.** Privileged: portal UI/API, deploy endpoint, registry writes, capability approvals. Not routable from app subdomains. Owns the Postgres schema and all migrations (Prisma 7, pg driver adapter); the edge only reads a cached projection.
- **`packages/shared` — `@helix/shared`.** zod schemas validated at every boundary (visibility, app, version, manifest, health), with inferred types exported alongside. Re-exported from `src/index.ts`; consumed via `workspace:*`. Note `@helix/shared` exports `./src/index.ts` directly (no build step).

`packages/cli` — `@helix/cli`, the `azx` CLI — landed in M1 (zips a build dir or a prebuilt bundle and drives the deploy API). `apps/portal-web` (React SPA), `packages/deploy-skill`, and `infra/` appear in the target layout (project plan §2) but land in later milestones.

### The edge is the trusted path

**Hard rule: `apps/edge` is dependency-minimal.** Every npm package there is code inside the trusted path, so adding a runtime dependency requires justification at review time (project plan §6). No ORM in the edge — hand-written SQL. Never block the event loop; pipe streams, never buffer LLM responses.

### App boot pattern

Both apps follow the same shape: `src/app.ts` exports `buildApp(): FastifyInstance` (pure, testable, no listen), and `src/server.ts` imports it and calls `app.listen()`. Tests build the app and inject requests rather than binding a port. The `/health` endpoint validates its own response through `HealthStatusSchema` so the contract is identical across services.

## Conventions

- **TypeScript everywhere, ESM, Node 24.** Strict `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `isolatedModules`), extended per package. Because of `verbatimModuleSyntax`, type-only imports must be written as `import type` / `import { type X }`. ESM import specifiers use `.js` extensions even for `.ts` sources (`nodenext`).
- **Versions via the pnpm catalog** in `pnpm-workspace.yaml` — packages reference `catalog:` instead of pinning; bump in one place.
- **zod at every boundary** (`@helix/shared`); inferred types travel with the schemas.
- **Tests** are colocated `*.test.ts` under each package's `src/`; Vitest runs them in the `node` environment (single project for now — a jsdom project splits off when the React SPA lands).
- **Anything touching M3 auth code gets adversarial tests with it, not after** (project plan §6). The OIDC handoff is the most security-sensitive code in the platform and gets a dedicated review pass.
