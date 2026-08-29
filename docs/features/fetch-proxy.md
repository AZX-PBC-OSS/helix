# Fetch proxy

> **Related ADRs:** [ADR-0005](../adr/0005-ssrf-egress-controls.md) (SSRF + secret injection) · [ADR-0013](../adr/0013-egress-trust-model.md) (egress trust model) · [ADR-0001](../adr/0001-three-runtime-split.md) (three-runtime split / edge posture) · [ADR-0014](../adr/0014-same-origin-api-gateway.md) (same-origin API gateway).

**What it is.** Governed outbound HTTP for hosted apps (architecture §6.1; design
`docs/design/fetch-proxy.md`). An app calls a third-party API through a
same-origin path — `fetch('/_api/fetch/https://api.github.com/...')` — and the
platform makes the call on its behalf: audited, metered, SSRF-controlled, and
(when configured) with a credential injected server-side so the app never holds
it. The blocked-`connect-src` call has an on-platform answer.

| Route | Who | What |
| --- | --- | --- |
| `ALL /_api/fetch/<url>` | app host (edge) | authorize → mint instruction → forward to egress → stream back |
| `POST /proxy` | `helix-egress` (internal) | verify instruction → inject secret → SSRF controls → outbound call |

## How it works

The call crosses the policy/mechanism boundary (architecture §3): the edge
decides *whether* the call may happen and to *where*; egress actually makes it.

### The edge (policy plane)

`makeFetchHandler` (mirrors the LLM/data handlers):

1. **Gate.** `resolveCaller` — an authenticated session, or the anonymous caller
   on `public` apps (`ANON_USER_OID`). Anonymous callers also hit the per-IP
   limiter shared with the rest of `/_api/*`.
2. **CSRF.** `isSameOrigin` — the proxy call is same-origin by construction;
   anything else is `403`.
3. **Allowlist.** The target origin (parsed from the path raw *and*
   percent-decoded) must be a **proxied** origin in the app's manifest
   (`capabilities.fetch.origins`, projected as `proxyConnections`). Not present ⇒
   `403`, before anything leaves the edge. Direct-CSP origins
   (`externalOrigins`) are a separate list and are *not* proxied.
4. **Quota.** A per-app `requestsPerDay` budget (block-new/finish-in-flight),
   counted from `gateway_calls`.
