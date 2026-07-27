# Git connections (deploy-from-repo)

**Status: design, not built.** The deploy path today is upload-only (`azx deploy`
zips a build dir, or the portal takes a multipart zip; architecture §5). This doc
proposes the missing rung: **connect a git repo, and a push lands a preview
version.**

There are **two rungs**, and the order flipped in 2026-07:

| Rung | Model | Who builds | Record |
| --- | --- | --- | --- |
| **Crawl** (§2) | Helix **pulls** a CI-built, attested artifact | the author's CI | ADR [0030](../adr/0030-repo-backed-apps-pull-attested-artifacts.md) |
| **Run** (§3) | Helix clones and **builds** the repo | Helix | ADR [0026](../adr/0026-hosted-build-isolation-prerequisites.md) — deferred |

This document originally described only the "run" rung. That design is preserved
in §3, intact and still correct, because it remains the answer for authors who
have no CI (§4). But it is **no longer the next thing to build** — §2 is, and it
gets to production without Helix ever executing app code.

## 1. Why the order flipped

The "run" rung's whole difficulty is that **a git build is the first place Helix
runs untrusted code server-side.** Everything the platform hosts today is
untrusted (architecture §1), but a hosted app is static assets + browser JS + the
`/_api/*` gateway — none of the *app's* code executes on our infrastructure. A
build is categorically different: `npm install` runs dependency `postinstall`
scripts and the build script runs arbitrary code, **on our compute, with whatever
it can reach.** Building vibe-coded apps is remote code execution by design. §3
models that as a fourth untrusted execution zone and wires it accordingly; ADR
[0026](../adr/0026-hosted-build-isolation-prerequisites.md) gates it behind four
non-negotiable launch requirements.

The reframing that makes almost all of that unnecessary: **the author's CI
already builds the app.** GitHub Actions runs the build, on GitHub's ephemeral
runners, in GitHub's blast radius, and can publish the result to a GitHub-native
artifact store. Helix does not need to run the build to consume the output — it
needs to *fetch* it, *verify where it came from*, and hand it to the deploy path
that already exists.

Three properties follow, and they are the whole argument:

1. **Helix only ever reads.** The author's CI never calls Helix. Nobody asks
   Helix to perform a privileged action on their say-so, so no authority is
   delegated, so **there is no inbound authentication problem to solve.** This is
   the source of nearly all the saving — it is not merely "a smaller build
   service."
2. **Provenance gets stronger, not weaker.** A Helix-run builder can only ever
   *self*-attest; compromise it and it forges its own provenance.
   `actions/attest-build-provenance` produces a **Sigstore-signed** attestation
   whose certificate is issued by Fulcio against the workflow's OIDC identity —
   a *third-party* claim about origin, bound to the bytes, that a compromised app
   repo cannot forge.
3. **The dangerous threat class never arrives.** A Shai-Hulud-class `postinstall`
   payload is the threat hosted builds would *introduce*; §2 never introduces it.
   A chalk/debug-class payload bundled *into the served JS* already threatens the
   platform today via any author-built bundle, and its defense is unchanged: CSP
   + the gateway (ADR [0009](../adr/0009-relaxed-csp.md)/[0014](../adr/0014-same-origin-api-gateway.md)).
   The two must not be conflated.

---

## 2. Crawl — pull a CI-built attested artifact

**Record: ADR [0030](../adr/0030-repo-backed-apps-pull-attested-artifacts.md).**
Helix runs no build, clones no repository, and executes no app code or dependency
script — ever.

### 2.1 What the author does

Once, in their repo:

```yaml
# .github/workflows/deploy.yml
permissions:
  contents: read
  packages: write
  id-token: write      # for the attestation, not for talking to Helix
  attestations: write
steps:
  - run: npm ci && npm run build
  - uses: oras-project/setup-oras@v1
  - run: oras push ghcr.io/${{ github.repository }}/helix-app:main ./dist
  - uses: actions/attest-build-provenance@v1
    with: { subject-name: ghcr.io/${{ github.repository }}/helix-app, ... }
  - run: curl -fsS -X POST https://portal.example/poke/my-app || true   # optional
```

Helix ships this as a starter workflow (and an `azx` command that writes it), so
the author's job is a copy-paste. **Note the poke is `|| true`** — it is a hint,
never a dependency (§2.4).

### 2.2 What Helix does

