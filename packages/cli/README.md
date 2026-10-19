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

| Setting     | Flag            | Env                | `helix.json` key | Default                    |
| ----------- | --------------- | ------------------ | ---------------- | -------------------------- |
| App slug    | `--slug`        | —                  | `slug`           | _(required)_               |
| Portal URL  | `--portal-url`  | `HELIX_PORTAL_URL` | `portalUrl`      | `http://localhost:3001`    |
| Build dir   | `--dir`         | —                  | `dir`            | `dist`                     |
| Auth token  | `--token`       | `HELIX_TOKEN`      | —                | _(`helix login` if unset)_ |
| Description | `--description` | —                  | `description`    | —                          |

A `helix.json` looks like:

```json
{
  "slug": "my-app",
  "dir": "dist",
  "portalUrl": "https://portal.example.com",
  "description": "Tracks Q3 cloud spend by team."
}
```

**`portalUrl` is the one you cannot leave to the default.** `http://localhost:3001`
is right only for a portal running on your own machine; against a deployed one,
set `portalUrl` (or `HELIX_PORTAL_URL`, or `--portal-url`) or every command —
starting with `helix login` — fails to connect to a portal that was never there.
Your portal prints the exact file to copy under **How to develop → On your
machine**. The file is the form worth checking in: `login`, `create`, `deploy`
and `promote` all resolve it the same way, so it is set once.

The repo's `examples/*/helix.json` deliberately omit it — a checked-in portal URL
would be wrong for every deployment but one — so to deploy an example, add
`portalUrl` to its file or export `HELIX_PORTAL_URL` first.

`--dir` is resolved **relative to the current working directory**, and so is
`helix.json` — another reason to run `helix` from the app directory.

## Commands

```
helix login                                                   # browser sign-in (OIDC device flow)
helix logout                                                  # forget the cached tokens
helix whoami                                                  # who the portal thinks you are
helix create   [--display-name <name>] [--description <text>] [--visibility <v>]   # register the app
helix deploy   [--dir <dir>] [--bundle <zip>] [--promote]    # upload a version
helix versions                                               # list versions
helix promote  <number>                                      # make a version live
helix rollback [number]                                      # revert the live pointer
helix capabilities [--json]                                  # what this deployment offers
helix skill    [--path <file>]                               # write this deployment's agent skill to disk
helix ci init  [--repo <owner/name>] [--branch <b>] [--reusable] [--force]   # deploy from GitHub Actions
helix ci show | helix ci remove                              # the app's repo binding
```

`deploy` uploads the bundle as a **preview**; `--promote` flips it live in the
same step (architecture §5.1). `visibility` is `internal | group:<id>[,<id>…] | password
| public`.

`helix capabilities` prints the deployment capability catalogue
(`GET /api/v1/capabilities`, ADR-0036) in readable form:

- servable models;
- approval baselines;
- named connections and OAuth providers;
- visibility modes;
- deploy caps;
- the dev gateway;
- which requests queue for an admin.

`--json` prints the raw catalogue. If the portal sends a shape this CLI can't
format, it prints the JSON instead of failing.

`helix skill` fetches this deployment's rendered agent skill (`GET /api/v1/skill`).
It is the same document the portal's **How to develop** modal hands out: this
deployment's hosts, plus pointers to `helix capabilities` and the public docs.

Neither command needs an app slug or `helix.json`, only a portal URL and a token.
`helix skill` writes `./SKILL.md` by default; `--path .claude/skills/helix/SKILL.md`
puts it where a Claude Code agent reads it from disk.

### Compatibility with the portal

Every command except `logout` first reads the public `GET /api/v1/config`. If
the portal states a `cli.minVersion` newer than this CLI, the CLI prints a
warning to stderr suggesting `@latest`. The warning never fails the command.

