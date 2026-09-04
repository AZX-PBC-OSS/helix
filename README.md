# Helix — AZX App Platform

> ⚠️ **Alpha — not yet suitable for public consumption.** Helix is under active
> development. Interfaces, data formats, and security posture are still changing,
> there is no stability or support guarantee, and it has not been hardened for
> production or third-party use. Use at your own risk.

Secure hosting for vibe-coded AI apps. **New here? Start with [`TOUR.md`](./TOUR.md)** — the
high-level map for someone about to read the code, or
[`docs/OVERVIEW.md`](./docs/OVERVIEW.md) for the problem, architecture, and security model in
one file without the repo. Then: [`docs/features/`](./docs/features/) for per-feature docs (the
_what & how, today_), [`docs/platform-architecture.md`](./docs/platform-architecture.md) (the
_what & why_), and [`docs/platform-project-plan.md`](./docs/platform-project-plan.md) (the _with
what & in what order_) — [`docs/README.md`](./docs/README.md) maps the rest. The whole design rests on one stance — **every hosted app is untrusted code** —
and contains the blast radius per app instead of trying to verify it.

> **Status: deployed on Azure (M5); feature set M4.5 — Egress & Connections.** Running in
> production on Container Apps — three planes, real Entra OIDC, wildcard TLS, a live Key Vault
> — and still fully runnable on a laptop, with `apps/dev-idp` standing in for Entra and an AES-GCM
> envelope for Key Vault. Shipped: registry + deploys (portal API, `helix` CLI, and
> drag-and-drop upload in the SPA), edge serving, the §4.2 / Appendix A auth flow (central
> callback, one-time handoff token, `__Host-session` cookies, server-side sessions, group
> visibility, silent refresh, password/public modes, `/_api/me`; portal/CLI bearer JWTs), the
> `/_api/*` **gateway** — LLM (`/_api/llm/chat`, plus an OpenAI-compatible
> `/_api/openai/v1/*` surface and structured output), app-data (`/_api/data/*`: user /
> collection / shared), and the fetch-proxy (`/_api/fetch/<url>` + an opt-in transparent
> fetch/XHR shim) — all metered against a ledger over the Postgres role split, an enforced
> capability **approval** workflow, secret-backed connections through the **`helix-egress`**
> mechanism plane (its own container from day one), the platform-authored **offline** service
> worker, and **dev mode** for building an app against an isolated `env=dev` tier. Outstanding
> from M5: a real pilot app end to end, and confirming the egress firewall is on in the live
> deployments (project plan §4).

## Layout

```
apps/
  edge/        # helix-edge — data/policy plane (Fastify). Hard rule: dependency-minimal.
  portal/      # helix-portal — control plane (Fastify + Prisma). Owns the schema.
  portal-web/  # the portal SPA (Vite + React 19 + Mantine + TanStack Query)
  egress/      # helix-egress — mechanism plane: outbound HTTP + secret injection + SSRF
  dev-idp/     # local OIDC issuer (oidc-provider). Dev only, never deployed.
  certbot/     # scheduled ACA job: wildcard TLS via DNS-01 (deployment only, no local role)
packages/
  shared/        # @azx-pbc/shared — zod schemas: visibility, app, version, manifest, auth, llm, data, usage, instruction
  secret-store/  # @azx-pbc/secret-store — seal/open/destroy seam (dev envelope / prod Key Vault)
  cli/           # helix — the deploy CLI (login / deploy / promote / …), published to npm
  deploy-skill/  # SKILL.md — the agent skill for building apps on Helix
examples/      # reference apps to `helix deploy` (hello-world, notes, chatbot, waitlist, github-stars, fetch-proxy, offline); built dist/ committed
docs/          # TOUR is at repo root; here: OVERVIEW, platform-architecture, project-plan, adr/, features/, design/, runbooks/, reviews/ (see docs/README.md)
infra/azure/   # Bicep — the deployed Azure topology (source of truth; see its README)
.devcontainer/ # VS Code dev container; also runs Postgres 18 + Azurite
```

## Prerequisites

