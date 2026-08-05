# 0005. Egress SSRF + secret-injection mechanism

**Status:** Accepted
**Related:** ADR [0001](0001-three-runtime-split.md), [0013](0013-egress-trust-model.md); review ISSUE-01, ISSUE-02, ISSUE-09, ISSUE-10

## Context

Egress is the only component that makes outbound calls with injected secrets. It is the platform's single point of contact with the public internet and with attacker-influenced target URLs (an app declares the proxied origin). It must resist SSRF and never let the credential reach the app.

## Decision

Egress (`apps/egress/src/ssrf.ts`, `proxy.ts`) applies, per outbound call:

- Resolve the hostname, **validate the resolved IP** against private/loopback/link-local/IMDS ranges, and **dial the validated IP literal** so there is no second resolution (DNS-rebind defeated).
- Do **not** follow redirects — undici 7 follows a redirect only when a `redirect`
  interceptor is composed onto the dispatcher, and egress composes none (a plain
  `Agent` returns the 3xx verbatim); `Location` is additionally stripped from the
  response by the blocklist so a forwarded redirect can't be chased by the browser
  either (ISSUE-10 resolved, issue #10). `Content-Location` survives but has an
  injected query secret redacted (issue #7).
- Filter headers in both directions — a safelist on the request path; on the response path a *blocklist* plus a **dynamic strip of the exact headers egress injected** (ISSUE-01/#7 resolved — `applyInjection` reports every header name and query param it wrote and the response loop removes them, since per-recipe configured names defeat any static list; `authorization` is also in the blocklist as a backstop, and a secret reflected in `Location`/`Content-Location` is redacted). Inject the resolved secret server-side only.
  - **Amended 2026-08-04 for the `hmac-timestamp` recipe**, which writes *two* headers (a timestamp and a signature), so the report is a list rather than a single name. The signature header is the load-bearing case: its name is configuration, so it can never be in the static blocklist, and only the dynamic strip covers it.
- Stream the response back to the edge with size/time bounds.

## Consequences

- A compromised or malicious app cannot use the proxy to reach internal services or cloud metadata.
- The credential is injected at egress and never returned to the app in a **response header** — the dynamic strip covers arbitrary recipe header names, the blocklist backstops `authorization`, and query secrets are redacted from `Location`. Response-**body** echo (an upstream reflecting the secret into the body) remains an accepted transparent-proxy residual: no header-level filter closes it.
  - For a **derived** recipe (`hmac-timestamp`) that residual cuts both ways, and the net is *worse* than it first appears. What can reflect is a per-timestamp signature, never the private key — better than a static bearer, which reflects a permanent credential. But that signature is a working credential for the upstream's whole clock-skew window against **any** path on the origin, and the app can re-harvest a fresh one on every proxied call, so "short-lived" buys nothing against a persistent app. Spending it bypasses the manifest allowlist, the per-app budget, the instruction's method/path binding, and the `gateway_calls` ledger. Redacting a known-exact token from a streamed body is more tractable here than in general (egress knows the precise string it just minted) — filed, not built, because the same argument applies to `header-bearer` and was declined there.
- The controls are a denylist/validation surface that must be kept current against IP-encoding and redirect tricks.
- The `maxBodyBytes` cap is enforced by a **byte counter over the actual bytes** (`@azx-pbc/shared` `capBody`/`byteCapStream`), not the `content-length` header — so chunked, CL-absent, and lying-`content-length` bodies are all counted (resolves **ISSUE-02**, issue #8). It runs per-direction on both hops (egress `/proxy` and the edge `/_api/fetch` relay), so the planes cap independently. The `content-length` check is retained only as a fast-path. A request-side overflow is refused with **413 `too_large`** before/without completing the upstream call; a response-side overflow **truncates** the already-committed stream (logged out-of-band) — a documented transparent-proxy residual, since status + headers are flushed before the counter can trip.

## Review notes (2026-06-25)

IP-pinning **verified to defeat DNS-rebind** (refuted a reviewer's "socket not pinned" claim — `connectUrlFor()` dials the IP literal). Gaps to close:
- Response-header blocklist omits `authorization`/`www-authenticate` → injected secret echo-back (**ISSUE-01, Critical**).
- Body-size cap is `content-length`-only → chunked-transfer bypass (**ISSUE-02, Critical**).
- IPv6 blocklist gaps: `fe80::/10`, 6to4, NAT64, full-form loopback, hex-mapped v4 (ISSUE-09).
- ~~`maxRedirections: 0` is implicit; `Location` is forwarded so the browser follows it (ISSUE-10).~~ **Resolved (issue #10):** the non-follow is now structural (undici 7 follows redirects only via a composed `redirect` interceptor, which egress omits) and made explicit in code, and `Location` is stripped by the response blocklist.

## Challenge outcome (2026-06-26)

WEAKEN — ISSUE-01/02/09/10 above all re-confirmed; the SNI-preservation refutation holds (`servername: target.hostname`). One **new, undocumented** gap (filed **#11**): egress injects a connection secret over **cleartext `http://`** — `proxy.ts:97-99` accepts `http:`, and secret injection (`:108-121`, `applyInjection`) applies no `target.protocol` guard. Require `https://` on any secret-backed origin. (Response-header safelist → **#7**; body-size cap → **#8**; IPv6 ranges → **#2**.) Also reframe: the IP denylist is defense-in-depth — the network-zone egress allowlist (ADR-0001) is the primary control.

## Deployment note (2026-07-23, `deployFirewall`)

The network-zone egress allow-list named here as the **primary control** is
realized on Azure by the Azure Firewall in `infra/azure` (deny-by-default; only
`snet-egress` is allowed out). That firewall is now **operator-optional**
(`deployFirewall`, default `true`) because its ~$900/mo flat cost is an adoption
barrier for a customer-deployed product. **Turning it off removes this ADR's
primary control**, demoting the outbound posture to the app-level `ssrf.ts`
denylist (the defense-in-depth surface described above) and letting the edge
reach the internet directly. This is acceptable only for dev / smoketest /
trusted single-tenant installs; production and untrusted/multi-tenant hosting
must keep it (or an equivalent network egress control). Data-plane privacy
(private endpoints on Postgres/Blob/KV) is independent of the flag. See
`infra/azure/README.md` → "Optional: the egress firewall".

**Perf note (Resolved):** egress originally built a **fresh undici `Agent` per request** because the dispatcher carried the per-request pinned IP + `servername` (SNI), which defeated cross-request connection pooling (a TCP+TLS handshake per outbound call) — an accepted simplicity-for-isolation trade. This is now **optimized**: `makeProxyHandler` holds **one long-lived shared `Agent`** (closed on app teardown via a Fastify `onClose` hook) whose connector — built with `buildConnector` — runs `resolveAndValidate` and **pins the socket to the validated IP on every new connection**, then hands off to the default connector with `servername` pinned to the real hostname. The request dials the **real origin** (undici pools by origin and derives Host/SNI from it), so keep-alive is recovered (a `proxy.test.ts` case asserts one TCP connection across six requests). The IP-pin is unweakened: validation runs per *new* socket, a pooled/keep-alive socket is already bonded to a validated IP (so reuse can't reach a rebound address and the next fresh socket re-validates), and a blocked/unresolvable host throws `SsrfBlockedError` from the connector, which undici propagates verbatim to the `request()` rejection where the handler maps it to `403 blocked` — preserving the old upfront-check semantics.
