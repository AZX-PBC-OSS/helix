# 0014. Same-origin `/_api/*` gateway as the single capability choke point

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; the decision shipped in M4)_
**Related:** `docs/platform-architecture.md` §3 (decision #4), §6.1; ADR [0004](0004-auth-model.md), [0009](0009-relaxed-csp.md); `apps/edge/src/app.ts`

## Context

Untrusted, vibe-coded apps need governed access to platform capabilities (LLM, app-data, fetch-proxy, future MCP). The gateway could live on a **separate API origin** (`api.<base>`) or on the **app's own origin** (`/_api/*` on `<slug>.<base>`). A separate origin forces CORS on every call and forces a token to be handed to app JavaScript (the cookie can't ride a cross-origin request) — exactly the things an untrusted app must not hold.

## Decision

Serve the entire gateway at **`/_api/*` on each app's own origin**. The app calls same-origin; the `__Host-session` cookie is sent automatically; no CORS, no bearer token in app JS. The edge routes `/_api/*` on app hosts to the gateway and `sendNotFound` elsewhere. Every capability (LLM, data, fetch) is the same same-origin shape.

## Consequences

- No CORS configuration anywhere on the app-user path; the session cookie is the only credential and the app never sees a token.
- SameSite does **not** distinguish same-origin sibling subdomains, so CSRF protection is done by explicit **Origin checks** on mutating `/_api/*` calls (not cookie attributes).
- Couples the gateway to the edge's host routing (one process terminates app traffic and serves the API).
- **Costly to reverse:** introducing a dedicated `api.<base>` later would require CORS, a token-handoff model, and reworking the auth/CSP posture — it would reshape the whole platform. This is the load-bearing choice the auth model and relaxed CSP both build on.
