# 0024. Portal/CLI authentication: bearer JWT verified over JWKS

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; shipped in M3)_
**Related:** `docs/features/authentication.md`; ADR [0004](0004-auth-model.md), [0007](0007-portal-authz-v0.md); `apps/portal/src/auth/verifier.ts`, `apps/portal/src/plugins/auth.ts`; `packages/cli`

## Context

The control plane (portal API, `azx` CLI) needs its own authentication, distinct from app-user auth (ADR-0004, which is cookie + OIDC handoff on app origins). Options: issue portal-side sessions, or verify stateless bearer tokens.

## Decision

Portal mutating routes accept **bearer JWTs verified statelessly over the issuer's JWKS** — no portal-side session store. `azx login` is an **OIDC device flow** with an XDG token cache (`AZX_TOKEN` short-circuits). **`PORTAL_DEV_TOKEN` is demoted to one verifier in a chain** (CI/dev fallback) and **refused in production**. Reads are sign-in-gated (only `/health` + the auth-config bootstrap stay public); the *authorization* level is ADR-0007 (v0: authenticated == authorized).

## Consequences

- Stateless control-plane auth: no session store, no portal-side session lifecycle; verification is a JWKS signature check.
- The verifier is a **chain** (IdP-JWT + dev-token), so the dev escape hatch composes cleanly and is fail-closed in production.
- Distinct from app-user auth (ADR-0004) — different threat model (operators/CI, not anonymous internet), different primitive (bearer token, not `__Host-` cookie + handoff).
- This ADR is the *authentication* mechanism; per-app *authorization* (ownership/RBAC) is ADR-0007 and its open BOLA gap.
