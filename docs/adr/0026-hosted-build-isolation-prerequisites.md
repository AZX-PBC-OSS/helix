# 0026. Hosted-build isolation prerequisites (the build-step boundary shift)

**Status:** Accepted (2026-06-26) — the decision is *"hosted builds stay deferred; these are the launch gates if they are ever built"*, and that is in force. Nothing to implement while no builder exists. **Displaced in practice by ADR [0030](0030-repo-backed-apps-pull-attested-artifacts.md) (2026-07-27), not superseded.**
**Related:** ADR [0030](0030-repo-backed-apps-pull-attested-artifacts.md) (repo-backed apps by pulling CI-built attested artifacts — the cheaper path that removes the motivation for hosted builds), [0018](0018-deploy-model-immutable-versions.md) (upload-only, immutable versions — the model this would extend), [0020](0020-static-only-apps-v1.md) (static-only apps), [0001](0001-three-runtime-split.md) (the credential-free / network-zoned isolation pattern a builder must reuse), [0006](0006-secret-custody-seam.md) (SecretStore custody). **Design:** `docs/design/git-connections.md`.

> **Read this with ADR [0030](0030-repo-backed-apps-pull-attested-artifacts.md).** Repo-backed apps now reach production by having the **author's CI** build and publish an attested artifact that Helix *pulls* — the platform runs no build at all. That makes gates 1–3 below moot (there is no builder to make credential-free, ephemeral, or network-restricted) and satisfies gate 4 **more strongly** than a Helix-run builder could: a Sigstore-signed `actions/attest-build-provenance` attestation is a *third-party* claim about origin, whereas a compromised in-house builder can always forge its own self-attestation.
>
> This ADR is **not superseded.** Hosted builds remain a plausible later rung — ADR [0030](0030-repo-backed-apps-pull-attested-artifacts.md) assumes the author has working CI, which many vibe-coding authors will not. If that rung is ever built, **every gate below still applies unchanged.**

## Context

Today the deploy model is **upload-only**: the `helix` CLI zips a **prebuilt** static bundle and uploads it; the platform never runs `npm install` / a build / app code server-side (verified — `packages/cli` only zips; no `exec`/`spawn`/`child_process` in the edge serving path; no SSR of uploaded HTML). The author's build happens on the author's machine/CI, **outside the platform's blast radius**.

A future "hosted build" / git-connect milestone (the project calls it **v2**; sometimes referenced as "M6") would clone an app's repo and **build it on platform infrastructure**. A 5-model review (2026-06-26) of the "build-step trap" risk note unanimously returned **"real but needs refinement"** and surfaced the precise shape of the risk:

- **Building untrusted code = executing it.** `npm install` runs `pre`/`postinstall` lifecycle scripts — arbitrary code execution on the build host, by design (OWASP). The 2025 npm supply-chain attacks make this live and at-scale: **Shai-Hulud** (self-replicating worm; malicious **postinstall** harvests CI/dev secrets and auto-publishes to spread; 500+ packages; CISA alert Sept 2025; a second wave Nov 2025) is the directly-on-point exemplar.
- **The acute harm is credential egress, not raw code execution.** Per `docs/design/git-connections.md:59`: *"the dangerous coupling is not 'we run a build' — it is 'we run untrusted code **next to a git credential**.'"* A `postinstall` reads env / filesystem / `.git-credentials` in milliseconds.
- **Helix-specific severity amplifier:** ADR [0018](0018-deploy-model-immutable-versions.md) treats the produced version as **trusted-on-intake** (content-addressed, **no build provenance in v1**). A compromised ephemeral builder doesn't just run code — it **forges a trusted, signed-as-good artifact** that downstream consumers can't distinguish, an **all-tenant supply-chain** risk worse than on platforms that re-scan on ingest.
- **Distinguish two threat classes** (the review's sharpest correction): a **bundled-into-output** payload (e.g. the Sept 8 2025 chalk/debug wallet-drainer — an account-takeover whose code runs **client-side in the browser**) **already threatens the platform *today*** via the author's local build → static bundle → served JS; its defense is **CSP + the gateway** (ADR [0009](0009-relaxed-csp.md)/[0014](0014-same-origin-api-gateway.md)), and it is unaffected by hosted builds. A **build-host-execution** payload (Shai-Hulud-class `postinstall`) is the threat **newly introduced** by hosted builds. The two must not be conflated.

This is **not a novel discovery** — `platform-architecture.md:159` (decision #10, risk table `:281`) and the dedicated design `docs/design/git-connections.md` already model the builder as a *"fourth untrusted execution zone."* This ADR records the **non-negotiable prerequisites** that gate shipping it.

## Decision

Hosted builds remain **deferred**. When they ship, they must clear these **launch gates** (not v2.x follow-ups). The builder is treated as a fourth untrusted execution zone, reusing the egress plane's posture (ADR [0001](0001-three-runtime-split.md)):

1. **Credential-free builder — the load-bearing control.** The build container holds **no** platform/git/registry/cloud secret. The git clone happens *outside* the build zone; the builder receives a **credential-free source tarball**, and produces an artifact handed back over a one-way channel (`git-connections.md:59-88`). Rationale: if the builder has no secret, a successful `postinstall` RCE exfiltrates **nothing**. Sandboxing alone is **insufficient** — npm tarballs, git deps, and lifecycle scripts routinely exit a sandbox; credential-free is what makes the residual RCE harmless.
2. **Ephemeral by construction.** One container per build, destroyed after — no warm pools, no state/cache leaking between builds (defeats cache-poisoning + persistent build-environment attacks). `git-connections.md:88-96`.
3. **Network-restricted install.** No arbitrary egress from the builder; dependency fetch goes through a **registry allowlist / mirror** (treated as *leaky, secondary* — defense in depth, not the primary control). Block lifecycle-script egress.
4. **Build provenance is a launch gate, not a follow-up.** Produced versions carry a **SLSA / in-toto / signed attestation** so a compromised builder's forged artifact is detectable downstream — closing the "trusted-on-intake" gap ADR [0018](0018-deploy-model-immutable-versions.md) leaves open. Preview-then-promote (ADR [0018](0018-deploy-model-immutable-versions.md) §5.1) stays as the human gate.

## Consequences

- Hosted builds become a **manageable new isolation tier**, mirroring the edge→egress policy/mechanism split, rather than a contradiction of the "app code is untrusted" model.
- The headline supply-chain risk (credential theft + artifact forging) is structurally neutralised by **credential-free + provenance**, independent of how good the sandbox is.
- Cost: real engineering (ephemeral builder orchestration, a clone-outside-the-zone flow, an attestation pipeline) — which is exactly why it stays deferred until a real app needs it. Until then, the answer is **"authors run `helix deploy` from their own CI"** (zero platform build infrastructure).
- The `--ignore-scripts` flag is **defense-in-depth only** — it breaks legitimate packages (esbuild native bindings, node-gyp, husky) and is not a substitute for credential-free isolation.

## Open question

Confirm the milestone label (**v2** in the docs vs. "M6") and decide whether provenance attestation must cover the *author-CI* upload path too (a bundled-output / chalk-debug-class payload rides in there regardless of hosted builds — CSP/gateway is the defense, but artifact signing on upload would raise the bar).

## Provenance

Multi-model parallel review + Brave best-practice grounding, 2026-06-26 (5/5 "real but needs refinement"; both cited npm attacks verified; chalk/debug-vs-Shai-Hulud threat-class distinction adjudicated on evidence). Restates and sharpens the existing rationale in `platform-architecture.md` §5 and `docs/design/git-connections.md`.
