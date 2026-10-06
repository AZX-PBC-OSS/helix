# Raise the fetch-proxy body cap on Azure

This runbook raises the per-direction body cap on `/_api/fetch` from 10 MiB to
25 MiB on the deployed platform. The cap is a code default today, and
`infra/azure` never sets it, so the change adds a Bicep parameter and then
applies it.

## Why

An app sends long audio recordings to the Azure Foundry transcription API
through the fetch-proxy, and those recordings are larger than 10 MiB. The target
is 25 MiB because the OpenAI-style `/audio/transcriptions` endpoint caps uploads
at 25 MB. Setting the platform cap higher than that would not help this
endpoint.

The app should also send compressed audio, such as mono Opus in WebM or
low-bitrate mono MP3, instead of stereo WAV. That change alone fits about
45 minutes of audio into 10 MiB. The cap raise is still fine to ship.

Out of scope: the 120 s fetch timeouts (`EDGE_FETCH_TIMEOUT_MS`,
`EGRESS_TIMEOUT_MS`), the 1 MiB parsed-JSON limit on the LLM and data routes,
the deploy-bundle caps, and app code.

## What enforces the cap

Three container apps each enforce the cap independently. Any app left at the
default keeps rejecting bodies over 10 MiB with a 413.

| Container app                         | Bicep module    | Env var                     | Read in                                                     |
| ------------------------------------- | --------------- | --------------------------- | ----------------------------------------------------------- |
| helix-edge                            | `edgeApp`       | `EDGE_FETCH_MAX_BODY_BYTES` | `apps/edge/src/config.ts` (`fetch.maxBodyBytes`)            |
| helix-egress                          | `egressApp`     | `EGRESS_MAX_BODY_BYTES`     | `apps/egress/src/config.ts` (`limits.maxBodyBytes`)         |
| dev gateway (when `deployDevGateway`) | `devGatewayApp` | `EDGE_FETCH_MAX_BODY_BYTES` | Same edge config; `apps/edge/src/devGateway/` proxies fetch |

Bodies are streamed through a byte counter (`capBody`), not buffered, so a
higher cap does not raise memory use per request. It does mean each call can
move more bytes and hold its connection open longer.

Neither service validates the value. Both use `Number(env.X ?? default)`, so a
malformed value turns into `NaN` and is not caught at boot. The Bicep `int`
type and `@minValue` are what guard it.

## 1. Edit `infra/azure/main.bicep`

Follow the `deployMaxFileMb` pattern: the parameter is an int in MB, and the env
block converts it to bytes.

Add the parameter next to `deployMaxBundleMb`:

```bicep
@description('Per-direction body cap in MB for the /_api/fetch proxy, enforced independently by the edge, the dev gateway and egress. Bodies are streamed, not buffered, so this bounds bytes per call rather than memory.')
@minValue(1)
param fetchMaxBodyMb int = 25
```

Add one shared var so the three env entries cannot drift:

```bicep
var fetchMaxBodyBytes = string(fetchMaxBodyMb * 1024 * 1024)
```

Add the env entries:

- `edgeApp` and `devGatewayApp`, next to `EDGE_EGRESS_URL`:
  `{ name: 'EDGE_FETCH_MAX_BODY_BYTES', value: fetchMaxBodyBytes }`
- `egressApp`, next to `EGRESS_PORT`:
  `{ name: 'EGRESS_MAX_BODY_BYTES', value: fetchMaxBodyBytes }`

No `main.bicepparam` edit is needed while 25 is the default. For a different
value, set `fetchMaxBodyMb` in the params file or pass
`--parameters fetchMaxBodyMb=<n>`.

## 2. Document it

- `infra/azure/README.md`: add a short "Fetch-proxy body cap" note beside the
  "Deploy bundle size caps" section. List the param and its default, and say
  that one value feeds both hops.
- `apps/docs/src/deploy/configuration.md`: add `EDGE_FETCH_MAX_BODY_BYTES` and
  `EGRESS_MAX_BODY_BYTES`, which the operator config page does not list today.

## 3. Check and commit

```bash
cd infra/azure && az bicep build --file main.bicep
cd ../.. && ./check-and-lint.sh
```

Commit on a branch. The CI `bicep` job compiles `main.bicep` and
`main.bicepparam`.

## 4. Preview and apply

A full template apply touches every container app. Two parameters can roll more
than this change if you leave them at their defaults:

- **`imageTag`** reads `HELIX_IMAGE_TAG` and falls back to `latest`. Pin it to
  the tag the apps run now, so this apply does not also roll the images:

  ```bash
  az containerapp show -g <rg> -n <namePrefix>-edge \
    --query 'properties.template.containers[0].image' -o tsv
  ```

- **`deployDevGateway`** defaults to `false` in `main.bicepparam`. If the dev
  gateway is deployed, pass `deployDevGateway=true`, or the apply will not
  manage it.

`main.bicepparam` also reads several `HELIX_*` environment variables (OIDC
client ids, admin group, ACME, trust proxy). Load the same environment the last
production apply used. A missing variable renders as an empty string, not as
the current value. Read "Known deploy gotchas" in `infra/azure/README.md`
before applying.

```bash
cd infra/azure
export HELIX_IMAGE_TAG=<current tag>
az deployment group what-if -g <rg> -f main.bicep -p main.bicepparam \
  --parameters deployApps=true [deployDevGateway=true]
```

The what-if should show only:

- the new env var on the edge, egress and dev gateway container apps;
- the new revisions those changes create.

Stop and investigate any other diff, especially images, OIDC settings, custom
domains or secrets. If the diff is clean, run the same command with
`az deployment group create`.

## 5. Verify

Confirm the env var on each app:

```bash
for app in edge egress dev-gateway; do
  az containerapp show -g <rg> -n <namePrefix>-$app \
    --query "properties.template.containers[0].env[?contains(name,'MAX_BODY')]" -o table
done
```

Each should show `26214400`. Confirm the new revisions are healthy, and that
`GET /health` on the edge reports `ok`.

For an end-to-end check, have the app owner repeat the failing upload. A
15–20 MiB file should now succeed. A file over 25 MiB should get a 413 from the
platform, or an error from the vendor, which has its own 25 MB limit.

## Rollback

Set `fetchMaxBodyMb=10` and apply again with the same pinned tag. As a faster
stopgap, set the env var directly with `az containerapp update -n <app>
--set-env-vars EDGE_FETCH_MAX_BODY_BYTES=10485760` on the edge and dev gateway,
or `EGRESS_MAX_BODY_BYTES=10485760` on egress. The next template apply
overwrites a hand-set value, so record any stopgap in the params.