5. **Attest + forward.** The edge mints a short-lived signed instruction
   `(app, user, capability, origin, connection?, request-id)` and forwards the
   request + instruction to egress over the `EgressProvider` HTTP seam. The edge
   has **no grant on `app_secrets`** (it cannot read an app's connection secret)
   and no *arbitrary* outbound route — only egress reaches the open internet — so
   it can only ask egress to make a call it already authorized. The edge is *not*
   secretless, though: it holds its own operational keys (auth/instruction/OIDC)
   and today an over-broad Blob access key (tightening that to a read-only managed
   identity is tracked). (ADR-0001.)

### `helix-egress` (mechanism plane)

`POST /proxy` (`apps/egress/src/proxy.ts`) — the only component that touches
plaintext secrets or the public internet:

1. **Verify** the attested instruction (`jose`, HKDF key shared with the edge,
   `typ`-bound, 30 s TTL). Trusts it; never re-authenticates the user.
2. **Resolve + inject** the named connection secret, if any
   (`PgSecretResolver` under the `helix_egress` role; see
   `secrets-and-connections.md`). The credential is applied per its recipe
   (`Authorization: Bearer …`, a header template, or a query param).
3. **SSRF controls** (`apps/egress/src/ssrf.ts`): resolve every address and
   refuse private / loopback / link-local / `169.254.169.254` (IMDS); pin the
   connection to the validated IP (cert/SNI still checked against the hostname),
   defeating DNS rebinding; no redirect-following (undici 7 only follows redirects
   when a `redirect` interceptor is composed onto the dispatcher, and egress
   composes none — a `302` to IMDS comes back as data, never chased, and its
   `Location` is stripped so the browser can't chase it either; issue #10).
4. **Header controls** — a **request-header safelist** (the app's
   `cookie`/`authorization` never go upstream: no session leak, no overriding the
   injected credential) plus a **response-header blocklist** (`set-cookie` and
   friends stripped off the response). The response blocklist has tracked gaps
   today — it omits `authorization`/`www-authenticate` (#7), the body caps read
   only `content-length` (#8), and the injection path still accepts cleartext
   `http://` (#11). (ADR-0005.)
5. **Stream** the upstream response straight back through the edge to the
   browser; never buffered.

### Metering

The **edge** writes one `gateway_calls` row per call (`capability = "fetch"`,
`model = <target origin>`, `path` + `method` for the request line, outcome mapped
from the egress outcome header) — it holds the ledger grant and owns audit.
Egress writes only `app_secrets.lastUsedAt`. The Audit/Usage pages light up for
`fetch` with no extra work.

The **allowlist denial is metered too**, as `outcome = "forbidden"` — an app
reaching for an origin its manifest never granted is the most audit-interesting
event on this surface, and it is the one outcome here that never reaches egress.
It is **rate-capped per (app, env)** (`DenialThrottle`): this is the one ledger
write no other gate bounds — the per-IP limiter skips authenticated callers, the
allowlist check returns before the quota gate, and the budget query excludes
`forbidden` — so without a cap a retry loop against a typo'd host appends to an
undeletable table at line rate. Past the cap the call is still refused; only the
metering is dropped, with a summary log line. The first rows carry the whole
audit signal. It does **not** count against `requestsPerDay`: that budget prices work done at
the egress boundary, and a denial mints no instruction and dials nothing, exactly
like `quota_blocked`. (Counting denials would not bound the ledger either — the
allowlist check returns *before* the quota gate, so a denial loop never reaches
it; counting would only starve the app's legitimate traffic.)

`path` is the target's **pathname only — the query string is not recorded**,
matching the line `redactFetchTarget` in `@azx-pbc/shared/logging` draws for
request logs. That is where credentials are conventionally placed (`?api_key=`, a
SAS `?sig=`).

**It does not follow that `path` is credential-free.** Some APIs put the secret in
a path segment (Telegram `/bot<TOKEN>/…`, Slack webhooks), and those are retained.
No heuristic tries to spot one: a token segment and a REST resource id are the
same shape, so any test that catches the former also eats `/customers/<uuid>/orders`
— the value this column exists to capture. The mitigations are bounding rather
than detection (truncation at write time, and the denial cap above), and
retention is the real fix. Read ADR-0021 for the full position, including the
asymmetry that matters most: log lines age out, ledger rows have no DELETE grant
for any role.

## Try it

The capability is enabled when both `EDGE_EGRESS_URL` and
`HELIX_INSTRUCTION_SECRET` are set (dev container: both are, and
`pnpm dev:egress` runs the service on `:8081`). Add a proxied origin in the
portal's **Capabilities → Fetch proxy** card (optionally bound to a connection
secret), approve it, then from the app:

```js
const r = await fetch("/_api/fetch/https://api.github.com/users/octocat");
const user = await r.json(); // proxied, audited; no CSP exception needed
```

## Transparent shim (zero-edit adoption)

For apps that set `capabilities.fetch.shim`, the edge builds a per-app script
(proxied origins baked in) and **inlines** it at the top of the document's
`<head>` at serve time (`apps/edge/src/serving/shim.ts`, wired from
`assets.ts`). It monkeypatches **both `window.fetch` and
`XMLHttpRequest.prototype.open`** — XHR too because `axios` defaults to the XHR
adapter — so an unmodified `fetch('https://api.github.com/…')` to a *granted*
origin is transparently rewritten to `/_api/fetch/…` with no code change. Inline
at the top of `<head>`, the patch lands before any app code captures `fetch`.

It used to be served from `/_helix/fetch-shim.js` and referenced with a
`<script src>`. That path is deliberately unprecachable by the offline
capability's service worker, so an app holding both grants lost the shim on
every offline cold boot — proxied calls then went direct and died on CSP rather
than failing as a proxy error (ADR-0035, amendment to §9). The route is gone.

It is **ergonomics, not a boundary**: it only ever adds reach the manifest
already granted (a rewrite to a non-allowlisted origin still 403s at the edge),
so deleting or bypassing it gains nothing — a direct call still dies on
`connect-src 'self'`. It fails safe. Toggle it in the portal's **Capabilities →
Fetch proxy** card.

## Key files

- `apps/edge/src/gateway/fetch.ts` — `makeFetchHandler`, the policy plane.
- `apps/edge/src/serving/shim.ts` + `assets.ts` — the shim script + serve-time injection.
- `apps/edge/src/gateway/instruction.ts` — mints the attested instruction.
- `apps/egress/src/{proxy,ssrf,instruction}.ts` — the mechanism plane: verify, inject, SSRF, stream.
- `packages/shared/src/{instruction,manifest}.ts` — the instruction payload + `capabilities.fetch` schema.

## Design notes (the why)

- **Why a separate plane, not a forked process.** Secret injection breaks the
  password pattern's containment: a password projects only a *hash* (the edge
  verifies, never recovers it), but a connection secret must be injected as
  *plaintext* into an outbound header — "you can't inject a hash." The boundary
  that matters is a separate deployable unit with its **own** managed identity
  (authenticates to Key Vault as itself) and **own** network zone — a forked
  process shares both and "buys you almost nothing." The split buys three things:
  credential isolation that is true-by-architecture not by-code-review;
  **network/SSRF isolation** (the big one — the edge has no *arbitrary* outbound
  route, only egress reaches the open internet, so an SSRF bug in the edge itself
  reaches nothing; ADR-0001); and dependency
  isolation (the fat HTTP deps live on egress, the edge stays minimal §3). Honest
  limit: extraction *relocates* the all-secrets read, it doesn't eliminate it —
  egress still holds the vault grant.
- **Attested instruction, not re-auth.** Egress trusts the edge's signed
  attestation and never re-authenticates the user, so a compromised egress can't
  become an identity-forging service — it can only act on what the edge already
  attested. The instruction reuses the OIDC-handoff primitives (`jose` + HKDF off
  `HELIX_INSTRUCTION_SECRET`), domain-separated by a distinct `typ` and HKDF info
  string, carrying `(app, user, capability, origin, connection?, request-id)`
  with a 30 s TTL. It now also carries `aud: "azx-egress"` and a `jti` (= the
  request-id), **burned one-time at egress** so a captured instruction can't be
  replayed within its TTL (ADR-0013 Step 1, issue #3 — `apps/egress/src/burn.ts`,
  shared `instruction_jti` table). **This seam still does not contain an *edge*
  compromise:** the instruction is signed with a **symmetric secret both planes
  hold**, so a compromised edge can forge an instruction for any `appId`, and
  `method`/`path` are still unbound. The edge cannot *read* `app_secrets`
  directly (no DB grant), but it can steer egress to spend a connection.
  Remaining hardening is tracked: per-action authz + method/path binding before
  multi-tenant (#6), asymmetric (Ed25519) signing post-M5 (ADR-0013). A header
  today; the shape is forward-compatible with an mTLS/SPIFFE SVID later.
- **The adoption spine** is three rungs that never fork the mental model: (1) the
  path-prefix wire contract `fetch('/_api/fetch/https://…')` — a mechanical
  string prefix that is codemod-able (a POST-envelope design was rejected because
  it forces a full rewrite); (2) the opt-in shim above; (3) CSP-origin grants and
  the fetch proxy as "one knob, two settings" (`mode: direct|proxy`). Shim scope
  is **HTTP request/response only** — out of scope by design: WebSocket,
  EventSource/SSE, and `<img>`/`<form>`/font loads.
- **SSRF gotchas.** `undici.request` (v7) follows a redirect only if a `redirect`
  interceptor is composed onto the dispatcher; egress composes none, so a `302` to
  IMDS is returned as data, never chased — and `Location` is stripped from the
  response so the browser can't follow it un-proxied either (issue #10).
  `URL.hostname` keeps IPv6
  brackets (`[::1]`) which `isIP` rejects — they're stripped before resolve. The
  whole host is refused if *any* resolved address is blocked (defeats a
  dual-A-record split), and the connection is pinned to the validated IP against
  rebind. App-layer checks here are the belt; an NSG/firewall is the
  network-layer suspenders in prod.

## Planned / not yet built

- **Egress byte metering** — `gateway_calls` records the call + outcome; request/
  response byte counts are not yet tallied.
- **Stronger egress isolation** (per-tenant egress, microVM) lands only when
  *untrusted* code runs in the egress path (custom backends); shared egress is
  fine while the egress code is ours — design §10.
