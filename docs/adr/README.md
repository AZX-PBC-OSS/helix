# Architecture Decision Records

This directory records the significant architecture decisions for Helix (the AZX App Platform), using a lightweight [Nygard-style](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) format: **Context → Decision → Consequences**, with a status.

0001–0013 were scaffolded from the 2026-06-25 multi-model architecture review ([`docs/reviews/2026-06-25-architecture-review.md`](../reviews/2026-06-25-architecture-review.md)); `ISSUE-xx` / `DEC-xx` references point into that review. **0014–0024 were added 2026-06-26 from a multi-model ADR-coverage audit** — they record decisions that had already shipped but lacked an ADR (their bodies are retroactive). **0025–0026 (also 2026-06-26) are `Proposed` hardening records** spun out of the same review pass — registry-projection hardening (extends 0017) and hosted-build isolation prerequisites (gates the deferred build service in 0018). ADR numbers do **not** imply chronological order of when the decision was first made.

## Status legend

- **Accepted** — decided and in force; the review found the decision sound.
- **Accepted (revisit before multi-tenant / M5)** — a deliberate v0 choice that must be reconsidered before the platform serves more than one trusted operator.
- **Proposed** — a direction chosen but not yet fully decided or implemented; needs sign-off.

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](0001-three-runtime-split.md) | Three-runtime split along trust boundaries | Accepted |
| [0002](0002-postgres-role-split-rls.md) | Postgres least-privilege role split + RLS | Accepted |
| [0003](0003-dependency-minimal-edge.md) | Dependency-minimal edge, hand-written SQL (no ORM) | Accepted |
| [0004](0004-auth-model.md) | Edge-terminated auth: OIDC handoff + password visibility | Accepted |
| [0005](0005-ssrf-egress-controls.md) | Egress SSRF + secret-injection mechanism | Accepted |
| [0006](0006-secret-custody-seam.md) | `SecretStore` custody seam (dev envelope / prod Key Vault) | Accepted |
| [0007](0007-portal-authz-v0.md) | Portal authorization v0: authenticated == authorized | Accepted (revisit before multi-tenant) |
| [0008](0008-llm-key-via-egress.md) | LLM vendor key resolved by egress + legacy fallback | Accepted (revisit) |
| [0009](0009-relaxed-csp.md) | Relaxed CSP posture for hostile app code | Accepted (revisit) |
| [0010](0010-anonymous-shared-writes.md) | Anonymous writes to `shared` keys on public apps | Accepted (revisit) |
| [0011](0011-in-memory-rate-limiting.md) | In-memory rate-limit / throttle state (single-replica) | Accepted (revisit before multi-replica) |
| [0012](0012-edge-portal-codeploy.md) | Edge and portal may co-deploy as one binary in v0 | Accepted |
| [0013](0013-egress-trust-model.md) | Egress trust model: harden the attested-instruction seam | Proposed |
| [0014](0014-same-origin-api-gateway.md) | Same-origin `/_api/*` gateway as the single choke point | Accepted |
| [0015](0015-app-data-three-scope-model.md) | App-data: three scopes (user/collection/shared), writer ≠ reader | Accepted |
| [0016](0016-capability-manifest-approval-classifier.md) | Capability manifest + baseline/elevated approval classifier | Accepted |
| [0017](0017-registry-listen-notify-projection.md) | Edge registry projection over Postgres LISTEN/NOTIFY | Accepted |
| [0018](0018-deploy-model-immutable-versions.md) | Deploy model: upload-only, immutable versions, preview→live flip | Accepted |
| [0019](0019-subdomain-per-app-isolation.md) | Subdomain-per-app isolation with host-scoped cookies | Accepted |
| [0020](0020-static-only-apps-v1.md) | Static-only hosted apps in v1 | Accepted |
| [0021](0021-metering-ledger.md) | Metering ledger: `gateway_calls`, append-only, token budgets + frozen cost | Accepted |
| [0022](0022-self-hosted-edge-not-front-door.md) | Self-hosted edge/auth, not a cloud-vendor edge | Accepted |
| [0023](0023-one-org-app-id-partitioning.md) | One org now, app-id partitioning everywhere | Accepted |
| [0024](0024-portal-cli-bearer-jwt-jwks.md) | Portal/CLI authentication: bearer JWT over JWKS | Accepted |
| [0025](0025-registry-projection-hardening.md) | Registry projection hardening (observability, jitter, cold-start) | Accepted (items 1–2 landed) |
| [0026](0026-hosted-build-isolation-prerequisites.md) | Hosted-build isolation prerequisites (the build-step boundary shift) | Proposed |
| [0027](0027-blob-auth-managed-identity.md) | Blob authentication: managed identity, not the storage account key | Accepted |
| [0028](0028-deployment-model-customer-deployed.md) | Deployment model: single-tenant, customer-deployed into the customer's cloud | Accepted |
| [0029](0029-platform-secret-delivery.md) | Platform secret delivery: deployment-injected env vars, not ACA Key Vault references | Accepted |
| [0030](0030-repo-backed-apps-pull-attested-artifacts.md) | Repo-backed apps: pull CI-built attested artifacts (no hosted build) | Proposed |
| [0031](0031-connection-providers-delegated-auth.md) | Connection providers: MCP-first delegated auth, tenant-key as fallback | Proposed |
| [0032](0032-cli-naming-and-distribution.md) | CLI naming (`helix`) and distribution (public npm, bundled) | Accepted |
| [0033](0033-openai-compatible-gateway-surface.md) | OpenAI-compatible gateway surface and multi-provider routing | Accepted |
| [0034](0034-structured-output-on-the-llm-gateway.md) | Structured output on the LLM gateway (both surfaces) | Accepted |
| [0035](0035-offline-capability-platform-service-worker.md) | Offline capability: platform-owned, scope-confined service worker | Proposed |
