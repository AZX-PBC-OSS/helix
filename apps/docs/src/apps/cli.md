---
title: The helix CLI
description: "The npm-published deploy tool for app authors, run with npx: login, capabilities, create, deploy, promote, and rollback from the command line."
---

# The `helix` CLI

`helix` is the deploy tool for app authors. It is published to npm as
`@azx-pbc/helix-cli` and needs Node 22.12 or newer.

## Running it

Run it with `npx`, which fetches the current release each time. There is
nothing to install or keep up to date:

```bash
npx -y @azx-pbc/helix-cli@latest <command>
```

Write `@latest` explicitly. Without a version, `npx` may reuse a copy it
cached earlier. `-y` skips the "Ok to proceed?" prompt, which would otherwise
stall a coding agent.

**On this page, `helix` means that command.**

Run it from the app's directory, so it can read that app's `helix.json`.

If you would rather install it, run `npm i -g @azx-pbc/helix-cli`. You then
keep it current yourself with `npm i -g @azx-pbc/helix-cli@latest`.

## Signing in

```bash
helix login
```

This runs the OIDC device flow: it prints a URL and a code, you approve in a
browser, and the CLI caches the token at `~/.config/helix/tokens.json`. The
token is refreshed silently and is tied to the portal that issued it. Because
the cache is outside the package, it carries over between `npx` runs.

`helix whoami` shows who you are signed in as. `helix logout` forgets the
cached token.

To skip the prompt in a local script, set `HELIX_TOKEN` to a token instead.
Don't store a Helix token as a CI secret: it expires and can't be refreshed
there. To deploy from GitHub Actions, connect the repo with `helix ci init`;
the workflow authenticates with its own GitHub token. See
[Deploy from GitHub](./deploy-from-github).

## Finding out what your deployment offers

```bash
helix capabilities          # readable summary
helix capabilities --json   # the raw catalogue
```

Each Helix deployment is configured by its operator. This command lists what
yours allows:

- servable models;
- budgets that apply without approval;
- named connections and OAuth providers you can bind;
- visibility modes;
- deploy size limits;
- whether the [dev gateway](./dev-gateway) is on;
- which requests queue for an admin.

Read it before writing a [manifest](./manifest).

## Creating and deploying an app

Put a `helix.json` in the app's directory:

```json
{
  "slug": "my-app",
  "dir": "dist",
  "portalUrl": "https://portal.example.com",
  "description": "Tracks Q3 cloud spend by team."
}
```

Write a description: one plain-text sentence of up to 500 characters, with no
markdown, saying what the app does and who it is for. It appears under the
app's name in the portal, where a long list is otherwise just names. You can
edit it later on the app's Overview tab.

```bash
helix create --display-name "My App" --description "Tracks Q3 cloud spend by team."
helix deploy
```

`create` registers the app. It reads `slug` and `description` from
`helix.json`; a flag wins when you give both. Pass `--visibility` to set who can
open the app (`internal`, `group:<id>[,<id>…]`, `password`, or `public`).

`deploy` zips the build output (default `dist/`), uploads it as a **preview
version**, and `--promote` makes it live. `--bundle <zip>` uploads an
existing archive instead.

Deployed versions are immutable. Rolling back points the live version at an
older number; it never overwrites anything:

```bash
helix versions          # list versions, preview vs live
helix promote <number>  # make a version live
helix rollback [number] # go back to a previous version
```

### Upload limits

Each deployment sets its own per-file and per-bundle size caps, and
`helix capabilities` shows them. Every deployment also enforces these limits:

- at most 5,000 entries;
- a compression ratio of at most 200:1;
- static asset types only;
- no symlinks;
- no paths that escape the archive root.

Each upload also runs a **CSP lint**. It doesn't block the deploy, but it warns
about third-party origins the page's [Content-Security-Policy](./serving-and-csp)
will block at serve time. Each warning is a request that will fail in
production.

## Configuration

Each setting resolves in this order: command-line flag, environment variable,
`helix.json`, default.

| Setting | Flag | Env | `helix.json` | Default |
| --- | --- | --- | --- | --- |
| app slug | `--slug` | — | `slug` | required |
| portal URL | `--portal-url` | `HELIX_PORTAL_URL` | `portalUrl` | `http://localhost:3001` |
| build dir | `--dir` | — | `dir` | `dist` |
| description | `--description` | — | `description` | none |
| token | `--token` | `HELIX_TOKEN` | — | the `helix login` cache |

Watch the portal URL. The `localhost` default only works against a local
portal. For a deployed platform, set `portalUrl` in `helix.json`. The portal's
"How to develop" panel prints the file with the right URL for your deployment.

## Other commands

- `helix skill [--path <file>]` writes your deployment's agent skill to disk.
  It is the same file the portal's "How to develop" panel offers.
- `helix ci init | show | remove` manages a GitHub repository connection. See
  [Deploy from GitHub](./deploy-from-github).

## Version compatibility

The CLI and the portal are released separately, and your deployment may run an
older or newer version of Helix than the CLI.

- **CLI older than the portal supports:** the portal publishes the oldest CLI
  it supports. An older CLI prints a warning telling you to use `@latest`.
- **Portal older than the CLI:** if the CLI calls a route the portal doesn't
  have yet, the error says so. Ask your operator to update Helix, or run an
  older CLI release by naming its version: `npx -y @azx-pbc/helix-cli@<version> <command>`.
