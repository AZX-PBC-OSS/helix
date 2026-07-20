# 0027. Blob authentication: managed identity, not the storage account key

**Status:** Accepted _(2026-07-20 — resolves the P0 flagged in ADR-0001)_
**Related:** ADR [0001](0001-three-runtime-split.md), [0003](0003-dependency-minimal-edge.md); issue #15; `apps/edge/src/blob/token.ts`, `apps/edge/src/blob/client.ts`, `apps/edge/src/config.ts`, `apps/portal/src/blob/store.ts`, `apps/portal/src/plugins/blob.ts`; `infra/azure/modules/{storage,kv-secrets,rbac}.bicep`, `infra/azure/main.bicep`

## Context

The public-facing **edge** held the **Azure Storage account key** — a full
read/write/delete credential for the whole account that holds every app's bundle
— injected as `AZURE_STORAGE_CONNECTION_STRING` (via a Key Vault secret built
from `storageAccount.listKeys()`). The edge's runtime use is read-only, but
*holding* the key meant an edge RCE could PUT/DELETE any `<slug>/<version>/...`
bundle and serve persistent malicious JS to every visitor of any app — an
**all-tenant supply-chain compromise**, exactly the event the three-plane split
(ADR-0001) exists to contain. The portal held the same key for its legitimate
writes.

The least-privilege path was **already provisioned but unused**: `rbac.bicep`
grants the edge identity `Storage Blob Data Reader` and the portal identity
`Blob Data Contributor`, and `identity.bicep` already outputs their client IDs.
Only the code and the injected credential needed to change. (ADR-0001 recorded
this as a P0 to be tracked; this ADR is its resolution.)

## Decision

Both planes authenticate to Blob with their **managed identity**; the account
key is never listed into Key Vault or injected into either container.

- **Edge (read):** fetches an AAD bearer token itself over `undici` from the
  Container Apps identity endpoint (`IDENTITY_ENDPOINT`/`IDENTITY_HEADER`,
  `resource=https://storage.azure.com/`, user-assigned `client_id`), cached with
  refresh-before-expiry and single-flight. It stays **off `@azure/identity`**
  (ADR-0003, dependency-minimal edge). The hand-rolled SharedKey signer is
  retained only for dev/Azurite.
- **Portal (write):** `DefaultAzureCredential` + `Blob Data Contributor` (adds
  `@azure/identity` — acceptable on the privileged control plane, never the edge).
- **Auth mode is inferred with a production guard:** managed identity when
  `AZURE_STORAGE_BLOB_ENDPOINT` (+ `AZURE_CLIENT_ID`) is set, and it **wins**
  over any connection string; the SharedKey/account-key path is used only when a
  connection string is present and is **refused when `NODE_ENV=production`**. The
  credential material lives inside a discriminated union so the managed-identity
  config carries **no account-key field at all** — the guarantee is structural.

## Consequences

- An edge compromise can no longer rewrite or delete any tenant's bundle: the
  edge holds no standing Blob credential and its identity is read-only. The
  blast radius drops from all-tenant supply-chain to read-only asset access.
- Dev is unchanged: Azurite has no AAD, so the dev container keeps the SharedKey
  connection string and the SharedKey path (and its byte-layout tests) stay.
- A stale connection-string secret in a prod image can never be a silent
  fallback — MI wins, and SharedKey hard-fails in production.
- The edge takes on a small amount of token-lifecycle code (fetch/cache/refresh)
  rather than an SDK, preserving the dependency-minimal posture.
- **Deferred (defense-in-depth):** a short-lived **user-delegation SAS** scoped
  to the bundle container, instead of a standing Data Reader token, would further
  narrow the edge's window — tracked as a follow-up, not required to close #15.
