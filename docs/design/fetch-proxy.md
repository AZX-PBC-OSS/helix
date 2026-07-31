# AZX App Platform — Fetch Proxy (design doc)

**Status:** Design draft v1 · June 2026
**Companion to:** `platform-architecture.md` (§3 the `helix-egress` plane, §6.1 names it, §12/M4.5 phase it), `platform-project-plan.md` (the M4.5 milestone), `docs/design/secrets-and-connections.md` (the secret store + `connection` it consumes), `docs/design/app-data-storage.md` and `docs/design/approvals.md` (the gateway patterns this reuses), and `docs/platform-custom-backends-and-apis.md` §4 (the policy/mechanism split + egress/SSRF lesson).
**Why this exists:** The fetch-proxy is the gateway's answer to "my app needs to call a third-party API." It is named everywhere and designed nowhere. The hard part is not the proxy — it is the **adoption story**: a vibe-coded app reaches us already written, with plain `fetch('https://…')` in it, and the proxy only earns its keep if integrating with it is closer to *zero edits* than *learn a new API*. This doc designs the mechanism in service of that.

> **Related ADRs:** [ADR-0005](../adr/0005-ssrf-egress-controls.md) (SSRF + secret injection) · [ADR-0013](../adr/0013-egress-trust-model.md) (egress trust model).

---

## 1. The motivating problem: two arrival orders

A hosted app that talks to a third party arrives in one of two orders, and the design has to serve both:

- **Platform-first.** The author starts from our deploy skill, which tells them about `/_api/*` up front. They write to the gateway from line one. This is the easy case and the one every other capability (LLM, app-data) implicitly assumes.
- **Vibe-coded-first (the common case).** The author builds the whole app against `localhost` — where there is no CSP and `fetch('https://api.github.com/users/octocat')` just works — and comes to us *second*, to host the thing that already runs. They discover the platform at the moment their working app breaks.

The second order is where adoption is won or lost, and it is the order we should optimize for, because it is what "vibe-coded" *means*. The break is concrete: our baseline CSP is `connect-src 'self'` (architecture §4.4), so the moment the app loads on `<slug>.local.helix.azxlabs.io` the browser refuses the cross-origin `fetch` the app was built around. Today we have exactly one answer to that break — a **CSP origin grant** (`capabilities.externalOrigins`, approval-gated, the `examples/github-stars` loop): widen `connect-src` to include `api.github.com` and let the browser call it **directly**. That is the right answer when the call is to a public, keyless, read-only API. It is the *wrong* answer the instant any of these is true:

- the call needs a **secret** (an API key, a bearer token) — a direct browser call puts the secret in the bundle, readable by anyone with devtools;
- the owner wants the call **audited or metered** — a direct call never touches our plane, so it is invisible to `gateway_calls` and the Audit page;
- the third party's **CORS** policy refuses the browser origin — common for APIs that never expected to be called from a page.

For all three, the call has to go *through* us. That is the fetch-proxy. So the proxy is not a competitor to the CSP grant — it is **the second setting of the same knob**: both are governed by the per-app external-origin allowlist, and the choice between them is "direct or proxied" per origin (§4).

## 2. The one invariant

Echoing the house framing (custom-backends §1): every capability flows through the gateway, the app holds no ambient credentials, and the gateway stays the single choke point for identity, authz, quota, and audit. For outbound HTTP specifically:

> **The app names *where* it wants to go; it never holds the keys to get in, and it can only reach origins the manifest already granted. Every proxied call is attributed to `(app, user)`, metered, and audited, and egress is SSRF-isolated so a malicious app cannot turn the proxy into a weapon against our own network.**

Two corollaries fall straight out and shape everything below:

1. **Egress is allowlist-only, never open.** The proxy will refuse any target origin not in the app's manifest. This is both the security boundary (§6) *and* the thing that keeps the developer's mental model from forking: the same `externalOrigins` list they already edit to satisfy CSP is the list the proxy reads. One list, two enforcement points.
2. **Secrets are a portal-side, deliberate act.** The zero-touch adoption story (§3) covers keyless calls completely. The moment a secret is involved, the author *must* take an explicit step (store the secret, declare the connection) — and that is correct, because needing a secret is itself a deliberate act, not something to infer. We make the keyless path frictionless and the secret path obvious; we do not try to make the secret path invisible.

