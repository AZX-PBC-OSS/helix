# 0051. Repo-backed apps: CI pushes the bundle, authenticated by GitHub Actions OIDC

**Status:** Accepted (2026-10-19). Supersedes ADR [0030](0030-repo-backed-apps-pull-attested-artifacts.md). Amends ADR [0007](0007-portal-authz-v0.md) (the `portalExternal` default, decision 11).
**Related:** ADR [0007](0007-portal-authz-v0.md) (portal access posture and `portalExternal`), [0030](0030-repo-backed-apps-pull-attested-artifacts.md) (the pull model this replaces), [0026](0026-hosted-build-isolation-prerequisites.md) (hosted-build launch gates — still displaced, not superseded), [0018](0018-deploy-model-immutable-versions.md) (upload-only, immutable versions, preview→live), [0024](0024-portal-cli-bearer-jwt-jwks.md) (bearer JWT over JWKS), [0007](0007-portal-authz-v0.md) (portal authz, `ownsApp`), [0028](0028-deployment-model-customer-deployed.md) (customer-deployed), [0048](0048-canonical-principal-oid.md) (canonical principal), [0037](0037-platform-observability-otlp-boundary.md) (observability). **Design:** `docs/design/git-connections.md` §2. **Code:** `apps/portal/src/auth/verifier.ts`, `apps/portal/src/plugins/auth.ts`, `apps/portal/src/routes/versions.ts`, `packages/cli`.

## Context

The goal is unchanged from ADR [0030](0030-repo-backed-apps-pull-attested-artifacts.md): connect a GitHub repo and branch to an app, and a push to that branch lands a preview version. Helix still runs no build. The author's CI builds the app.

ADR 0030 had Helix **pull** the built bundle: CI pushed an OCI artifact to GHCR with a Sigstore build attestation, and the portal polled GHCR, verified the attestation and imported the bytes. It chose pull for one reason. The portal was internal-ingress by default (`portalExternal = false` in `infra/azure/main.bicep` until decision 11 below), so a GitHub-hosted runner might not be able to reach it, and a pull model works without any inbound call.

That constraint does not hold in practice. Every deployment so far sets `portalExternal = true`, because the portal is the deploy target for `helix deploy`, the SPA and the agent skill, and an unreachable portal makes the platform unusable for a remote team (`infra/azure/README.md` §"Portal access"). With the portal reachable, the pull model's cost is all downside:

- **Machinery.** A binding table with a dirty flag, a drain worker, an OCI manifest and layer client, a Sigstore/Fulcio verifier, a `/poke/:slug` route, and ORAS plus attestation steps in every author's workflow.
- **Private repos.** A per-deployment GitHub App, created through the Manifest flow, with its private key in `SecretStore`, installation-token minting, `installation.*` webhook handling, and an unresolved question about whether installation tokens can read private GHCR packages at all.
- **Latency.** Polling is the floor, so a deploy waits for the next drain unless a poke arrives.

GitHub Actions already gives every job a credential that answers the question Helix needs answered. A job with `permissions: id-token: write` can request a short-lived JWT from GitHub's OIDC provider, signed by GitHub, with an audience the job chooses. Its claims identify the workflow run: `repository_id`, `repository_owner_id`, `ref`, `ref_type`, `sha`, `event_name`, `workflow_ref`, `job_workflow_ref`, `environment`, `run_id`, `run_attempt`, `actor` and `jti`. The portal already verifies bearer JWTs against an issuer's JWKS (ADR [0024](0024-portal-cli-bearer-jwt-jwks.md)). Verifying one more issuer is a small, well-understood change.

ADR 0030 rejected Actions OIDC only because "in a pull model the CI never talks to Helix" (its decision 10), and noted that OIDC was worth adopting for CI deploys independently. This ADR makes that the primary path.

## Decision

1. **CI pushes; Helix verifies the caller.** The author's workflow builds the app and uploads the bundle to the portal with `helix deploy`. The request carries a GitHub Actions OIDC token as its bearer credential. Helix stores no secret for this path, the author stores no secret in the repo, and Helix makes no call to GitHub other than fetching GitHub's JWKS.

