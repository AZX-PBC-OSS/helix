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

## Challenge outcome (2026-06-26)

This ADR settled subdomain **vs path** routing, but not the *registrable-domain* question — and that's a real gap (filed as **#16**, Important). Untrusted apps (`*.azx-labs.com`), the auth host (`auth.azx-labs.com`), and the portal (`portal.azx-labs.com`) all share **one registrable domain** (`infra/azure/modules/dns.bicep`, `main.bicepparam:12`), so apps are **same-site** with the control plane — separated only at the *origin* level. Established practice (Google `googleusercontent.com`, GitHub `github.io`) is to host untrusted content on a **separate registrable domain (eTLD+1)** so the coarser *site* boundary also separates it.

Subdomain isolation + `__Host-` + Origin-checked CSRF + bearer-JWT portal close **session theft** — so this is Important, not Critical. But the shared eTLD+1 leaves residuals a separate domain would close: **cookie-bomb DoS** (`Domain=.azx-labs.com` → 431 on portal/auth/all apps), **Safe-Browsing / reputation blast radius** (one bad app flags the whole domain incl. the admin plane), same-site coupling with the auth host, and site-keyed storage partitioning. (The planned PSL submission partially closes the cookie vectors but not reputation.)

**Decision/amendment:** host untrusted apps on a **separate registrable domain** (`*.azx-apps.<tld>`), portal/auth on `azx-labs.com`. Cheap pre-M5 (DNS zone + wildcard cert + OIDC redirect URIs + verify the now-cross-site handoff, which is a signed URL token so robust); painful after customer `<slug>.azx-labs.com` URLs are committed. Treat as a **pre-GA prerequisite**, not an M5 blocker.

### Considered and rejected (2026-06-26): render apps in a sandboxed iframe (no `allow-same-origin`)

A review proposed rendering each untrusted bundle in a sandboxed `<iframe>` without `allow-same-origin` (opaque/null origin). **Rejected — don't file; category error** (5-model panel + grounding):
- A **null-origin** frame cannot ride the `__Host-` session cookie or call the same-origin `/_api/*` gateway — it **breaks ADR-0014** (the load-bearing capability choke point). Enabling `allow-same-origin` to restore those defeats the sandbox entirely.
- The sandboxed-iframe pattern (Google SafeContentFrame / double-key) is for a **trusted page embedding untrusted content**; Helix is the inverse — the untrusted app **is** the top-level navigable site (this ADR), and CSP already sets `frame-ancestors 'none'` (apps refuse framing).
- The containment that actually applies is the **separate eTLD+1 move above** (#16) + strict CSP data-flow directives + ADR-0020 (no server-side untrusted execution). Browser-side XSS in a site the user navigated to directly is the user's risk by design, bounded by origin/site isolation, not by iframe sandboxing.
- **Narrow future slice:** if the *portal* ever embeds an unpromoted app for preview inside the control plane, sandbox-without-`allow-same-origin` is the right control for *that* surface — a separate forward-compat item, not a precedent for the hosting model.