## 3. The integration spectrum (the heart of it)

The adoption question — "how do people integrate with it" — has three answers stacked from most-explicit to zero-touch. We ship all three; they are layers, not alternatives.

### 3.1 The wire contract: a path-prefix proxy, not a POST envelope

The obvious design is a POST envelope: the app sends `{url, method, headers, body}` to `/_api/fetch` and reads a response object back. **Reject it.** It forces a total rewrite of every call site, it can't stream, and it reads nothing like `fetch`. Instead the proxy is a **path prefix**:

```js
// before (vibe-coded, breaks under CSP):
const r = await fetch('https://api.github.com/users/octocat');

// after (same-origin, passes connect-src 'self', proxied + audited):
const r = await fetch('/_api/fetch/https://api.github.com/users/octocat');
```

The target URL rides in the path. The request is **same-origin**, so it satisfies `connect-src 'self'` with no CSP widening at all for the proxied origin. Method, headers (a safelist — §6), and body pass through untouched; the response streams back with status, safelisted response headers, and body intact. `fetch('/_api/fetch/' + encodeURIComponent(targetUrl))` is also accepted, for callers that would rather encode. The edit from the "before" line to the "after" line is a **mechanical string prefix** — which is exactly what makes it codemod-able and skill-teachable (§3.3), and what the next layer automates entirely.

Why path-prefix beats the envelope on every axis we care about: it preserves streaming (the edge pipes the upstream body, never buffers — the standing edge rule), it preserves the `Response` shape the app already handles, and the diff is a search-and-replace rather than a re-architecture. The cost is that the edge must parse the target out of the path and validate it hard (§6); that validation is load-bearing and gets adversarial tests, like every gate path (project plan §6).

### 3.2 The transparent shim: zero edits for the vibe-coded-first case

The path-prefix is one edit per call site. For the vibe-coded-first author we can get to **zero** edits with an opt-in shim. The edge already owns the response on the way out (it sets the CSP header on every app response — §4.4). On `text/html` responses for apps that have opted in, it additionally injects, as the first child of `<head>`, a one-line reference to a platform-served script:

```html
<script src="/_helix/fetch-shim.js"></script>
```

`fetch-shim.js` is **our** code, served from a reserved edge path (`/_helix/fetch-shim.js`, same family as `/_api`, `/_auth`) with this app's proxied origins baked in. It monkeypatches **both `window.fetch` and `XMLHttpRequest.prototype.open`**: a call whose URL is absolute and whose origin is in the app's granted **proxy** set is transparently rewritten to `/_api/fetch/…` before it goes out. The vibe-coded `fetch('https://api.github.com/users/octocat')` — *and* the `axios.get(...)` next to it — then *just work* after deploy, unedited, and land in the audit log. Covering XHR is what makes axios work: its browser default is the XHR adapter (patching `open` catches it), and newer axios's fetch adapter is caught by the `fetch` patch.

The honest boundaries, stated plainly so nobody mistakes this for a security control:

