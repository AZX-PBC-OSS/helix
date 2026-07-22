# 0028. Deployment model: single-tenant, customer-deployed into the customer's cloud

**Status:** Proposed _(needs sign-off — parameterizes architecture decision 11 and reframes ADR-0019 / issue #16)_
**Related:** `docs/platform-architecture.md` §3 (decisions #6, #8, #11), §9; ADR [0002](0002-postgres-role-split-rls.md) (role split — per instance), [0005](0005-ssrf-egress-controls.md) / [0013](0013-egress-trust-model.md) (egress — now guards the customer cloud), [0006](0006-secret-custody-seam.md) (secret custody — customer Key Vault), [0019](0019-subdomain-per-app-isolation.md) (subdomain/domain split — now per-deployment; issue #16), [0022](0022-self-hosted-edge-not-front-door.md) (portable self-hosted edge — this ADR's parent), [0023](0023-one-org-app-id-partitioning.md) (one-org, app-id partitioning); `docs/design/dev-mode.md`; `docs/build-vs-buy-comparison.md` (C8)

## Context

Several earlier decisions were written implicitly against "our single hosted install on `azx.helix.azxlabs.io`" — most visibly architecture decision 11 ("custom domains rejected outright… apps live at `<app>.azx.helix.azxlabs.io`, **full stop**"), the ADR-0019 / issue #16 eTLD+1 split ("host untrusted apps on a separate registrable domain **we** own"), and the M5 framing of "the three planes on **Container Apps** [that we run]."

That framing is now wrong about the primary shape. The platform is **not** a SaaS product where customers are tenants on infrastructure we operate. It is **shipped software**: a full, independent instance of the platform is deployed into each customer's own cloud — their Azure, their resources, their domain, their IdP. We do not run customer instances.

This was already foreseen — ADR-0022 chose a self-hosted, portable data plane precisely "because customers may run the platform on their own clouds," and `build-vs-buy` C8 records "not a multi-tenant SaaS business; an internal platform." This ADR elevates that from an aside to **the deployment model**, and parameterizes the decisions that were implicitly single-install.

## Decision

**The platform is delivered as single-tenant, customer-deployed software: one complete, independent instance per customer, running in the customer's own cloud tenancy, under the customer's domain and IdP.** We ship a versioned, parameterized deployable (the M5 IaC); the customer applies it. Our own `azx.helix.azxlabs.io` install is the **reference/first deployment** of that same artifact (dogfood), not a separate hosted offering. _(Open point for sign-off: confirm whether `azx.helix.azxlabs.io` is strictly the reference deployment, or a hosted offering that coexists with customer-deployed installs. This ADR assumes the former.)_

Concretely, each prior decision that was implicitly single-install is **parameterized, not reversed**:

1. **Base domain is a per-deployment parameter.** `EDGE_BASE_DOMAIN` — already the single knob (`apps/edge/src/config.ts`) — is set to the customer's domain (e.g. `helix.customer.com`). Decision 11's actual invariant is **preserved**: apps live at `<app>.<base>`, one canonical origin each. Per-app **vanity** domains stay rejected (they reintroduce origin ambiguity — one app at two origins). There is no "custom domains" *feature*; there is only *this deployment's* domain, and it was always config, never literally `azx.helix.azxlabs.io`.

2. **The apps ↔ control-plane site split (ADR-0019 / #16) becomes a per-deployment topology.** The separation rationale is unchanged but now **internal to each install**: within a customer's deployment, untrusted apps sit on a separate *site* from that install's portal/auth/dev-api — via a delegated subdomain (`*.apps.helix.customer.com`) or a separate registrable domain the customer owns. **PSL listing of the apps zone is a documented per-deployment recommendation** the customer submits, not something we operate. The cookie-bomb / reputation / storage residuals (#16) are the customer's own risk *within their own namespace*, scoped by their domain choice — not a cross-customer concern, because there is no shared domain.

3. **Secret custody, identity, and storage are wholly in the customer's cloud.** Their Key Vault + KEK (the ADR-0006 seam, instantiated per deployment), their Entra tenant (single-tenant OIDC), their Postgres + Blob. We never hold customer secrets, sessions, or data.

4. **Egress SSRF controls now guard the customer's cloud.** The ADR-0005/0013 blocks — private/loopback/IMDS denial, validated-IP rebind pin, no redirect-follow — protect the *customer's* metadata endpoint and internal network. A bad app reaching their IMDS is *customer* credential theft. This **raises** the stakes on those controls; they are not weakened by the deployment shift.

5. **We ship IaC, not a service.** The M5 `infra/` is a versioned artifact the customer applies; upgrades and migrations run in the customer's DB on their schedule (shipped-software lifecycle — version pinning, forward-only migrations, documented rollback), not a Container Apps deploy we push.

6. **Tenancy stays per-app within an instance (ADR-0023).** Each customer = one instance, so cross-customer isolation *is the cloud boundary itself*. `orgId`-within-an-instance remains deferred and only matters if a single customer wants internal orgs.

## Consequences

- **Strongest possible isolation.** No cross-customer blast radius exists by construction — a compromised instance is contained to one customer's cloud. This is the security high-water mark the three-plane design was already reaching for.
- **We never custody customer secrets, data, or sessions.** The trust story simplifies sharply, and a customer's data-residency / compliance requirements are satisfied by "it runs in your tenancy" rather than by contract.
- **The dev tier is per-instance and unchanged in substance.** The dev-gateway rides that instance's control-plane base (`dev-api.<control-base>`), opt-in-flaggable off (the `EDGE_ALLOW_*` mold, dev-mode §10); dev-mode's isolation thesis — the `env` partition + `helix_dev` role split — lives entirely within one instance's Postgres and is untouched. The dev-mode §10/§11 "dev-gateway hostname" guidance resolves cleanly: control-plane base of *this* deployment, never the apps zone.
- **The ops model inverts.** We own **release engineering** (versioned artifact, migration safety, upgrade docs, a CVE patch cadence customers *pull*), not runtime operations. There is no central runtime to monitor for customer instances; observability ships as part of the artifact for the customer to wire into their own stack.
- **We lose central visibility and push-fix.** No cross-customer metering rollups, no hotfixing a running customer instance — patches are pull, not push. Support telemetry becomes a shipped, opt-in concern.
- **Version skew across the fleet is now a first-class cost.** Customers run different versions; docs/ADRs describe *a* deployment, and cross-version compatibility (migration ordering, manifest schema, instruction/handoff token formats) must be explicitly versioned. This is the classic self-managed-software tax (GitLab/Retool self-hosted).
- **Edits this ADR obligates:** architecture decision 11 (add the vanity-vs-deployment-domain distinction; base domain is a deploy parameter), architecture §9 ("custom domains rejected outright" → qualified), and an ADR-0019 amendment note (the #16 split is a per-deployment topology + PSL recommendation, not a domain we own). Tracked as follow-ups, not done in this ADR.

## Considered and rejected

**Hosted multi-tenant SaaS on our cloud.** Rejected: it would place customer apps, secrets, and data in *our* tenancy (custody + residency burden), create a cross-customer blast radius, and require exactly the multi-tenant machinery this model avoids — per-tenant base-domain resolution, SNI multi-cert at a shared ingress, cross-tenant unknown-host rejection, and an `orgId` scoping layer. Not a permanent bar: recorded so that any future hosted offering is a **conscious re-decision**, not drift — and note that reversing to it later is a large re-architecture, precisely because the machinery above is deliberately absent.