Open the repo in the **dev container** (VS Code: _Reopen in Container_). It provides Node 24,
pnpm, and the `db` (Postgres 18) + `azurite` (Blob) services, with `DATABASE_URL` and the
per-role DSNs, `AZURE_STORAGE_CONNECTION_STRING`, the M3 auth env (`EDGE_OIDC_*`,
`EDGE_AUTH_SECRET`, `PORTAL_OIDC_*`, `EDGE_TLS_*`), the egress env
(`HELIX_INSTRUCTION_SECRET` for the edge↔egress attested instruction), and dev mode
(`EDGE_ALLOW_DEV_MODE`) already set. The least-privilege Postgres roles (`helix_portal`,
`helix_edge`, `helix_egress`, `helix_dev`) are created on first DB init by
`.devcontainer/db-init/`. `pnpm install` runs on create, and post-create generates a mkcert
wildcard cert for `*.local.helix.azxlabs.io` into `.devcontainer/certs/` (gitignored) plus the
dev secret-store KEK.

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
pnpm dev:portal   # :3001 — registry + deploy API (also serves the built SPA)
pnpm dev:edge     # :8080 — HTTPS. Apps at https://<slug>.local.helix.azxlabs.io:8080,
                  #         login on https://auth.local.helix.azxlabs.io:8080
pnpm dev:egress   # :8081 — mechanism plane (fetch-proxy + secret injection).
                  #         Needed for /_api/fetch, connections, and the LLM gateway.
pnpm dev:devgw    # :8082 — HTTPS. The dev-gateway: develop an app against its
                  #         isolated env=dev tier from a browser builder / localhost (see below).
