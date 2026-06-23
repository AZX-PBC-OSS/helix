# Helix on Azure — Bicep (M5)

Infrastructure-as-code for deploying the three-plane Helix platform to Azure
Container Apps. This is the `infra/` referenced in the project plan (§2) and the
"minimal IaC" of M5 (architecture §8).

## What it provisions

| Layer    | Resources                                                                                   |
| -------- | ------------------------------------------------------------------------------------------- |
| Network  | VNet, 5 subnets, Azure Firewall + policy, 2 route tables (forced tunnel), private DNS zones |
| Data     | Postgres Flexible Server (private), Storage (blob, private), ACR (Premium, private)         |
| Secrets  | `kv-platform` (infra config) + `kv-connections` (app connection secrets) — both private     |
| Identity | 3 user-assigned managed identities + the least-privilege RBAC matrix                        |
| Compute  | 2 ACA environments (`apps`, `egress`) + edge / portal / egress container apps               |
| DNS      | public zone for the apps domain (`*`, `auth`, `portal`)                                     |

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
            private endpoints → Postgres · Blob · KV×2 · ACR
```

- **edge** can be reached from the internet (public ingress) but **cannot reach
  it** — its subnet's default route goes to the firewall, which denies.
- **egress** is the only subnet the firewall lets out. It has no public ingress.
- **portal** is internal ingress only — not routable from app subdomains.
- All data services are private-endpoint only; `publicNetworkAccess` is off.
- The **edge identity has no role on `kv-connections`** — an edge RCE cannot read
  an app connection secret. (Mirrors the `helix_edge` Postgres grant hole.)

## Layout

```
main.bicep            orchestrator (resourceGroup scope)
main.bicepparam       parameters (resource names + secrets via env vars)
modules/
  network.bicep       VNet + subnets + delegations
  routing.bicep       2 empty route tables (routes added by firewall.bicep)
  firewall.bicep      Azure Firewall + policy + default routes
  privatedns.bicep    private DNS zones + VNet links
  private-endpoint.bicep  reusable PE + DNS zone group
  registry.bicep      ACR (Premium) + PE
  storage.bicep       storage account + app-bundles container + PE
  keyvault.bicep      kv-platform + kv-connections + PEs
  postgres.bicep      Flexible Server (private) + helix DB
  identity.bicep      3 user-assigned managed identities
  rbac.bicep          role assignments (the grant matrix)
  aca-environment.bicep   reusable managed environment (called twice)
  containerapp.bicep  reusable container app (called x3)
  dns.bicep           public DNS zone + records
```

Production Dockerfiles for the three apps live next to their source
(`apps/edge/Dockerfile`, `apps/portal/Dockerfile`, `apps/egress/Dockerfile`);
build them from the **repo root** (the build context is the whole pnpm
workspace).

## Deploy

Prereqs: `az` CLI logged in, a target subscription, and a resource group.

### 1. Validate / preview

```bash
cd infra/bicep
az bicep build --file main.bicep                 # compile check
az deployment group what-if \
  -g <rg> -f main.bicep -p main.bicepparam        # preview
```

### 2. Phase 1 — infra only (`deployApps=false`)

Set the secret env vars, then deploy. ACR comes up empty; the apps are skipped.

```bash
export HELIX_PG_ADMIN_PASSWORD=$(openssl rand -base64 24)
export HELIX_EDGE_DB_PASSWORD=$(openssl rand -base64 24)
export HELIX_EGRESS_DB_PASSWORD=$(openssl rand -base64 24)
export HELIX_EDGE_AUTH_SECRET=$(openssl rand -base64 48)
export HELIX_PORTAL_SECRET=$(openssl rand -base64 48)
export HELIX_INSTRUCTION_SECRET=$(openssl rand -base64 48)
export HELIX_EDGE_OIDC_CLIENT_SECRET=<from Entra app registration>
export HELIX_EDGE_OIDC_CLIENT_ID=<from Entra>
export HELIX_PORTAL_OIDC_AUDIENCE=<from Entra>
export HELIX_PORTAL_ADMIN_GROUP_ID=<Entra group object id>

az deployment group create -g <rg> -f main.bicep -p main.bicepparam
```

### 3. Build + push the three images

```bash
az acr login -n <registryName>
ACR=$(az acr show -n <registryName> --query loginServer -o tsv)

# build from the repo root (workspace context)
docker build -f apps/edge/Dockerfile   -t $ACR/helix-edge:$TAG   .
docker build -f apps/portal/Dockerfile -t $ACR/helix-portal:$TAG .
docker build -f apps/egress/Dockerfile -t $ACR/helix-egress:$TAG .
docker push $ACR/helix-edge:$TAG && docker push $ACR/helix-portal:$TAG && docker push $ACR/helix-egress:$TAG
```

> ACR has a private endpoint. Push from inside the VNet (a build agent / jump
> box), or temporarily enable a network rule / use ACR Tasks (`az acr build`)
> which builds inside the registry.

### 4. Create the Postgres runtime roles + run migrations

The server and `helix` DB exist; the least-privilege roles and grants do not yet.
From inside the VNet, connect as the admin and run the role SQL (the prod analog
of `.devcontainer/db-init/01-roles.sql`) with the **same passwords** you set
above, then apply migrations:

```bash
# roles: CREATE ROLE helix_edge LOGIN PASSWORD '$HELIX_EDGE_DB_PASSWORD' ...
#        CREATE ROLE helix_egress LOGIN PASSWORD '$HELIX_EGRESS_DB_PASSWORD' ...
DATABASE_URL="postgresql://helixadmin:***@<pgFqdn>:5432/helix?sslmode=require" \
  pnpm --filter @helix/portal db:deploy
```

### 5. Phase 2 — deploy the apps (`deployApps=true`)

```bash
export HELIX_IMAGE_TAG=$TAG
az deployment group create -g <rg> -f main.bicep -p main.bicepparam \
  --parameters deployApps=true
```

### 6. DNS + TLS

- Delegate `azx-labs.com` to the zone's name servers (deployment output
  `dnsNameServers`).
- Bind the wildcard cert (`*.azx-labs.com`) and ACA custom domains. The cert
  itself (ACME DNS-01) is the portal's scheduled job — **deferred (M5 tail)**.
  Supply `domainVerificationId` to write the `asuid` TXT record ACA needs.

## Operator steps NOT done by this template

- **Entra app registration** — the OIDC flow is config-only; fill the client id /
  audience / admin group / client secret params from a real registration.
- **Wildcard ACME cert issuance/renewal** — portal scheduled job (deferred).
- **Postgres runtime roles + migrations** — step 4 above (data-plane, not IaC).
- **Front Door / bastion** for operator access to the internal portal.
- **Passwordless (Entra) Postgres auth** — a hardening follow-up; the MIs and
  blob RBAC roles are already granted so the switch is config-only.
- **Audit-log shipping to immutable blob** — architecture §10 follow-up.

## Verifying the isolation (post-deploy)

```bash
# from an edge replica console: outbound internet must FAIL, egress must succeed
az containerapp exec -g <rg> -n helix-prod-edge --command "sh"
  curl -m 5 https://example.com            # expect: timeout / blocked
  curl -m 5 https://<egress-internal-fqdn>/health   # expect: ok

# from an egress replica: outbound internet must SUCCEED
az containerapp exec -g <rg> -n helix-prod-egress --command "sh"
  curl -m 5 https://example.com            # expect: ok

# data services are private — confirm publicNetworkAccess is Disabled
az postgres flexible-server show -g <rg> -n helix-prod-pg --query network
az keyvault show -n helix-prod-kvc --query properties.publicNetworkAccess
```
