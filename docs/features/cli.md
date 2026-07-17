# `azx` CLI

**What it is.** `azx` (`packages/cli`, `@azx-pbc/cli`) is a **per-app** deploy CLI — you run it
from inside an app's directory, like `git` or `vercel`. It reads that app's `azx.json`, zips the
build output, uploads it to the portal as a new version, and manages the live pointer. M3 added
browser sign-in via the OIDC device flow. Full reference: [`packages/cli/README.md`](../../packages/cli/README.md).

## How it works

### Configuration resolution

Each setting resolves **flags → environment → `azx.json` → default** (first match wins),
handled in `packages/cli/src/config.ts` / `args.ts`:

| Setting | Flag | Env | `azx.json` | Default |
| --- | --- | --- | --- | --- |
| slug | `--slug` | — | `slug` | _(required)_ |
| portal URL | `--portal-url` | `AZX_PORTAL_URL` | `portalUrl` | `http://localhost:3001` |
| build dir | `--dir` | — | `dir` | `dist` |
| token | `--token` | `AZX_TOKEN` | — | _(`azx login` cache)_ |

### Commands (`packages/cli/src/commands.ts`)

```
azx login | logout | whoami
azx create   [--display-name <name>] [--visibility <v>]   # v = private | group:<id> | password | public
azx deploy   [--dir <dir>] [--bundle <zip>] [--promote]    # upload a preview; --promote flips it live
azx versions | promote <number> | rollback [number]
```

`deploy` zips the build dir (`packages/cli/src/zip.ts`) and POSTs it to the portal version
endpoint; `--promote` flips the live pointer in the same step (architecture §5.1). The HTTP
calls live in `packages/cli/src/client.ts`.

### Auth (M3 — `packages/cli/src/auth/`)

Two paths, in precedence order:

1. **Static token** — `AZX_TOKEN` / `--token` is sent as a bearer token verbatim. The CI/scripts
   path; also how the portal's dev-token stub keeps working (`AZX_TOKEN=$PORTAL_DEV_TOKEN`). Never
   accepted by a production portal.
2. **`azx login`** — the **OIDC device flow** (RFC 8628, `deviceFlow.ts` over `openid-client`).
   The CLI asks the portal `GET /api/v1/auth/config` which issuer/client to use, prints a
   verification URL + code, and polls while you approve in a browser.

`session.ts` chains the static token over the device-flow cache. `tokenStore.ts` is an
XDG-compliant cache at `~/.config/azx/tokens.json` (mode 0600), **bound by portal origin +
issuer** so a token can't be replayed across portals, with silent refresh-token renewal (and a
v1→v2 migration from the older issuer-only keying). On a 401 nothing auto-launches — agents run
headless; the error tells you to run `azx login`.

Tests: `deviceFlow.integration.test.ts`, `tokenStore.test.ts`, `session.test.ts`, driven against
an ephemeral dev-idp (see [dev-idp.md](./dev-idp.md)).

## Design notes (why)

- **Per-app, not a monolithic dashboard tool** — `azx` reads the app's own `azx.json` from the
  cwd, like `git`/`vercel`, so the deploy command is the same from any app directory.
- **Static token vs interactive login, in that precedence** — `AZX_TOKEN` keeps CI and scripts
  zero-prompt and lets the portal's dev-token stub keep working; everyone else uses the device flow.
  Either way the portal verifies the bearer statelessly over JWKS.
- **Token cache bound by portal origin + issuer** — a cached token can't be replayed against a
  different portal, and the v1→v2 migration re-keys older issuer-only caches without a re-login.
- **Headless-safe on 401** — nothing auto-launches a browser; the error tells you to `azx login`,
  so agents and CI fail loudly instead of hanging on an interactive prompt.

## Planned / not yet built

- **Not published yet** — run via `tsx`: `node --import tsx <repo>/packages/cli/src/bin.ts <cmd>`
  from the app directory, or alias it. `npm i -g @azx-pbc/cli` is a later milestone.
- Production login points `azx login` at Entra instead of the local issuer (config-only).