2. **The binding is portal-side app config, set by the owner.** An app has at most one GitHub binding: repository (`owner/name`), branch, and two optional constraints (decision 5). Creating, changing and removing it go through `authenticate` + `ownsApp`, like any other app setting. There is no ownership-proof step. A binding grants deploy rights *into* the binder's own app, so the only person a wrong binding can hurt is the owner who made it. One binding per app is a v1 limit, not an oversight: several branches feeding one app would need a rule for how their previews relate, and that is a separate decision.

3. **Identity is the numeric repository ID, pinned on first use.** Repos can be renamed, transferred, or deleted and their `owner/name` reclaimed, so the name is not a safe long-term identifier. The binding stores `repository_id` and `repository_owner_id`. Both are taken from the first token that verifies and whose `repository` claim matches the configured name, and the portal shows the pinned values. After that the name is display only, and a token must match both IDs. Requiring the owner ID as well means a repo transferred to another account stops deploying until the app owner rebinds it. Pinning from the token avoids any GitHub API call from the portal, which a private repo would otherwise need a credential for. The window between binding and first deploy is the only time the name is trusted, and it is the same name the owner just typed.

4. **Verification rules.** A token is accepted only if all of these hold:
   - `iss` equals the configured issuer. The default is `https://token.actions.githubusercontent.com`. It is a deployment setting so that GitHub Enterprise Cloud tenants using a customized issuer, and later GitHub Enterprise Server, can set their own.
   - The signature verifies against that issuer's JWKS, and `exp`/`nbf`/`iat` are valid with the same clock-skew allowance as the existing OIDC verifier.
   - `aud` equals this deployment's portal origin (`https://portal.<appsDomain>`) exactly. GitHub's default audience (`https://github.com/<owner>`) is refused, so a token minted for another service cannot be replayed here.
   - `repository_id` and `repository_owner_id` equal the binding's pinned values.
   - `ref_type` is `branch` and `ref` equals `refs/heads/<binding branch>`.
   - `event_name` is in an allowlist: `push` and `workflow_dispatch`. This is an allowlist rather than a denylist because the dangerous events are the ones that run with the base branch's `ref` but on behalf of someone without push access: `pull_request_target`, `workflow_run` and `issue_comment`. A `pull_request` token carries `refs/pull/<n>/merge` and fails the `ref` check anyway.
   - `jti` has not already produced a version (decision 8).

5. **Owners can tighten the binding.** Two optional fields narrow who can deploy within the repo:
   - **Workflow pin.** `job_workflow_ref` must equal a given value, for example the Helix reusable workflow at a tag, or `<repo>/.github/workflows/deploy.yml@refs/heads/main`. This stops a different workflow on the same branch from deploying.
   - **Environment.** `environment` must equal a given name. This lets the owner use GitHub's environment protection rules (required reviewers, wait timers, branch restrictions) as a deploy gate. Helix enforces that the token came from that environment; GitHub enforces the rules.

   Both are off by default. Without them, the deploy boundary is "anyone who can push to the branch", which is the boundary ADR 0030 accepted and the same one `helix deploy` with a stored token already has.

6. **A GitHub token can do exactly one thing.** The GitHub verifier is **not** added to the shared verifier chain behind `authenticate`. Adding it there would let a GitHub-signed token pass `authenticate` on every route that only checks sign-in. Instead, one route, `POST /api/v1/apps/:slug/ci/versions`, has its own preHandler, `authenticateRepoDeploy`. It verifies the token, loads the app's binding, applies decision 4, and attaches a **workload principal** (repo ID, ref, sha, run ID, GitHub `actor` login) rather than an `Actor`. No other route accepts it. A GitHub token cannot promote, roll back, change the binding, change access or capabilities, or mint dev tokens. The set of routes reachable with a GitHub token is one line in one file.

7. **Authenticate before reading the body.** `authenticateRepoDeploy` runs before the handler calls `req.file()`, so an unauthenticated or mismatched request is refused without spooling a byte of the upload. The existing deploy size limits still apply.

