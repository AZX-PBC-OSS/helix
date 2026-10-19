# Git connections (deploy-from-repo)

**Status: design, not built.** The crawl rung is decided (ADR 0051, Accepted). The deploy path today is upload-only (`helix deploy`
zips a build dir, or the portal takes a multipart zip; architecture §5). This doc
covers the missing rung: **connect a git repo and branch, and a push lands a
preview version.**

There are two rungs:

| Rung | Model | Who builds | Record |
| --- | --- | --- | --- |
| **Crawl** (§2) | The author's CI builds and **pushes** the bundle, authenticated by its GitHub Actions OIDC token | the author's CI | ADR [0051](../adr/0051-repo-backed-apps-ci-push-github-oidc.md) |
| **Run** (§3) | Helix clones and **builds** the repo | Helix | ADR [0026](../adr/0026-hosted-build-isolation-prerequisites.md) — deferred |

§2 is the next thing to build. §3 is kept because it is still the answer for
authors who have no CI (§4).

**History.** This doc first described only the run rung. In 2026-07, ADR
[0030](../adr/0030-repo-backed-apps-pull-attested-artifacts.md) replaced it as the
next step with a pull model: CI published an attested OCI artifact to GHCR, and
Helix polled for it. In 2026-10, ADR
[0051](../adr/0051-repo-backed-apps-ci-push-github-oidc.md) replaced the pull
model with a push, once it was clear that every deployment exposes the portal.
ADR 0030 keeps the pull design for reference.

## 1. Why the author's CI builds

**A git build is the first place Helix would run untrusted code server-side.**
Everything the platform hosts is untrusted (architecture §1), but a hosted app is
static assets, browser JS and the `/_api/*` gateway. None of the app's code runs
on our infrastructure. A build is different: `npm install` runs dependency
`postinstall` scripts and the build script runs arbitrary code, on our compute,
with whatever it can reach. §3 models that as a fourth untrusted execution zone,
and ADR [0026](../adr/0026-hosted-build-isolation-prerequisites.md) gates it
behind four launch requirements.

**The author's CI already builds the app.** GitHub Actions runs the build on
GitHub's ephemeral runners, inside GitHub's blast radius. Helix only needs to
receive the output, know where it came from, and hand it to the deploy path that
already exists.

**GitHub Actions can prove where a request came from.** A job with
`permissions: id-token: write` can request a short-lived JWT signed by GitHub,
with an audience the job chooses. Its claims name the repository (by numeric ID),
the branch, the commit, the triggering event, the workflow and the run. The
portal already verifies bearer JWTs against an issuer's JWKS (ADR
[0024](../adr/0024-portal-cli-bearer-jwt-jwks.md)), so accepting this token is one
more issuer, not a new trust model.

The result:

- **Helix runs no build.** A Shai-Hulud-class `postinstall` payload never reaches
  platform infrastructure. A chalk/debug-class payload bundled *into the served
  JS* is a different threat; it already applies to any author-built bundle, and
  its defense is unchanged: CSP and the gateway (ADR
  [0009](../adr/0009-relaxed-csp.md)/[0014](../adr/0014-same-origin-api-gateway.md)).
- **No stored credential anywhere.** The author keeps no Helix token in repo
  secrets, and Helix keeps no GitHub credential. Private repos need nothing extra,
  because the runner already has the source.
- **Deploys are as fast as the upload.** Nothing polls.

---

## 2. Crawl — CI pushes, authenticated by GitHub Actions OIDC

**Record: ADR [0051](../adr/0051-repo-backed-apps-ci-push-github-oidc.md).** The
ADR is the source of truth; this section explains how the pieces fit.

### 2.1 What the author does

Once, in the portal: connect the app to `owner/repo` and a branch.

Once, in the repo:

```yaml
# .github/workflows/helix-deploy.yml
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  id-token: write # lets the job request a GitHub-signed token for Helix
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - run: npx @azx-pbc/helix-cli deploy --portal https://portal.example.com
```

Helix ships this as a starter workflow, a `helix` command that writes it into the
repo, and a reusable workflow the author can call in a few lines. There is no
secret to add to the repo: storing a `HELIX_TOKEN` in CI secrets is not a
supported path (ADR-0051 decision 12). Owners who want
a tighter gate can pin the reusable workflow (§2.5).

### 2.2 What happens on a push

