# 0030. Repo-backed apps: pull CI-built attested artifacts (no hosted build)

**Status:** Proposed (2026-07-27)
**Related:** ADR [0026](0026-hosted-build-isolation-prerequisites.md) (hosted-build isolation prerequisites — the alternative this displaces), [0018](0018-deploy-model-immutable-versions.md) (upload-only, immutable versions — the path this rejoins), [0020](0020-static-only-apps-v1.md) (static-only apps), [0028](0028-deployment-model-customer-deployed.md) (single-tenant, customer-deployed — the constraint that shapes credentials and reachability), [0006](0006-secret-custody-seam.md) (`SecretStore`), [0024](0024-portal-cli-bearer-jwt-jwks.md) (bearer JWT / JWKS verifier chain), [0011](0011-in-memory-rate-limiting.md) (superseded — the `CounterStore` / `rate_counters` primitive this reuses). **Design:** `docs/design/git-connections.md` (predates this ADR; its §4 build-sandbox mechanics are displaced — see Consequences).

## Context

Deploys today are **upload-only** (ADR [0018](0018-deploy-model-immutable-versions.md)): `azx deploy` zips a prebuilt bundle and POSTs it. The missing rung is "connect a repo, and a push becomes a preview version."

`docs/design/git-connections.md` proposed getting there by **cloning and building on platform infrastructure**, and ADR [0026](0026-hosted-build-isolation-prerequisites.md) gated that behind four non-negotiable launch gates (credential-free builder, ephemeral-by-construction, network-restricted install, build provenance) precisely because building untrusted code *is* executing it — a fourth untrusted execution zone, with Shai-Hulud-class `postinstall` credential theft as the live threat.

The reframing that makes almost all of that unnecessary: **the author's CI already builds the app.** GitHub Actions runs the build, in GitHub's blast radius, on GitHub's ephemeral runners, and can publish the result to a GitHub-native artifact store. Helix does not need to run the build to consume the output — it needs to *fetch* it, *verify where it came from*, and hand it to the deploy path that already exists.

Three properties of this shape drive the decision:

1. **Helix only ever reads.** In a pull model the author's CI never calls Helix. Nobody asks Helix to perform a privileged action on their say-so, so no authority is delegated, so there is **no inbound authentication problem to solve**. This is the source of nearly all the cost saving; it is not merely "a smaller build service."
2. **Provenance gets *stronger*, not weaker.** ADR [0026](0026-hosted-build-isolation-prerequisites.md)'s gate 4 wanted a SLSA/in-toto attestation so a compromised builder's forged artifact is detectable. A Helix-run builder can only ever *self*-attest — compromise it and it forges its own provenance. `actions/attest-build-provenance` produces a **Sigstore-signed** attestation whose signing certificate is issued by Fulcio against the workflow's OIDC identity, carrying `repository`, `repository_id`, `ref`, `workflow_ref`, `sha`, `event_name`. That is a **third-party** claim about origin, bound to the bytes, verifiable offline, that a compromised app repo cannot forge.
3. **The build-host threat class disappears; the bundled-output threat class is unchanged.** ADR [0026](0026-hosted-build-isolation-prerequisites.md) draws this distinction and it holds here: a Shai-Hulud-class `postinstall` payload is the threat hosted builds would have *introduced*, and this decision never introduces it. A chalk/debug-class payload bundled *into the served JS* already threatens the platform today via any author-built bundle; its defense remains CSP + the gateway (ADR [0009](0009-relaxed-csp.md)/[0014](0014-same-origin-api-gateway.md)) and is untouched either way. The two must not be conflated.

## Decision

Ship **repo-backed apps as pull-only over a CI-published, attested artifact**. Helix runs no build, clones no repository, and executes no app code or dependency script — ever.

1. **No hosted build.** ADR [0026](0026-hosted-build-isolation-prerequisites.md) is not superseded: its four gates remain in force *if* hosted builds are ever revisited. This decision removes the motivation for revisiting them.

2. **Artifact transport: an OCI artifact in GHCR, addressed by digest.** The author's workflow pushes the built bundle (ORAS) to `ghcr.io/<owner>/<repo>/<package>`. Digest (`sha256:…`) is the identity; tags (`main`) are a mutable lookup that Helix resolves and then **pins**. Rationale: content-addressing matches ADR [0018](0018-deploy-model-immutable-versions.md)'s immutable-version model exactly, and OCI 1.1's referrers API puts the attestation next to the artifact. **GitHub Releases assets are a supported second backend** (durable, installation-token-readable, no digest in the identity — Helix records the sha itself); see Open questions.

