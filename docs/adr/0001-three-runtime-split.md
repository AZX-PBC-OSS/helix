# 0001. Three-runtime split along trust boundaries

**Status:** Accepted
**Related:** `docs/platform-architecture.md` §3 (decision table row 12); ADR [0002](0002-postgres-role-split-rls.md), [0013](0013-egress-trust-model.md)

## Context

Helix hosts untrusted, vibe-coded AI apps. The two capabilities most dangerous to co-locate with a public-facing process are *plaintext third-party secrets* and *an unrestricted outbound network*. A single process means shared fate: a bug in the public-facing path exposes control-plane memory and secrets, and every control-plane deploy restarts the data path (killing in-flight LLM streams).

## Decision

Split the system into three deployable containers along the trust boundary:

- **`apps/edge`** — data/policy plane. Faces untrusted app users; terminates TLS, auth, serving, and `/_api/*` gateway policy. Holds **no third-party connection secret** and has **no arbitrary** outbound route — those live in egress. (It *does* hold its own operational secrets — the Blob account key, `EDGE_OIDC_CLIENT_SECRET`, `EDGE_AUTH_SECRET`, `HELIX_INSTRUCTION_SECRET` — and dials Blob + the IdP directly.)
- **`apps/portal`** — control plane. Privileged; owns the schema, deploys, approvals, secret writes. Not routable from app subdomains.
- **`apps/egress`** — mechanism plane. The only component with plaintext connection secrets *and* a route to the internet. Built as its own container from day one (not extracted later), in its own network zone.

The edge and portal *may* co-deploy as one binary in v0 (see ADR [0012](0012-edge-portal-codeploy.md)); egress is always separate.

## Consequences

- A compromise of the public-facing edge reaches no secret and no arbitrary internet — those live in egress, behind a different posture.
- The control plane can iterate without restarting the data path.
- Cost: an extra internal hop (edge → egress) and the operational overhead of a third service.
- The boundary is only as strong as what flows across the edge→egress seam — see ADR [0013](0013-egress-trust-model.md).

## Review notes (2026-06-25)

Confirmed sound. The split is enforced a second time in Postgres (ADR [0002](0002-postgres-role-split-rls.md)).

## Challenge outcome (2026-06-26)

WEAKEN — reword, not reverse. The original Decision bullet ("holds no secret … no direct route to the internet") was materially false as written: the edge holds the Blob account key (`blob/signing.ts`), the OIDC client secret, `EDGE_AUTH_SECRET`, and `HELIX_INSTRUCTION_SECRET`, and makes direct outbound calls to Blob and the IdP. Corrected above to match the Context/Consequences framing ("third-party" / "arbitrary"). Note containment is **one-way**: egress constrains edge-*initiated* outbound, but Blob / IdP / proxied-fetch *responses* flow back through the edge.
