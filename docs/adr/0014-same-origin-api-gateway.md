# 0014. Same-origin `/_api/*` gateway as the single capability choke point

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; the decision shipped in M4)_
**Related:** `docs/platform-architecture.md` §3 (decision #4), §6.1; ADR [0004](0004-auth-model.md), [0009](0009-relaxed-csp.md); `apps/edge/src/app.ts`

## Context

Apps need access to LLM, data, fetch, and future MCP capabilities. A separate
API origin would require cross-origin request configuration and credential
handling. Serving /_api/* on each app's origin lets the gateway use its existing
host-only session cookie and Origin checks.

## Decision

Serve the entire gateway at **`/_api/*` on each app's own origin**. The app calls same-origin; the `__Host-session` cookie is sent automatically; no CORS, no bearer token in app JS. The edge routes `/_api/*` on app hosts to the gateway and `sendNotFound` elsewhere. Every capability (LLM, data, fetch) is the same same-origin shape.

## Consequences

- No CORS configuration anywhere on the app-user path; the session cookie is the only credential and the app never sees a token.
- SameSite does **not** distinguish same-origin sibling subdomains, so CSRF protection is done by explicit **Origin checks** on mutating `/_api/*` calls (not cookie attributes).
- Couples the gateway to the edge's host routing (one process terminates app traffic and serves the API).
- **Costly to reverse:** introducing a dedicated `api.<base>` later would require CORS, a token-handoff model, and reworking the auth/CSP posture — it would reshape the whole platform. This is the load-bearing choice the auth model and relaxed CSP both build on.