```
author push ─▶ GitHub Actions                           GitHub's infrastructure
               • npm ci && build
               • helix deploy
                   - requests an OIDC token, aud = portal origin
                   - POST /api/v1/apps/:slug/ci/versions
                     Authorization: Bearer <GitHub OIDC token>
                       │
                       ▼
               helix-portal                              control plane
               authenticateRepoDeploy (before reading the body)
               • verify signature against GitHub's JWKS; iss, aud, exp
               • load the app's binding
               • repository_id + repository_owner_id match the binding
               • ref = refs/heads/<branch>; event_name ∈ {push, workflow_dispatch}
               • optional: job_workflow_ref, environment
               • jti not already used
                       │
                       ▼
               existing deploy path                      no shortcut
               • spoolUpload → validate.ts (zip-slip, symlink, MIME, bomb)
               • csp-lint advisory • manifest approval write-gate
               • copy bytes to Blob • land as `preview` with provenance
               • a person promotes (architecture §5.1)
```

### 2.3 The binding

The binding is portal-side app config: repository `owner/name`, branch, and two
optional constraints (§2.5). Creating or changing it requires `authenticate` +
`ownsApp`, like any other app setting.

**There is no step to prove you own the repo.** A binding grants deploy rights
*into* the binder's own app. Pointing your app at someone else's repo lets their
pushes land previews of your app, which hurts nobody but you. Pointing someone
else's app at your repo requires write access to their app, which `ownsApp`
denies.

**The numeric repository ID is the identity, pinned on first use.** Repos can be
renamed or transferred, and a freed-up `owner/name` can be claimed by someone
else, so the name is not a safe long-term identifier. The first token that
verifies and whose `repository` claim matches the configured name pins
`repository_id` and `repository_owner_id` on the binding. After that, both IDs
must match and the name is display only. Requiring the owner ID means a repo
transferred to another account stops deploying until the app owner rebinds it.
Pinning from the token means the portal never calls the GitHub API, which for a
private repo would need a credential.

### 2.4 Verification

Each rule closes a specific hole:

| Rule | Why |
| --- | --- |
| `iss` = configured issuer (default `https://token.actions.githubusercontent.com`) | Only GitHub-signed tokens. Configurable for GitHub Enterprise Cloud's customized issuer and, later, GitHub Enterprise Server. |
| Signature against the issuer's JWKS; `exp`/`nbf`/`iat` valid | Standard JWT verification, same clock-skew allowance as the existing OIDC verifier. |
| `aud` = this deployment's portal origin, exactly | A token minted for another service can't be replayed here. GitHub's default audience (`https://github.com/<owner>`) is refused. |
| `repository_id`, `repository_owner_id` = the binding's pinned values | Only the bound repo, and not after a rename, reclaim or transfer. |
| `ref_type` = `branch`, `ref` = `refs/heads/<branch>` | Only the tracked branch. A `pull_request` token carries `refs/pull/<n>/merge` and fails here. |
| `event_name` ∈ {`push`, `workflow_dispatch`} | `pull_request_target`, `workflow_run` and `issue_comment` run with the base branch's `ref` on behalf of someone who may not have push access. An allowlist keeps new event types out by default. |
| `jti` not already recorded on a version | A captured token can't produce a second version. A deploy that fails validation doesn't consume it, so a retry within the token's lifetime works. |

### 2.5 Optional constraints

Without these, anyone who can push to the bound branch can deploy a preview. That
is the boundary `helix deploy` with a stored token already has. Owners can narrow
it:

- **Workflow pin.** `job_workflow_ref` must equal a given value, such as the
  Helix reusable workflow at a tag. Stops a different workflow on the same branch
  from deploying.
- **Environment.** `environment` must equal a given name. GitHub's environment
  protection rules (required reviewers, wait timers, branch restrictions) then
  apply before the job can get a token at all.

### 2.6 What a GitHub token can do

**Exactly one thing: create a preview version of the bound app.** The GitHub
verifier is not part of the shared verifier chain behind `authenticate`. If it
were, a GitHub-signed token would pass every route that only checks sign-in. One
route, `POST /api/v1/apps/:slug/ci/versions`, uses its own preHandler,
`authenticateRepoDeploy`, which yields a workload principal (repo ID, ref, sha,
run ID, GitHub `actor` login) rather than an `Actor`. A GitHub token cannot
promote, roll back, edit the binding, change access or capabilities, or mint dev
tokens.

