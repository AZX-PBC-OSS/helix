# Helix on Azure — Bicep (M5)

Infrastructure-as-code for deploying the three-plane Helix platform to Azure
Container Apps. This is the `infra/` referenced in the project plan (§2) and the
"minimal IaC" of M5 (architecture §8).

## What it provisions

| Layer    | Resources                                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Network  | VNet, 5 subnets, Azure Firewall + policy, 2 route tables (forced tunnel), private DNS zones                                     |
| Data     | Postgres Flexible Server (private), Storage (blob, private)                                                                     |
| Secrets  | `kv-platform` (infra config) + `kv-connections` (app connection secrets) — both private                                         |
| Identity | 4 user-assigned managed identities + the least-privilege RBAC matrix (the 4th, dev-gateway, is idle unless `deployDevGateway`)  |
| Compute  | 2 ACA environments (`apps`, `egress`) + edge / portal / egress container apps, plus the opt-in dev-gateway (`deployDevGateway`) |
| DNS      | public zone for the apps domain (`*`, `auth`, `portal`; `dev-api` when `deployDevGateway`)                                      |

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
       (app images pulled from public GHCR, not a private registry)
```

- **edge** can be reached from the internet (public ingress) but **cannot reach
  it** — its subnet's default route goes to the firewall, which denies.
- **egress** is the only subnet the firewall lets out. It has no public ingress.
- **portal** is internal ingress only — not routable from app subdomains.
- All data services are private-endpoint only; `publicNetworkAccess` is off.
- The **edge identity has no role on `kv-connections`** — an edge RCE cannot read
  an app connection secret. (Mirrors the `helix_edge` Postgres grant hole.)
- **dev-gateway** (opt-in, `deployDevGateway`) is the edge image run as the
  `helix_dev` role on `dev-api.<appsDomain>`, external in the apps env like the
  edge. Its identity mirrors the edge's holes — no blob, no `kv-connections` —
  and the `helix_dev` env-literal RLS keeps it off every production row. Off by
  default; see [`docs/features/dev-mode.md`](../../docs/features/dev-mode.md).

## Optional: the egress firewall (`deployFirewall`)

The Azure Firewall (Standard tier) is the enforcement point for the egress-only
network zone: it forces both app subnets' `0.0.0.0/0` through itself, **allows
only `snet-egress` out** (to any FQDN) plus a narrow platform allow-list, and
**denies the apps subnet** (edge/portal) by default. Per
[ADR-0005](../../docs/adr/0005-ssrf-egress-controls.md) this network-zone
allow-list is the **primary** SSRF/egress control; the egress app's own
`ssrf.ts` IP validation + header filtering is explicitly *defense-in-depth*
behind it (ADR [0001](../../docs/adr/0001-three-runtime-split.md),
[0013](../../docs/adr/0013-egress-trust-model.md)).

It is also the single most expensive resource in the stack: **~$900/mo** for the
Standard-tier deployment charge alone (a flat, always-on reservation — an idle
firewall costs the same as a busy one), before data processing. That is a real
adoption barrier for a customer-deployed product, so it is **opt-out** via
`deployFirewall` (default **`true`** — secure by default).

**What you lose when `deployFirewall=false`:**

- The firewall and its forced-tunnel routes are not created; both app subnets get
  **default internet egress**. A compromised **edge can now reach the internet**
  directly, and the primary egress control is gone — only the egress app-level
  denylist (defense-in-depth, a validation surface that must be kept current)
  remains, and it only governs traffic that actually goes *through* egress.
- The isolation guarantee in the diagram above no longer holds; the
  isolation-verification checks below invert (edge outbound **succeeds**).

**What you keep either way:** all data services stay private — Postgres, Blob,
and both Key Vaults remain private-endpoint-only (`publicNetworkAccess` disabled)
regardless of this flag. Turning the firewall off does **not** expose them.

**When off is acceptable:** dev, smoketest/integration scaffolding, or a trusted
single-tenant install where you accept the app-level denylist as the outbound
control. **When it is not:** production, or any install hosting untrusted /
multi-tenant apps — keep the firewall (or your own equivalent network egress
control). Cheaper options if you want *some* always-on control: Azure Firewall
**Basic** (~$290/mo, same FQDN model) or — losing FQDN filtering — NAT Gateway +
NSGs. An NSG-only substitute cannot replicate the apps-subnet
posture because the platform image pulls (GHCR/MCR) require **FQDN** rules NSGs
can't express, which is why a firewall was chosen in the first place. For a
temporary install, `az network firewall deallocate` also stops the hourly charge
between test sessions without losing config.

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
  storage.bicep       storage account + app-bundles container + PE
  keyvault.bicep      kv-platform + kv-connections + PEs
  postgres.bicep      Flexible Server (private) + helix DB
  identity.bicep      4 user-assigned managed identities (edge/portal/egress + dev-gateway)
  rbac.bicep          role assignments (the grant matrix)
  aca-environment.bicep   reusable managed environment (called twice)
  containerapp.bicep  reusable container app (edge/portal/egress + opt-in dev-gateway)
  dns.bicep           public DNS zone + records (incl. opt-in dev-api)
```

