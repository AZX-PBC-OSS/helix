# 0005. Egress SSRF + secret-injection mechanism

**Status:** Accepted
**Related:** ADR [0001](0001-three-runtime-split.md), [0013](0013-egress-trust-model.md); review ISSUE-01, ISSUE-02, ISSUE-09, ISSUE-10

## Context

Egress is the only component that makes outbound calls with injected secrets. It is the platform's single point of contact with the public internet and with attacker-influenced target URLs (an app declares the proxied origin). It must resist SSRF and never let the credential reach the app.

## Decision

Egress (`apps/egress/src/ssrf.ts`, `proxy.ts`) applies, per outbound call:

- Resolve the hostname, **validate the resolved IP** against private/loopback/link-local/IMDS ranges, and **dial the validated IP literal** so there is no second resolution (DNS-rebind defeated).
- Do **not** follow redirects.
- Apply a header safelist in both directions; inject the resolved secret server-side only.
- Stream the response back to the edge with size/time bounds.

## Consequences

- A compromised or malicious app cannot use the proxy to reach internal services or cloud metadata.
- The credential is injected at egress and never returned to the app — provided the response-header filter is complete.
- The controls are a denylist/validation surface that must be kept current against IP-encoding and redirect tricks.

## Review notes (2026-06-25)

IP-pinning **verified to defeat DNS-rebind** (refuted a reviewer's "socket not pinned" claim — `connectUrlFor()` dials the IP literal). Gaps to close:
- Response-header blocklist omits `authorization`/`www-authenticate` → injected secret echo-back (**ISSUE-01, Critical**).
- Body-size cap is `content-length`-only → chunked-transfer bypass (**ISSUE-02, Critical**).
- IPv6 blocklist gaps: `fe80::/10`, 6to4, NAT64, full-form loopback, hex-mapped v4 (ISSUE-09).
- `maxRedirections: 0` is implicit; `Location` is forwarded so the browser follows it (ISSUE-10).

## Challenge outcome (2026-06-26)

WEAKEN — ISSUE-01/02/09/10 above all re-confirmed; the SNI-preservation refutation holds (`servername: target.hostname`). One **new, undocumented** gap (filed **#11**): egress injects a connection secret over **cleartext `http://`** — `proxy.ts:97-99` accepts `http:`, and secret injection (`:108-121`, `applyInjection`) applies no `target.protocol` guard. Require `https://` on any secret-backed origin. (Response-header safelist → **#7**; body-size cap → **#8**; IPv6 ranges → **#2**.) Also reframe: the IP denylist is defense-in-depth — the network-zone egress allowlist (ADR-0001) is the primary control.
