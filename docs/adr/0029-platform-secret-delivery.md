# 0029. Platform secret delivery: deployment-injected env vars, not ACA Key Vault references

**Status:** Superseded in part (2026-09-17 — see "Update" below). The delivery-mechanism half (direct values instead of Key Vault references) is reversed; the app-contract half (apps read only env vars, no Key Vault SDK) and the connection-secret custody half (ADR-0006) are unchanged.
**Related:** ADR [0006](0006-secret-custody-seam.md) (connection-secret custody), [0001](0001-three-runtime-split.md); `infra/azure`

## Update (2026-09-17): Key Vault references work after all — the July failure was our DNS bug

The central claim below — "ACA resolves Key Vault references on the control plane
outside the VNet, so they cannot read a private vault" — is **wrong for our
topology**, and the 2026-07-24 failure this ADR generalized from was caused by a
template-wide private-DNS bug of our own, not a platform limitation.

**Root-cause correction.** `privatedns.bicep` originally built the vault zone as
`environment().suffixes.keyvaultDns` = the *public* suffix `.vault.azure.net`,
while a vault CNAMEs to `<name>.privatelink.vaultcore.azure.net`. In-VNet DNS
therefore fell through to the vault's public IPs, which `publicNetworkAccess:
Disabled` refuses — so *every* in-VNet vault resolution failed template-wide,
including the KV references at revision provisioning. The zone was fixed
2026-07-29 (`1c01614`) and the failure was never retried afterwards until now.

**What is true today (verified live 2026-09-17, Franklin install, Consumption
workload profile, RBAC-mode vault with `defaultAction: Deny`):**

- On workload-profile environments, ACA resolves KV references **from inside the
  environment's VNet** — a private-endpoint vault works. (Microsoft's
  manage-secrets doc implies this via its UDR/firewall guidance, and
  microsoft/azure-container-apps#1804 shows our exact topology succeeding.)
  A referenced secret resolved, the revision stayed healthy, and
  `az containerapp secret list --show-values` returns the resolved value for a
  KV reference (so control-plane readers with `listSecrets` can still read
  platform secrets back — the README's Contributor paragraph is unaffected).
- Deploy-time `az.getSecret()` in a bicepparam also works against the
  PNA-Disabled vault once `enabledForTemplateDeployment: true` is set: the ARM
  template-deployment service IS a Key Vault trusted service, and that bypass
  survives `publicNetworkAccess: Disabled`. The deploy principal needs
  `Microsoft.KeyVault/vaults/deploy/action` (Owner/Contributor include it). This
  worked on our RBAC-mode vault with no access policy.
- Container Apps is still **not** itself a Key Vault trusted service — that
  clause below was accurate, just never the operative constraint.
- **ACA Jobs cannot resolve KV references** (open platform bug,
  microsoft/azure-container-apps#1804). The migrate job keeps its runtime vault
  read, which was the better design for it anyway.

**Verified mechanics of references (they differ from what we assumed):**

- A vault write is picked up by ACA's background refresh and rolled out with a
  revision restart — observed 22 minutes on 2026-09-17; Microsoft documents
  "within ~30 min". No redeploy, no operator action.
- Any app-config write (e.g. re-`az containerapp secret set`) re-resolves all
  references **immediately** — the way to rotate *now*.
- A bare `az containerapp revision restart` does **not** re-resolve; it serves
  the snapshot stored with the revision.

**New delivery model** (implemented the same day): each app's ACA secrets are
`{ keyVaultUrl, identity }` references against `kv-platform` with **versionless**
URIs, so rotation is "write the vault". The deploy-time params source from the
same vault via `az.getSecret()`, so the vault is the single source of truth and
no secret plaintext transits the deployer's environment. `kv-platform` stays
`publicNetworkAccess: Disabled` throughout. The app contract is untouched: apps
still read only env vars via `secretRef`, ACA materializes the reference into
the env var, and portability (the overriding constraint below) is intact.

The original text follows unchanged, as the record of what we believed and why.

---

## Context

The three container apps need **platform/bootstrap secrets** at startup — the
per-role Postgres DSNs, the edge auth secret, the instruction-signing secret,
and the edge OIDC certificate (`private_key_jwt`). These are distinct from
**connection secrets** (third-party API creds, the LLM key), which are custodied
through the `@azx-pbc/secret-store` seam (ADR [0006](0006-secret-custody-seam.md);
prod backend = `kv-connections`, read by egress **at runtime**).

The M5 Azure infra stored the platform secrets in a private Key Vault
(`kv-platform`, `publicNetworkAccess: Disabled`, private-endpoint only) and wired
the container apps to them via **ACA Key Vault secret references**
(`keyVaultUrl` + managed identity).

The first real end-to-end deploy proved that
combination cannot work: **ACA resolves Key Vault references on the Container
Apps control plane — outside the app's VNet — at revision-provisioning time.** A
vault with public access disabled is reachable only through its private
endpoint, so the control-plane resolver can't read it (RBAC and private DNS are
both correct; the resolver simply isn't on the VNet). ACA is **not** on Key
Vault's trusted-services bypass list, so `networkAcls.bypass: AzureServices`
doesn't help either — the only ways to make references resolve are a public or
IP-allow-listed vault, which drops the network isolation.

A further, overriding constraint: **the app must run on non-Azure platforms.**
Making the app read a private vault at runtime (the other way to reach it) means
baking an Azure Key Vault SDK dependency into the app — increasing cloud
coupling, the wrong direction.

## Decision

Deliver platform secrets to the containers as **direct values set by the
deployment**, exposed to the app as ordinary **environment variables**
(`secretRef` → env). The app consumes only env vars (12-factor) and holds no
secret-store SDK for these; *how* the value reaches the env is a deployment
concern and may be platform-specific (ACA secret, K8s `Secret`, ECS task-def
secret, a local `.env`).

`kv-platform` remains the **canonical store** on Azure — the deploy still writes
the secrets there (ARM management-plane writes bypass the data-plane firewall),
for audit and future rotation tooling — but it is **not** on the
provisioning/runtime path and stays fully private.

Connection secrets are unchanged: still custodied via the SecretStore seam
(ADR [0006](0006-secret-custody-seam.md)) and read by egress **at runtime** from
inside the VNet over the private endpoint — a data-plane path that *does* work
with a private vault.

## Consequences

- **Portable:** platform secrets arrive as env vars whether the target is ACA,
  Kubernetes, ECS, or a laptop — one app contract, per-platform injection.
- `kv-platform` keeps `publicNetworkAccess: Disabled` (no public surface); no
  dependence on ACA being a KV trusted service.
- The resolved values live in the ACA revision configuration (encrypted at rest,
  per-app) — **the same place a KV reference would have materialized them.** The
  only real loss vs references is **KV-driven rotation without redeploy**:
  rotating a platform secret now needs a redeploy **and a forced new revision**
  (changing an ACA secret *value* alone does not roll a revision).
- The deploy pipeline handles the plaintext — acceptable, since it already
  generates them.
- **Remaining coupling / follow-up:** connection secrets still use the Azure Key
  Vault SecretStore backend at runtime (ADR [0006](0006-secret-custody-seam.md)).
  That path is already behind the `@azx-pbc/secret-store` abstraction, so
  portability there is a matter of adding a non-Azure backend, not re-architecting.

## Note (2026-07-24, first real end-to-end deploy)

Found on the first Azure deploy: apps failed to provision with *"unable to fetch
secret … using Managed identity"* until the KV references were replaced with
direct injection. Implemented in `infra/azure/modules/containerapp.bicep`
(a `@secure()` `secretValues` object) + `main.bicep`.
