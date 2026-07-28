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
`ssrf.ts` IP validation + header filtering is explicitly _defense-in-depth_
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
  remains, and it only governs traffic that actually goes _through_ egress.
- The isolation guarantee in the diagram above no longer holds; the
  isolation-verification checks below invert (edge outbound **succeeds**).

**What you keep either way:** all data services stay private — Postgres, Blob,
and both Key Vaults remain private-endpoint-only (`publicNetworkAccess` disabled)
regardless of this flag. Turning the firewall off does **not** expose them.

**When off is acceptable:** dev, smoketest/integration scaffolding, or a trusted
single-tenant install where you accept the app-level denylist as the outbound
control. **When it is not:** production, or any install hosting untrusted /
multi-tenant apps — keep the firewall (or your own equivalent network egress
control). Cheaper options if you want _some_ always-on control: Azure Firewall
**Basic** (~$290/mo, same FQDN model) or — losing FQDN filtering — NAT Gateway +
NSGs. An NSG-only substitute cannot replicate the apps-subnet
posture because the platform image pulls (GHCR/MCR) require **FQDN** rules NSGs
can't express, which is why a firewall was chosen in the first place. For a
temporary install, `az network firewall deallocate` also stops the hourly charge
between test sessions without losing config.

## Platform secret delivery ([ADR-0029](../../docs/adr/0029-platform-secret-delivery.md))

