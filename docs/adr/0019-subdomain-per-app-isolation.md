# 0019. Subdomain-per-app isolation with host-scoped cookies

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; shipped in M2)_
**Related:** `docs/platform-architecture.md` §3 (decision #2), §4.1; ADR [0004](0004-auth-model.md), [0014](0014-same-origin-api-gateway.md); `apps/edge/src/routing/hosts.ts`, `apps/edge/src/auth/cookies.ts`

## Context

The platform hosts many mutually-untrusted apps. They can be addressed by **path** on one shared origin (`apps.<base>/<slug>`) or by **subdomain** (`<slug>.<base>`). Path routing puts every app in a single browser origin, so the same-origin policy gives any app's script read access to every other app's cookies, `localStorage`, and DOM — a cross-app breach by construction.

## Decision

Each app is served on **its own subdomain** `<slug>.<base>`. Sessions use **`__Host-`-prefixed cookies** (host-scoped: no `Domain` attribute, `Secure`, `Path=/`), so a session cookie set for one app cannot be read by another. The **browser's same-origin policy is the isolation primitive**. A reserved set of subdomain labels (e.g. `auth`) can never be app slugs (`classifyHost`).

## Consequences

- Per-app origin isolation comes free from the browser — no app can touch another's storage, cookies, or DOM.
- `__Host-` requires HTTPS and forbids a `Domain` attribute, so a cookie genuinely cannot span subdomains — which is why crossing the boundary (login) needs an **explicit signed carrier**, the OIDC handoff (ADR-0004).
- Requires a wildcard TLS cert and DNS for `*.<base>`; custom per-app domains are rejected (they'd reintroduce origin ambiguity).
- This is the platform's most load-bearing security boundary (architecture §4.1 calls it "non-negotiable"). Reversing to path routing would collapse all apps into one origin.