pnpm dev:web      # :5173 — the SPA dev server (proxies /api + /health to :3001)
pnpm dev:clean    #         free any of those ports left held by a dead process
```

`*.local.helix.azxlabs.io` resolves to `127.0.0.1`, so app subdomains and the auth host work with no
`/etc/hosts` edits. Fixture identities at the IdP (pick one on the login page):

| User              | Groups                       |
| ----------------- | ---------------------------- |
| `alice@azx.dev`   | `eng-team`, `platform-admin` |
| `bob@azx.dev`     | `eng-team`                   |
| `mallory@azx.dev` | _none_ (for group-denial)    |

The dev container leaves `EDGE_DEV_ALLOW_UNAUTHENTICATED` **off**, so local dev mirrors reality:
app navigations 302 into the real SSO flow and the session-gated `/_api/*` gateway is exercisable
from the browser. To serve app content without logging in — debugging asset serving in isolation,
say — start the edge with the bypass on (it skips the **session gate** only, never TLS):

```bash
EDGE_DEV_ALLOW_UNAUTHENTICATED=true pnpm dev:edge
```

## Deploy an app and log in

Two paths, same registry. **From the portal SPA**: create the app, then drop a build folder or a
zip onto the deploy modal — it validates and salvages the bundle in the browser before upload.
**From the CLI** (`npm i -g @azx-pbc/helix-cli`, or run it out of the workspace as below), from
inside the app directory:

```bash
# 0. Run the CLI straight from the working tree, under the name it really has:
alias helix='node --import tsx /workspace/packages/cli/src/bin.ts'

# 1. Sign the CLI in (OIDC device flow against the dev IdP). Or export
#    HELIX_TOKEN=$PORTAL_DEV_TOKEN to use the static dev token instead.
cd examples/notes
helix login                 # prints a URL + code; pick alice

# 2. Register + deploy + promote (slug/dir come from helix.json):
helix create
helix deploy --promote

# 3. Open it (accept the cert warning the first time):
open https://notes.local.helix.azxlabs.io:8080/
```

`helix` is **cwd-driven** — it reads `helix.json`, and resolves `--dir`, from the directory you
are standing in, like `git`. That is why the alias above points at an absolute path, and why
`pnpm --filter @azx-pbc/helix-cli helix` is the one form to avoid for a real deploy: `--filter`
runs with the cwd inside `packages/cli`, where the app isn't.

The examples' `helix.json` deliberately omits `portalUrl` — a checked-in portal URL would be
wrong for every deployment but one — so the CLI falls back to `http://localhost:3001`, which is
right here and nowhere else. Against a deployed portal, set `portalUrl` (or `HELIX_PORTAL_URL`);
the portal prints the exact file to copy under **How to develop → On your machine**.

With the gate on (the default), an unauthenticated visit 302s to the login page; pick a fixture
user and you land back on the app with a host-scoped session. `GET /_api/me` returns the
signed-in user. To exercise the **LLM gateway** locally, run `pnpm dev:egress` and seed a
`platform`-scoped secret named `anthropic` (portal → Secrets) — the edge never holds a vendor
key, so the capability fails closed until egress can resolve one (ADR-0008).

See [`apps/edge/README.md`](./apps/edge/README.md) for the request flow and config,
[`apps/dev-idp/README.md`](./apps/dev-idp/README.md) for the IdP, and
[`packages/cli/README.md`](./packages/cli/README.md) for the CLI and its auth.

## Develop an app against Helix (dev mode)

The flow above _deploys_ a finished app. To iterate on an app that's still being written
elsewhere — on `localhost`, in a browser builder, in a cloud IDE — and have it call the real
platform (LLM, data, fetch) as you go, use **dev mode**: an isolated `env=dev` tier on the same
app, reached through the **dev-gateway** (`pnpm dev:devgw`, `:8082`). It never touches production
data, budget, or secrets, and promotion later moves _code_, never dev data.

```bash
# 1. Create the app (no code needed yet) and grant its capabilities in the portal.
# 2. In the portal "Dev mode" tab: register your app's origin (e.g. http://localhost:5173
#    or your builder's URL) and mint a dev token (shown once, azxdev_…). Configure any
#    env=dev connection secrets in the "Secrets" tab (Tier → dev).
# 3. From your in-development app, call the dev-gateway — same /_api/* shape as prod,
#    slug in the path, token as a bearer:
curl -k -X PUT https://dev-api.local.helix.azxlabs.io:8082/<slug>/_api/data/user/todo \
  -H "Authorization: Bearer azxdev_…" -H "Origin: http://localhost:5173" \
  -H "content-type: application/json" -d '["milk","eggs"]'
```

The full walkthrough (surfaces, isolation, and what's not yet built — `helix dev` and the client
SDK) is in [`docs/features/dev-mode.md`](./docs/features/dev-mode.md). The dev-gateway is
opt-in (`EDGE_ALLOW_DEV_MODE`, on in the dev container) and runs as the least-privilege
`helix_dev` role, so it physically can't read a production row.

## Commands (from the repo root)

| Command                                    | What                                               |
| ------------------------------------------ | -------------------------------------------------- |
| `pnpm install`                             | Install all workspace deps                         |
| `pnpm typecheck`                           | `tsc` across every package                         |
| `pnpm lint` / `pnpm format`                | ESLint / Prettier (`format:check` to verify only)  |
| `pnpm test`                                | Vitest across the workspace                        |
| `pnpm dev:idp`                             | Local OIDC issuer (`:3002`)                        |
| `pnpm dev:portal`                          | helix-portal (`:3001`, registry + deploy API)      |
| `pnpm dev:edge`                            | helix-edge (`:8080`, HTTPS)                        |
| `pnpm dev:egress`                          | helix-egress (`:8081`, fetch-proxy + secrets)      |
| `pnpm dev:devgw`                           | the dev-gateway (`:8082`, develop against env=dev) |
| `pnpm dev:web`                             | portal SPA (`:5173`, proxies `/api` to :3001)      |
| `pnpm dev:clean`                           | Free the dev ports (8080–8082, 3001, 3002, 5173)   |
| `pnpm --filter @azx-pbc/portal db:migrate` | Create/apply a Prisma migration (dev)              |
| `./check-and-lint.sh`                      | Poor-man's CI: typecheck + lint + format + tests   |

`./check-and-lint.sh` (add `--fix` to auto-fix first) is the same gate CI runs, and a change
isn't finished until it passes clean. CI invokes this same script, splitting it across two
jobs by naming steps (`./check-and-lint.sh typecheck lint format` and `… test`) — running it
bare locally covers both.

## Conventions

- **TypeScript everywhere, ESM, Node 24.** Strict `tsconfig.base.json`, extended per package.
- **Versions via the pnpm catalog** in `pnpm-workspace.yaml` — bump in one place.
- **zod at every boundary** (`@azx-pbc/shared`); inferred types travel with the schemas.
- Adding a runtime dependency to `apps/edge` requires justification at review time
  (project plan §6) — it is code inside the trusted path.
- **M3 auth code gets adversarial tests with it, not after.** The OIDC handoff is the most
  security-sensitive path in the platform (`apps/edge/src/auth/adversarial.test.ts`).
