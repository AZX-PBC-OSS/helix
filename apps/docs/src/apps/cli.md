---
title: The helix CLI
description: "The npm-published deploy tool for app authors: login, create, deploy, promote, and rollback from the command line."
---

# The `helix` CLI

`helix` is the deploy tool for app authors. It is published to npm:

```bash
npm i -g @azx-pbc/helix-cli
```

Run it from inside an app's directory — it reads that app's `helix.json`, like
`git` reads `.git`. Node 24 or newer is required.

## Signing in

```bash
helix login
```

This runs the OIDC device flow: it prints a URL and a code, you approve in a
browser, and the CLI caches the token at `~/.config/helix/tokens.json`. The
token is refreshed silently and is bound to the portal it was issued for.

For CI and scripts, set `HELIX_TOKEN` to a token instead — nothing prompts.

## Creating and deploying an app

```bash
helix create --display-name "My app"
helix deploy
```

`create` registers the app and writes `helix.json`. `deploy` zips the build
output (default `dist/`), uploads it as a **preview version**, and
`--promote` makes it live. Deployed versions are immutable — rolling back is
pointing the live version at an older number, never overwriting:

```bash
helix versions          # list versions
helix promote <number>  # flip the live pointer
helix rollback [number] # back to a previous version
```

## Configuration

Each setting resolves in this order: command-line flag, environment variable,
`helix.json`, default.

| Setting | Flag | Env | `helix.json` | Default |
| --- | --- | --- | --- | --- |
| app slug | `--slug` | — | `slug` | required |
| portal URL | `--portal-url` | `HELIX_PORTAL_URL` | `portalUrl` | `http://localhost:3001` |
| build dir | `--dir` | — | `dir` | `dist` |
| token | `--token` | `HELIX_TOKEN` | — | the `helix login` cache |

The portal URL is the one to watch: the `localhost` default is only right
against a local portal. Against a deployed platform, set `portalUrl` in
`helix.json` — the portal's "How to develop" panel prints the file with the
right URL for your deployment.
