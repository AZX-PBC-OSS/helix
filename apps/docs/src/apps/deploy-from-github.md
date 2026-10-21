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
upload. [How it stays secure](#how-it-stays-secure-without-a-shared-secret)
explains the details.

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

### Use the public reusable workflow

`helix ci init --reusable` writes a short workflow that calls Helix's public
reusable workflow,
[`AZX-PBC-OSS/helix-actions`](https://github.com/AZX-PBC-OSS/helix-actions),
instead of a self-contained one. It runs the same two jobs. It also sets
[**Only this workflow**](#optional-limits) to that workflow, so a different
workflow on the branch can't deploy.

The workflow it writes, for an npm app at the repository root, looks like this:

```yaml
name: Deploy to Helix
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions: {}
jobs:
  deploy:
    uses: AZX-PBC-OSS/helix-actions/.github/workflows/deploy.yml@v1
    permissions:
      contents: read
      id-token: write
    with:
      package-manager: npm
      working-directory: "."
      build-script: "build"
      cli-version: "latest"
```

The inputs are `package-manager` (`npm`, `pnpm` or `yarn`),
`working-directory` (the app's directory in the repository), `build-script`
(empty deploys the directory as-is), `pnpm-version`, `node-version`, and
`cli-version` (defaults to `latest`). The
[repository](https://github.com/AZX-PBC-OSS/helix-actions) has the full
definition.

### Write your own workflow

You can also connect a repository on the app's **Repository** tab in the portal
and write the workflow yourself. Start from the reusable workflow above, or from
what `helix ci init` writes, and keep its shape: build in a job without
`id-token: write`, then deploy the build output from a separate job that has it
and runs only the Helix CLI. A single job that builds and deploys gives your
dependencies' install scripts a chance to request a deploy token.

Pin the CLI version (`@azx-pbc/helix-cli@<version>`) for deploys you can
reproduce. `@latest` runs the newest CLI on every build.

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

[`helix ci init --reusable`](#use-the-public-reusable-workflow) sets the
workflow limit for you.

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

## How it stays secure without a shared secret

A stored deploy key is a password: anyone who copies it can use it, from
anywhere, until someone notices and rotates it. Helix doesn't use one. A deploy
is accepted because GitHub vouches for the job that sent it.

1. **The job asks GitHub for an identity token.** A workflow with
   `permissions: id-token: write` can request a short-lived token from GitHub's
   OIDC provider. GitHub signs it, and it states facts GitHub observed about the
   run: which repository, branch, event, and workflow it came from. The job
   can't change those facts, because changing them would break GitHub's
   signature.
2. **The token is addressed to your portal.** The CLI asks for a token whose
   audience is your portal's own URL. Helix refuses tokens addressed to anything
   else, so a token minted for another service can't be used here.
3. **Helix checks the signature and the facts.** The portal verifies the token
   against GitHub's published signing keys. Then it compares the token's facts
   with the connection you set up: the right repository, the right branch, and
   an allowed trigger. The rules are in [What can deploy](#what-can-deploy).
4. **The token is spent on one upload.** A token produces at most one version
   and expires shortly after it is issued, so a copy captured from a log is of
   little use.

That avoids the usual problems with a stored credential:

- **There is nothing to leak or rotate.** Helix stores no secret for this, and
  you add none to the repository. Each run gets a fresh token, and the token
  expires on its own.
- **It only works from your repository.** A token is valid only when GitHub says
  it came from the connected repository and branch. Helix records the
  repository's numeric GitHub ids on the first deploy, so a different repository
  that later takes the same name is refused.
- **It can do one thing.** A GitHub token is accepted on exactly one route:
  uploading a version to an app connected to that repository and branch. It
  can't promote, roll back, or change any app's settings or access.
- **A person still decides what goes live.** CI deploys always land as previews,
  and there is no setting to send them straight to live.
- **Your build can't mint tokens.** In the workflow `helix ci init` writes, the
  job that installs and builds your code has no permission to request a token.
  Only the separate deploy job, which runs just the Helix CLI, can request one.
  A malicious dependency can't take the deploy credential, because its job never
  has one.

What you still own is who can trigger a deploy. By default, anyone who can push
to the connected branch can deploy a preview. That is the same boundary a stored
deploy key would have. Branch protection, and the
[optional limits](#optional-limits), narrow it further.
