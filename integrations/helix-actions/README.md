# helix-actions

A reusable GitHub Actions workflow that builds an app and deploys it to
[Helix](https://github.com/AZX-PBC-OSS/helix) as a **preview** version.

The job authenticates with its own short-lived GitHub OIDC token, so the repo
needs no secret. Helix accepts the upload only from the repository and branch
the app is connected to, and a preview goes live only when someone promotes it.
The design and threat model are in
[ADR-0051](https://github.com/AZX-PBC-OSS/helix/blob/main/docs/adr/0051-repo-backed-apps-ci-push-github-oidc.md).

## Use

From the app's directory in your repo, signed in to your Helix portal:

```bash
npx @azx-pbc/helix-cli ci init --reusable
```

That connects the app to the repo and current branch, pins the connection to
this workflow, and writes `helix.json` and a caller like this one. Commit both.

```yaml
# .github/workflows/helix-deploy.yml
name: Deploy to Helix
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
      cli-version: "0.5.0"
```

`helix.json` in `working-directory` names the app's `slug` and the `portalUrl`.
`helix deploy` reads both.

### Inputs

| Input               | Default  | Meaning                                                                          |
| ------------------- | -------- | -------------------------------------------------------------------------------- |
| `package-manager`   | `npm`    | `npm`, `pnpm` or `yarn`                                                          |
| `node-version`      | `24`     | Passed to `actions/setup-node`                                                   |
| `working-directory` | `.`      | The app directory, relative to the repo root. It must hold `helix.json`          |
| `build-script`      | `build`  | The `package.json` script that builds the app. Empty deploys the directory as-is |
| `cli-version`       | `latest` | The `@azx-pbc/helix-cli` version that runs `helix deploy`. Pin it                |

The caller must grant `id-token: write`. The job asks GitHub for a token whose
audience is your portal and uploads with it. It never stores or prints a
credential.

## Pinning

An app owner can require that deploys come from this workflow only. `helix ci
init --reusable` sets that up; in the portal it is **Repository → Only this
workflow** with the value:

```
AZX-PBC-OSS/helix-actions/.github/workflows/deploy.yml@refs/tags/v1
```

A deploy from any other workflow on the branch is then refused.

## Versions

`v1` is a moving tag that tracks the latest `v1.x.y` release. It only moves for
backward-compatible changes, because every app pinned to `@refs/tags/v1` runs
the new content on its next push. A breaking change ships as `v2`, and owners
re-pin. To freeze on exact content, call a full release tag such as `@v1.0.0`
and pin `@refs/tags/v1.0.0` instead.

## Contributing

This repository is a mirror. The source lives in
[`integrations/helix-actions/`](https://github.com/AZX-PBC-OSS/helix/tree/main/integrations/helix-actions)
in the Helix repository; open changes there. See [SYNC.md](SYNC.md) for how a
change is published here.

Report security issues as described in [SECURITY.md](SECURITY.md).
