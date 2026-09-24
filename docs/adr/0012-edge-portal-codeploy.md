# 0012. Edge and portal may co-deploy as one binary in v0

**Status:** Accepted
**Related:** ADR [0001](0001-three-runtime-split.md); `docs/platform-architecture.md` §3

## Context

Edge and portal share request infrastructure and can be routed by hostname in
one process. Separate processes provide the isolation described in ADR-0001,
but the pilot could use co-deployment without changing the routing model.
Egress must remain separate because it holds connection credentials and has
a different outbound network policy.

## Decision

In v0, edge and portal *may* ship as a single binary keyed by hostname, while egress always runs as its own container in its own network zone. The edge/portal split can be made physical later without code changes.

## Consequences

- Faster, cheaper v0 deployment.
- **Co-deploying edge and portal temporarily collapses *their* trust boundary**: a public-facing edge compromise sits in the same process as a writable `helix_portal`-capable control plane. The DB role split (ADR [0002](0002-postgres-role-split-rls.md)) still applies per-connection, but the process isolation does not.
- Egress's isolation — the part that protects secrets + outbound network — is preserved regardless.

## Open question

Decide the trigger for making the edge/portal split physical (e.g. before onboarding external app owners, or before M5 prod). Until then, document that v0 co-deploy is an accepted, time-boxed boundary collapse.

## Resolution (2026-07) — the Azure deploy made the split physical

The question is answered by deployment rather than by decision. `infra/azure` provisions **edge, portal and egress as three separate container apps** (`main.bicep` → `edgeApp` / `portalApp` / `egressApp`), with the portal on internal ingress only and unreachable from app subdomains. So in the deployed platform the boundary collapse described above **does not exist**: an edge compromise is not in-process with a `helix_portal`-capable control plane, and the "three blast radii" claim the 2026-06-25 reviewers flagged is now literally true there.

What survives is narrower and worth stating rather than quietly dropping:

- **Co-deploy remains possible in code.** The trade-off documented above still applies to any topology that runs them together, so this ADR is not obsolete — it describes a configuration the codebase still permits. The proposed CI gate (refuse co-deploy when `NODE_ENV=production`) was **considered and declined (2026-09-23)**: the failure mode it covers is a deliberate, reviewed topology change — merging the two container apps contradicts ADR [0001](0001-three-runtime-split.md), this ADR and `infra/azure/README.md` — not the silent drift CI gates catch, and a Bicep-parsing check would duplicate the deployment source of truth without covering a realistic risk. A boot-time refusal would go further and *revoke* this ADR's permission, which is an amendment warranted by a trust driver (the first non-employee owner onboarding), not a mechanical task. The split's enforcement point is deployment review; revisit the gate if co-deploy is ever exercised in production or an external owner onboards.
- **The portal still connects to Postgres as the schema owner** (ADR [0002](0002-postgres-role-split-rls.md)), so process separation is now real while the in-DB privilege separation on the control-plane side is still partial.

## Review notes (2026-06-25)

Two reviewers noted the footnote quietly undercuts the "three blast radii" claim; the decision is sound but the v0 trade-off should be stated explicitly rather than as an aside.

## Challenge outcome (2026-06-26)

UPHELD — the re-challenge was **refuted** on its load-bearing claims. Edge and portal are **not** co-deployed today (separate Dockerfiles / entrypoints; no single process holds both DB pools), and the `platform` `HostClass` kind is **actively used** (the host-router catch-all, `routing/hosts.ts`), not dead scaffolding — so "no code changes to split later" is closer to *already-satisfied* than false. The in-process boundary-collapse risk applies only *if* co-deploy is exercised, which this ADR already states (Consequences). The one surviving point: **no mechanical gate** enforces the split — add a CI check that refuses co-deploy when `NODE_ENV=production` (or revoke co-deploy when the first non-employee owner onboards).
