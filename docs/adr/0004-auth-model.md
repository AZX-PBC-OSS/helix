# 0004. Edge-terminated auth: OIDC handoff + password visibility

**Status:** Accepted
**Related:** `docs/features/authentication.md`; review ISSUE-08, ISSUE-11, ISSUE-15

## Context

The platform must authenticate users without relying on untrusted app code or
exposing credentials to it. Authentication must establish a session on each
app's own origin.

## Decision

The edge terminates all auth:

- Central OIDC login on `auth.<base>`; a **one-time signed handoff token** (30 s, single-use, audience-bound, burned by an atomic `UPDATE` on `sessions`) carries identity to the app host.
- `__Host-`-prefixed opaque session cookies; a per-request session gate (navigations 302, fetches 401); group visibility re-checked per request; silent refresh via `prompt=none`.
- **`password` visibility** for external demos: the portal mints an xkcd passphrase, projects a scrypt hash to the edge; the edge serves an Origin-checked, throttled `/_auth/login` challenge that mints a pseudonymous `pw_<random>` session — no OIDC, no handoff.

## Consequences

- Apps contain nothing to leak: no auth code, no secret.
- The handoff token is the most security-sensitive primitive; it gets a dedicated adversarial test suite.
- The password path trades security for demo convenience and depends on online-guessing being throttled.

## Review notes (2026-06-25)

Core flow verified **sound**: handoff is genuinely single-use (atomic `UPDATE … WHERE tokenHash IS NULL`, no TOCTOU), audience double-bound, JWS alg pinned, `__Host-` invariants met, OIDC state/nonce/PKCE delegated correctly. Hardening items:
- scrypt cost is Node default `N=2^14`, 8× below OWASP's `2^17` (ISSUE-08, `Brave ✗`).
- Group-revocation staleness until refresh, ≤ 60 min (ISSUE-11).
- Per-process login throttle + check-then-increment TOCTOU; multiplies under replicas (ISSUE-15) — see ADR [0011](0011-in-memory-rate-limiting.md).

## Challenge outcome (2026-06-26)

WEAKEN — facts verified (scrypt `N=2^14`; throttle TOCTOU + N×; ≤60 min group staleness; no admin-kill path; handoff UPHELD). Editorial amendments: move the group-staleness (ISSUE-11) and throttle TOCTOU (ISSUE-15) out of review notes into **Consequences**, and harden the password mode from soft "demo convenience" to an explicit **demo-only / no-production-data** restriction (there is no data-class ban today). The throttle weaknesses compound with ADR-0011's now-falsified single-replica premise (**#13**).

## Amendment (2026-09-21) — the admin-kill path landed

The ISSUE-11 mitigation this ADR's challenge demanded now exists: the portal's admin **Sessions**
screen (`GET`/`POST /api/v1/sessions[...]`, `docs/features/authentication.md` §Admin session
revocation). It changes nothing about the *staleness itself* — the ≤60-min window between a group
removal in Entra and the session's next silent refresh is inherent to snapshot-based visibility —
but an operator can now close it on demand: the revoke deletes the user's session rows, the
edge's uncached per-request lookup misses on the next request, and re-login re-checks group
membership at the callback, so a user who actually lost the group cannot get back in. The kill
revokes sessions, not principals — that boundary is stated in the feature doc and is the design,
not a residual. Grant posture: the portal holds SELECT+DELETE on `sessions` only
(migration `20260921120000`), so minting/rebinding a session stays edge-only by grant.
