# `helix` CLI

> **Related ADRs:** [ADR-0024](../adr/0024-portal-cli-bearer-jwt-jwks.md) (portal/CLI JWT) · [ADR-0018](../adr/0018-deploy-model-immutable-versions.md) (immutable versions).

**What it is.** `helix` (`packages/cli`, `@azx-pbc/helix-cli`) is a **per-app** deploy CLI — you run it
from inside an app's directory, like `git` or `vercel`. It reads that app's `helix.json`, zips the
build output, uploads it to the portal as a new version, and manages the live pointer. M3 added
browser sign-in via the OIDC device flow. Full reference: [`packages/cli/README.md`](../../packages/cli/README.md).

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

The portal URL is the one setting whose default is a trap: `http://localhost:3001`
is right only for a portal on the same machine, and nothing about the failure says
so. Against a deployed portal it must be set — as `portalUrl` in `helix.json` for
anything persistent, since `login`, `create`, `deploy` and `promote` all resolve it
the same way. The portal's **How to develop → On your machine** tab prints that
file with this deployment's URL already in it, and so does the agent skill
([onboarding.md](./onboarding.md)).

### Commands (`packages/cli/src/commands.ts`)

```
helix login | logout | whoami
helix create   [--display-name <name>] [--visibility <v>]   # v = internal | group:<id>[,<id>…] | password | public
helix deploy   [--dir <dir>] [--bundle <zip>] [--promote]    # upload a preview; --promote flips it live
helix versions | promote <number> | rollback [number]
```

`deploy` zips the build dir (`packages/cli/src/zip.ts`) and POSTs it to the portal version
endpoint; `--promote` flips the live pointer in the same step (architecture §5.1). The HTTP
calls live in `packages/cli/src/client.ts`.

### Auth (M3 — `packages/cli/src/auth/`)

Two paths, in precedence order:

1. **Static token** — `HELIX_TOKEN` / `--token` is sent as a bearer token verbatim. The CI/scripts
   path; also how the portal's dev-token stub keeps working (`HELIX_TOKEN=$PORTAL_DEV_TOKEN`). Never
   accepted by a production portal.
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
- **Static token vs interactive login, in that precedence** — `HELIX_TOKEN` keeps CI and scripts
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
