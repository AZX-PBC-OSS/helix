---
title: Getting started
---

# Deploy Helix on Azure

This page walks through a full deployment: infrastructure, database, the three
services, and TLS. The whole thing is one Bicep template in
[`infra/azure`](https://github.com/AZX-PBC-OSS/helix/tree/main/infra/azure).
That directory's [README](https://github.com/AZX-PBC-OSS/helix/blob/main/infra/azure/README.md)
is the complete operational reference, including known deploy gotchas; this
page is the shorter path through it.

## What gets deployed

| Layer | Resources |
| --- | --- |
| Network | VNet, subnets, optional Azure Firewall, private DNS zones |
| Data | Postgres Flexible Server (private), Blob storage (private) |
| Secrets | Two Key Vaults — platform config, and app connection secrets (both private) |
| Compute | Two Container Apps environments, running the edge, portal, and egress services |
| DNS | A public DNS zone for your apps domain |
| Observability | Application Insights, OTLP collectors, alert rules, an outside uptime probe |

The three services are published to GitHub's container registry by CI, so a
normal deploy builds nothing locally — you pick a published image tag.

### The security shape, in one diagram

```
                 Internet
                    │ (inbound: edge only)        ▲ (outbound: egress only)
        ┌───────────┴───────────┐                │
        │  apps env (snet-apps)  │       ┌────────┴────────────┐
        │   edge  (external)     │       │ egress env          │
        │   portal(internal)     │       │  egress (internal)  │
        │   UDR → Firewall DENY  │       │  UDR → Firewall ALLOW│
        └───────────┬───────────┘       └────────┬────────────┘
                    └──────── same VNet ──────────┘
            private endpoints → Postgres · Blob · KV×2
```

- The **edge** can be reached from the internet but cannot reach it — its
  subnet's default route goes to the firewall, which denies.
- **Egress** is the only subnet the firewall lets out, and it has no public
  ingress. It is the only component that ever holds an app connection secret.
- All data services are private-endpoint only; `publicNetworkAccess` is off.
- The **edge identity has no role on the connections vault** — an edge RCE
  cannot read a single app secret.

## What it costs

The default shape costs roughly **$125/month**. The one expensive optional is
the Azure Firewall: about **$920/month**, flat whether busy or idle. It is the
primary egress control — it is what stops a compromised app (or the edge
itself) from reaching the internet directly — so it is on by default.

- Production, or anything hosting apps from multiple authors: keep it.
- A dev or test install: `deployFirewall=false` saves the money. Data services
  stay private either way.

A monthly budget alert is deployed alongside, sized from these two numbers, so
tune `expectedMonthlyUsdExFirewall` if your Postgres SKU differs much from the
default. See the [configuration reference](/deploy/configuration#cost).

## Prerequisites

- An Azure subscription and a resource group, with the `az` CLI logged in.
- A Microsoft Entra tenant you can create app registrations in.
- A DNS domain you control, to delegate as the apps domain (e.g.
  `apps.example.com`). Apps live on `<slug>.<appsDomain>`, the portal on
  `portal.<appsDomain>`, and sign-in happens on `auth.<appsDomain>`. Every app
  gets its own origin — deliberate isolation, since every hosted app is
  untrusted code: the browser's same-origin policy is what keeps one app's
  code away from another app's data, and the platform manages it all.
- `psql`, `openssl`, and Node 24 + pnpm for the one-time migration step.

## Step 1: Entra app registrations

Helix needs three app registrations in your tenant (edge, portal, CLI), plus
client ids and — for the edge — a certificate. It is a half hour of portal
clicks and it is fully documented: **[Entra ID setup](/deploy/entra-setup)**.

This is also when to decide who gets in. By default a fresh install is open
to every member of your tenant; the recommended shape is one Entra security
group per audience — app users, portal users, platform admins — with sign-in
restricted to them. See **[Access control](/deploy/access-control)**.

Do this first; the values feed the deploy in the next step.

## Step 2: Fill in the parameters

Copy `infra/azure/main.bicepparam` and set, at minimum:

- Names: `namePrefix`, `storageAccountName`, `platformVaultName`,
  `connectionsVaultName`, `postgresServerName` (vault and storage names are
  globally unique).
- `appsDomain` — your apps domain.
- The Entra values from step 1: `edgeOidcClientId`, `portalOidcAudience` (the
  bare client-id GUID), `portalAdminGroupId` (`platform-admin`),
  `azxCliClientId`, `azxWebClientId`, `edgeOidcPrivateKey` and
  `edgeOidcCertificate`.
- `acmeEmail` — required for the wildcard certificate.
- `portalExternal: true` — unless you plan to reach the portal over a private
  network path, nothing is deployable without it. The portal is
  internal-by-default; this flag puts it on the public load balancer, gated by
  Entra sign-in.

The [configuration reference](/deploy/configuration) lists every parameter and
what it does.

## Step 3: Deploy the infrastructure

Secrets are read from environment variables, not the params file. Generate
them, then deploy with apps disabled — this pass creates the network, data
services, vaults, and identities, but no containers.

```bash
cd infra/azure

export HELIX_PG_ADMIN_PASSWORD=$(openssl rand -base64 24)
export HELIX_EDGE_DB_PASSWORD=$(openssl rand -base64 24)
export HELIX_PORTAL_DB_PASSWORD=$(openssl rand -base64 24)
export HELIX_EGRESS_DB_PASSWORD=$(openssl rand -base64 24)
export HELIX_DEV_DB_PASSWORD=$(openssl rand -base64 24)
export HELIX_EDGE_AUTH_SECRET=$(openssl rand -base64 48)
export HELIX_PORTAL_SECRET=$(openssl rand -base64 48)
export HELIX_INSTRUCTION_SECRET=$(openssl rand -base64 48)
export HELIX_EDGE_OIDC_PRIVATE_KEY=$(base64 -w0 edge-key.pem)
export HELIX_EDGE_OIDC_CERTIFICATE=$(base64 -w0 edge-cert.pem)
export HELIX_EDGE_OIDC_CLIENT_ID=<helix-edge client id>
export HELIX_PORTAL_OIDC_AUDIENCE=<helix-portal client id>
export HELIX_PORTAL_ADMIN_GROUP_ID=platform-admin
export HELIX_AZX_CLI_CLIENT_ID=<azx-cli client id>
export HELIX_AZX_WEB_CLIENT_ID=<helix-portal client id>

az deployment group create -g <rg> -f main.bicep -p main.bicepparam
```

::: tip Preview first
`az deployment group what-if -g <rg> -f main.bicep -p main.bicepparam` shows
what the apply will change. On any re-apply of an install with TLS already
bound, the what-if must **not** show a delete of
`properties.configuration.ingress.customDomains` — if it does, stop and see the
`wildcardTlsBound` note in the [configuration reference](/deploy/configuration#tls).
:::

## Step 4: Create the database roles and run the first migration

Postgres is private-endpoint-only, so connect from inside the VNet (for example
with `az containerapp exec`, a VPN, or a temporary job in the apps
environment). As the admin user, run the committed role script with the
passwords from step 3, then apply migrations:

```bash
ADMIN_URL="postgresql://helixadmin:$HELIX_PG_ADMIN_PASSWORD@<pgFqdn>:5432/helix?sslmode=require"

psql "$ADMIN_URL" \
  -v edge_password="$HELIX_EDGE_DB_PASSWORD" \
  -v portal_password="$HELIX_PORTAL_DB_PASSWORD" \
  -v egress_password="$HELIX_EGRESS_DB_PASSWORD" \
  -v dev_password="$HELIX_DEV_DB_PASSWORD" \
  -v ON_ERROR_STOP=1 \
  -f sql/01-roles.sql

DATABASE_URL="$ADMIN_URL" pnpm --filter @azx-pbc/portal db:deploy
```

Create all four roles even if you are not enabling the dev gateway — the extra
role is harmless and adding it later means re-running migrations.

This is the only time anyone handles the admin password. Every later migration
runs through a scheduled container job (`<namePrefix>-migrate`) that reads the
admin password from Key Vault itself:

```bash
az containerapp job update -g <rg> -n <namePrefix>-migrate \
  --image ghcr.io/azx-pbc-oss/helix-portal:<tag>
az containerapp job start  -g <rg> -n <namePrefix>-migrate
```

## Step 5: Deploy the apps

```bash
export HELIX_IMAGE_TAG=<tag>
az deployment group create -g <rg> -f main.bicep -p main.bicepparam \
  --parameters deployApps=true
```

Images come from `ghcr.io/azx-pbc-oss` (edge, portal, egress). CI publishes
them on every push to the main branch and on `v*` tags. The three GHCR packages
must be **public** for the default anonymous pull to work — the repo being
public does not make its packages public; flip each one under
*Package settings → Change visibility*. To keep them private instead, pass a
`registries` credential to the container apps (see the infra README).

## Step 6: DNS and TLS

1. **Delegate the domain.** In the parent zone, add NS records for
   `<appsDomain>` pointing at the nameservers in the deployment output
   `dnsNameServers`.
2. **Bootstrap the wildcard certificate.** A scheduled job (`certbot`) issues
   and renews `*.<appsDomain>` via Let's Encrypt DNS-01 and binds it. It needs
   the domain verified first: take the `customDomainVerificationId` from the
   edge deployment output, set it as the `domainVerificationId` parameter, and
   re-apply. Then run the job once:

   ```bash
   az containerapp job start -g <rg> -n <namePrefix>-certbot
   ```

   Delegation from step 1 must be live before this run — Let's Encrypt has to
   resolve the challenge TXT publicly.
3. **Flip `wildcardTlsBound: true`** in the params file and re-apply. From then
   on the template itself declares the certificate bindings, so re-applies
   preserve them. Set this literally in the file, never through an environment
   variable — a blank variable reads as false, and false is the direction that
   silently strips bindings.

The certificate defaults to the Let's Encrypt **staging** directory so you can
validate the flow without burning rate limits. Once it works, set `acmeServer`
to `https://acme-v02.api.letsencrypt.org/directory` and re-run the job.

## Step 7: Verify

- Sign in to `https://portal.<appsDomain>` with an admin-assigned user and
  check the admin pages appear.
- Deploy a test app (`helix create` + `helix deploy`, see
  [the CLI page](/apps/cli)) and open its URL — you should get the Entra
  sign-in redirect, then your app.
- Read the `alertsNotify` deployment output. It says whether your alert rules
  have anyone to notify; an empty `alertEmails` still deploys rules that fire
  into nothing.
- After enabling anything that changes egress, drive a request through a
  deployed app and check the trace lands in Application Insights. A missing
  allowlist rule fails as silence, not as an error.

## Next: shipping changes

From here on, an update is a scoped `az containerapp update` against a new
image tag, with the migrate job run first — not a re-apply of this template.
**[Deploying updates](/deploy/updates)** covers the routine release, what a
Container Apps rollout actually does (including why a failed one is silent),
rollback, secret rotation, and the hazards of the rarer full apply.
