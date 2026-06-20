# Helix — AZX App Platform

Secure hosting for vibe-coded AI apps. **New here? Start with [`TOUR.md`](./TOUR.md)** — the
high-level map. Then: [`docs/features/`](./docs/features/) for per-feature docs (the _what &
how, today_), [`docs/platform-architecture.md`](./docs/platform-architecture.md) (the _what &
why_), and [`docs/platform-project-plan.md`](./docs/platform-project-plan.md) (the _with what &
in what order_). The whole design rests on one stance — **every hosted app is untrusted code** —
and contains the blast radius per app instead of trying to verify it.

> **Status: M4.5 (local) — Egress & Connections.** Registry + deploys (portal API + `azx` CLI),
> edge serving on `*.localtest.me`, the §4.2 / Appendix A auth flow against a **local OIDC
> issuer** (central callback, one-time handoff token, `__Host-session` cookies, server-side
> sessions, group visibility, silent refresh, password/public modes, `/_api/me`; portal/CLI
> bearer JWTs), the `/_api/*` **gateway** (LLM proxy `/_api/llm/chat`, app-data `/_api/data/*` —
> user / collection / shared — with a metering ledger and the Postgres role split), an enforced
> capability **approval** workflow, **plus the `azx-egress` mechanism plane**: the fetch-proxy
> (`/_api/fetch/<url>` + an opt-in transparent fetch/XHR shim) and secret-backed connections,
> built as a third container from day one. A real Entra registration (M3 tail) and the Azure
> deploy (M5) are next.

## Layout

```
apps/
  edge/        # azx-edge — data/policy plane (Fastify). Hard rule: dependency-minimal.
  portal/      # azx-portal — control plane (Fastify + Prisma). Owns the schema.
  portal-web/  # the portal SPA (Vite + React 19 + Mantine + TanStack Query)
  egress/      # azx-egress — mechanism plane: outbound HTTP + secret injection + SSRF
  dev-idp/     # local OIDC issuer (oidc-provider). Dev only, never deployed.
packages/
  shared/        # @helix/shared — zod schemas: visibility, app, version, manifest, auth, llm, data, usage, instruction
  secret-store/  # @helix/secret-store — seal/open/destroy seam (dev envelope / prod Key Vault)
  cli/           # azx — the deploy CLI (azx login / deploy / promote / …)
examples/      # reference apps to `azx deploy` (hello-world, notes, chatbot, waitlist, github-stars, fetch-proxy); built dist/ committed
docs/          # TOUR is at repo root; here: platform-architecture, project-plan, phase-1-user-stories, features/, design/
.devcontainer/ # VS Code dev container; also runs Postgres 18 + Azurite
```

`packages/deploy-skill` and `infra/` are in the target layout (project plan §2) but land in
later milestones.

## Prerequisites

Open the repo in the **dev container** (VS Code: _Reopen in Container_). It provides Node 24,
pnpm, and the `db` (Postgres) + `azurite` (Blob) services, with `DATABASE_URL`,
`AZURE_STORAGE_CONNECTION_STRING`, the M3 auth env (`EDGE_OIDC_*`, `EDGE_AUTH_SECRET`,
`PORTAL_OIDC_*`, `EDGE_TLS_*`), and the egress env (`HELIX_INSTRUCTION_SECRET` for the
edge↔egress attested instruction) already set. `pnpm install` runs on create, and post-create
generates a mkcert wildcard cert for `*.localtest.me` into `.devcontainer/certs/` (gitignored),
the dev secret-store KEK, and the `helix_egress` DB role.

### The platform is HTTPS-only

There is no plain-HTTP mode, even locally. `__Host-` session cookies require `Secure`, and
hosted apps' crypto APIs (`crypto.randomUUID`, SubtleCrypto) only exist in a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) — so
the edge **refuses to boot in dev without TLS**. The dev container terminates TLS itself with
mkcert; production terminates at ingress. The one-time cost: your **host browser will warn on
the self-signed cert** the first time you open an app — accept it (or import
`.devcontainer/certs/caroot/rootCA.pem` into your OS/browser trust store to silence it). Node
processes inside the container already trust the CA via `NODE_EXTRA_CA_CERTS`.