- **It is ergonomics, not a boundary.** The real boundary is CSP + the proxy's own allowlist and authz (§6). If a malicious app deletes the shim or restores native `fetch`/`XMLHttpRequest`, it gains *nothing* — its direct call to a non-granted origin still hits `connect-src 'self'` and dies. The shim only ever *adds* reach the manifest already granted. It fails safe.
- **It covers `fetch` and `XMLHttpRequest`.** Not `<img>`/`<form>`/font loads, not `WebSocket`, not `EventSource`/SSE. That is fine: vibe-coded third-party API calls are overwhelmingly `fetch`/XHR (the latter via axios), and the uncovered transports either have their own CSP directive (`img-src`) or are streaming shapes out of scope for a request/response proxy. Two behavioral notes, documented rather than hidden: the rewritten call is **same-origin**, so the browser never CORS-preflights the third party (a *feature* — axios calls that died on CORS now work — but the app's own `withCredentials`/CORS config becomes moot on those origins); and `response.url` / `xhr.responseURL` reflect the `/_api/fetch/…` proxy path, not the third-party URL.
- **It is opt-in per app**, because injecting a `<script>` into untrusted HTML is a real serve-time cost (the edge buffers the one HTML doc, inserts the tag after `<head>`, and serves it without an etag — cheap, bounded to opt-in HTML, but not free, and not something to impose on the static-only apps that are the majority). A manifest flag (`capabilities.fetch.shim: true`, §5) turns it on. The deploy lint (§3.3) is where we *offer* to turn it on.

The combination is the point: **the path-prefix is what we teach; the shim is what rescues the app that arrived already written.**

### 3.3 Meeting the developer at the break

Adoption is a *moment*, and we already own both moments where it happens:

- **Deploy-time, in the CSP courtesy lint.** The lint already scans the uploaded bundle for external origins and warns (registry-and-deploys; approvals §6.2). Today it offers one fix — request a direct CSP grant. We give it a second, defaulted-to fix: *"`api.github.com` is called from your bundle and will be blocked. Route it through the fetch-proxy (audited, supports server-side keys) or grant it as a direct browser call."* The proxy becomes the recommended answer at the exact instant the author learns there's a problem, before they've even deployed a broken build.
- **Runtime, in the Violations screen.** A blocked `connect-src` already fires a CSP report into `csp_reports` and surfaces on the portal Violations screen as a one-click origin-grant request through the approval spine (approvals §6.2). That one click grows a choice: **grant direct** (today's behavior — widen `connect-src`) or **route through proxy** (add the origin in `proxy` mode, no CSP widening). Either way the author never reads this design doc; they click the thing the platform offered at the break.
- **Greenfield, in the deploy skill.** `packages/deploy-skill` (project plan §5) teaches the path-prefix form directly, so platform-first authors write to the proxy from line one and the question never arises. The skill is also where a codemod lives: "rewrite my third-party `fetch` calls to the proxy" is a find-and-replace it can run over the bundle, because §3.1's contract made it one.

This is the whole adoption answer in one sentence: **the developer integrates by doing nothing different (shim), by accepting a one-click suggestion at the break (lint/violations), or by following the skill (greenfield) — and the proxy is the recommended branch at each.**

## 4. Direct vs. proxied: one knob, two settings

`capabilities.externalOrigins` (`z.array(z.url())`) already means one thing — widen this app's `connect-src`/`img-src` so the browser may call the origin **directly** (the registry projection carries it to the edge's CSP builder). That is the *direct* setting and it is left untouched. The proxy adds the *other* setting as a sibling capability, `capabilities.fetch`, rather than mutating the existing list — additive, so the github-stars direct-grant loop, the CSP builder, the Violations one-click grant, and the existing classifier rule all keep working unchanged:

```ts
// packages/shared/src/manifest.ts
export const FetchConnectionSchema = z.object({
  origin: z.url(),                          // scheme + host + port, e.g. https://api.github.com
  connection: z.string().min(1).optional(), // secret name to inject server-side (§5); absent ⇒ keyless
});
export const FetchCapabilitySchema = z.object({
  shim: z.boolean().default(false),         // transparent fetch shim (§3.2)
  origins: z.array(FetchConnectionSchema).default([]), // proxied origins (the egress allowlist)
  requestsPerDay: z.int().positive().optional(),       // per-app abuse budget (§7)
});
```

So an origin is **direct** if it appears in `externalOrigins` (browser calls it, CSP-widened) and **proxied** if it appears in `fetch.origins` (routed through `/_api/fetch`, same-origin, served by egress). One knob, two settings, expressed as which list the origin lives in — the portal UI presents it as a single per-origin direct/proxy toggle that moves the entry between the two fields.

The registry projection (`apps/edge/src/registry/projection.ts`) keeps feeding `externalOrigins` to the CSP builder exactly as today, and additionally derives `proxyConnections` (`origin → connection?`) from `fetch.origins` as the egress allowlist — fail-closed to empty on malformed JSON, like `llm`/`data`. The approval classifier (`@azx-pbc/shared` `classifyChange`, approvals §3) treats a proxied origin as elevated (`fetch.origins[+origin]`, risk `med`), and a *secret-bound* one as strictly more sensitive (`fetch.origins[+origin→secret:name]`, risk `high`, because it spends a credential) — new classifier cases, same spine.

## 5. Secret-backed connections (the proxy's unique value)

A `direct` grant can never carry a secret — the key would sit in the browser. The proxy's reason to exist beyond audit is **server-side credential injection**, which is named as v1.x in architecture §12 and lands here. The credential store, the CRUD surface, and the app↔secret binding are designed in `docs/design/secrets-and-connections.md` — this section is the consumer's-eye view; that doc owns the `connection` it references (including how the plaintext reaches the outbound call without the policy edge ever holding it).

The owner stores a secret in the portal (Key Vault-backed, control-plane only — the edge's `helix_edge` role has no secret-read by design, §3 of the architecture) and names it as a **connection**:

```yaml
# manifest
capabilities:
  fetch:
    shim: true                     # §3.2 — opt-in transparent rewrite
    origins:
      - origin: https://api.github.com
        connection: github-pat     # portal-stored secret, injected server-side (omit ⇒ keyless)
```

The app calls `fetch('/_api/fetch/https://api.github.com/...')` with **no `Authorization` header**. The edge, on a `proxy` entry that names a `connection`, looks up how that connection injects (e.g. `Authorization: Bearer <secret>` or a header template) and applies it on the outbound side, after the app's request has left the browser. The app never sees the secret; the bundle is clean; rotating the key is a portal action with no redeploy.

The deliberate-config caveat from §2 lands here and is *correct*: a secret connection cannot be zero-touch — someone has to store the secret and approve the grant (it's a privileged write through the approval spine). The adoption work is to make that the obvious, well-lit path for the apps that need it, not to make it disappear. The keyless majority gets §3's frictionless path; the secret minority gets a clear, audited ceremony.

How a connection injects (header template, query param, OAuth client-credentials refresh) is its own small schema; v1 ships the header-bearer case and defers the rest (§11).

## 6. SSRF hardening (the part that must be right)

An outbound HTTP proxy that an *untrusted* app drives is an SSRF engine if built naively — the Capital One IMDS vector verbatim (custom-backends §4). The controls, belt-and-suspenders:

- **Allowlist-only, per app.** The target origin must be a `proxy`-mode entry in *this app's* manifest. Not "any URL" — not even "any public URL." No entry, `403 forbidden`, before a single packet leaves. This is the primary control and the reason §4 ties egress to the manifest.
- **Block private and link-local ranges** at resolution time: RFC 1918, loopback, `::1`, ULA, and especially **`169.254.169.254`** (cloud instance metadata). Resolve the host ourselves and refuse if it lands in a blocked range — which also defends the **DNS-rebinding** move (allowlisted hostname, attacker-controlled DNS flips to `127.0.0.1` between check and connect). Pin the connection to the address we validated; re-validate every hop.
- **No redirect following by default.** A `302` to `http://169.254.169.254/…` is the classic allowlist bypass. The proxy returns the redirect to the app as data; it does not chase it. (A future per-connection "follow redirects within the same allowlisted origin" knob is conceivable; default off.)
- **Header controls — request safelist, response blocklist.** Requests use a **safelist**: strip hop-by-hop headers and refuse to forward `Cookie`/`Authorization` *from the app* on a connection-backed origin (the app must not override our injected secret, nor smuggle our session cookie outbound). Responses use a **blocklist**: strip `Set-Cookie` and other sensitive headers off the response. The session cookie and the internal identity header (custom-backends §6.2) never leave our plane. **The response blocklist has tracked gaps today** — it omits `authorization`/`www-authenticate` (#7), the body caps read only `content-length` (#8), and the injection path still accepts cleartext `http://` (#11) (ADR-0005).
- **Response and time caps.** Max body size, max time, max concurrent proxied calls per app — a slow-loris or a 10 GB download is a DoS on the shared edge otherwise. Caps are config (`EDGE_FETCH_*`), mirroring the existing budget/limit env.
- **Egress isolation — its own zone, from day one.** The outbound call is made by the separate `helix-egress` service (architecture §3), which lives in its own network egress zone: it is the only component with a route to the public internet, so an SSRF bug *in the edge* reaches nothing, and the network-layer egress policy (block private ranges / IMDS at the firewall, not just in app code) backs the application-layer checks above — the belt-and-suspenders the custom-backends §4 IMDS lesson demands. We build this split from the start rather than running in-edge and extracting later, which would mean shipping the blast radius first.

This section gets the dedicated adversarial pass the auth handoff gets (project plan §6): rebinding, redirect-to-IMDS, header smuggling, allowlist-decode bypasses (the `/_api/fetch/` target must be validated both raw and percent-decoded, exactly as the edge already double-checks reserved paths).

## 7. Mechanism: the policy/mechanism split across two services

The call is handled by two services with a signed boundary between them (the policy/mechanism split of custom-backends §4). The **edge** is the policy plane and reuses the gateway spine wholesale; the **`helix-egress`** service is the mechanism plane and is the only thing that touches plaintext secrets or the public internet.

**On the edge (policy):**

- **Route.** `ALL /_api/fetch/*` on the app-host router (the same router that owns `/_api/llm/chat` and `/_api/data/*`), method preserved from the incoming request.
- **Identity.** `resolveCaller(req, reply, entry)` (`apps/edge/src/auth/gate.ts`) yields the `(app, user)` `Caller`, or the anonymous caller on `public` apps (`ANON_USER_OID`). No new identity code.
- **CSRF.** `isSameOrigin(...)` on every proxied call (it's a same-origin fetch by construction; reject anything else), identical to the data-handler's mutation check.
- **Allowlist.** The target origin (parsed from the path, raw *and* percent-decoded) must be a `proxy`-mode entry in the registry projection (`proxyConnections`); else `403`, before anything leaves the edge.
- **Quota.** A per-app daily request budget (`capabilities.fetch.requestsPerDay`), checked block-new/finish-in-flight against `gateway_calls` like the LLM token budget; the anonymous tier answers to the existing per-IP limiter (`apps/edge/src/gateway/ipRateLimiter.ts`) across all `/_api/*`, so the proxy inherits anon rate-limiting for free.
- **Attested instruction.** The edge mints a short-lived signed JWT `(app, user, capability, origin, connection?, request-id)` — same `jose`/HKDF primitives as the OIDC handoff token (`apps/edge/src/auth/{secrets,handoff}.ts`, new info string `helix-instruction-v1`) — and forwards the app's request + instruction to egress through the **`EgressProvider`** seam (an HTTP client to `EDGE_EGRESS_URL`, shaped like `LlmProvider`). The edge has **no grant on `app_secrets`** (it cannot read a connection secret) and no *arbitrary* outbound route — only egress reaches the open internet — so it can only *ask* egress to make a call it has authorized. It is **not** secretless, though: it holds its own operational keys (auth/instruction/OIDC) and today an over-broad Blob access key (tightening tracked; ADR-0001). And because the instruction is signed with a **symmetric secret both planes hold**, the seam attests the edge's decision but does **not** contain an edge compromise — a compromised edge could forge an instruction for any `appId` and steer egress to spend a connection; there is no `jti` replay-burn or `aud` check, and `method`/`path` are unbound today. Hardening is tracked: jti/aud burn now (#3), per-action authz + method/path binding before multi-tenant (#6), asymmetric Ed25519 signing post-M5 (ADR-0013).
- **Metering.** One `gateway_calls` row per call: `capability = "fetch"`, `model = <target origin>` (the existing `model` column doubles as the sub-resource label, as it already does for data verbs like `user.put`), byte counts in `inputTokens`/`outputTokens` (§11), `outcome ∈ {ok, error, refusal, quota_blocked, forbidden}`. Egress returns outcome + byte counts to the edge; the **edge** writes the row (it holds the `gateway_calls` INSERT grant and owns audit), so the immutable ledger and the Audit/Usage pages light up for `fetch` with **no portal changes** beyond a capability label.

**On `helix-egress` (mechanism):** verifies the instruction signature (trusts the edge's attestation, never re-authenticates the user); if a `connection` is named, resolves it to plaintext via the `SecretStore` (`packages/secret-store`) under the `helix_egress` role and re-checks the global-secret grant; applies the §6 SSRF controls at the network layer; injects the credential per the connection's recipe; makes the `undici` call; streams the upstream body straight back through the edge to the browser (never buffers); updates the secret's `last_used_at`. It carries the fat outbound-HTTP dependencies the dependency-minimal edge must not (the mechanism-plane-carries-deps principle, custom-backends §4).

## 8. Threat mapping

| Threat | Control |
| --- | --- |
| App exfiltrates a secret | App never receives it; injected server-side on the outbound hop (§5); `helix_edge` can't read secrets at all. |
| App SSRFs our network / IMDS | Allowlist-only egress + blocked private ranges + IMDS IP refused + no redirect-follow + DNS-rebind pinning (§6). |
| App smuggles the session cookie / internal identity header outbound | Header safelist strips them; app can't override the injected `Authorization` (§6). |
| App calls an origin it wasn't granted | Not in `proxyConnections`, `403 forbidden`, before egress (§6). |
| Anonymous flood on a `public` app | Per-IP limiter across all `/_api/*` (§7) + per-app request budget. |
| App tampers the audit trail | `gateway_calls` is INSERT-only for `helix_edge`; the proxy can append, never edit (§7). |
| Shim removed/bypassed to reach an origin | Gains nothing — non-granted direct call still dies on `connect-src 'self'`; shim is ergonomics, not a boundary (§3.2). |
| Decode-bypass of the target in the path | Target validated raw *and* percent-decoded against the allowlist, like reserved-path checks (§6). |

## 9. Milestone fit

Milestone **M4.5** (project plan), after the approval spine and CSP loop it builds on (both done — project plan §2/§6.2). The `helix-egress` service is stood up as its own deployable unit first; the rungs then ride on it, each independently shippable:

1. **Stand up `helix-egress` + keyless proxy + path-prefix contract + allowlist + SSRF hardening.** The service, the `EgressProvider`/attested-instruction seam, and `fetch.origins` with no secrets. Audited and metered the day it ships. This alone replaces the "had to grant a CORS-broken origin direct" failures. The adversarial egress suite lands *with* it.
2. **The deploy-lint / Violations "route through proxy" offer.** The adoption surface (§3.3) — turns the existing one-click origin grant into a direct-or-proxy choice. Pure portal work on top of rung 1.
3. **Secret-backed connections (header-bearer).** The `SecretStore` (`packages/secret-store` — dev envelope now, Key Vault for prod) + `connection` injection in egress (§5). The unique-value rung. (Designed in full in `docs/design/secrets-and-connections.md`.)
4. **The transparent shim — *built*.** Opt-in serve-time injection (§3.2), covering `fetch` **and** `XMLHttpRequest` (so axios works). `/_helix/fetch-shim.js` is served per-app with the proxied origins baked in; the edge buffers opt-in HTML and injects the tag after `<head>`. Last because it's the most serve-path-invasive and the least security-load-bearing.

## 10. Open questions / deliberately deferred

1. **Shim injection cost.** Shipped as **buffer-the-one-HTML-doc + inject** (bounded to opt-in apps), not a streaming transform. Open: is buffering opt-in HTML cheap enough to ever default it on, or does it stay strictly opt-in? Needs a serve-path benchmark. (Alternative still on the table: the deploy skill *adds* the shim reference to the bundle, trading zero-touch for zero serve-cost — viable for platform-first, useless for vibe-coded-first.)
2. **Connection injection beyond header-bearer.** OAuth client-credentials (refresh server-side), query-param keys, mTLS. v1 ships header-bearer; the rest is connection-schema work, deferred.
3. **Byte metering vs. token metering.** Reuse `inputTokens`/`outputTokens` as request/response byte counts, or add `gateway_calls` columns? Leaning reuse (no migration, the columns are already nullable) but it muddies the semantics — decide before rung 1.
4. **Stronger egress isolation, later.** `helix-egress` is its own SSRF-isolated container from day one (architecture §3), so the original "when do we extract it" question is moot. The remaining question is when egress needs a *heavier* posture — per-tenant egress IPs, or microVM/gVisor isolation once *untrusted code* runs in the egress path (custom backends, the rung ladder of custom-backends §3). Tie that to the §11 "third real app" line; the shared egress service is the right shape until then.
5. **WebSocket / SSE upstream.** The proxy is request/response. Long-lived upstream connections (a third-party stream) are a different shape — defer to the custom-backends "long-lived connections" gap (memo §3, rung 0/1), don't bolt onto the fetch-proxy.
