---
title: Deploy from GitHub
description: "Connect an app to a GitHub repository so every push lands a preview, authenticated by the job's own GitHub OIDC token — no secret to store."
---

# Deploy from GitHub

Connect an app to a GitHub repository and branch, and every push to that branch
lands a new **preview** version. Your repository's GitHub Actions workflow
builds the app and uploads it. Helix never runs your build and never reads your
repository.

There is no secret to set up. The workflow authenticates with the short-lived
token GitHub gives every job that asks for `id-token: write`. Helix checks that
the token came from the connected repository and branch before it accepts the
upload.

A CI deploy is always a preview. It goes live only when someone promotes it, in
the portal or with `helix promote`.

## Connect a repository

You need to own the app, have the `helix` CLI signed in to your portal, and run
this from the app's directory in a clone of the repository:

```bash
helix ci init
```

It reads the repository from your `origin` remote and uses the repository's
default branch, or takes `--repo owner/name` and `--branch <name>`. Then it:

1. connects the app to that repository and branch,
2. writes `helix.json` with the app's slug and the portal URL, and
3. writes `.github/workflows/helix-deploy.yml`, set up for your package manager
   and build script.

The workflow has two jobs. `build` installs and builds your app without
permission to request a token. `deploy` takes the build output and runs only
the Helix CLI, which is the one step that requests a token. Your code and your
dependencies' install scripts never run where they could mint one.

Running `helix ci init` again keeps any limits you set on the Repository tab.

Commit both files and push. The workflow's next run deploys a preview.

You can also connect a repository on the app's **Repository** tab in the portal
and write the workflow yourself. The smallest one, for an npm app at the
repository root with a `package-lock.json`, needs these permissions and a
`helix deploy` step:

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
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm ci && npm run build
      - run: npx --yes @azx-pbc/helix-cli@latest deploy
```

`@latest` runs the newest CLI on every build. For deploys you can reproduce,
pin a version (`@azx-pbc/helix-cli@<version>`) and update it when you choose to.
`helix ci init` writes the pin for you.

This single job runs your build in the same job that can request a token, so
it doesn't get the protection described above. For anything else, such as pnpm
or yarn, an app in a subdirectory, or a workflow you want to pin, use
`helix ci init`.

`helix deploy` notices it is running in GitHub Actions, asks GitHub for a token
meant for your portal, and uploads with it. It reads the slug and portal URL
from `helix.json`. Don't set `HELIX_TOKEN` in this workflow: an explicit token
makes the CLI use the signed-in route instead.

## What can deploy

A deploy is accepted only when the job's token shows that it:

- came from the connected repository,
- ran on the connected branch, and
- was triggered by a `push` or a manual `workflow_dispatch`.

Pull requests, `pull_request_target`, `workflow_run`, `issue_comment` and every
other trigger are refused. So without the limits below, anyone who can push to
the connected branch can deploy a preview. Protect the branch the way you
would for any deploy.

The first accepted deploy **pins** the repository's numeric GitHub ids. After
that, renaming the repository keeps working, and a different repository that
later takes the old name cannot deploy. Transferring the repository to another
account stops deploys until you reconnect it.

Each token deploys at most one version, so a captured token can't be replayed.

## Optional limits

On the Repository tab, under **optional limits**:

- **Only this workflow.** The exact workflow a deploy must come from, as GitHub
  reports it: `owner/repo/.github/workflows/helix-deploy.yml@refs/heads/main`.
  Another workflow on the same branch can then no longer deploy. The pin is only
  as strong as the pinned workflow: it holds when, like the workflows
  `helix ci init` writes, that workflow keeps the token out of the job that runs
  your build.
- **Only this environment.** A GitHub environment the deploy job must run in.
  The environment's protection rules, such as required reviewers or a wait
  timer, then gate every deploy. Add `environment: <name>` to the job.

`helix ci init --reusable` writes a workflow that calls Helix's shared reusable
workflow instead of a self-contained one, and sets the workflow limit to it.

## When a deploy is refused

The CLI prints the reason when the token came from the connected repository:

| Reason | What to check |
| --- | --- |
| `ref_mismatch` | The workflow ran on a different branch than the connected one |
| `event_rejected` | The workflow was triggered by something other than `push` or `workflow_dispatch` |
| `workflow_mismatch` | The deploy came from a workflow other than the one in **Only this workflow** |
| `environment_mismatch` | The job didn't run in the environment in **Only this environment** |
| `replayed` | The token already deployed a version. Re-run the job to get a new one |

Any other refusal reads "this token may not deploy to this app", with no
reason. Helix gives the same answer for a repository that isn't connected, an
app with no connection and an app that doesn't exist. Run `helix ci show` to see
what the app is connected to.

If the CLI says it is running in GitHub Actions without an ID token, add
`permissions: id-token: write` to the workflow or the job.

## Disconnect

Use **Disconnect** on the Repository tab, or `helix ci remove`. Versions the
repository already deployed stay.
