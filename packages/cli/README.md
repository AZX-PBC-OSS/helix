# `helix` — Helix deploy CLI

`helix` is a **per-app CLI**, like `git` or `vercel`: you run it **from inside an
app's directory**. It reads that app's `helix.json`, zips the build output, uploads
it to the portal as a new version, and manages the live pointer.

## The mental model

```
my-app/
  helix.json        ← helix reads this from the current working directory
  dist/           ← the folder helix zips and uploads (configurable)
```

Everything keys off the **current working directory**. `cd` into your app, then
run `helix <command>`. There is no "select an app" flag you normally need — the app
is wherever you're standing.

## Configuration

Each setting is resolved **flags → environment → `helix.json` → built-in default**
(first match wins):

| Setting    | Flag           | Env                | `helix.json` key | Default                    |
| ---------- | -------------- | ------------------ | ---------------- | -------------------------- |
| App slug   | `--slug`       | —                  | `slug`           | _(required)_               |
| Portal URL | `--portal-url` | `HELIX_PORTAL_URL` | `portalUrl`      | `http://localhost:3001`    |
| Build dir  | `--dir`        | —                  | `dir`            | `dist`                     |
| Auth token | `--token`      | `HELIX_TOKEN`      | —                | _(`helix login` if unset)_ |

A minimal `helix.json` is just:

```json
{ "slug": "my-app" }
```

`--dir` is resolved **relative to the current working directory**, and so is
`helix.json` — another reason to run `helix` from the app directory.

## Commands

```
helix login                                                   # browser sign-in (OIDC device flow)
helix logout                                                  # forget the cached tokens
helix whoami                                                  # who the portal thinks you are
helix create   [--display-name <name>] [--visibility <v>]   # register the app
helix deploy   [--dir <dir>] [--bundle <zip>] [--promote]    # upload a version
helix versions                                               # list versions
helix promote  <number>                                      # make a version live
helix rollback [number]                                      # revert the live pointer
```

`deploy` uploads the bundle as a **preview**; `--promote` flips it live in the
same step (architecture §5.1). `visibility` is `private | group:<id> | password
| public`.

## Authentication (M3)

Two paths, in precedence order:

1. **Static token** — `HELIX_TOKEN` / `--token`. Sends the value as a bearer
   token verbatim. This is the CI/scripts path, and also how the portal's
   dev-token stub keeps working (`HELIX_TOKEN=$PORTAL_DEV_TOKEN`). It is never
   accepted by a production portal.
2. **`helix login`** — the OIDC device flow. The CLI asks the portal
   (`GET /api/v1/auth/config`) which issuer to use (the local dev IdP on
   `:3002` in dev; Entra later), prints a verification URL + code, and polls
   while you approve in a browser. Tokens land in
   `~/.config/helix/tokens.json` (mode 0600, keyed by issuer) and are silently
   renewed with the refresh token. On 401, nothing is auto-launched — agents
   run headless; the error says to run `helix login`.

## Running it

### Installed from npm

```bash
npm i -g @azx-pbc/helix-cli
cd my-app
export HELIX_TOKEN="…"
helix deploy --promote
```

Needs **Node 24+** — the bundle is emitted at that target, so older runtimes
may not merely warn, they may fail to parse it.

`0.0.0` is a deprecated placeholder that exists only because npm requires a
package to exist before a trusted publisher can be attached to it. Every real
version is `0.1.0` or later and carries a provenance attestation.

### From this monorepo today

Build the real binary once and link it; from then on `helix` behaves exactly as
it will when installed from npm:

```bash
pnpm --filter @azx-pbc/helix-cli build
npm link ./packages/cli          # puts `helix` on your PATH

cd examples/hello-world
export HELIX_TOKEN="$PORTAL_DEV_TOKEN"          # the portal's dev-token stub
helix create --display-name "Hello World"
helix deploy --promote
helix versions
```

Run it **from your app directory** so `helix.json` and a relative `--dir`
resolve against the app, not the repo.

Without linking, `node packages/cli/dist/helix.js <cmd>` works the same way. To
skip the build during CLI development, `node --import tsx packages/cli/src/bin.ts <cmd>`
runs straight from source.

## About `pnpm --filter @azx-pbc/helix-cli helix -- <cmd>`

This form runs the CLI's dev script through pnpm. It works for flags now (the
CLI strips the `--` that pnpm forwards — see `src/args.ts`), **but pnpm runs the
script in `packages/cli`, not your app**. So it will not find your app's
`helix.json`, and a relative `--dir` resolves against `packages/cli`. Use it only
for `--help` or with explicit `--slug` + an absolute `--dir`:

```bash
pnpm --filter @azx-pbc/helix-cli helix -- deploy --slug my-app \
  --dir /abs/path/to/my-app/dist --promote
```

For real deploys, prefer running from the app directory (`npm link`, above).

## Packaging

This is the **only package in the repo that emits JS**. Everything else runs
from TypeScript source via `tsx` and is `private: true`; a published CLI can't.

`pnpm build` runs `scripts/build.mjs`, which esbuild-bundles `src/bin.ts` into a
single `dist/helix.js` with a `#!/usr/bin/env node` banner. Two things make that
the right shape rather than a `tsc --outDir`:

- **`@azx-pbc/shared` gets inlined.** It's a private `workspace:*` package whose
  `exports` point straight at `./src/index.ts`, and the edge/portal/egress all
  consume it as raw TS deliberately. Publishing must not force a build+dist+d.ts
  onto `shared` for one consumer, and must not ship a manifest depending on
  `@azx-pbc/shared@0.0.0` — a version no registry has. Bundling solves both, so
  `shared` is a **devDependency** here, not a dependency.
- **No tsx at runtime.** The `bin` used to point at `src/bin.ts` behind a
  `#!/usr/bin/env -S tsx` shebang while `tsx` was only a devDependency, so a real
  global install would have been broken on arrival.

`archiver`, `openid-client`, and `zod` stay external and install from the
registry — bundling archiver's transitive tree buys nothing.

CI's `package` job builds, runs `pnpm pack`, asserts the tarball ships `dist/`
and no `src/`, then globally installs the tarball in a clean prefix **with tsx
off `PATH`** and runs `helix --help`. That last step is what actually proves
publishability; the unit tests never touch the bundle. It runs on every PR, so
a broken artifact fails before a release is ever cut.

## Releasing

Releases are cut by tag and published by
[`.github/workflows/release-cli.yml`](../../.github/workflows/release-cli.yml):

```bash
cd packages/cli
npm version patch                       # or minor — edits package.json only
cd ../.. && git commit -am "release(cli): v0.1.1"
git tag cli-v0.1.1 && git push && git push --tags
```

The workflow re-runs the whole build → pack → assert → global-install sequence
against the tag, refuses to publish if the tag and `package.json` disagree, and
then publishes with provenance.

Three things to know before touching it:

- **The tag prefix is `cli-v`, not `v`.** `v*` is the platform's version and
  already drives the container-image builds in `ci.yml`. The CLI versions
  independently.
- **There is no `NPM_TOKEN`.** Auth is npm trusted publishing (OIDC): npmjs.com
  has a registered trust relationship with `AZX-PBC-OSS/helix` +
  `release-cli.yml`. Renaming or moving that workflow file breaks publishing
  until the registration is updated — that narrowness is the point.
- **It packs with pnpm and publishes with npm.** Only pnpm rewrites `catalog:`
  and `workspace:*` into real ranges; npm is the client whose OIDC support is
  documented and reliable. Each does the half it's good at.

See [ADR-0032](../../docs/adr/0032-cli-naming-and-distribution.md) for why
public npm rather than GitHub Packages.