```
author push ─▶ GitHub Actions              GitHub's infrastructure, GitHub's blast radius
               • npm ci && build
               • oras push  → GHCR
               • attest-build-provenance → Sigstore-signed provenance
                       │
                       ▼
               GHCR  ghcr.io/owner/repo/helix-app@sha256:…     transport, not the serving store
                       │
      poll (floor) ────┤  or  poke (latency optimization)
                       ▼
               azx-portal drain worker                          control plane
               • resolve tag → digest (manifest only, ~hundreds of bytes)
               • unchanged? stop.  ← bounds amplification to ~1
               • pull layer by digest
               • verify attestation: repository_id == binding, ref, event_name
                       │
                       ▼
               existing deploy path                             no shortcut
               • validate.ts (zip-slip, symlink, MIME, bomb)
               • csp-lint advisory • manifest approval write-gate
               • copy bytes to Blob • land as `preview`
               • human promotes (architecture §5.1)
```

**The artifact store is transport, not the serving store.** Bytes are copied into
Helix's own Blob at intake, as today. A GHCR outage or a deleted package delays a
*deploy*; it never takes a live app down.

### 2.3 The binding is portal-side app config

The owner types the repo/package into app settings, gated by the existing
`ownsApp` authz (`apps/portal/src/plugins/auth.ts`). **There is no
ownership-proof ceremony**, and it would not buy anything:

- Binding *someone else's public* repo is harmless — it is `curl` with extra
  steps, granting no access the binder did not already have.
- Binding *your* repo to *my* app requires portal write access to your app, which
  `ownsApp` already denies.
