# 0029. Platform secret delivery: deployment-injected env vars, not ACA Key Vault references

**Status:** Accepted
**Related:** ADR [0006](0006-secret-custody-seam.md) (connection-secret custody), [0001](0001-three-runtime-split.md); `infra/azure`

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