3. **The artifact store is transport, not the serving store.** Bytes are copied into Helix's own Blob at intake, as today. A GHCR outage or a deleted package must never take a live app down, and the edge's serving path is unchanged.

4. **The binding is portal-side app config; no ownership ceremony.** The owner types the repo/package into app settings, gated by the existing `ownsApp` authz (`apps/portal/src/plugins/auth.ts`). Binding *someone else's* public repo is harmless — it is `curl` with extra steps, granting no access the binder did not already have. Binding *your* repo to *my* app requires portal write access to your app, which `ownsApp` already denies. **The one thing bind time must do is resolve the repo name to its immutable numeric `repository_id`** and store that: repos are renamable and a freed-up `owner/name` can be reclaimed by a third party, so the name string is not a safe long-term identifier.

5. **Trigger: polling is the floor; an unauthenticated poke is a latency optimization.**
   - **Polling** must be sufficient on its own. Under ADR [0028](0028-deployment-model-customer-deployed.md) the portal is internal-ingress by default (`infra/azure/main.bicep:147`, `portalExternal = false`) and Entra-gated when exposed (`infra/azure/README.md:145`), so a meaningful fraction of deployments can receive **no** inbound call from GitHub at all. The system must be correct with polling alone.
   - **`POST /poke/:slug`** — no auth, no payload, no authority; a pure "wake up and check" hint. It is preferred over a GitHub webhook precisely *because* it carries nothing: an HMAC webhook costs a shared secret per repo (storage, rotation, config UX) and delivers a payload that must be parsed as trusted input. The poke has neither, and forging it is meaningless because everything the deploy depends on is fetched and verified by Helix independently.
   - **Coalesce, do not rate-limit-reject.** A poke sets a dirty flag (`checkDueAt` on the binding row); a worker drains dirty bindings at most once per interval. 10,000 pokes and 1 poke then do *identical* work — hammering is free rather than merely bounded, and the flag is replica-safe because it is a DB column. Where a hard limiter is also wanted, use the existing `CounterStore` / `rate_counters` primitive from the ADR [0011](0011-in-memory-rate-limiting.md) resolution (atomic cross-replica upsert), not an in-memory map.
   - **Bound the amplification.** A poke resolves the OCI **manifest** first (hundreds of bytes) and downloads the layer only when the digest differs from the live version.
   - Return `202` unconditionally. Slugs are already public as subdomains (ADR [0019](0019-subdomain-per-app-isolation.md)), so enumeration is a non-concern, but there is no reason to leak existence either.

6. **No inbound authentication on this path, by construction.** Authorization is *inherited from GitHub*: whoever can publish to the bound package can land a preview. That set is approximately whoever has push access to the repo — **which is exactly the trust boundary already accepted for `azx deploy`**, so it is not a regression. Stated plainly: *provenance proves origin, not safety; anyone with push access to the bound repo can deploy a preview of the bound app.*

7. **Verify the attestation at pull, and verify it names the bound repo.** Checking only that "a valid attestation exists" is insufficient — anyone able to write the package could publish bytes carrying an honest attestation from a *different* repository. The verifier **must** assert the attestation's `repository_id` equals the binding's stored ID (per decision 4), and should additionally constrain `ref` to the tracked branch and reject `event_name` of `pull_request` / `pull_request_target` (fork-poisoning guard). Unattested artifacts are rejected in v1 (see Open questions).

8. **The output rejoins the existing deploy path with no shortcut.** The fetched zip goes through `validate.ts` (zip-slip, symlink, MIME, decompression bomb), the advisory csp-lint, and the manifest approval write-gate; it lands as **`preview`**, and a human promotes (ADR [0018](0018-deploy-model-immutable-versions.md) §5.1). The worst a compromised upstream achieves is submitting a malicious *preview* — a case the deploy pipeline is already built to contain.