Production Dockerfiles for the three apps live next to their source
(`apps/edge/Dockerfile`, `apps/portal/Dockerfile`, `apps/egress/Dockerfile`);
build them from the **repo root** (the build context is the whole pnpm
workspace).

## Deploy

Prereqs: `az` CLI logged in, a target subscription, and a resource group.

### 1. Validate / preview

```bash
cd infra/azure
az bicep build --file main.bicep                 # compile check
az deployment group what-if \
  -g <rg> -f main.bicep -p main.bicepparam        # preview
```

### 2. Phase 1 — infra only (`deployApps=false`)

Set the secret env vars, then deploy. The apps are skipped on this pass.

```bash
export HELIX_PG_ADMIN_PASSWORD=$(openssl rand -base64 24)
export HELIX_EDGE_DB_PASSWORD=$(openssl rand -base64 24)
export HELIX_PORTAL_DB_PASSWORD=$(openssl rand -base64 24)   # helix_portal runtime role (role created in step 4)
export HELIX_EGRESS_DB_PASSWORD=$(openssl rand -base64 24)
export HELIX_DEV_DB_PASSWORD=$(openssl rand -base64 24)     # helix_dev role — create it now even if deployDevGateway stays false (see step 4)
export HELIX_EDGE_AUTH_SECRET=$(openssl rand -base64 48)
export HELIX_PORTAL_SECRET=$(openssl rand -base64 48)
export HELIX_INSTRUCTION_SECRET=$(openssl rand -base64 48)
# Edge auth is a CERTIFICATE (private_key_jwt) — the tenant blocks client secrets.
# Upload the public cert to the edge app registration; feed both PEMs here (base64
# avoids multiline env headaches). See docs/runbooks/entra-app-registration.md.
export HELIX_EDGE_OIDC_PRIVATE_KEY=$(base64 -w0 edge-key.pem)
export HELIX_EDGE_OIDC_CERTIFICATE=$(base64 -w0 edge-cert.pem)
export HELIX_EDGE_OIDC_CLIENT_ID=<helix-edge client id (GUID)>
export HELIX_PORTAL_OIDC_AUDIENCE=<helix-portal client id (BARE GUID — v2 token aud)>
export HELIX_PORTAL_ADMIN_GROUP_ID=platform-admin   # the App Role value, not a group id
export HELIX_AZX_CLI_CLIENT_ID=<azx-cli client id (GUID)>
export HELIX_AZX_WEB_CLIENT_ID=<helix-portal client id (GUID)>

az deployment group create -g <rg> -f main.bicep -p main.bicepparam
```

### 3. Build + publish the three images

CI builds and publishes all three images to **GHCR** on pushes to the default
branch and on `v*` tags (`.github/workflows/ci.yml`):

```
ghcr.io/azx-pbc-oss/helix-edge:<tag>
ghcr.io/azx-pbc-oss/helix-portal:<tag>
ghcr.io/azx-pbc-oss/helix-egress:<tag>
```

Tags produced per push: the branch name, the commit SHA (`sha-<short>`), the
semver on `v*` tags, and `latest` on the default branch. The container apps pull
these directly (see `imageRegistry` / `imageTag` in `main.bicepparam`), so a
normal deploy needs no local build — set `imageTag` to the tag CI published and
run the deployment.

> **GHCR packages must be pullable by the deploy.** The bicep does an anonymous
> pull by default (empty `registries`), which requires the three packages to be
> **public** (Package settings → Change visibility → Public — the repo can be
> public while packages default to private). To keep them private instead, pass
> a `registries` entry to the container apps (a `{ server: 'ghcr.io', username,
passwordSecretRef }` with a `read:packages` PAT) and provision that secret.

To build/publish manually (e.g. off-CI), from the repo root:

```bash
echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
REG=ghcr.io/azx-pbc-oss
docker build -f apps/edge/Dockerfile   -t $REG/helix-edge:$TAG   .
docker build -f apps/portal/Dockerfile -t $REG/helix-portal:$TAG .
docker build -f apps/egress/Dockerfile -t $REG/helix-egress:$TAG .
docker push $REG/helix-edge:$TAG && docker push $REG/helix-portal:$TAG && docker push $REG/helix-egress:$TAG
```

### 4. Create the Postgres runtime roles + run migrations

