# [IMPORTANT (conditional)] Edge↔egress hop is plain HTTP (no TLS in the seam)

**Component:** `apps/edge/src/gateway/egressProvider.ts`, `apps/egress/src/app.ts`, `apps/egress/src/server.ts`
**Status:** factual core verified against the code; severity revised to conditional after a full recheck (see below)

## Problem

`HttpEgressProvider` (`apps/edge/src/gateway/egressProvider.ts:51-56`) creates an undici `Agent` with
**zero TLS config**, egress's `buildApp` (`apps/egress/src/app.ts:24`) is `Fastify({ logger })` with no
`https` option, and `server.ts:62` does `app.listen({ port, host })` — plain HTTP. Neither config schema
has any TLS field. The attested instruction is signed, so *forgery* isn't the risk — but on a plain-HTTP
hop, any component on the same network segment can **observe and replay** the signed token within its
~35s TTL (see issue 02), and the secret-gated upstream **response bodies** also traverse the hop in
cleartext.

The seam cannot be switched to TLS by configuration: setting `EDGE_EGRESS_URL=https://` does nothing
because egress can't speak TLS at all, and the edge's `Agent` has no CA/cert wiring — so even server-auth
TLS, let alone mTLS, requires new code on **both** sides. This is the concrete shape of the cross-cutting
concern: service-to-service trust rests entirely on a shared-secret HS256 JWT with **no transport
authentication or encryption** (the industry default for S2S is mTLS + workload identity).

## Severity — Important, conditional on the prod deployment

The exposure is **real today**: no infra mesh exists yet (M5 hasn't landed), nothing enforces a private
segment, and egress binds `0.0.0.0` (`apps/egress/src/config.ts`), so "internal-only" is an operational
assumption rather than an enforced boundary.

It **downgrades to Minor once M5 provides verified east-west encryption** — a private VNet plus
mesh / Container Apps mTLS. Notably, this is already the platform's stated TLS philosophy: the edge
itself terminates TLS at ingress and "runs plain HTTP behind it" in prod (`apps/edge/src/config.ts:86-92`).
By that model, edge↔egress plain HTTP behind a private, encrypted boundary is by-design — the gap is that
the boundary guarantee isn't yet in place and isn't enforced anywhere.

## Proposed handling

The recheck was clear that an application-layer TLS seam is **not** the right primary fix — east-west
mTLS belongs at the infra/mesh layer, an app-layer seam cuts against the dependency-minimal-edge stance,
and it would only cover this one hop (Postgres and Blob traffic are next, which pushes toward a mesh
anyway).

- **Primary:** ensure infra-layer encryption for east-west traffic in prod — private VNet + service mesh
  / Container Apps mTLS — and **document** that the edge↔egress hop relies on it (the same model the edge
  already uses behind ingress). Make this an M5 deploy requirement, not application code.
- **Secondary / optional:** a config-gated TLS+mTLS seam (default off) as a fallback for non-mesh
  deploys, so TLS can be enabled without a code change. Useful, but explicitly not the headline fix.
- Treat mTLS / workload identity as the planned graduation from the shared HS256 instruction secret
  (see issue 04), and pair this with the replay-protection fix (issue 02) — a signed-but-replayable
  token on a cleartext hop is the real compound risk.

---

### Recheck (2026-06-25)

Five independent reviews + a direct code trace. **Factual core unanimous (5/5): the hop is genuinely
plain HTTP, has no TLS capability, and mTLS is impossible without new code on both sides** — confirmed at
`egressProvider.ts:53-56`, `app.ts:24`, `server.ts:62`, and the absence of TLS fields in both config
schemas. **Severity split 3–2** (Important vs Minor); adjudicated on evidence to *Important, conditional*
— real exposure now, Minor once the M5 infra guarantee exists. The strongest correction: the original
"config-capable app-layer TLS seam" remediation is over-scoped and partly contradicts the platform's own
"TLS at the boundary, plain HTTP internally" philosophy — reframed above to make infra/mesh the primary
control and the app-layer seam an optional fallback.