- For *private* repos the confused-deputy risk is real (Helix's credential
  out-ranks the binder's), and the control is GitHub's **installation scope**
  (§2.6) — authorization inherited, not adjudicated.

**The one thing bind time must do is resolve the repo name to its immutable
numeric `repository_id`** and store that. Repos are renamable and a freed-up
`owner/name` can be reclaimed by a third party, so the name string is not a safe
long-term identifier — and that ID is what the attestation check compares against
(§2.5).

### 2.4 Trigger: polling is the floor, poke is an optimization

**Polling must be sufficient on its own.** Under ADR
[0028](../adr/0028-deployment-model-customer-deployed.md) the portal is
internal-ingress by default (`infra/azure/main.bicep:147`, `portalExternal =
false`) and Entra-gated when exposed (`infra/azure/README.md:145`) — a meaningful
fraction of deployments can receive **no** inbound call from GitHub at all. Build
for that case and everything else is gravy.

**`POST /poke/:slug`** — no auth, no payload, no authority; a pure "wake up and
check" hint. This is *preferred over a GitHub webhook precisely because it
carries nothing*: an HMAC webhook costs a shared secret per repo (storage,
rotation, config UX) and delivers a payload you must then treat as trusted input.
The poke has neither, and forging it is meaningless — everything the deploy
depends on is fetched and verified by Helix independently.

Design notes:

- **Coalesce; do not rate-limit-reject.** A poke sets a dirty flag (`checkDueAt`
  on the binding row); a worker drains dirty bindings at most once per interval.
  10,000 pokes and 1 poke then do **identical work** — hammering is free rather
  than merely bounded, and the flag is replica-safe because it is a DB column.
  Where a hard limiter is also wanted, use the `CounterStore` / `rate_counters`
  primitive from the ADR [0011](../adr/0011-in-memory-rate-limiting.md)
  resolution (atomic cross-replica upsert), never an in-memory map.
- **Manifest-first.** Resolve the OCI manifest before pulling any layer, so one
  cheap inbound request cannot trigger an expensive outbound download.
- **Return `202` unconditionally.** Slugs are already public as subdomains (ADR
  [0019](../adr/0019-subdomain-per-app-isolation.md)), so enumeration is a
  non-concern — but there is no reason to leak existence either.

Because the poke carries no authority, it is the *one* control-plane route that
could plausibly be exposed publicly even where the rest of the portal
deliberately is not. That is an open question (§2.9), not a blocker — polling is
the floor.

### 2.5 Verification, and the mistake to avoid

Checking that "a valid attestation exists" is **not enough.** Anyone able to
write the package could publish bytes carrying an *honest* attestation from a
different repository, and a sloppy verifier waves it through. The verifier must:

1. assert the attestation's **`repository_id` equals the binding's stored ID**
   (§2.3) — this is what that ID is for;
2. constrain **`ref`** to the tracked branch;
3. reject **`event_name`** of `pull_request` / `pull_request_target` — the
   fork-poisoning guard;
4. record the resolved **digest** on the version; tags are lookup only, never
   identity.

**GitHub Actions OIDC is not part of this path.** In a pull model the CI never
talks to Helix, so there is no live token to present. The workflow's OIDC
identity still reaches Helix — *embedded in the Sigstore attestation*, bound to
the bytes and verifiable offline, which is the stronger form of the same claim.
(OIDC remains worth adopting on the **separate direct-upload path**, where
`azx deploy` from CI today carries a long-lived portal token in repo secrets;
that is ADR [0024](../adr/0024-portal-cli-bearer-jwt-jwks.md) verifier-chain work,
not this feature.)

**The trust boundary, stated plainly:** provenance proves origin, not safety.
Whoever can publish to the bound package can land a **preview** of the bound app.
That set is approximately whoever has push access to the repo — *exactly* the
boundary already accepted for `azx deploy`, so it is not a regression. The human
promote gate (architecture §5.1) is what stands between a preview and traffic.

### 2.6 Private repos: the GitHub App

**The public path needs no credential at all.** When private repos or packages
are in scope:

- The credential of record is a **GitHub App private key** in the existing
  `SecretStore` seam (ADR [0006](../adr/0006-secret-custody-seam.md)) — not a
  PAT, not a deploy key. Installation access tokens are ~1 h, repo-scoped and
  centrally revocable, and can be scoped *below* the installation grant via the
  `repositories` / `permissions` body on
  `POST /app/installations/{id}/access_tokens`.
- **Confused-deputy control comes from GitHub's installation scope**, not a
  Helix-side proof: the token simply cannot read repos the customer did not
  install the app on. Bind-time validation ("we can't see that repo — is the app
  installed?") is UX, not a security control.
- **Under ADR [0028](../adr/0028-deployment-model-customer-deployed.md), each
  customer deployment registers its own App.** One Helix-owned App would require
  shipping its private key into every customer deployment, letting each
  customer's Helix mint tokens for every other customer's installation —
  disqualifying. Onboarding uses the **GitHub App Manifest flow**
  (`github.com/settings/apps/new?manifest=…`), which exists for exactly this
  self-hosted case: the customer confirms once and GitHub returns the generated
  private key, webhook secret and client credentials in a single exchange,
  straight into `SecretStore`.
- Handle `installation.deleted` / `installation_repositories` so revoked bindings
  fail loudly rather than silently.

> **Unverified, and load-bearing.** Whether a *third-party* App's installation
> token authenticates to **GHCR for private container packages** is not settled.
> The mechanism is not categorically impossible — Actions' `GITHUB_TOKEN` *is* an
> installation token and works against GHCR — but private package access has
> historically been governed by per-package access lists rather than repo
> permissions. **Verify empirically before building phase 3.** If it does not
> work cleanly, the fallback is **GitHub Releases** as the private-path backend,
> where installation tokens definitely work. This is the strongest argument for
> keeping Releases first-class rather than going GHCR-only.

### 2.7 Schema sketch (portal-owned, as always)

- **`git_bindings`** — `(appId, provider, repositoryId, repoFullName,
  artifactRef, trackedRef, checkDueAt, lastSeenDigest, lastCheckedAt,
  lastError?)`. `repositoryId` is the immutable numeric ID and is the field the
  attestation is checked against; `repoFullName` is display only. The GitHub App
  private key is **not** here — it is one platform-level secret in `SecretStore`.
- **`Version`** gains the provenance it landed with: `sourceDigest`,
  `sourceCommitSha`, `sourceRepositoryId`. Preserves ADR
  [0018](../adr/0018-deploy-model-immutable-versions.md) immutability; makes
  "where did this bundle come from" answerable in the portal.

Each transition writes an `audit_events` row (`binding.check`, `binding.pull`,
`binding.reject`, …) like every other mutation.

### 2.8 Threat model (abridged — see ADR [0030](../adr/0030-repo-backed-apps-pull-attested-artifacts.md) for the full table)

| Threat | Mitigation |
| --- | --- |
| Malicious dependency `postinstall` runs on platform infra | Structurally impossible — Helix runs no build |
| Bytes attested from a repo the attacker controls | Attestation `repository_id` must equal the binding's stored ID (§2.5) |
| Repo renamed / `owner/name` reclaimed by a third party | Binding stores the immutable numeric ID, not the name (§2.3) |
| Tag moved to a malicious image | Digest resolved, pinned and recorded; tag is lookup only (§2.5) |
| Fork / PR workflow publishes an artifact | Attestation `ref` + `event_name` constrained (§2.5) |
| Poke used to DoS or amplify | Coalesce-to-dirty-flag + manifest-first check (§2.4) |
| Poke used to inject a deploy | Carries no authority or payload; Helix verifies everything itself (§2.4) |
| Confused deputy on a private repo | GitHub App installation scope (§2.6) |
| Cross-customer token minting | Per-deployment App via the Manifest flow (§2.6) |
| Malicious artifact reaches live traffic | Lands as `preview`; human promote (architecture §5.1) |
| Payload bundled into served JS (chalk/debug class) | **Unchanged, out of scope** — CSP + gateway |

**Honest limits.** For private repos the portal (or a mechanism-zone fetcher)
holds a path to the App key and briefly a plaintext installation token — that is
exposure, not its absence, though materially milder than §3's case because no
untrusted code runs next to it. And a malicious dependency in the author's build
can steal the author's own CI credentials on GitHub's runner; that risk lives
with the author, who already owns it, and Helix's exposure is bounded to a
*preview* of that one app behind the promote gate.

### 2.9 Phasing and open questions

1. **Public repos, public packages, poll-only.** Binding + ID resolution, drain
   worker, OCI pull by digest, attestation verify, hand to the existing deploy
   API. No credential anywhere.
2. **`POST /poke/:slug`.** Dirty flag + coalescing drain.
3. **Private repos/packages.** GitHub App via the Manifest flow, `SecretStore`,
   installation tokens, `installation.*` webhooks. *Gated on the GHCR question
   in §2.6.*
4. **Portal UX.** Connect-repo in `apps/portal-web`, binding history,
   last-checked / last-digest, manual "check now."
5. **Later.** GitLab / Bitbucket / Azure DevOps (all have comparable OIDC +
   registry stories); monorepo fan-out; PR preview environments.

Open: the GHCR/installation-token question (§2.6); whether unattested artifacts
are rejected outright or allowed behind an approval-gated per-binding opt-out;
how `/poke/:slug` is exposed when the portal is internal or Entra-gated (a
carved-out unauthenticated path is preferred — the route is provably inert —
but *nothing is blocked*, since polling is the floor); whether Releases is
first-class or fallback; and where the drain worker lives (it holds the App key
path in phase 3, the mechanism-zone argument that made `azx-egress` its own
deployable — but it runs no untrusted code, which was the reason that actually
mattered).

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
GitHub push ─▶ webhook ─▶ azx-portal                     control plane
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
                                  ▼  same artifact `azx deploy` produces
                          azx-portal deploy API ─▶ preview version  existing gate
```

**The output rejoins the existing path.** The build emits the same zip
`azx deploy` produces and POSTs it with a scoped build token; it does not write
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

Orchestrator home (fold into `azx-egress` vs. a new `apps/build-orchestrator` —
leaning separate: egress is request/response-shaped and dependency-minimal, a job
runner has a different lifecycle); ACI vs. Container Apps Jobs against real
latency and cost numbers; how many real vibe-coded apps `--ignore-scripts`
breaks; whether to require a committed lockfile and pin the toolchain image; and
per-app plus platform-wide build concurrency caps so a push storm cannot fan out
unbounded paid containers.

---

## 4. What crawl deliberately does not solve

§2 is cheaper and safer on every axis but one, and the gap is worth naming
because it is the reason §3 survives: **§2 assumes the author has working CI.**

The platform's target user is a vibe-coder. "Add a GitHub Actions workflow that
builds, pushes an OCI artifact with ORAS, and attests it" is a real ask of
someone whose mental model stops at "I made an app." Mitigations, in order of
how much they help:

- **Ship the workflow.** A starter file plus an `azx` command that writes it into
  the repo turns this into a copy-paste. Most of the gap closes here.
- **A reusable workflow** (`azxlabs/deploy@v1`) the author calls in five lines,
  so upgrades to the build/attest steps do not require every repo to change.
- Neither helps an author with **no GitHub repo at all**, or an agent-generated
  app that never touches GitHub. That is the genuine residual, and it is the
  scenario §3 exists for.

Also out of scope for both rungs, as before:

- **Letting *running* apps read private repos at runtime** — that is a
  fetch-proxy connection (`fetch-proxy.md`), not this.
- **Monorepo multi-app fan-out**, build matrices, caching layers.
- **PR preview environments** — needs ephemeral subdomains.

## 5. Related

- ADR [0030](../adr/0030-repo-backed-apps-pull-attested-artifacts.md) — the crawl
  rung's decision record (full threat table, decisions, open questions).
- ADR [0026](../adr/0026-hosted-build-isolation-prerequisites.md) — the run
  rung's launch gates.
- ADR [0018](../adr/0018-deploy-model-immutable-versions.md) /
  `docs/features/registry-and-deploys.md` — the preview-then-promote gate both
  rungs rejoin.
- ADR [0028](../adr/0028-deployment-model-customer-deployed.md) — customer-deployed,
  which drives the per-deployment GitHub App and the reachability floor.
- `docs/design/secrets-and-connections.md` — the `SecretStore` custody seam.
- `docs/design/fetch-proxy.md` — the policy/mechanism split both rungs borrow.
- architecture §3 (three planes), §5.1 (deploy), §10 (threat model).