The container apps receive their **platform/bootstrap** secrets (per-role Postgres
DSNs, `EDGE_AUTH_SECRET`, `HELIX_INSTRUCTION_SECRET`, the edge OIDC cert) as
**direct values injected by this deployment**, surfaced to the app as env vars
(`containerapp.bicep`'s `secretValues`). The app reads only env vars — no Key
Vault SDK — so it stays portable across clouds.

**Why not ACA Key Vault references?** They resolve on the Container Apps **control
plane, outside the VNet**, at revision-provisioning time, so they cannot read
`kv-platform` (`publicNetworkAccess: Disabled`, private-endpoint only). ACA is not
a Key Vault trusted service, so `networkAcls.bypass: AzureServices` doesn't admit
it either. Direct injection sidesteps this entirely and keeps `kv-platform` fully
private.

`kv-platform` is still written at deploy (ARM management-plane, bypasses the
firewall) as the **canonical store** for audit/rotation — it's just not on the
provisioning path. **Connection** secrets are different: they stay in
`kv-connections` and are read by egress **at runtime from inside the VNet** (a
data-plane path that works with a private vault) via the `@azx-pbc/secret-store`
seam ([ADR-0006](../../docs/adr/0006-secret-custody-seam.md)).

## Wildcard TLS (`deployCertbot`, [ADR-0029](../../docs/adr/0029-platform-secret-delivery.md))

Apps live on per-app subdomains (`<app>.<appsDomain>`, ADR-0019), so serving them
over HTTPS needs a **wildcard cert** `*.<appsDomain>`. ACA managed certificates
don't do wildcards, so `deployCertbot=true` stands up **`apps/certbot`** — a
scheduled Container Apps Job (not an app/sidecar; TLS terminates at ingress) that:

1. issues/renews `*.<appsDomain>` (+ apex) from Let's Encrypt via **DNS-01**
   (`certbot-dns-azure` writes the `_acme-challenge` TXT using the job's managed
   identity — DNS Zone Contributor on the zone),
2. uploads the cert to the **ACA environment cert store** (not Key Vault — same
   control-plane-can't-reach-a-private-vault reason as ADR-0029), and
3. binds the **wildcard custom domain** on the edge.

It renews on a daily cron. Requires `acmeEmail`; defaults to the **LE staging**
directory (`acmeServer`) — validate the flow there, then flip `acmeServer` to the
prod directory.

**Why a daily cron is safe.** The job container is ephemeral — nothing mounts
`/etc/letsencrypt` — so certbot's own "skip unless due for renewal" logic can
never fire: it always believes it has no cert. Left alone it would request a new
certificate _every run_, which outspends Let's Encrypt's duplicate-certificate
limit (**5 per identical identifier set per 7 days**, refilling 1 per 34h): a
daily schedule drains the budget in ~2.5 weeks, then fails roughly a third of its
runs — including any emergency re-issue you actually need. So the job takes its
renewal clock from the **expiry of the cert already in the environment cert
store**, the durable state it does have, and contacts the CA only within
`renewBeforeDays` (default 30) of expiry. The decision **fails open**: a missing
cert, unreadable expiry, or failed query all fall through to issuing, so the worst
case is a wasted issuance rather than a silent expiry.

The **bind** steps run on every execution regardless of that decision. They are
idempotent, and it means a scheduled run repairs bindings stripped by a template
re-apply (see "Known deploy gotchas") without spending an issuance.

**Bootstrap (one-time, after deploy):** the cert must exist before the domain can
bind, so trigger the job once:

```bash
# ensure the ownership record exists (asuid TXT), then run the job:
az containerapp job start -g <rg> -n <namePrefix>-certbot
# watch it: az containerapp job execution list -g <rg> -n <namePrefix>-certbot
```

The `asuid.<appsDomain>` TXT (`domainVerificationId`) must be present for the bind
to validate — set `domainVerificationId` (the edge app's
`customDomainVerificationId`) so `dns.bicep` writes it, or add it out-of-band
before the first bootstrap run.

## Portal access (`portalExternal`, [ADR-0007](../../docs/adr/0007-portal-authz-v0.md))

The **edge** (app-serving) is public; the **portal** (control plane + `azx-cli`
target) is **internal ingress by default** — which means nobody can actually
deploy or manage anything until you make it reachable. Under
[ADR-0028](../../docs/adr/0028-deployment-model-customer-deployed.md) the customer
runs it themselves, so this can't be left as an out-of-band operator chore.

`portalExternal=true` serves the portal at `portal.<appsDomain>` on the public LB,
**gated by Entra OIDC** (portal audience + the `platform-admin` App Role), with
per-app authz enforced by `ownsApp` (ADR-0007, issue #9 closed). When set, the
certbot job also binds `portal.<appsDomain>` to the wildcard cert. The perimeter
is **identity + device posture** (Entra Conditional Access) — deliberately **not**
IP-allowlists or a bastion, which don't fit a remote team. A specific
`portal.<appsDomain>` hostname on the portal app takes precedence over the edge
wildcard in the shared environment.

Default is **false** (internal, secure-by-default); flip it per install. For a
zero-public-exposure posture instead, keep it internal and reach it via a VNet
path (VPN / Tailscale / Front Door + Private Link) — but that's friction a
customer-run, remote-team install usually doesn't want.

## Deployment topology handed to the portal SPA

The portal SPA is a **prebuilt bundle baked into the portal image**, so it cannot
know this install's domain at build time — there are deliberately no `VITE_*`
build args. It reads the topology at runtime from the public
`GET /api/v1/config`, which the template feeds via three portal env vars:

| Env var                    | Set from                                                                 | Absent means                                           |
| -------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| `APP_PUBLIC_BASE`          | `https://<appsDomain>`                                                   | **Boot failure** — the portal refuses to start in prod |
| `DEV_API_PUBLIC_BASE`      | `https://dev-api.<appsDomain>`, or `''` when `deployDevGateway` is false | The SPA says dev mode isn't enabled on this deployment |
| `PLATFORM_MONTHLY_USD_CAP` | `platformMonthlyUsdCap` (default `1000`)                                 | No spend watch line on the admin Activity page         |

`APP_PUBLIC_BASE` also drives the `url` field on every app the API returns, so a
redeployment onto a different `appsDomain` needs no client or image change.

The spend cap defaults to **$1000/mo** so an install gets a budget signal without
being configured for one; pass `platformMonthlyUsdCap=0` to show no ceiling. It is
display-only — the rollup is exact (the gateway is the choke point) but nothing
enforces it, so treat it as a watch line, not a kill-switch. Local dev leaves it
unset (no ceiling); see `.env.example`.

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
- Bind the wildcard cert (`*.azx.helix.azxlabs.io`) and ACA custom domains — the
  `deployCertbot` job does this (see "Wildcard TLS"). Supply
  `domainVerificationId` to write the `asuid` TXT record ACA needs.
  A custom-domain binding is **per container app**, so the job binds each plane
  that has its own external ingress: the edge wildcard always, plus
  `portal.<appsDomain>` when `portalExternal` and `dev-api.<appsDomain>` when
  `deployDevGateway`. Nothing to bind by hand.
- **Delegation must exist before the first certbot run** — Let's Encrypt has to
  resolve the DNS-01 TXT in the Azure zone publicly, so a cert issued before the
  NS records propagate will fail validation.

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

## Known deploy gotchas

Wrinkles hit during the first real deploy (franklin-energy smoketest). Check these
if a deploy misbehaves:

- **Key Vault private-endpoint DNS may not auto-register.** The two `kv-*` private
  endpoints' `privateDnsZoneGroups` can report `Succeeded` yet leave
  `privatelink.vault.azure.net` with **no A records** (the blob PE registered fine
  in the same deploy; the vault PEs didn't, and re-creating the zone group didn't
  fix it). Without the A records the vault FQDN won't resolve in the VNet, so any
  in-VNet KV access (e.g. egress → `kv-connections` at runtime) fails. **Verify and
  backfill after deploy:**

  ```bash
  az network private-dns record-set a list -g <rg> -z privatelink.vault.azure.net -o table
  # if empty, add one A record per vault pointing at its PE NIC IP:
  az network private-endpoint show -g <rg> -n <kv>-pe \
    --query "customDnsConfigs[0].ipAddresses[0]" -o tsv
  az network private-dns record-set a add-record -g <rg> \
    -z privatelink.vault.azure.net -n <kv-name> -a <pe-ip>
  ```

- **Changing a secret value does not roll a new ACA revision.** Container Apps
  secrets are app-level, not part of the revision template, so a redeploy that only
  changes secret _values_ won't restart the apps to pick them up (a failed revision
  will keep failing on the old value). After rotating a secret, force a new
  revision: `az containerapp update -g <rg> -n <app> --revision-suffix <tag>`.

- **A template re-apply WIPES the certbot custom-domain bindings.** The bindings are
  made by the job at runtime (see "Wildcard TLS"), but `containerapp.bicep`'s
  declarative `ingress` block does not list `customDomains` — so any subsequent
  `az deployment group create` removes every bound hostname, and all custom domains
  immediately serve the ACA default cert (browsers fail TLS verification). **After
  any re-apply, re-bind.** Prefer re-binding against the cert already in the
  environment store rather than re-running the job, so you don't spend a Let's
  Encrypt issuance:

  ```bash
  CERT_ID=$(az containerapp env certificate list -g <rg> -n <env> --query "[0].id" -o tsv)
  az containerapp hostname bind -g <rg> -n <app> \
    --hostname '<host>' --environment <env> --certificate "$CERT_ID"
  ```

  A **scoped `az containerapp update`** (e.g. `--set-env-vars`) does _not_ wipe the
  bindings — only a full ARM apply reconciles the whole resource — so prefer that for
  single-knob changes to a live install.

  This matters most for **CI-driven deploys**: a workflow that re-applies the template
  on every release silently breaks TLS unless it re-binds afterwards.

- **Provider registration can wedge.** `Microsoft.DBforPostgreSQL` (and friends) can
  sit in `Registering` for a long time; re-issuing `az provider register -n <ns>`
  nudges it to `Registered`.

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