The preHandler runs before the handler reads the multipart body, so a refused
request never spools an upload.

The route sits outside the Entra perimeter: Conditional Access governs Entra
sign-ins, and a GitHub token never passes through Entra. The controls on this
route are GitHub's (branch protection, rulesets, environments), and its authority
is limited to a preview behind the promote gate.

### 2.7 CLI

When `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` are set
and `HELIX_TOKEN` is not, `helix deploy` requests an ID token with `audience` set
to the portal origin (from `GET /api/v1/config`) and uploads to the CI route. An
explicit `HELIX_TOKEN` still takes the normal route, so existing CI setups keep
working.

### 2.8 Schema sketch (portal-owned, as always)

- **`repo_bindings`** — `(appId unique, provider, repoFullName, branch,
  repositoryId?, repositoryOwnerId?, workflowRef?, environment?, createdBy,
  createdAt, updatedAt)`. The two IDs are null until the first deploy pins them.
- **`Version`** gains its source: `sourceProvider`, `sourceRepositoryId`,
  `sourceRef`, `sourceCommitSha`, `sourceWorkflowRef`, `sourceRunId`,
  `sourceRunAttempt`, and `sourceTokenJti` (unique). This preserves ADR
  [0018](../adr/0018-deploy-model-immutable-versions.md) immutability and makes
  "which commit and run produced this version" answerable in the portal.

Binding changes and CI deploys write `audit_events` rows. A token that is
GitHub-signed but fails the binding check also writes one. A token that fails
signature verification does not, so unauthenticated noise cannot fill the table.

### 2.9 Telemetry

The CI route gets a root span `helix.deploy.repo` (wrapping the existing
`helix.deploy.bundle`) and a counter `helix.deploy.repo_requests` with a bounded
`outcome`: `accepted` or one of the denial reasons. Refusals also log at `warn`
with `event: "repo_deploy.denied"`. The token, the GitHub `actor` login and the
repo name are never attributes or dimensions. See ADR
[0051](../adr/0051-repo-backed-apps-ci-push-github-oidc.md) Consequences.

### 2.10 Threat model (abridged — see ADR [0051](../adr/0051-repo-backed-apps-ci-push-github-oidc.md) for the full table)

| Threat | Mitigation |
| --- | --- |
| Malicious dependency `postinstall` runs on platform infra | Structurally impossible — Helix runs no build |
| Token for another service replayed to Helix | Exact `aud` match; default audience refused (§2.4) |
| Valid token from a repo the attacker controls | `repository_id` + `repository_owner_id` must match (§2.3) |
| Repo renamed, reclaimed or transferred | IDs pinned on first use; owner ID check (§2.3) |
| Fork / PR workflow deploys | `ref` check and `event_name` allowlist (§2.4) |
| Another workflow on the branch deploys | Optional workflow pin (§2.5) |
| GitHub token used on other portal routes | Not in the `authenticate` chain; one route only (§2.6) |
| Captured token replayed | Unique `jti` per version (§2.4) |
| Unauthenticated uploads | Refused before the body is read (§2.6) |
| Malicious bundle reaches live traffic | Lands as `preview`; a person promotes |
| Payload bundled into served JS (chalk/debug class) | **Unchanged, out of scope** — CSP + gateway |

**Limits.** A malicious dependency in the author's build can steal the author's
own CI credentials on GitHub's runner, and can tamper with the bundle before it is
uploaded. That risk sits with the author, who already owns it. Helix's exposure is
a preview of that one app, behind the promote gate.

### 2.11 Requirements, phasing and open questions

**Reachability.** The runner must reach the portal. `portalExternal` defaults to
`true`, so GitHub-hosted runners work out of the box; an install that sets it to
`false` needs a self-hosted or privately networked runner.

1. **Verifier, binding and route,** with the adversarial tests.
2. **CLI and workflows:** token exchange in `helix deploy`, starter workflow,
   reusable workflow.
3. **Portal UX:** connect-repo on the app's settings, pinned identity, optional
   pins, per-version commit and run links.
4. **Later:** GitLab CI, Azure Pipelines and Bitbucket Pipelines (all issue OIDC
   tokens with repo and branch claims), GitHub Enterprise Server, several branches
   per app, PR preview environments.

Settled at acceptance (ADR-0051, 2026-10-19): no auto-promote, so CI deploys
always land as a preview; one binding per app; `portalExternal` defaults to
`true`; and a stored `HELIX_TOKEN` is not a supported way to deploy from CI.

