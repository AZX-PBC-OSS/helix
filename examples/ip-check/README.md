# IP check

Two buttons call [ipify's IPv4 API](https://www.ipify.org): one directly from
the browser, one through `/_api/fetch/https://api.ipify.org`. Compare the proxy
result with the Azure deployment's `egressNatPublicIp` output to verify NAT
egress. The browser result is the user's public IP (or their VPN/proxy's).

Each click uses a unique query parameter and disables browser caching. Results
include a timestamp and elapsed time; failures clear the previous address.
No API key or connection secret is needed.

## Deploy and configure

The built `dist/` is included, so deployment needs no install or build step.
Point `HELIX_PORTAL_URL` at the deployment you want to test, then:

```bash
cd examples/ip-check
helix login
helix create --display-name "IP check"
helix deploy --promote
```

In the app's portal Capabilities tab, grant `https://api.ipify.org` both as a
direct external origin and as a keyless fetch-proxy origin. Leave the transparent
fetch shim **off**: it would rewrite the browser request through the proxy too.
The app refuses the browser check if it detects that shim.

Alternatively, apply `manifest.json` to this new app using an API bearer token:

```bash
curl --fail-with-body -X PUT "$HELIX_PORTAL_URL/api/v1/apps/ip-check/manifest" \
  -H "Authorization: Bearer $HELIX_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @manifest.json
```

`helix deploy` does not apply this manifest file. Complete any required approval
in the portal, allow the edge projection to refresh, and reload the hosted app.
Use authenticated app access for the proxy check.

## Verify NAT

Read the expected address:

```bash
az deployment group show -g <rg> -n <deployment> \
  --query properties.outputs.egressNatPublicIp.value -o tsv
```

Click each button. The **proxy** result should equal that output when the egress
subnet routes through NAT. Different browser/proxy results alone do not prove
the NAT configuration is correct. The ingress IP is not the expected value.
Repeat after revision changes and scale-out; existing egress connections can
retain an older route until re-established. See the
[NAT runbook](../../infra/azure/README.md#enable-and-verify).

Local browser and egress traffic can share one public IP. A plain Vite server
can exercise the browser button; the proxy button needs the app hosted on Helix
with egress running and the capability granted.

## Rebuild

```bash
pnpm install --ignore-workspace
pnpm typecheck
pnpm build
```

Include regenerated `dist/` files with source changes.
