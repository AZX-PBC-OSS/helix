# @azx-pbc/dev-oauth-vendor

The **fixture OAuth vendor** for the OAuth-connections acceptance work (I-02
T-0005, [ADR-0010](../../.shipwright/initiatives/I-02/architecture.md)): a
hand-rolled minimal vendor with per-test fault control that no real vendor (or
`dev-idp`'s oidc-provider) can produce deterministically — a hanging token
endpoint, consumed-then-dropped refresh grants, and an API destination that
reports which header the access token arrived in. **Never deployed** — dev-only
test infrastructure, like [`apps/dev-idp`](../dev-idp/README.md), which it
siblings.

## Run

```bash
pnpm dev:vendor      # http://localhost:3003 (OAUTH_VENDOR_PORT overrides)
```

Like dev-idp it runs **inside the workspace container**, not as a compose
service, and needs no CI service container: suites boot it **in-process on an
ephemeral port** and drive it over real HTTP.

```ts
import { startDevOAuthVendor } from "@azx-pbc/dev-oauth-vendor";
const vendor = await startDevOAuthVendor(); // ephemeral port, parallel-safe
```

## Surface

- `GET /authorize` — authorization-code entry. Auto-approves (302 to
  `redirect_uri` with `code` + `state`) when the instance's authorize mode is
  `approve`, and 302s back with the standard `error=access_denied` when it is
  `deny`. S256 PKCE is required end to end: the authorize request must carry
  `code_challenge` + `code_challenge_method=S256`, and the exchange must
  present the matching `code_verifier`. An unregistered `redirect_uri` is
  answered 400 without redirecting (RFC 6749 §4.1.2.1).
- `POST /token` — form in, JSON out, standard error shapes, so
  [openid-client](https://github.com/panva/openid-client) validates the
  non-fault responses. Four switchable modes (see `TOKEN_MODES`):
  - **`rotating`** — a refresh grant retires the presented refresh token and
    issues a replacement (`refresh_token` in the response).
  - **`non-rotating`** — a refresh grant succeeds and **omits**
    `refresh_token`; the presented token stays valid. Retain-on-omission
    semantics are the caller's problem (spec criterion 35), not the fixture's.
  - **`hang`** — every token request stalls until the caller gives up; the
    response is never written while the client is listening. Use a short
    caller timeout.
  - **`consumed-then-drop`** — the presented grant (refresh token or
    authorization code) is consumed and a standard `invalid_grant` error is
    returned: nothing usable comes back, and the grant is gone on retry (the
    criterion-39 uncertainty shape).
- **API destination** — every path the OAuth surface does not own is the fake
  vendor API, any method. It answers with which header the access token
  arrived in: `{ placement, headerName, token, method, path }`, where
  `placement` mirrors `TokenPlacement`'s kinds (`header-bearer` /
  `header`, plus `none` with a 401 when no token arrived). `Authorization:
Bearer` wins when both placements are present; the named header is
  `x-user-token` by default and per-instance configurable
  (`apiTokenHeaderName`).

Grant codes are single-use (a failed redemption burns them, strictly), state
is in-memory per instance, and tokens are opaque random strings.

## Modes are per-test, never global

There is **no module-level mode anywhere**. Choose modes per instance at
`startDevOAuthVendor({ authorizeMode, tokenMode })`, flip an instance
mid-journey with `vendor.setModes({ tokenMode: "hang" })` (connect in
`rotating`, then hang the renewal), or boot two instances side by side and
watch them disagree — concurrently running suites cannot leak into each
other.

## It is a test knob, not a vendor claim

Nothing the fixture does may be read as a claim about how any real vendor
behaves — rotation-mode defaults and scope conventions are test knobs, and the
real-vendor evidence is the manual Asana acceptance exercise (spec criterion
55), which no fixture substitutes for. This service exists to be controllable,
not to be a reference server (ADR-0010 §Consequences).

## In tests

```ts
import {
  startDevOAuthVendor,
  requestAuthorizationCode,
  exchangeAuthorizationCode,
  refreshAccessToken,
  callApiDestination,
  TOKEN_MODES,
  JOURNEYS,
} from "@azx-pbc/dev-oauth-vendor";

const vendor = await startDevOAuthVendor({ tokenMode: "rotating" });
const grant = await requestAuthorizationCode(vendor, { redirectUri, state });
const tokens = await exchangeAuthorizationCode(vendor, grant.code!, {
  verifier,
  redirectUri,
});
const report = await callApiDestination(vendor, { bearerToken: tokens.body.access_token });
// report.report → { placement: "header-bearer", headerName: "authorization", ... }
await vendor.close();
```

`TOKEN_MODES` / `JOURNEYS` are the shared vocabulary every consumer suite
(portal callback, egress renewal, edge flow, browser lane) imports — the one
fixture contract, defined here (ADR-0010 §Shared ground).