---

## 3. Run — hosted build (deferred)

**Record: ADR [0026](../adr/0026-hosted-build-isolation-prerequisites.md), whose
four launch gates apply unchanged if this is ever built.** Everything below was
the original design for this document and remains correct; it is deferred, not
wrong.

### 3.1 The framing

A hosted build is a **fourth untrusted execution zone**, wired with the seams the
platform already has rather than a new trust model:

- the **policy/mechanism split** (edge→egress, architecture §3) — the thing that
  holds the secret is never the thing that runs untrusted code;
- the **`SecretStore` custody seam** — where the git credential of record lives,
  unreadable by the build;
- the **preview-then-promote gate** — the build's output rejoins the *existing*
  validated path; it gets no privileged shortcut.

| Failure mode | Prevented by |
| --- | --- |
| Malicious build code / dependency exfiltrates the git credential | **Credential never enters the build zone** (§3.2) |
| Owning a pool of warm, reset-between-builds nodes becomes ops hell | **Ephemeral-by-construction**: one container per build, destroyed after (§3.3) |

### 3.2 The credential never enters the build

This is the whole security argument; everything else is mechanics. The dangerous
coupling is not "we run a build" — it is "we run untrusted code *next to a git
credential*." A dependency's `postinstall` can read the environment, the
filesystem and `~/.git-credentials` in milliseconds. So split the clone from the
build exactly as the edge splits authz from egress:

1. **Store a GitHub App private key** (not a PAT or deploy key) in `SecretStore`,
   with no `helix_edge` grant.
2. **A privileged fetcher** (mechanism zone) mints a short-lived installation
   token, clones with it, and discards it.
3. The fetcher hands the build container a **credential-less checkout** — a
   tarball on a read-only mount, `.git/config` carrying no remote credential, no
   `~/.gitconfig` and no credential helper present.

The worst a compromised build can do with "git" is read the customer's own source
it was handed.

### 3.3 The build is ephemeral by construction

Clearing state between builds is a correctness burden you own forever, and a warm
container holding a standing credential is a fat, long-lived target. So go one
step past reset — **destroy**. One container per build; it does exactly one build
and exits.

- **Runtime:** Azure Container Instances (one-shot) or Container Apps Jobs
  (KEDA-driven, scale-to-zero). No pool, no warm nodes, no hygiene sweep, no
  reset logic to get wrong. Cold start is irrelevant for a build.
- **Lock the box down:** non-root, read-only rootfs + `tmpfs` work dir, `seccomp`
  default + `no-new-privileges`, CPU/memory caps, and a hard wall-clock timeout.
- **`npm install --ignore-scripts` as the default** — defense-in-depth only (ADR
  [0026](../adr/0026-hosted-build-isolation-prerequisites.md) is explicit that it
  is *not* a substitute for credential-free isolation, and it breaks esbuild
  native bindings, node-gyp, husky). Per-app opt-out routes through the approval
  write-gate.
- **Outbound network:** the build needs the package registry. Open outbound is
  acceptable while the only material in the box is the customer's own source and
  there is no secret to exfiltrate — `log()` the relaxation so it is never
  mistaken for "locked down." Tighten to an allowlist proxy when private
  registries or native builds arrive.

### 3.4 Wiring

```
GitHub push ─▶ webhook ─▶ helix-portal                     control plane
                          • verify HMAC (X-Hub-Signature-256)
                          • match installation + tracked branch, enqueue
                                  ▼
                          fetcher (mechanism zone)        holds the secret
                          • mint installation token, clone
                          • produce credential-less checkout
                                  ▼  read-only checkout, no credential
                          build job (ACI / Container Apps Job)  untrusted exec zone
                          • one-shot, sandboxed, --ignore-scripts default
                          • run declared build → artifact
                                  ▼  same artifact `helix deploy` produces
                          helix-portal deploy API ─▶ preview version  existing gate
```

**The output rejoins the existing path.** The build emits the same zip
`helix deploy` produces and POSTs it with a scoped build token; it does not write
the registry, the live pointer, or Blob directly. So it inherits `validate.ts`,
the CSP lint, the approval write-gate and preview-then-promote for nothing. The
worst a compromised build achieves is submitting a malicious *preview*.

