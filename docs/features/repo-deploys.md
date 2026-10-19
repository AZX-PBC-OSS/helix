# Repo-backed apps — deploy previews from GitHub Actions

> **Related ADRs:** [ADR-0051](../adr/0051-repo-backed-apps-ci-push-github-oidc.md) (the decision, threat model and amendments) · [ADR-0018](../adr/0018-deploy-model-immutable-versions.md) (immutable versions, preview→live) · [ADR-0024](../adr/0024-portal-cli-bearer-jwt-jwks.md) (bearer JWT over JWKS). Design context: [`../design/git-connections.md`](../design/git-connections.md) §2. Author guide: [`apps/docs/src/apps/deploy-from-github.md`](../../apps/docs/src/apps/deploy-from-github.md).

An app owner connects the app to one GitHub repository and branch. A GitHub
Actions job on that branch builds the app and runs `helix deploy`, which uploads
the bundle with the job's own GitHub OIDC token. The portal checks the token
against the binding and runs the upload through the normal deploy path. The
version lands as a **preview**, and a person promotes it.

Helix runs no build, stores no credential for this path, and calls GitHub only
to fetch its JWKS.

## The binding

`repo_bindings`, one row per app (`apps/portal/prisma/schema.prisma`
`RepoBinding`): `repoFullName`, `branch`, optional `workflowRef` and
`environment`, and `repositoryId` / `repositoryOwnerId`, which are null until
the first accepted deploy pins them.

| Route | Gate | Behavior |
| --- | --- | --- |
| `GET /api/v1/apps/:slug/repo-binding` | `authenticate` + `ownsApp` | The binding, or 404 with `details.reason = "no_binding"` |
| `PUT /api/v1/apps/:slug/repo-binding` | `authenticate` + `ownsApp` | Full replace. Changing `repoFullName` clears the pins; any other change keeps them. Refused on an archived app. Audits `app.repo-binding.set` |
| `DELETE /api/v1/apps/:slug/repo-binding` | `authenticate` + `ownsApp` | Idempotent 204. Audits `app.repo-binding.delete` when a row was removed |

Code: `apps/portal/src/routes/repoBinding.ts`; request schema
`SetRepoBindingRequestSchema` in `packages/shared/src/repoBinding.ts`. The
binding read is owner-gated, unlike most app reads, because it names who can
deploy. `helix_edge`, `helix_egress` and `helix_dev` have no grant on the table
(`apps/edge/src/registry/role-split.integration.test.ts`).

## The CI route

`POST /api/v1/apps/:slug/ci/versions` (`apps/portal/src/routes/ciVersions.ts`)
is the only route that accepts a GitHub token. The verifier
(`apps/portal/src/auth/githubOidc.ts`) is not in the `authenticate` chain, and
a test presents a valid GitHub token to every `authenticate` route and expects
401.

The handler authenticates before it reads the multipart body
(`apps/portal/src/plugins/repoDeployAuth.ts`):

1. **Token.** RS256 signature against the issuer's JWKS; `iss`; `exp`/`nbf`/`iat`
   with 5 s skew; `jti` present; `aud` a single string equal to this portal's
   origin. Every claim the binding check reads must be present and well formed.
2. **Binding** (`apps/portal/src/repoDeploy/authorize.ts`, pure). Before pinning,
   the `repository` claim must equal the binding's name (case-insensitive);
   after, both numeric ids must match. Then `ref_type = branch` and
   `ref = refs/heads/<branch>`; `event_name` ∈ {`push`, `workflow_dispatch`};
   the optional `job_workflow_ref` (exact) and `environment` (case-insensitive)
   pins.
3. **Pin** on the first accepted token: a conditional update on an unpinned row
   with the same name, then a re-read and re-check.
4. **Replay.** `versions.sourceTokenJti` is unique. The route checks it first,
   and the unique index refuses the loser of two concurrent requests.
