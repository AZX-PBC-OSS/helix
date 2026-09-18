# Kubernetes deployment (design scoping)

**Status:** Informational scoping · September 2026 · triggered by a customer ask. **This is not a plan and commits to nothing** — it maps what a Kubernetes deployment would require, in two variants, so a future conversation can start from facts.
**Why this exists:** the deployed topology's source of truth is `infra/azure` (Bicep, Azure Container Apps). A customer asked what running on Kubernetes would take. The answer splits in two: **(A) hybrid** — the three runtimes in k8s, Azure managed services (Postgres, Blob, Key Vault, App Insights, Entra) stay; and **(B) fully k8s-native** — those managed services replaced too.

> **Related ADRs:** [ADR-0029](../adr/0029-platform-secret-delivery.md) (env-var-only config, no cloud SDKs in the trusted path — the premise that makes this cheap) · [ADR-0037](../adr/0037-platform-observability-otlp-boundary.md) (OTLP-only telemetry boundary) · [ADR-0040](../adr/0040-entra-group-visibility-directory-seam.md) (directory absence is a supported posture) · [ADR-0044](../adr/0044-declarative-wildcard-tls-bindings.md) (wildcard TLS via certbot job + env cert store) · [ADR-0002](../adr/0002-postgres-role-split-rls.md) (Postgres role split + RLS).

---

## 1. What's already portable (proven by the dev container)

The codebase is unusually well-positioned for this: every Azure dependency already has a proven seam, because local development substitutes each one. The work is mostly _around_ the runtimes, not in them.

- **The three runtimes are stateless, env-configured containers.** Edge and egress carry zero Azure SDK dependencies (hand-rolled REST over `fetch`/undici); portal alone uses `@azure/identity` + `@azure/storage-blob`. Images are already published to public GHCR and pulled anonymously.
- **OIDC is a generic issuer swap.** `EDGE_OIDC_*` / `PORTAL_OIDC_*` point at any compliant issuer; `apps/dev-idp` proves the swap is env-only. Works with Entra, Keycloak, dex, anything.
- **Telemetry is OTLP-only** (ADR-0037). Nothing App Insights-specific exists in `apps/` or `packages/`; that coupling lives entirely in Bicep. Dev already runs Jaeger.
- **Secret custody is a two-implementation interface** (`packages/secret-store`: Key Vault or AES-GCM envelope behind `createSecretStore`). A third implementation is a known-size change.
- **TLS is already ingress-terminated in prod.** The edge runs plain HTTP behind the ACA ingress today — exactly the k8s shape. `EDGE_PUBLIC_PORT=443` exists for this.
- **Health contract is platform-neutral**: `/health` answers 200 in every state with a three-state body — probe-friendly anywhere.

## 2. Variant A — hybrid: runtimes in k8s, Azure PaaS for data

Postgres Flexible Server, Blob Storage, both Key Vaults, App Insights, and Entra all stay. What ACA provides today must be re-expressed:

