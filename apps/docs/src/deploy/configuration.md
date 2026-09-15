---
title: Configuration reference
---

# Configuration reference

Everything an operator configures lives in two places:

- **Bicep parameters** — `infra/azure/main.bicepparam`, applied by the deploy.
- **Environment variables** — secrets are supplied as `HELIX_*` variables at
  deploy time; the template injects them (and every other runtime setting) into
  the container apps.

This page lists the parameters you will actually touch, grouped by what they
affect. Every parameter also carries a `@description` in
[`main.bicep`](https://github.com/AZX-PBC-OSS/helix/blob/main/infra/azure/main.bicep),
which is the complete and current list.

## Names and resources

| Parameter | Default | What it is |
| --- | --- | --- |
| `namePrefix` | `helix-prod` | Prefix for every resource name |
| `location` | resource group's region | Azure region for all resources |
| `storageAccountName` | — | Globally unique, 3–24 lowercase alphanumerics |
| `platformVaultName` | — | Globally unique Key Vault name (platform config secrets) |
| `connectionsVaultName` | — | Globally unique Key Vault name (app connection secrets) |
| `postgresServerName` | — | Globally unique Postgres Flexible Server name |
| `blobContainerName` | `app-bundles` | Blob container for app bundles |

## Data

| Parameter | Default | What it is |
| --- | --- | --- |
| `postgresSkuName` | `Standard_D2ds_v5` | Postgres SKU. A `Standard_B1ms` burstable SKU is fine for small installs and costs meaningfully less |
| `postgresSkuTier` | `GeneralPurpose` | Must match the SKU family (`Burstable` for B-series) |
| `postgresStorageSizeGB` | `32` | Postgres disk size. Growing it is a maintenance operation |

## Domains and TLS

| Parameter | Default | What it is |
| --- | --- | --- |
| `appsDomain` | — | Your apps domain. Apps live on `<slug>.<appsDomain>`, sign-in on `auth.<appsDomain>`, the portal on `portal.<appsDomain>` |
| `deployCertbot` | `true` | The scheduled job that issues and renews the `*.<appsDomain>` Let's Encrypt certificate via DNS-01 |
| `acmeEmail` | *(empty)* | Required for the certificate — the job is skipped without it |
| `acmeServer` | Let's Encrypt **staging** | Switch to `https://acme-v02.api.letsencrypt.org/directory` once the flow is validated |
| `wildcardTlsBound` | `false` | Flip to `true` after the first certbot run (see below) |
| `domainVerificationId` | *(empty)* | ACA's custom-domain verification id (from the edge deployment output), needed before the first certbot run |
| `edgeTrustProxy` | `auto` | The address of the ingress the edge should trust for `req.ip`. Leave at `auto` behind ACA; set an address only if something else fronts the edge |

## TLS: the `wildcardTlsBound` flag

A certificate has to exist before a hostname can bind to it, so this is a
two-phase flag. While it is `false` (a fresh install), the certbot job makes
the bindings at runtime — but a full template re-apply **strips** them. After
the first successful certbot run, set it to `true` and re-apply; from then on
the template declares the bindings itself and re-applies preserve them.

Set it literally in `main.bicepparam`, never from an environment variable — a
set-but-blank variable reads as `false`, and that is the direction that wipes
the bindings. The what-if check in
[getting started](/deploy/getting-started#step-3-deploy-the-infrastructure)
catches a wrongly-off flag before it does damage.

## Feature gates

| Parameter | Default | What it is |
| --- | --- | --- |
| `deployApps` | `false` | The two-phase switch: `false` deploys infrastructure only, `true` adds the container apps |
| `deployFirewall` | `true` | The Azure Firewall that enforces the egress-only network zone. **Keep on for production** — it is the primary outbound control. `false` saves ~$920/month and is for dev/test installs only |
| `deployDevGateway` | `false` | The opt-in cross-origin dev surface (`dev-api.<appsDomain>`) for building apps locally against a deployed platform |
| `portalExternal` | `false` | Puts the portal on the public load balancer at `portal.<appsDomain>`, gated by Entra sign-in. Without it (or a private network path), nobody can reach the portal |
| `allowPublicApps` | `false` | Permits `public` (anonymous) app visibility on this install |
| `allowPasswordApps` | `false` | Permits `password` (shared-passphrase) app visibility |

## App behavior

| Parameter | Default | What it is |
| --- | --- | --- |
| `llmEndpoint` | `https://api.anthropic.com` | The LLM upstream the edge gateway proxies to |
| `platformMonthlyUsdCap` | `1000` | Display-only LLM spend line on the admin Activity page. `0` hides it. Nothing enforces it — per-app daily budgets are the real limit |
| `deployMaxFileMb` | `50` | Max uncompressed size of any single file in a deployed bundle |
| `deployMaxBundleMb` | `250` | Max uncompressed size of the whole bundle (and the compressed upload). Raising it a lot wants more CPU/memory on the portal container |
| `imageRegistry` / `imageTag` | `ghcr.io/azx-pbc-oss` / `latest` | Where the three service images come from |
| `logLevel` | `info` | Log level for all four services. `debug` on the edge puts app-request detail in Log Analytics (30-day retention) — treat it as a data decision, not a volume one |

## Observability and alerts

| Parameter | Default | What it is |
| --- | --- | --- |
| `deployTelemetry` | `true` | OTLP collectors + Application Insights. `false` leaves telemetry inert — the platform's documented default state |
| `deployAlerts` | `true` | Alert rules on the platform's own telemetry (registry staleness) |
| `deployAvailabilityTests` | `true` | Outside HTTP probes on the public hosts — the only monitoring that works when the platform can't see itself. Billed per execution |
| `deployInfraAlerts` | `true` | Azure platform-metric rules: Postgres availability/storage, restart storms, edge 5xx |
| `alertEmails` | `[]` | Who alerts notify. **Empty means the rules still deploy and still fire — at nobody.** Always set this, or turn alerts off |
| `registryStalenessThresholdMs` | `1200000` | Staleness that fires the registry alert |
| `availabilityTestFrequencySeconds` | `300` | Probe interval per location — the cost knob for availability tests |
| `availabilityExtraTargets` | `[]` | Extra URLs to probe, e.g. one real hosted app |
| `edgeServerErrorThreshold` | `100` | Edge 5xx per 15 minutes before the alert fires. Deliberately insensitive: one broken app is not a platform incident |

## Cost

| Parameter | Default | What it is |
| --- | --- | --- |
| `deployCostBudget` | `true` | A monthly budget that **notifies** — nothing enforces it |
| `expectedMonthlyUsdExFirewall` | `125` | Expected monthly spend without the firewall. **Set this per install** — the Postgres SKU alone moves it by 2× |
| `firewallMonthlyUsd` | `920` | What `deployFirewall` adds per month |
| `budgetHeadroomPercent` | `160` | Budget = expected × this. Below ~125% the notifications become a monthly "all is well" reminder |
| `monthlyCostBudgetUsd` | `0` | Override the derived budget entirely |

## Secret environment variables

Secrets are generated outside the template and read from the environment at
deploy time; the template injects them into the container apps directly (the
apps read env vars only — no Key Vault SDK — so they stay portable).

| Variable | What |
| --- | --- |
| `HELIX_PG_ADMIN_PASSWORD` | Postgres admin password |
| `HELIX_EDGE_DB_PASSWORD` / `HELIX_PORTAL_DB_PASSWORD` / `HELIX_EGRESS_DB_PASSWORD` / `HELIX_DEV_DB_PASSWORD` | Per-role database passwords (each container runs as its own least-privilege Postgres role) |
| `HELIX_EDGE_AUTH_SECRET` | Session cookie signing root |
| `HELIX_PORTAL_SECRET` | Shared-password app encryption key |
| `HELIX_INSTRUCTION_SECRET` | Shared edge→egress attestation key |
| `HELIX_EDGE_OIDC_PRIVATE_KEY` / `HELIX_EDGE_OIDC_CERTIFICATE` | Edge OIDC client certificate (base64 PEMs) |
| `HELIX_EDGE_OIDC_CLIENT_ID`, `HELIX_PORTAL_OIDC_AUDIENCE`, `HELIX_PORTAL_ADMIN_GROUP_ID`, `HELIX_AZX_CLI_CLIENT_ID`, `HELIX_AZX_WEB_CLIENT_ID` | The Entra values from [Entra setup](/deploy/entra-setup) |

Rotating one of these: update it, re-apply, and force a new revision on the
affected app — changing a secret value alone does not restart a container app.

## Runtime environment variables

Most runtime configuration is template-computed, not operator-set. The three
worth knowing are the ones the portal SPA reads at runtime (the SPA has no
build-time configuration at all):

| Variable | Set from | If absent |
| --- | --- | --- |
| `APP_PUBLIC_BASE` | `https://<appsDomain>` | The portal refuses to boot |
| `DEV_API_PUBLIC_BASE` | set when `deployDevGateway` | The SPA reports dev mode as disabled |
| `PLATFORM_MONTHLY_USD_CAP` | `platformMonthlyUsdCap` | No spend line on the Activity page |

Per-service variables (OIDC endpoints, feature flags, database URLs) are read
in each service's `config.ts`: [`apps/edge/src/config.ts`](https://github.com/AZX-PBC-OSS/helix/blob/main/apps/edge/src/config.ts),
[`apps/portal/src/config.ts`](https://github.com/AZX-PBC-OSS/helix/blob/main/apps/portal/src/config.ts),
[`apps/egress/src/config.ts`](https://github.com/AZX-PBC-OSS/helix/blob/main/apps/egress/src/config.ts).