The server and `helix` DB exist; the least-privilege roles and grants do not yet.
From inside the VNet, connect as the admin and run the committed role SQL
(`sql/01-roles.sql` — the prod analog of `.devcontainer/db-init/01-roles.sql`,
with `NOBYPASSRLS` explicit on all four roles) with the **same passwords** you
set above, then apply migrations (whose per-table GRANTs are guarded by an
`IF EXISTS role` check, so the roles must exist first):

> Create `helix_dev` here even if you are not deploying the dev-gateway
> (`deployDevGateway=false`) — the role is harmless without its app, and adding
> it later means re-running the migration to pick up its guarded grants + RLS.

```bash
ADMIN_URL="postgresql://helixadmin:$HELIX_PG_ADMIN_PASSWORD@<pgFqdn>:5432/helix?sslmode=require"

# 1. create the four least-privilege runtime roles (NOBYPASSRLS, per-role passwords)
psql "$ADMIN_URL" \
  -v edge_password="$HELIX_EDGE_DB_PASSWORD" \
  -v portal_password="$HELIX_PORTAL_DB_PASSWORD" \
  -v egress_password="$HELIX_EGRESS_DB_PASSWORD" \
  -v dev_password="$HELIX_DEV_DB_PASSWORD" \
  -v ON_ERROR_STOP=1 \
  -f sql/01-roles.sql

# 2. apply migrations as the owner (this issues the per-table edge/egress grants)
DATABASE_URL="$ADMIN_URL" pnpm --filter @azx-pbc/portal db:deploy
```

> **Note:** every container runtime connects as its least-privilege role
> (`helix_portal` / `helix_edge` / `helix_egress`, and `helix_dev` for the
> dev-gateway) — the portal reads `PORTAL_DATABASE_URL` and, under
> `NODE_ENV=production`, refuses the `DATABASE_URL` owner fallback (ADR-0002).
> The admin DSN is used only here in step 4 for `db:deploy` and is never placed
> in a container or in kv-platform.

### 5. Phase 2 — deploy the apps (`deployApps=true`)

```bash
export HELIX_IMAGE_TAG=$TAG
az deployment group create -g <rg> -f main.bicep -p main.bicepparam \
  --parameters deployApps=true
```

#### (Optional) the dev-gateway

The opt-in dev-mode surface (`dev-api.<appsDomain>`) is off by default. To stand
it up, add `deployDevGateway=true` (it shares the edge image, so no extra build):

```bash
az deployment group create -g <rg> -f main.bicep -p main.bicepparam \
  --parameters deployApps=true deployDevGateway=true
```

Before enabling it on a real deployment, read the riders in
[`docs/features/dev-mode.md`](../../docs/features/dev-mode.md): a verified
`edgeTrustProxy` hop count (issue #13 — the dev throttle keys on the real client
IP), a **distinct dev LLM budget** (the vendor key is env-agnostic), and the
`dev-api` DNS/TLS binding (step 6, added when this flag is set).

### 6. DNS + TLS

- Delegate `azx.helix.azxlabs.io` (a subdomain of `azxlabs.io`) by adding NS
  records for `azx.helix` in the parent `azxlabs.io` Cloudflare zone, pointing at
  the deployment output `dnsNameServers` — not at the registrar.
- Bind the wildcard cert (`*.azx.helix.azxlabs.io`) and ACA custom domains. The cert
  itself (ACME DNS-01) is the portal's scheduled job — **deferred (M5 tail)**.
  Supply `domainVerificationId` to write the `asuid` TXT record ACA needs.
  (The wildcard already covers `dev-api.azx.helix.azxlabs.io`; the dev-gateway
  still needs its own ACA custom-domain binding when `deployDevGateway` is set.)

## Operator steps NOT done by this template

- **Entra app registrations** — create the three registrations (or use the
  `infra/entra` Bicep) and fill the client id / audience / admin-role / edge
  certificate params. Full walkthrough + gotchas (v2 tokens, cert auth, App
  Roles): `docs/runbooks/entra-app-registration.md`.
- **Wildcard ACME cert issuance/renewal** — portal scheduled job (deferred).
- **Postgres runtime roles + migrations** — step 4 above (data-plane, not IaC).
- **Front Door / bastion** for operator access to the internal portal.
- **Passwordless (Entra) Postgres auth** — a hardening follow-up; the MIs and
  blob RBAC roles are already granted so the switch is config-only.
- **Audit-log shipping to immutable blob** — architecture §10 follow-up.

## Verifying the isolation (post-deploy)

> Assumes `deployFirewall=true` (the default). With the firewall **off**, the
> edge outbound check below **succeeds** instead of failing — the egress-only
> zone is not enforced (see "Optional: the egress firewall"). The private
> data-services checks hold regardless of the flag.

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
