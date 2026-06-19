# Fetch proxy

**What it is.** Governed outbound HTTP for hosted apps (architecture §6.1; design
`docs/design/fetch-proxy.md`). An app calls a third-party API through a
same-origin path — `fetch('/_api/fetch/https://api.github.com/...')` — and the
platform makes the call on its behalf: audited, metered, SSRF-controlled, and
(when configured) with a credential injected server-side so the app never holds
it. The blocked-`connect-src` call has an on-platform answer.

**Handler.** Edge policy plane: `apps/edge/src/gateway/fetch.ts` (route in
`app.ts`). Mechanism plane: the separate **`azx-egress`** service (`apps/egress`).

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
it into the app's HTML (`apps/edge/src/serving/shim.ts`). It monkeypatches
**both `window.fetch` and `XMLHttpRequest.prototype.open`**, so an unmodified
`fetch('https://api.github.com/…')` — or an `axios.get(...)` (XHR adapter) — is
transparently rewritten to `/_api/fetch/…` with no code change. It's ergonomics,
not a boundary: it only adds reach the manifest already granted, so removing it
just falls back to a CSP-blocked direct call. Toggle it in the portal's
**Capabilities → Fetch proxy** card.

## Planned / not yet built

- **Egress byte metering** — `gateway_calls` records the call + outcome; request/
  response byte counts are not yet tallied.
- **Stronger egress isolation** (per-tenant egress, microVM) lands only when
  untrusted code runs in the egress path (custom backends) — design §10.
