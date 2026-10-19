# `helix` CLI

> **Related ADRs:** [ADR-0024](../adr/0024-portal-cli-bearer-jwt-jwks.md) (portal/CLI JWT) · [ADR-0018](../adr/0018-deploy-model-immutable-versions.md) (immutable versions).

Run `helix` from an app's directory. It reads `helix.json`, packages the build
output, uploads a version, and supports promotion and rollback. Sign in with
`helix login` using the OIDC device flow. The CLI lives in `packages/cli` and is
published as `@azx-pbc/helix-cli`; see its
[reference](../../packages/cli/README.md).

## How it works

### Configuration resolution

Each setting resolves **flags → environment → `helix.json` → default** (first match wins),
handled in `packages/cli/src/config.ts` / `args.ts`:

| Setting | Flag | Env | `helix.json` | Default |
| --- | --- | --- | --- | --- |
| slug | `--slug` | — | `slug` | _(required)_ |
| portal URL | `--portal-url` | `HELIX_PORTAL_URL` | `portalUrl` | `http://localhost:3001` |
| build dir | `--dir` | — | `dir` | `dist` |
| token | `--token` | `HELIX_TOKEN` | — | _(`helix login` cache)_ |
| description | `--description` | — | `description` | — |

The default portal URL, `http://localhost:3001`, works only for local development.
For a deployed portal, set `portalUrl` in `helix.json` so login, create, deploy,
and promote use the same endpoint. **How to develop → On your machine** provides
a ready-to-copy file for this deployment, as does the
[agent skill](./onboarding.md).

### Commands (`packages/cli/src/commands.ts`)

```
helix login | logout | whoami
helix create   [--display-name <name>] [--description <text>] [--visibility <v>]   # v = internal | group:<id>[,<id>…] | password | public
helix deploy   [--dir <dir>] [--bundle <zip>] [--promote]    # upload a preview; --promote flips it live
helix versions | promote <number> | rollback [number]
helix ci init [--repo <owner/name>] [--branch <b>] [--reusable] [--force] | ci show | ci remove
```

`create` resolves the description from the flag or `helix.json` (flag wins) and
sends it only when set — an older portal never sees a key it doesn't know, so a
new CLI against an old portal degrades to no description rather than failing.

`deploy` zips the build dir (`packages/cli/src/zip.ts`) and POSTs it to the portal version
endpoint; `--promote` flips the live pointer in the same step (architecture §5.1). The HTTP
calls live in `packages/cli/src/client.ts`.

In GitHub Actions, with no static token and with `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` set,
`deploy` requests a GitHub OIDC token for `repoDeploy.audience` from `GET /api/v1/config` and
uploads to the CI route instead (`auth/githubActions.ts`, ADR-0051). `--promote` is refused on that
path. `ci init` (`ci/commands.ts`) binds the app through `PUT /api/v1/apps/:slug/repo-binding`
before writing anything, then writes `helix.json` and `.github/workflows/helix-deploy.yml` (a
starter, or a caller of the reusable workflow in `integrations/helix-actions/` with `--reusable`,
which also pins the binding to it). Generated workflows pin `@azx-pbc/helix-cli` to the CLI version
that wrote them; `scripts/build.mjs` stamps it in.

### Auth (M3 — `packages/cli/src/auth/`)

Two paths, in precedence order:

1. **Static token** — `HELIX_TOKEN` / `--token` is sent as a bearer token verbatim. The local scripts
   path; also how the portal's dev-token stub keeps working (`HELIX_TOKEN=$PORTAL_DEV_TOKEN`), which a
   production portal never accepts. Not a supported way to deploy from CI: repo-backed deploys use
   the workflow's GitHub Actions OIDC token (ADR-0051).
2. **`helix login`** — the **OIDC device flow** (RFC 8628, `deviceFlow.ts` over `openid-client`).
   The CLI asks the portal `GET /api/v1/auth/config` which issuer/client to use, prints a
   verification URL + code, and polls while you approve in a browser.

`session.ts` chains the static token over the device-flow cache. `tokenStore.ts` is an
XDG-compliant cache at `~/.config/helix/tokens.json` (mode 0600), **bound by portal origin +
issuer** so a token can't be replayed across portals, with silent refresh-token renewal (and a
v1→v2 migration from the older issuer-only keying). On a 401 nothing auto-launches — agents run
headless; the error tells you to run `helix login`.

Tests: `deviceFlow.integration.test.ts`, `tokenStore.test.ts`, `session.test.ts`, driven against
an ephemeral dev-idp (see [dev-idp.md](./dev-idp.md)).

### Distribution (`.github/workflows/release-cli.yml`)

Published to public npm as `@azx-pbc/helix-cli` — `npm i -g @azx-pbc/helix-cli`, Node 24+.
Releases are cut by a **`cli-v*`** tag (not `v*`, which is the platform's version and drives the
image builds), and published from CI by **npm trusted publishing** (OIDC, `id-token: write`) with
provenance — there is no `NPM_TOKEN` in the repo. The workflow packs with `pnpm` (the only client
that rewrites `catalog:`/`workspace:*` into real ranges), asserts the tarball, globally installs it
with `tsx` off `PATH`, and only then publishes those exact bytes with `npm`. Version `0.0.0` is a
deprecated placeholder: npm requires a package to exist before a trusted publisher can be attached
to it. Details in [`packages/cli/README.md`](../../packages/cli/README.md#releasing);
rationale in [ADR-0032](../adr/0032-cli-naming-and-distribution.md).

## Design notes (why)

- **Per-app, not a monolithic dashboard tool** — `helix` reads the app's own `helix.json` from the
  cwd, like `git`/`vercel`, so the deploy command is the same from any app directory.
- **Static token vs interactive login, in that precedence** — `HELIX_TOKEN` keeps local scripts
  zero-prompt and lets the portal's dev-token stub keep working; everyone else uses the device flow.
  Either way the portal verifies the bearer statelessly over JWKS.
- **Token cache bound by portal origin + issuer** — a cached token can't be replayed against a
  different portal, and the v1→v2 migration re-keys older issuer-only caches without a re-login.
- **Headless-safe on 401** — nothing auto-launches a browser; the error tells you to `helix login`,
  so agents and CI fail loudly instead of hanging on an interactive prompt.

## Planned / not yet built

- Production login points `helix login` at Entra instead of the local issuer (config-only).
- **Drop the `AZX_*` / `azx.json` dual-read.** ADR-0032 calls it transition scaffolding to remove
  at the first minor version after publishing; publishing is what started that clock.