## Local dev: the processes

```bash
pnpm dev:idp      # :3002 — local OIDC issuer (apps/dev-idp). Fixture users below.
pnpm dev:portal   # :3001 — registry + deploy API
pnpm dev:edge     # :8080 — HTTPS. Apps at https://<slug>.localtest.me:8080,
                  #         login on https://auth.localtest.me:8080
pnpm dev:egress   # :8081 — mechanism plane (fetch-proxy + secret injection).
                  #         Only needed when exercising /_api/fetch or connections.
```

`*.localtest.me` resolves to `127.0.0.1`, so app subdomains and the auth host work with no
`/etc/hosts` edits. Fixture identities at the IdP (pick one on the login page):

| User              | Groups                        |
| ----------------- | ----------------------------- |
| `alice@azx.dev`   | `eng-team`, `platform-admins` |
| `bob@azx.dev`     | `eng-team`                    |
| `mallory@azx.dev` | _none_ (for group-denial)     |

The dev container sets `EDGE_DEV_ALLOW_UNAUTHENTICATED=true`, which skips the **session gate**
(handy while iterating on an app) but not TLS — apps still serve over HTTPS. To exercise the
real login flow, run the edge with that flag cleared:

```bash
EDGE_DEV_ALLOW_UNAUTHENTICATED= pnpm dev:edge
```

## Deploy an app and log in

```bash
# 1. Sign the CLI in (OIDC device flow against the dev IdP). Or export
#    AZX_TOKEN=$PORTAL_DEV_TOKEN to use the static dev token instead.
cd examples/notes
node --import tsx ../../packages/cli/src/bin.ts login     # prints a URL + code; pick alice

# 2. Register + deploy + promote (slug/dir come from azx.json):
node --import tsx ../../packages/cli/src/bin.ts create
node --import tsx ../../packages/cli/src/bin.ts deploy --promote

# 3. Open it (accept the cert warning the first time):
open https://notes.localtest.me:8080/
```

With the gate on (no bypass), an unauthenticated visit 302s to the login page; pick a fixture
user and you land back on the app with a host-scoped session. `GET /_api/me` returns the
signed-in user. See [`apps/edge/README.md`](./apps/edge/README.md) for the request flow and
config, [`apps/dev-idp/README.md`](./apps/dev-idp/README.md) for the IdP, and
[`packages/cli/README.md`](./packages/cli/README.md) for the CLI and its auth.

## Commands (from the repo root)

| Command                     | What                                             |
| --------------------------- | ------------------------------------------------ |
| `pnpm install`              | Install all workspace deps                       |
| `pnpm typecheck`            | `tsc` across every package                       |
| `pnpm lint` / `pnpm format` | ESLint / Prettier                                |
| `pnpm test`                 | Vitest across the workspace                      |
| `pnpm dev:idp`              | Local OIDC issuer (`:3002`)                      |
| `pnpm dev:portal`           | azx-portal (`:3001`, registry + deploy API)      |
| `pnpm dev:edge`             | azx-edge (`:8080`, HTTPS)                        |
| `pnpm dev:egress`           | azx-egress (`:8081`, fetch-proxy + secrets)      |
| `pnpm dev:web`              | portal SPA (`:5173`, proxies `/api` to :3001)    |
| `./check-and-lint.sh`       | Poor-man's CI: typecheck + lint + format + tests |

## Conventions

- **TypeScript everywhere, ESM, Node 24.** Strict `tsconfig.base.json`, extended per package.
- **Versions via the pnpm catalog** in `pnpm-workspace.yaml` — bump in one place.
- **zod at every boundary** (`@helix/shared`); inferred types travel with the schemas.
- Adding a runtime dependency to `apps/edge` requires justification at review time
  (project plan §6) — it is code inside the trusted path.
- **M3 auth code gets adversarial tests with it, not after.** The OIDC handoff is the most
  security-sensitive path in the platform (`apps/edge/src/auth/adversarial.test.ts`).