1. **All of the packaging.** There is no Helm chart, kustomize tree, or single k8s manifest in the repo. Needed: three Deployments+Services, a migrate Job (replaces the ACA `migrate` job), cert automation, RBAC, NetworkPolicies. This is the bulk of the work.
2. **Wildcard ingress + TLS + DNS.** Today ACA's Envoy does host routing for `*.<appsDomain>` / `auth.` / `portal.`, and a scheduled certbot ACA job does DNS-01 against Azure DNS and uploads to the environment cert store (ADR-0044). K8s equivalent: an ingress controller (or Gateway API) with wildcard SNI + cert-manager with the Azure DNS solver — the DNS zone itself can stay. `EDGE_TRUST_PROXY` needs the ingress/LB CIDR instead of the baked-in ACA Envoy range (`100.64.0.0/10`); config, not code.
3. **A token provider for workload identity — the one real code change.** The hand-rolled providers (edge's blob token, secret-store's Key Vault token, egress's Foundry minter) speak the ACA-injected `IDENTITY_ENDPOINT` / `IDENTITY_HEADER` shape. On AKS the native mechanism is Entra Workload Identity (projected service-account token + federation). Portal's `DefaultAzureCredential` handles that natively; the three hand-rolled sites each need a new provider behind their existing one-function seams (`GetVaultToken` and friends). Contained by design. On **non-AKS** clusters there is no managed identity at all, and the private endpoints fronting Postgres/Blob/Key Vault are unreachable — that means VPN/ExpressRoute or public endpoints, which is a security-posture conversation, not a code change.
4. **Secret delivery.** ACA Key Vault references → Secrets Store CSI driver (it has a Key Vault provider) or External Secrets Operator, plus rotation semantics (e.g. reloader). A bootstrap path is also needed for the deploy-time secrets Bicep currently generates (`kv-secrets.bicep`: database URLs, `EDGE_AUTH_SECRET`, `HELIX_INSTRUCTION_SECRET`, the OIDC cert pair).
5. **Rebuilding the network trust boundary.** Today it is structural: egress sits alone in an `internal: true` environment (no public load balancer is possible), both subnets force-tunnel through Azure Firewall, and the edge subnet has **no internet egress at all** — egress is the only path out. In k8s this becomes NetworkPolicy (edge/portal: deny egress except DNS + the egress Service + data endpoints), admission policy (the egress workload can never receive a public Ingress), and a NAT path for the egress namespace. On AKS in the same VNet, the existing firewall design carries over unchanged.
6. **Alert ports.** Standard availability tests and cost budgets survive untouched (they probe public URLs / Azure consumption). Two things don't: the `registry.never_loaded` alert reads `ContainerAppConsoleLogs_CL` (ACA stdout shipping — gone), and the `RestartCount` / `Requests` / Postgres metric alerts are ACA/Azure platform metrics. K8s equivalents are Prometheus/Alertmanager rules plus a log pipeline — or keep shipping logs and metrics to Log Analytics / App Insights via the collector. The OTel collectors themselves become plain k8s Deployments running the same contrib image with the same `azuremonitor` exporter.

**Code changes for variant A: small.** The workload-identity token providers, `EDGE_TRUST_PROXY` configurability, and nothing else of note.

## 3. Variant B — fully k8s-native

Everything in §2, plus replacing each managed service:

1. **Postgres → in-cluster (e.g. CloudNativePG) or any managed Postgres.** The RLS + three-role least-privilege model is vanilla Postgres and carries over; `infra/azure/sql/01-roles.sql` needs light adaptation (it exists partly because Azure Postgres has no superuser). Backups, PITR, and HA become our problem — though prod currently runs HA-disabled, so there is no regression to close on day one.
2. **Blob → the second real code gap.** The code speaks _Azure Blob REST_ (hand-rolled SharedKey signer on the edge, SDK on the portal). Azurite is a dev emulator, not production-supported; MinIO and friends speak S3, not Blob. So this means an S3-backed implementation of the blob store/reader (SigV4 signing, streaming range GETs). The portal side is already an interface and the edge side is one reader class — real but contained, and the largest single code item in either variant.
3. **Key Vault → a third implementation behind the existing seam.** The natural fit is k8s-native: portal writes Secrets, egress reads them, and k8s RBAC enforces the portal-write/egress-read split — mirroring today's vault RBAC exactly, with the edge still holding no access at all. (Reusing the AES-GCM envelope with the KEK delivered via a Secret also works, but would want a hardening pass and a rename from "dev".) Either way the interface already exists and the edge never touches it.
4. **Entra → keep it.** It is SaaS OIDC and works from anywhere; the swap is env-only. If the customer wants zero Azure, any OIDC issuer works, and the Access tab already has a supported degraded posture without Graph (ADR-0040 — the directory reports its own absence as a value).
5. **App Insights → any OTLP backend** (Jaeger/Tempo/Prometheus). Alerts become Alertmanager rules; the outside HTTP probe becomes a blackbox exporter — or keep App Insights standard tests, which are just HTTP probes of public URLs and work against any hosting.
6. **Foundry → nothing to do.** Point `EDGE_LLM_ENDPOINT` at the default public model endpoints; the keyless managed-identity connection path (`EGRESS_MANAGED_IDENTITY_CONNECTIONS`) is Azure-only but optional — stored secrets are the default.

## 4. Missing in both variants

- **Re-expressing the platform-enforced security invariants.** Today ACA and the firewall make three things _structurally_ true: egress has no public ingress, the edge cannot reach the internet, and the edge identity holds no `kv-connections` grant. In k8s each becomes a policy artifact (NetworkPolicy, admission control, RBAC) that needs adversarial tests equivalent to today's. The database-level split is unaffected: `helix_edge` having no grant on `app_secrets` is plain Postgres and `role-split.integration.test.ts` holds that line regardless of hosting.
- **Operations surface.** Bootstrap/seeding runbook, upgrade and chart-versioning story, the migration-job workflow, and docs — `infra/azure/README.md` would need a k8s counterpart.
- **Registry story**, if the customer mirrors images into their own registry instead of pulling from public GHCR.

## 5. Effort shape

Application code changes are days, not weeks — the seams were built for this (ADR-0029's env-only posture, the hand-rolled SDK-free trusted path, the OTLP boundary). The real cost is platform engineering around the containers — chart, ingress/TLS/DNS, network policy, secrets delivery, observability — plus re-proving the trust boundary. That platform work is roughly the same size in both variants; the delta from hybrid to fully-native is essentially the S3 blob implementation, the secret-store implementation, and owning Postgres operations.