8. **The bundle takes the normal deploy path and lands as a preview.** The handler calls the same `spoolUpload` / `deployBundle` path as `POST /api/v1/apps/:slug/versions`, including `validate.ts` and the CSP lint (see Amendment 7). The version lands as `preview`, and a person promotes it (ADR [0018](0018-deploy-model-immutable-versions.md)). There is no auto-promote option. A binding cannot be configured to send CI deploys straight to live; the human promote step stays the gate between a push and traffic. The version records where it came from: provider, `repository_id`, `ref`, `sha`, `workflow_ref`, `run_id`, `run_attempt` and the token's `jti`. The `jti` column is unique, so a token that has already produced a version is refused. A deploy that fails validation does not consume the token, so a retry within the token's lifetime still works. The audit row's actor is `github:<owner/name>` with the GitHub `actor` login alongside it.

9. **The CLI handles the token.** When `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are set and the user has not supplied `HELIX_TOKEN`, `helix deploy` requests an ID token with `audience` set to the portal origin (already known from `GET /api/v1/config`) and uploads to the CI route. The author's workflow is checkout, build, `npx @azx-pbc/helix-cli deploy`, with `permissions: { id-token: write, contents: read }`. Helix ships this as a starter workflow, a `helix` command that writes it into the repo, and a reusable workflow that owners can pin with decision 5.

10. **No GitHub App, no stored credential, and no difference for private repos.** The runner already has the source, so private repos need nothing extra. Helix never reads the repository.

11. **The portal is external by default.** Repo-backed deploys require the portal to be reachable from the runner, and every deployment already exposes it because the platform is not usable otherwise. `portalExternal` therefore defaults to `true` in `infra/azure/main.bicep` and the shipped params files. This amends ADR [0007](0007-portal-authz-v0.md)'s "opt-in" access posture: the perimeter it describes (Entra sign-in and Conditional Access for people, `ownsApp` for per-app authz) is unchanged, and only the default moves. An operator who wants no public portal can still set `false` and reach it over a private network path; repo-backed deploys then need a self-hosted or privately networked runner.

12. **A stored Helix token is not a supported way to deploy from CI.** The docs, the agent skill and the portal's help modal stop recommending `HELIX_TOKEN` for CI. It was never viable against a production portal: `PORTAL_DEV_TOKEN` is refused there, and an Entra access token expires within hours with no way to refresh it from a repo secret. `HELIX_TOKEN` stays as a mechanism for local scripts and the dev-token stub. CI deploys go through this ADR's route, with the workflow's own GitHub token.

13. **Hosted builds stay displaced.** ADR [0026](0026-hosted-build-isolation-prerequisites.md)'s gates are unchanged and still apply if Helix ever builds app code. This ADR, like 0030, removes the reason to.

## Consequences

- **What gets built:** a `repo_bindings` table, a GitHub OIDC verifier in `apps/portal/src/auth/`, the `authenticateRepoDeploy` preHandler, the CI deploy route, provenance columns on `Version`, binding UI on the app's settings in `apps/portal-web`, the CLI token exchange, and the starter and reusable workflows. There is no worker, no new deployable, no outbound dependency on GitHub beyond the JWKS fetch, and no new secret.
- **Deletes all of ADR 0030's machinery** before it was built: GHCR and ORAS, Sigstore verification, polling, the drain worker, `/poke/:slug`, the GitHub App and its Manifest onboarding, installation tokens and webhooks, and the open GHCR-private-package question.
- **Deploys are as fast as the upload.** No polling interval.
- **The route sits outside the Entra perimeter.** Entra Conditional Access governs who can obtain an Entra token. A GitHub token never passes through Entra, so device posture and sign-in policy do not apply to this route. That is acceptable because the route's authority is limited to creating a preview of one bound app (decision 6), and the controls that do apply are GitHub's: branch protection, rulesets, and optionally environment protection rules (decision 5). Operators should understand that "who can push to the bound branch" is now part of who can deploy a preview.
- **Provenance is weaker than a signed attestation, and that is acceptable.** ADR 0030's attestation bound the bytes to a workflow run. Here, the token authenticates the request, and the bytes arrive in that same TLS request. A compromised runner could upload different bytes than it built, but a compromised runner can also build different bytes, so an attestation made on that runner would not have helped. The recorded `sha` and `run_id` let an owner trace any version back to its run.
- **Telemetry ships with the route** (ADR [0037](0037-platform-observability-otlp-boundary.md)). The CI route gets a root span, `helix.deploy.repo`, wrapping the existing `helix.deploy.bundle` span, with `appId` and a bounded `helix.outcome`. It also gets a counter on the portal's `instruments()` object, `helix.deploy.repo_requests` (`outcome`). This is the second portal instrument, and it meets the bar the first one set: it is an internet-facing authentication route, and a rate of one denial reason is what an operator alerts on (a burst of `repo_mismatch` is someone probing; a run of `event_rejected` is a misconfigured workflow). The outcomes are `accepted`, `bad_token`, `bad_audience`, `no_binding`, `repo_mismatch`, `ref_mismatch`, `event_rejected`, `workflow_mismatch`, `environment_mismatch` and `replayed`. The token, the GitHub `actor` login and the repo name never appear as attributes or dimensions. Refusals also log at `warn` with `event: "repo_deploy.denied"` and the same reason. Names go in `packages/shared/src/telemetry.ts`, and both go into the inventory in `docs/features/observability.md`.
- **Audit.** A token that verifies as GitHub-signed but fails the binding check writes an `audit_events` row, because that is a real signal about the bound repo. Requests that fail signature verification do not, so unauthenticated noise cannot fill the audit table. Successful deploys produce the existing deploy audit row.
- **Tests ship with it.** This is new authentication code on an internet-facing route, so the adversarial suite lands with the implementation: wrong issuer, wrong audience, the default audience, expired token, another repo's valid token, the right repo after a transfer, each rejected event, a `pull_request` ref, a replayed `jti`, a GitHub token presented to every `authenticate`-only route, and a body that must not be read on refusal.
- **Other CI systems follow the same shape.** GitLab CI `id_tokens`, Azure Pipelines workload identity federation and Bitbucket Pipelines OIDC all issue signed JWTs with repo and branch claims. Each is another issuer and claim mapping behind the same route. None is in scope for v1.

## Threat model (extends architecture §10)

| Threat | Mitigation |
| --- | --- |
| Malicious dependency `postinstall` runs on platform infrastructure | Structurally impossible. Helix runs no build (decision 1). |
| Token minted for another service replayed to Helix | `aud` must equal this deployment's portal origin; GitHub's default audience is refused (decision 4). |
| Valid token from a repo the attacker controls | `repository_id` and `repository_owner_id` must match the binding (decisions 3, 4). |
| Repo renamed, or `owner/name` reclaimed by a third party | Binding pins numeric IDs on first use; the name is display only afterwards (decision 3). |
| Bound repo transferred to another account | `repository_owner_id` no longer matches; the owner must rebind (decision 3). |
| Fork PR deploys via `pull_request` | `ref` is `refs/pull/<n>/merge`, which fails the branch check (decision 4). |
| Fork-influenced run with the base `ref` (`pull_request_target`, `workflow_run`, `issue_comment`) | `event_name` allowlist (decision 4). |
| Another workflow on the bound branch deploys | Optional `job_workflow_ref` pin (decision 5). |
| Push to the branch bypasses review | Optional `environment` pin, which brings GitHub's environment protection rules into the path (decision 5). Otherwise accepted: same boundary as `helix deploy`. |
| Captured token replayed after a successful deploy | Unique `jti` on the version (decision 8), plus GitHub's short token lifetime. |
| GitHub token used against other portal routes | Verifier is not in the `authenticate` chain; one route accepts it (decision 6). |
| Unauthenticated uploads consume portal resources | Token and binding are checked before the body is read (decision 7). |
| Malicious bundle reaches live traffic | Lands as `preview`; a person promotes (decision 8). |
| Zip-slip, symlink or decompression bomb | Existing `validate.ts`; no shortcut (decision 8). |
| Malicious payload bundled into the served JS | Unchanged and out of scope: CSP and the gateway (ADR [0009](0009-relaxed-csp.md), [0014](0014-same-origin-api-gateway.md)). |
| GitHub's OIDC signing keys compromised | Out of scope. GitHub is the identity provider for this path in the same way Entra is for users. |

## Phasing

1. **Verifier, binding and route.** `repo_bindings`, the GitHub verifier, `authenticateRepoDeploy`, the CI route, provenance columns, and the adversarial tests. Bindings are managed through the API.
2. **CLI and workflows.** Token exchange in `helix deploy`, the starter workflow, the `helix` command that writes it, and the reusable workflow.
3. **Portal UX.** Connect-repo on the app's settings, the pinned identity, the optional workflow and environment pins, and a per-version "from commit `abc1234`, run #N" link.
4. **Later.** Other CI issuers, GitHub Enterprise Server, per-branch bindings (one app, several branches), and PR preview environments, which need ephemeral subdomains.

## Resolved questions

These were open when the ADR was drafted and were settled at acceptance on 2026-10-19:

- **Auto-promote:** not offered. CI deploys always land as a preview (decision 8). Revisit only with a concrete need, and expect it to go through the approval write-gate.
- **Bindings per app:** one (decision 2).
- **`portalExternal` default:** `true` (decision 11).
- **Stored-token CI deploys:** no longer documented or recommended (decision 12).

## Amendments

**2026-10-19, at implementation.** Building phases 1–3 settled these points. Where they differ from the text above, they take precedence.

1. **Audit scope for refusals.** The Consequences section says a GitHub-signed token that fails the binding check writes an audit row, and that only signature failures stay out of the table. That doesn't hold: anyone with a GitHub repository can mint a validly signed token with this portal's audience. Only refusals of the **bound repo's own** tokens are audited (`ref_mismatch`, `event_rejected`, `workflow_mismatch`, `environment_mismatch`, `replayed`). `repo_mismatch` and `no_binding` go to the counter and the `warn` log only.
2. **What a refused caller is told.** A token from another repo, an app with no binding and an unknown slug all get the same `403` with no reason, so bindings can't be enumerated. The bound repo gets the reason in `details.reason`, which makes a misconfigured workflow debuggable from its own log.
3. **Where the check runs.** `authenticateRepoDeploy` is the first call in the route handler rather than a separate Fastify preHandler, so the `helix.deploy.repo` span and the single counter increment cover the whole decision. It still runs before `req.file()` (decision 7), which a test proves with an upload body that never finishes.
4. **The audience.** The portal had no setting for its own public origin, and the request's `Host` header can't decide which audience a caller's token must carry. The audience is `https://portal.<APP_PUBLIC_BASE host>`, the hostname the Bicep binds, with `PORTAL_PUBLIC_ORIGIN` as an override. `GET /api/v1/config` returns it as `repoDeploy.audience`, and the CLI requests its token for that value.
5. **An operator kill switch.** `PORTAL_REPO_DEPLOY_ENABLED` (Bicep `repoDeployEnabled`, default `true`). When off, the CI and binding routes answer 404 and the SPA hides the Repository tab.
6. **When a token is spent.** A bundle that fails validation never allocates a version, so it doesn't spend the token (decision 8). A failure after allocation, such as a Blob error, does. A re-run of the job mints a new token.
7. **No manifest approval gate on this path.** Decision 8 and the design doc listed "the manifest approval gate" among the deploy-path checks. The deploy path has none: approvals run on the manifest, visibility and origin routes. A CI deploy goes through exactly the checks a signed-in upload does.
8. **The reusable workflow** lives at `AZX-PBC-OSS/helix-actions`, a public repository, because a reusable workflow can only be called across organizations from a public one. Its source is `integrations/helix-actions/` in this repo.

## Provenance

Design conversation, 2026-10-19; accepted the same day. The pull model in ADR 0030 rested on the assumption that the portal may be unreachable from GitHub. In practice every deployment exposes the portal, because the platform is not usable otherwise. With that assumption gone, OIDC on push removes all of ADR 0030's machinery and its private-repo credential, and closes its main open question. The constraints that ADR 0030 got right carry over unchanged: no hosted build, the numeric repository ID as the identity, no ownership ceremony, and every deploy landing as a preview through the existing pipeline.
