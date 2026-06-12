# `azx` — Helix deploy CLI

`azx` is a **per-app CLI**, like `git` or `vercel`: you run it **from inside an
app's directory**. It reads that app's `azx.json`, zips the build output, uploads
it to the portal as a new version, and manages the live pointer.

## The mental model

```
my-app/
  azx.json        ← azx reads this from the current working directory
  dist/           ← the folder azx zips and uploads (configurable)
```

Everything keys off the **current working directory**. `cd` into your app, then
run `azx <command>`. There is no "select an app" flag you normally need — the app
is wherever you're standing.

## Configuration

Each setting is resolved **flags → environment → `azx.json` → built-in default**
(first match wins):

| Setting    | Flag           | Env              | `azx.json` key | Default                  |
| ---------- | -------------- | ---------------- | -------------- | ------------------------ |
| App slug   | `--slug`       | —                | `slug`         | _(required)_             |
| Portal URL | `--portal-url` | `AZX_PORTAL_URL` | `portalUrl`    | `http://localhost:3001`  |
| Build dir  | `--dir`        | —                | `dir`          | `dist`                   |
| Auth token | `--token`      | `AZX_TOKEN`      | —              | _(`azx login` if unset)_ |

A minimal `azx.json` is just:

```json
{ "slug": "my-app" }
```

`--dir` is resolved **relative to the current working directory**, and so is
`azx.json` — another reason to run `azx` from the app directory.

## Commands

```
azx login                                                   # browser sign-in (OIDC device flow)
azx logout                                                  # forget the cached tokens
azx whoami                                                  # who the portal thinks you are
azx create   [--display-name <name>] [--visibility <v>]   # register the app
azx deploy   [--dir <dir>] [--bundle <zip>] [--promote]    # upload a version
azx versions                                               # list versions
azx promote  <number>                                      # make a version live
azx rollback [number]                                      # revert the live pointer
```

`deploy` uploads the bundle as a **preview**; `--promote` flips it live in the
same step (architecture §5.1). `visibility` is `private | group:<id> | password
| public`.

## Authentication (M3)

Two paths, in precedence order:

1. **Static token** — `AZX_TOKEN` / `--token`. Sends the value as a bearer
   token verbatim. This is the CI/scripts path, and also how the portal's
   dev-token stub keeps working (`AZX_TOKEN=$PORTAL_DEV_TOKEN`). It is never
   accepted by a production portal.
2. **`azx login`** — the OIDC device flow. The CLI asks the portal
   (`GET /api/v1/auth/config`) which issuer to use (the local dev IdP on
   `:3002` in dev; Entra later), prints a verification URL + code, and polls
   while you approve in a browser. Tokens land in
   `~/.config/azx/tokens.json` (mode 0600, keyed by issuer) and are silently
   renewed with the refresh token. On 401, nothing is auto-launched — agents
   run headless; the error says to run `azx login`.

## Running it

### Once published (later milestone)

```bash
npm i -g @helix/cli
cd my-app
export AZX_TOKEN="…"
azx deploy --promote
```

### From this monorepo today (not yet published)

The package isn't published, so there's no global `azx` binary. Run the dev
entrypoint with `tsx`, **from your app directory** so `azx.json` and `--dir`
resolve correctly:

```bash
cd examples/hello-world
export AZX_TOKEN="$PORTAL_DEV_TOKEN"          # the portal's dev-token stub
node --import tsx /path/to/repo/packages/cli/src/bin.ts deploy --promote
```

For less typing, alias it once (from the repo root) and then use `azx` like the
real thing:

```bash
alias azx="node --import tsx $PWD/packages/cli/src/bin.ts"

cd examples/hello-world
azx create --display-name "Hello World"
azx deploy --promote
azx versions
```

## About `pnpm --filter @helix/cli azx -- <cmd>`

This form runs the CLI's dev script through pnpm. It works for flags now (the
CLI strips the `--` that pnpm forwards — see `src/args.ts`), **but pnpm runs the
script in `packages/cli`, not your app**. So it will not find your app's
`azx.json`, and a relative `--dir` resolves against `packages/cli`. Use it only
for `--help` or with explicit `--slug` + an absolute `--dir`:

```bash
pnpm --filter @helix/cli azx -- deploy --slug my-app \
  --dir /abs/path/to/my-app/dist --promote
```

For real deploys, prefer running from the app directory (the alias above).