9. **A GitHub App is required only for private repos/packages.** The public path needs **no credential at all**. When private access is in scope:
   - The credential of record is a **GitHub App private key** in the existing `SecretStore` seam (ADR [0006](0006-secret-custody-seam.md)) — not a PAT, not a deploy key. Installation access tokens are ~1 h, repo-scoped, centrally revocable, and can be scoped *below* the installation grant via the `repositories`/`permissions` body on `POST /app/installations/{id}/access_tokens`.
   - **Confused-deputy control comes from GitHub's installation scope, not from a Helix-side proof.** Because decision 4 has no ownership ceremony, a binder could name any repo; the installation simply cannot read repos the customer did not install the app on. Authorization is inherited rather than adjudicated. Bind-time validation ("we can't see that repo — is the app installed on it?") is UX, not a security control.
   - **Under ADR [0028](0028-deployment-model-customer-deployed.md), each customer deployment must register its own App.** One Helix-owned App would require shipping its private key into every customer deployment, letting each customer's Helix mint tokens for every other customer's installation — disqualifying. Onboarding uses the **GitHub App Manifest flow** (`github.com/settings/apps/new?manifest=…`), which exists for exactly this self-hosted case: the customer confirms once, and GitHub returns the generated private key, webhook secret, and client credentials in a single exchange, straight into `SecretStore`.
   - Handle the `installation.deleted` / `installation_repositories` webhooks so revoked bindings fail loudly rather than silently.

10. **GitHub Actions OIDC is *not* part of this path.** In a pull model the CI never talks to Helix, so there is no live token to present. The workflow's OIDC identity still reaches Helix — embedded in the Sigstore attestation (Context §2), bound to the bytes and verifiable offline, which is the stronger form of the same claim. OIDC remains valuable on the **separate direct-upload path** (`azx deploy` from CI, where a request *does* ask Helix to act and today carries a long-lived portal token in repo secrets); adding GitHub's issuer to the ADR [0024](0024-portal-cli-bearer-jwt-jwks.md) verifier chain is worth doing independently and is out of scope here.

## Consequences

- **ADR [0026](0026-hosted-build-isolation-prerequisites.md)'s gates 1–3 become moot** (no builder to make credential-free, ephemeral, or network-restricted) and **gate 4 is satisfied externally and more strongly** than a self-attesting Helix builder could manage.
- **`docs/design/git-connections.md` §4 (build sandboxing) and §5 (webhook HMAC, orchestrator, job runner) are displaced.** Deleted outright: ACI/Container Apps Jobs orchestration, one-shot container lifecycle and reaping, wall-clock timeouts and CPU/mem caps, `--ignore-scripts` and its approval opt-out flow, build-log streaming to Blob and its stored-XSS handling, the registry allowlist/mirror, the credential-less-checkout fetcher, per-repo webhook secrets and HMAC verification, and per-app build concurrency/cost ceilings. Its §3 credential-custody reasoning survives, narrowed to private-repo pulls. Per the ADR-wins convention (`CLAUDE.md`), that document is superseded where it disagrees and should be rewritten around this model.
- **What gets built instead:** a `git_bindings` table (app, provider, `repositoryId`, package ref, tracked tag/branch, `checkDueAt`, last-seen digest), a drain worker, an OCI manifest/layer client, a Sigstore attestation verifier, the `/poke/:slug` route, and a starter GitHub Action for authors. No new deployable, no new execution zone, no new untrusted-code boundary.
- **The platform's founding property is preserved verbatim:** Helix still never executes app code or dependency scripts server-side (ADR [0020](0020-static-only-apps-v1.md)), and there is still no git library in the server path (ADR [0018](0018-deploy-model-immutable-versions.md) §"Versioning model").
- **New dependency surface:** GHCR (or Releases) availability becomes a deploy-time dependency, and a Sigstore/Fulcio trust-root verification path enters the portal. Neither is in the serving path — a failure delays a deploy, it does not affect live apps (decision 3).
- **Cost of the credential relocation is honest, not eliminated:** for private repos the portal (or a mechanism-zone fetcher) holds a path to the GitHub App key and briefly a plaintext installation token. This is materially milder than the hosted-build case — there is no untrusted code running next to it — but it is exposure, not its absence.
- **Residual accepted risk:** a malicious dependency in the author's build can steal the author's own CI credentials on GitHub's runner. That risk lives with the author, who already owns it and already has GitHub's mitigations; Helix's exposure is bounded to an attacker publishing a package that lands as a *preview* of that one app, behind the human promote gate.

## Threat model (extends architecture §10)

