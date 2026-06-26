# 0012. Edge and portal may co-deploy as one binary in v0

**Status:** Accepted
**Related:** ADR [0001](0001-three-runtime-split.md); `docs/platform-architecture.md` §3

## Context

The three-runtime split (ADR [0001](0001-three-runtime-split.md)) is the security model made physical. But edge and portal share a request framework, session store, and registry cache; their split is a deploy-config concern (hostname routing), not a code rewrite. Egress is the exception — its split is a genuinely different posture and is non-negotiable.

## Decision

In v0, edge and portal *may* ship as a single binary keyed by hostname, while egress always runs as its own container in its own network zone. The edge/portal split can be made physical later without code changes.

## Consequences

- Faster, cheaper v0 deployment.
- **Co-deploying edge and portal temporarily collapses *their* trust boundary**: a public-facing edge compromise sits in the same process as a writable `helix_portal`-capable control plane. The DB role split (ADR [0002](0002-postgres-role-split-rls.md)) still applies per-connection, but the process isolation does not.
- Egress's isolation — the part that protects secrets + outbound network — is preserved regardless.

## Open question

Decide the trigger for making the edge/portal split physical (e.g. before onboarding external app owners, or before M5 prod). Until then, document that v0 co-deploy is an accepted, time-boxed boundary collapse.

## Review notes (2026-06-25)

Two reviewers noted the footnote quietly undercuts the "three blast radii" claim; the decision is sound but the v0 trade-off should be stated explicitly rather than as an aside.

## Challenge outcome (2026-06-26)

UPHELD — the re-challenge was **refuted** on its load-bearing claims. Edge and portal are **not** co-deployed today (separate Dockerfiles / entrypoints; no single process holds both DB pools), and the `platform` `HostClass` kind is **actively used** (the host-router catch-all, `routing/hosts.ts`), not dead scaffolding — so "no code changes to split later" is closer to *already-satisfied* than false. The in-process boundary-collapse risk applies only *if* co-deploy is exercised, which this ADR already states (Consequences). The one surviving point: **no mechanical gate** enforces the split — add a CI check that refuses co-deploy when `NODE_ENV=production` (or revoke co-deploy when the first non-employee owner onboards).
