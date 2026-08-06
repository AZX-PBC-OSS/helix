# 0022. Self-hosted edge/auth, not a cloud-vendor edge (Front Door / App Gateway)

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; founding build-vs-buy choice)_
**Related:** `docs/platform-architecture.md` §3 (decision #6), §4.2; `docs/reviews/2026-06-build-vs-buy.md`; ADR [0001](0001-three-runtime-split.md), [0003](0003-dependency-minimal-edge.md)

## Context

The edge's responsibilities — host routing, session auth + OIDC handoff, CSP injection, the `/_api/*` gateway — could be assembled from cloud-vendor building blocks (Azure Front Door / Application Gateway / a WAF + `oauth2-proxy`) instead of self-built code.

## Decision

**Self-host the data plane.** The proxy, auth, CSP, and gateway logic is our own code, not vendor edge configuration. Rationale: it is **core IP**, it must be **portable** (customers may run the platform on their own clouds), and the **highest-risk glue (auth)** belongs in code we own and test adversarially rather than in vendor config we can't unit-test.

## Consequences

- More code to own, maintain, and test (this is the cost ADR-0003 dependency-minimal accepts) — offset by full control and a small, auditable surface.
- The data path is cloud-portable; no lock-in of the request path to one vendor's edge.
- We carry maintenance and CVE response a managed edge would otherwise handle.
- Reversing to a vendor edge later would couple the request path to one cloud and externalize the auth logic — costly and against the portability goal.
