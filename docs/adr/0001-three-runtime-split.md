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

WEAKEN — reword, not reverse. The original Decision bullet ("holds no secret … no direct route to the internet") was materially false as written: the edge holds the Blob account key (`blob/signing.ts`), the OIDC RP credential, `EDGE_AUTH_SECRET`, and `HELIX_INSTRUCTION_SECRET`, and makes direct outbound calls to Blob and the IdP. Corrected above to match the Context/Consequences framing ("third-party" / "arbitrary"). Note containment is **one-way**: egress constrains edge-*initiated* outbound, but Blob / IdP / proxied-fetch *responses* flow back through the edge.

### Escalation (2026-06-26) — this is a P0, not a wording fix

The note above under-rated one item. The edge holds the **full read/write/delete Blob storage account key** (`config.ts` parses `AccountKey`; `signing.ts` SharedKey HMAC), and **prod injects it into the edge** (`infra/azure/modules/storage.bicep:77` → `infra/azure/main.bicep:361`) even though the edge's managed identity is already granted the read-only **Storage Blob Data Reader** role (`rbac.bicep:86-94`) — the least-privilege path is provisioned but unused. Consequence: an edge RCE can **rewrite or delete any app's bundle** in the shared account → persistent malicious JS served to every user of every tenant (**all-tenant supply-chain**). A 5-model recheck rated this **P0/Critical (4/5; 1 Important)**.

Precision: this does **not** falsify the three-plane thesis — *third-party connection* secrets and *arbitrary outbound* still live only in egress (the edge has no `app_secrets` / `kv-connections` grant). The defect is an **over-privileged *platform* credential on the most-exposed plane** when a read-only one (already provisioned) suffices. Fix: drop `AZURE_STORAGE_CONNECTION_STRING` from the edge, authenticate Blob reads via the edge's managed identity (ACA `$IDENTITY_ENDPOINT` token — no new dependency), replace the SharedKey signer with bearer-token auth; portal keeps write in lockstep; dev/Azurite keeps the SharedKey fallback (Azurite has no AAD). (OIDC: prod uses certificate auth (`private_key_jwt`), so the *symmetric* client secret is dev-only; the cert private key is the prod RP credential — still edge-held, secondary blast radius.) **Tracked as a P0 issue.**