Schema: **`git_connections`** `(appId, provider, installationId, repoFullName,
trackedBranch, buildCommand, outputDir, ignoreScripts)` and **`builds`**
`(id, appId, connectionId, commitSha, status, startedAt, finishedAt,
logBlobPrefix, resultingVersionId?)` with status
`queued | cloning | building | uploaded | promoted | failed | timed_out`. Build
logs are untrusted bytes — stream to Blob, never interpolate into the portal UI
unescaped.

### 3.5 Threat model

| Threat | Mitigation |
| --- | --- |
| Malicious dependency `postinstall` exfiltrates a credential | No credential in the build zone (§3.2); `--ignore-scripts` default (§3.3) |
| Build escapes its work dir into the next build | One-shot container, destroyed after (§3.3) |
| Crypto-miner / fork-bomb / hung build | CPU/mem caps + hard wall-clock timeout (§3.3) |
| Stolen/leaked clone credential | GitHub App installation token: ~1 h TTL, repo-scoped, revocable (§3.2) |
| Build writes a malicious version live, skipping review | Build can only submit a **preview** (§3.4) |
| Forged / replayed webhook triggers builds | HMAC-verify `X-Hub-Signature-256`; reject otherwise (§3.4) |
| Build log injection into the portal UI (stored XSS) | Logs stored in Blob, escaped on render (§3.4) |
| Source exfiltration via open build egress | Accepted: only the customer's own source is present — but logged, not silent (§3.3) |

**Honest limits.** The fetcher still holds a path to the App key and a brief
plaintext installation token; extraction *relocates* that exposure into the
mechanism zone, it does not eliminate it. And open build egress means a
determined build can phone home with the source it was handed — the customer's
own code, so the trade is deliberate.

### 3.6 Open questions (unchanged)

Orchestrator home (fold into `helix-egress` vs. a new `apps/build-orchestrator` —
leaning separate: egress is request/response-shaped and dependency-minimal, a job
runner has a different lifecycle); ACI vs. Container Apps Jobs against real
latency and cost numbers; how many real vibe-coded apps `--ignore-scripts`
breaks; whether to require a committed lockfile and pin the toolchain image; and
per-app plus platform-wide build concurrency caps so a push storm cannot fan out
unbounded paid containers.


---

## 4. What crawl does not solve

§2 is cheaper and safer than §3 on every axis but one, and that one is why §3 is
kept: **§2 assumes the author has working CI.**

The platform's target user is often a vibe-coder. Adding a GitHub Actions
workflow is a real ask of someone whose mental model stops at "I made an app."
Mitigations, in order of how much they help:

- **Ship the workflow.** A starter file, plus a `helix` command that writes it
  into the repo, makes this a copy-paste. The workflow holds no secret, so there
  is nothing to configure in the repo's settings.
- **A reusable workflow** the author calls in a few lines, so changes to the
  build and deploy steps don't require every repo to change.
- Neither helps an author with **no GitHub repo at all**, or an agent-generated
  app that never touches GitHub. That is the remaining gap, and it is what §3
  exists for.

Also out of scope for both rungs:

- **Letting *running* apps read private repos at runtime.** That is a fetch-proxy
  connection (`fetch-proxy.md`), not this.
- **Monorepo multi-app fan-out**, build matrices, caching layers.
- **PR preview environments.** They need ephemeral subdomains.

## 5. Related

- ADR [0051](../adr/0051-repo-backed-apps-ci-push-github-oidc.md) — the crawl
  rung's decision record (full threat table, decisions, open questions).
- ADR [0030](../adr/0030-repo-backed-apps-pull-attested-artifacts.md) — the
  superseded pull model, kept as a record.
- ADR [0026](../adr/0026-hosted-build-isolation-prerequisites.md) — the run
  rung's launch gates.
- ADR [0024](../adr/0024-portal-cli-bearer-jwt-jwks.md) — the portal's bearer JWT
  verification that the GitHub verifier sits beside.
- ADR [0018](../adr/0018-deploy-model-immutable-versions.md) /
  `docs/features/registry-and-deploys.md` — the preview-then-promote gate both
  rungs rejoin.
- ADR [0028](../adr/0028-deployment-model-customer-deployed.md) — customer-deployed,
  which makes portal reachability a per-install setting.
- `docs/design/secrets-and-connections.md` — the `SecretStore` custody seam (§3).
- `docs/design/fetch-proxy.md` — the policy/mechanism split §3 borrows.
- architecture §3 (three planes), §5.1 (deploy), §10 (threat model).
