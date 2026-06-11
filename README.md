# Helix — AZX App Platform

Secure hosting for vibe-coded AI apps. See [`platform-architecture.md`](./platform-architecture.md)
(the _what & why_) and [`platform-project-plan.md`](./platform-project-plan.md) (the _with
what & in what order_).

> **Status: M0 — Skeleton.** Monorepo scaffold, lint/format/test wiring, shared zod
> schemas, and empty Fastify apps that boot and health-check. No routing, auth,
> registry, or gateway yet — those are M1–M4.

## Layout

```
apps/
  edge/      # azx-edge — data plane (Fastify). Hard rule: dependency-minimal.
  portal/    # azx-portal — control plane (Fastify; Prisma lands in M1)
packages/
  shared/    # @helix/shared — zod schemas: visibility, app, version, manifest
.devcontainer/   # VS Code dev container; also runs Postgres 18 + Azurite
```

`apps/portal-web`, `packages/cli`, `packages/deploy-skill`, and `infra/` are in the
target layout (project plan §2) but land in later milestones.

## Prerequisites

Open the repo in the dev container (VS Code: _Reopen in Container_). It provides Node
24, pnpm, and the `db` (Postgres) + `azurite` (Blob) services, with `DATABASE_URL` and
`AZURE_STORAGE_CONNECTION_STRING` already in the environment. `pnpm install` runs on
create.

## Commands (from the repo root)

| Command                             | What                                     |
| ----------------------------------- | ---------------------------------------- |
| `pnpm install`                      | Install all workspace deps               |
| `pnpm typecheck`                    | `tsc` across every package               |
| `pnpm lint`                         | ESLint (flat config + typescript-eslint) |
| `pnpm format` / `pnpm format:check` | Prettier write / verify                  |
| `pnpm test`                         | Vitest across the workspace              |
| `pnpm dev:edge`                     | Run azx-edge (`:8080`, `GET /health`)    |
| `pnpm dev:portal`                   | Run azx-portal (`:3001`, `GET /health`)  |

## Conventions

- **TypeScript everywhere, ESM, Node LTS.** Strict `tsconfig.base.json`, extended per package.
- **Versions via the pnpm catalog** in `pnpm-workspace.yaml` — bump in one place.
- **zod at every boundary** (`@helix/shared`); inferred types travel with the schemas.
- Adding a runtime dependency to `apps/edge` requires justification at review time
  (project plan §6) — it is code inside the trusted path.