| Threat | Mitigation |
| --- | --- |
| Malicious dependency `postinstall` executes on platform infrastructure | Structurally impossible — Helix runs no build (decision 1) |
| Attacker publishes bytes attested from a repo they control | Attestation `repository_id` must equal the binding's stored ID (decision 7) |
| Repo renamed / `owner/name` reclaimed by a third party | Binding stores the immutable numeric `repository_id`, not the name (decision 4) |
| Tag moved to a malicious image | Digest resolved, pinned, and recorded per version; tag is lookup only (decision 2) |
| Fork / PR-triggered workflow publishes an artifact | Attestation `ref` constrained to the tracked branch; `pull_request*` events rejected (decision 7) |
| Malicious artifact reaches live traffic | Lands as `preview` only; human promote (decision 8, ADR [0018](0018-deploy-model-immutable-versions.md)) |
| Zip-slip / symlink / decompression bomb in the artifact | Existing `validate.ts` — the fetched zip gets no shortcut (decision 8) |
| Poke endpoint used to DoS or amplify | Coalesce-to-dirty-flag (identical work at any request rate); manifest-first check bounds amplification to ~1 (decision 5) |
| Poke endpoint used to inject a deploy | Carries no authority and no payload; Helix fetches and verifies everything itself (decision 5) |
| Confused deputy: bind a repo Helix can read but the binder cannot | GitHub App installation scope — the token cannot read un-installed repos (decision 9) |
| Cross-customer token minting from a shared App key | Per-deployment App via the Manifest flow; no key is ever shipped to customers (decision 9) |
| Malicious payload bundled into the served JS (chalk/debug class) | **Unchanged and out of scope** — CSP + gateway (ADR [0009](0009-relaxed-csp.md)/[0014](0014-same-origin-api-gateway.md)) |
| Compromised upstream artifact store serves different bytes | Digest pinning + attestation verification; bytes copied to Blob at intake (decisions 2, 3, 7) |

## Phasing

1. **Public repos, public packages, poll-only.** Binding config + `repository_id` resolution, drain worker, OCI pull by digest, attestation verify, hand to the existing deploy API. No credential anywhere. Proves the whole path.
2. **`POST /poke/:slug`.** Dirty flag + coalescing drain; decide the ingress carve-out (Open questions).
3. **Private repos/packages.** GitHub App via the Manifest flow, key in `SecretStore`, installation-token minting, `installation.*` webhook handling.
4. **Portal UX.** Connect-repo in `apps/portal-web`, binding history, last-checked / last-digest, manual "check now."
5. **Later.** GitLab / Bitbucket / Azure DevOps (all have comparable OIDC + registry stories); monorepo fan-out; PR preview environments.

## Open questions

- **Does a third-party GitHub App's installation token authenticate to GHCR for private container packages?** Load-bearing for phase 3. The mechanism is not categorically impossible — Actions' `GITHUB_TOKEN` *is* an installation token and works against GHCR — but private package access has historically been governed by per-package access lists rather than repo permissions. **Verify empirically before committing.** If it does not work cleanly, the fallbacks are a fine-grained PAT with `read:packages` (a long-lived secret — worse) or making **Releases** the private-path backend, where installation tokens definitely work. This is the strongest argument for keeping Releases first-class rather than going GHCR-only.
- **Reject unattested artifacts outright, or allow an explicit per-binding opt-out?** v1 says reject. An opt-out would widen adoption (authors who do not run `attest-build-provenance`) at the cost of reducing the guarantee to "the bytes at this digest," and if allowed it should route through the approval write-gate like any above-baseline capability.
- **How does `/poke/:slug` get exposed when the portal is internal or Entra-gated?** Options: a single unauthenticated path carved out of the Entra gate (preferred — the route is provably inert); serve it from the already-public edge, which would require a narrow write grant that pokes a hole in the ADR [0002](0002-postgres-role-split-rls.md) role split; or a tiny separate public receiver. Because polling is the floor (decision 5), *none of these is blocking* — the answer can be "not exposed, poll only."
- **Releases: first-class backend or fallback?** Depends on the GHCR question above, and on whether requiring GHCR of customers is acceptable.
- **Where does the drain worker live?** Portal-internal timer versus a separate process. It holds the App key path in phase 3, which is the mechanism-zone argument that made `azx-egress` its own deployable (architecture §3) — but it runs no untrusted code, which was the actual reason that mattered.
- **Should `azx deploy`-from-CI also carry provenance?** Restates ADR [0026](0026-hosted-build-isolation-prerequisites.md)'s open question. This path now demonstrates the machinery; applying it to direct uploads is additive.

## Provenance

Design conversation, 2026-07-27. Three corrections landed against the initial framing and are recorded here because each removed machinery: (1) bind-time ownership proof is redundant — authorization is inherited from portal `ownsApp` and GitHub's installation scope, and the only thing bind time must do is resolve an immutable repo ID; (2) an unauthenticated poke beats an HMAC webhook *because* it carries no authority, and coalescing beats rate-limiting; (3) Actions OIDC has no role in a pull model — the workflow identity arrives inside the Sigstore attestation, which is the stronger form of the claim. The GHCR/installation-token question is flagged as unverified rather than assumed.