A 404 from a missing _route_ (the portal's not-found handler, as opposed to "app
not found") means the portal is older than the CLI, and the error says so. The
floor is `MIN_CLI_VERSION` in `@azx-pbc/shared`. Bump it by hand when the portal
removes or changes something an older CLI relies on (ADR-0052).

### Deploying from GitHub Actions

`helix ci init`, run signed in from the app's directory in its repo checkout,
connects the app to the repo and branch. The repo comes from `origin`; the
branch is the remote's default branch. `--repo` and `--branch` override either.
It then writes `.github/workflows/helix-deploy.yml` and merges `slug`,
`portalUrl` and `dir` into `helix.json`, or into a legacy `azx.json` if that's
the file in use. Commit both. Each push to the branch then lands a preview
(ADR-0051). Re-running it keeps any environment or workflow limit set on the
Repository tab, and refuses to replace a workflow pin unless you pass `--force`.

The generated workflow has two jobs. `build` installs and builds with no
`id-token` permission. `deploy` downloads the output and runs only the pinned
CLI. Code from the repo or its dependencies never runs where it could mint a
deploy token.

The workflow needs no secret. Inside GitHub Actions, when `HELIX_TOKEN` is not
set and the job has `permissions: id-token: write`, `helix deploy` asks GitHub
for an OIDC token whose audience is the portal (read from `GET /api/v1/config`)
and uploads to `POST /api/v1/apps/:slug/ci/versions`. CI deploys always land as
a preview, so `--promote` is refused there. It refuses to send the token to a
plain-`http` portal other than one on `localhost`.

`--reusable` writes a caller of the public reusable workflow
(`AZX-PBC-OSS/helix-actions`, source in `integrations/helix-actions/`) instead
of a self-contained one. It also pins the binding to that workflow, so no other
workflow on the branch can deploy. `helix ci show` prints the binding,
including the repo ids pinned by the first deploy. `helix ci remove` disconnects
the app.

> **Breaking in 0.2.0:** the `private` visibility mode was renamed to `internal`.
> It never checked _which_ user signed in, only that someone had. Passing the old
> value now **errors** rather than mapping to the new one, deliberately: the name
> is reserved for a future owner-only mode, so a silent alias would come to mean
> the opposite of what it says. Update scripts to use `internal`.

## Authentication (M3)

Two paths, in precedence order:

1. **Static token** — `HELIX_TOKEN` / `--token`. Sends the value as a bearer
   token verbatim. This is the local scripts path, and also how the portal's
   dev-token stub keeps working (`HELIX_TOKEN=$PORTAL_DEV_TOKEN`). The dev token
   is never accepted by a production portal. A stored token is not a supported
   way to deploy from CI; repo-backed deploys use the workflow's GitHub Actions
   OIDC token instead (ADR-0051).
2. **`helix login`** — the OIDC device flow. The CLI asks the portal
   (`GET /api/v1/auth/config`) which issuer to use (the local dev IdP on
   `:3002` in dev; Entra later), prints a verification URL + code, and polls
   while you approve in a browser. Tokens land in
   `~/.config/helix/tokens.json` (mode 0600, keyed by issuer) and are silently
   renewed with the refresh token. On 401, nothing is auto-launched — agents
   run headless; the error says to run `helix login`.

## Running it

### From npm

App authors and agents run it with `npx`, so it is always the current release
and there is nothing to keep updated (ADR-0052):

```bash
cd my-app
npx -y @azx-pbc/helix-cli@latest deploy --promote
```

Write `@latest` explicitly, because a bare package name lets `npx` reuse a copy
it cached earlier. `-y` skips the install prompt.

To install it once instead:

```bash
npm i -g @azx-pbc/helix-cli          # update with: npm i -g @azx-pbc/helix-cli@latest
helix deploy --promote
```

CI workflows pin an exact version; `helix ci init` writes the one it was run
with.

Needs **Node 22.12+** (or 24+). The engines range and the bundle's esbuild
target move together (see `scripts/build.mjs`), so the declared floor is real:
older runtimes may not merely warn, they may fail to parse it.

`0.0.0` is a deprecated placeholder that exists only because npm requires a
package to exist before a trusted publisher can be attached to it. Every real
version is `0.1.0` or later and carries a provenance attestation. npm filters
registry versions by `engines` against the running runtime, so before 0.3.0
declared 22.12+ an install on Node 22 fell all the way back to that
placeholder — the reason a supported-looking Node could yield a
non-functional package.

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