5. **Deploy.** The shared `deployUploadedBundle` helper (`routes/versions.ts`)
   runs `validate.ts`, the CSP lint and the Blob upload. The salvage `report`
   field is not read. The version records `source*` provenance from the token.

A bundle that fails validation never allocates a version, so it doesn't spend
the token. A failure after allocation does; a re-run job mints a new token.

### Refusals

| Caller | Status | Body | Audit |
| --- | --- | --- | --- |
| No token, not a GitHub token, wrong issuer, wrong or default audience, expired | 401 `unauthorized` | Generic | None |
| A repo other than the bound one, an app with no binding, an unknown slug | 403 `forbidden` | Identical for all three, no reason | None |
| The bound repo, outside the binding's limits | 403 `forbidden` | `details.reason` ∈ `ref_mismatch`, `event_rejected`, `workflow_mismatch`, `environment_mismatch` | `app.repo-deploy.denied` |
| The bound repo, a used token | 409 `conflict` | `details.reason = "replayed"` | `app.repo-deploy.denied` |
| The bound repo, an archived app | 409 `conflict` | | None |
| Feature off | 404 | | None |

Anyone with a GitHub repository can mint a validly signed token with this
portal's audience, so the refusals that a stranger can cause carry no detail
and write no audit row. The bound repo's own refusals are a real signal about
its workflows, so they do both. The audit metadata holds the reason, numeric
repository id, ref, event, sha, run id and attempt, and GitHub login, never the
token. A successful deploy writes the usual `version.upload` row with actor
`github:<owner/name>` and a `source` block.

## Configuration

| Env (portal) | Bicep param | Default | Meaning |
| --- | --- | --- | --- |
| `PORTAL_REPO_DEPLOY_ENABLED` | `repoDeployEnabled` | `true` | `false` makes the CI and binding routes 404 and hides the SPA tab |
| `PORTAL_GITHUB_OIDC_ISSUER` | `githubOidcIssuer` | `https://token.actions.githubusercontent.com` | The trusted issuer; https only |
| `PORTAL_PUBLIC_ORIGIN` | — | `https://portal.<APP_PUBLIC_BASE host>` | The exact `aud`. Never taken from the request's `Host` |
| `PORTAL_GITHUB_SERVER_URL` | — | `https://github.com` | Web origin for commit and run links |

`GET /api/v1/config` returns `repoDeploy: { enabled, audience, serverUrl }`.
The CLI requests its token for that `audience`, not for the URL it was pointed
at. Resolvers live in `apps/portal/src/deployment.ts` and are checked at boot.

## Clients

- **CLI** (`packages/cli`). In GitHub Actions, with no `HELIX_TOKEN` and with
  `ACTIONS_ID_TOKEN_REQUEST_URL`/`_TOKEN` set, `helix deploy` uses the CI route
  and refuses `--promote`. `helix ci init | show | remove` manage the binding;
  `init` also writes `helix.json` and the workflow. See
  [cli.md](./cli.md).
- **Reusable workflow**, source in `integrations/helix-actions/`, to be
  published as `AZX-PBC-OSS/helix-actions` (mirroring is manual; see `TODO.md`).
- **Portal SPA.** The **Repository** tab (`apps/portal-web/src/pages/tabs/RepositoryTab.tsx`)
  edits the binding and shows the pin state. The Versions tab links a CI
  version's commit and run.

## Telemetry

The route's root span is `helix.deploy.repo`, with `helix.deploy.bundle` nested
inside when the token is accepted. The counter `helix.deploy.repo_requests`
counts one decision per request by `outcome` (`REPO_DEPLOY_OUTCOMES` in
`packages/shared/src/telemetry.ts`) and `appId`. Refusals log
`event: "repo_deploy.denied"` at `warn`. A refusal is not an error status on the
span. See [observability.md](./observability.md).

## Known gaps

- One binding per app, GitHub only. Other CI issuers, GitHub Enterprise Server,
  several branches per app and PR preview environments are later work
  (ADR-0051 phasing).
- The reusable workflow isn't published until the mirror exists.
