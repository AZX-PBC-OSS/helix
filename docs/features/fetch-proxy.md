# Fetch proxy

**What it is.** Governed outbound HTTP for hosted apps (architecture §6.1; design
`docs/design/fetch-proxy.md`). An app calls a third-party API through a
same-origin path — `fetch('/_api/fetch/https://api.github.com/...')` — and the
platform makes the call on its behalf: audited, metered, SSRF-controlled, and
(when configured) with a credential injected server-side so the app never holds
it. The blocked-`connect-src` call has an on-platform answer.

| Route | Who | What |
| --- | --- | --- |
| `ALL /_api/fetch/<url>` | app host (edge) | authorize → mint instruction → forward to egress → stream back |
| `POST /proxy` | `azx-egress` (internal) | verify instruction → inject secret → SSRF controls → outbound call |

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
   holds no secret and has no internet route — it can only ask egress to make a
   call it already authorized.

### `azx-egress` (mechanism plane)

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
   defeating DNS rebinding; no redirect-following (a `302` to IMDS is returned as
   data, never chased).
4. **Header safelist** both directions — the app's `cookie`/`authorization`
   never go upstream (no session leak, no overriding the injected credential),
   and `set-cookie` is stripped off the response.
5. **Stream** the upstream response straight back through the edge to the
   browser; never buffered.

### Metering

The **edge** writes one `gateway_calls` row per call (`capability = "fetch"`,
`model = <target origin>`, outcome mapped from the egress outcome header) — it
holds the ledger grant and owns audit. Egress writes only `app_secrets.lastUsedAt`.
The Audit/Usage pages light up for `fetch` with no extra work.

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

For apps that set `capabilities.fetch.shim`, the edge serves a per-app script at
`/_helix/fetch-shim.js` (proxied origins baked in) and injects a `<script>` for
it at the top of the document's `<head>` at serve time
(`apps/edge/src/serving/shim.ts`, wired from `assets.ts`). It monkeypatches
**both `window.fetch` and `XMLHttpRequest.prototype.open`** — XHR too because
`axios` defaults to the XHR adapter — so an unmodified
`fetch('https://api.github.com/…')` to a *granted* origin is transparently
rewritten to `/_api/fetch/…` with no code change. A plain (non-async) external
`<script>` blocks parsing until it runs, so the patch lands before any app code
captures `fetch`.

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
  **network/SSRF isolation** (the big one — the edge runs with *zero* internet
  egress, so an SSRF bug in the edge itself reaches nothing); and dependency
  isolation (the fat HTTP deps live on egress, the edge stays minimal §3). Honest
  limit: extraction *relocates* the all-secrets read, it doesn't eliminate it —
  egress still holds the vault grant.
- **Attested instruction, not re-auth.** Egress trusts the edge's signed
  attestation and never re-authenticates the user, so a compromised egress can't
  become an identity-forging service — it can only act on what the edge already
  attested. The instruction reuses the OIDC-handoff primitives (`jose` + HKDF off
  `HELIX_INSTRUCTION_SECRET`), domain-separated by a distinct `typ` and HKDF info
  string, carrying `(app, user, capability, origin, connection?, request-id)`
  with a 30 s TTL. A header today; the shape is forward-compatible with an
  mTLS/SPIFFE SVID later.
- **The adoption spine** is three rungs that never fork the mental model: (1) the
  path-prefix wire contract `fetch('/_api/fetch/https://…')` — a mechanical
  string prefix that is codemod-able (a POST-envelope design was rejected because
  it forces a full rewrite); (2) the opt-in shim above; (3) CSP-origin grants and
  the fetch proxy as "one knob, two settings" (`mode: direct|proxy`). Shim scope
  is **HTTP request/response only** — out of scope by design: WebSocket,
  EventSource/SSE, and `<img>`/`<form>`/font loads.
- **SSRF gotchas.** `undici.request` does not follow redirects by default, so a
  `302` to IMDS is returned as data, never chased. `URL.hostname` keeps IPv6
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
