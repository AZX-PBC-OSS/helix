# helix-actions

The reusable GitHub Actions workflow that deploys an app to Helix from CI
([ADR-0051](../../docs/adr/0051-repo-backed-apps-ci-push-github-oidc.md)).

This directory is the source of truth. It is mirrored to the public
`AZX-PBC-OSS/helix-actions` repository, because a reusable workflow can only be
called from another organization's repo when it lives in a public one. The
mirror and its `v1` tag are updated by hand for now.

## Use

Run `helix ci init --reusable` in the app's directory. It connects the app to
the repo, pins the binding to this workflow, and writes a caller like this:

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write
jobs:
  deploy:
    uses: AZX-PBC-OSS/helix-actions/.github/workflows/deploy.yml@v1
    with:
      package-manager: npm
      working-directory: "."
      build-script: build
      cli-version: "0.4.0" # the CLI that wrote this file
```

| Input               | Default  | Meaning                                                                          |
| ------------------- | -------- | -------------------------------------------------------------------------------- |
| `package-manager`   | `npm`    | `npm`, `pnpm` or `yarn`                                                          |
| `node-version`      | `24`     | Passed to `actions/setup-node`                                                   |
| `working-directory` | `.`      | The app directory, relative to the repo root. It must hold `helix.json`          |
| `build-script`      | `build`  | The `package.json` script that builds the app. Empty deploys the directory as-is |
| `cli-version`       | `latest` | The `@azx-pbc/helix-cli` version that runs `helix deploy`                        |

The job needs no secret. `helix deploy` requests a GitHub OIDC token for the
portal named in `helix.json` and uploads to the app's CI route. The version
lands as a preview; someone promotes it.

## Releasing

A change here goes out as a new tag on the mirror. Move `v1` only for
backward-compatible changes: every app whose binding pins
`…/deploy.yml@refs/tags/v1` runs the new content on its next push. A breaking
change is `v2`, and owners re-pin.
