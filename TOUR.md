# A tour of Helix

Helix hosts AI-generated static web apps. An app owner uploads a frontend bundle
and gets a URL with platform-managed access control. Apps can call language models,
store data, and use third-party APIs through the platform gateway.

Helix treats every hosted app as untrusted code. It limits each app's access to
other apps, user data, credentials, and external services. It does not verify that
an app's code is safe.

## The services

Three services separate public traffic, administration, and outbound requests:

| Service        | Responsibilities                                                                                                 | Restrictions                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `apps/edge`    | App routing, authentication, static assets, and `/_api/*` authorization, quotas, and audit                       | Cannot read app connection secrets or write the registry. Sends third-party API calls through egress. |
| `apps/portal`  | Portal UI/API, deploys, registry updates, capability approvals, and secret writes                                | Not reachable through app subdomains.                                                                 |
| `apps/egress`  | Verifies signed instructions from the edge, injects credentials, and makes outbound requests under SSRF controls | Internal only; does not accept app-user traffic.                                                      |
| `apps/dev-idp` | Local OIDC issuer with fixture users                                                                             | Development and tests only; never deployed.                                                           |

Separating egress keeps third-party credentials and unrestricted outbound access
out of the public-facing edge process. The edge still holds operational credentials
for authentication and signed instructions. In production, it reads Blob storage
with a read-only managed identity; local Azurite uses a storage account key.

Postgres roles enforce another layer of separation:

- `helix_edge` can read the registry, append metering and collection rows, and access
  app data under row-level security (RLS). It has no grant on `app_secrets`.
- `helix_egress` can read secrets and update their `lastUsedAt` column.
- `helix_portal` has control-plane permissions. Migrations run separately as `helix`.

Production requires role-specific database URLs. The edge and portal refuse to
fall back to the schema-owner URL, which would bypass these restrictions.
`role-split.integration.test.ts` checks the database permissions.

See [architecture §3](docs/platform-architecture.md),
[ADR-0001](docs/adr/0001-three-runtime-split.md), and
[ADR-0002](docs/adr/0002-postgres-role-split-rls.md) for the decisions and limits.
[ADR-0012](docs/adr/0012-edge-portal-codeploy.md) covers the earlier edge/portal
co-deployment option; Azure deploys them separately.

## How requests work

Each app has its own subdomain and browser origin. The edge handles authentication
and sets a host-only session cookie. Apps do not implement sign-in or hold API keys.

```text
browser → edge (auth, CSP) → Blob (static assets)
browser → edge /_api/llm/chat → egress → LLM vendor
browser → edge /_api/fetch/<url> → egress → third-party API
browser → edge /_api/data/* → Postgres (scoped app data)
```

For outbound requests, the edge checks the app's permissions and sends egress a
short-lived signed instruction. Egress verifies the instruction, resolves and
injects any required secret, and makes the request. Egress relies on the edge's
authorization decision; it does not authenticate the user again.

Deploys use the control plane:

```text
CLI or portal UI → portal API → Blob (immutable version) + registry (preview)
promote → update live-version pointer → notify edge to refresh its registry cache
```

Deploys create preview versions by default. Promotion makes a version live;
rollback selects an earlier version.

## Repository map

```text
apps/
  edge/         # App routing, authentication, serving, gateway policy
  portal/       # Registry/deploy API, approvals, secret writes, database schema
  portal-web/   # React + Mantine SPA, served by the portal
  egress/       # Outbound HTTP, credential injection, SSRF controls
  dev-idp/      # Local OIDC issuer
  docs/         # Public operator and app-author guides (VitePress)
packages/
  shared/       # Shared zod schemas and types
  secret-store/ # Credential storage: dev AES-GCM envelope or production Key Vault
  directory/    # Entra group search and name resolution for the portal
  telemetry/    # OpenTelemetry setup and test helpers
  cli/          # Published helix CLI
  deploy-skill/ # Agent instructions for building and deploying apps
examples/       # Deployable reference apps; built dist/ files are committed
docs/           # Contributor docs: architecture, decisions, designs, features, runbooks
infra/azure/    # Bicep deployment definitions
.devcontainer/  # Local Node, Postgres, Azurite, TLS, and credential setup
```

The code uses TypeScript, ESM, Node 24, and zod for boundary validation. The edge
has a small dependency budget: new runtime dependencies need review justification,
and database access uses parameterized SQL rather than an ORM.

## Deployment and local development

Helix runs on Azure Container Apps with Entra OIDC, wildcard TLS, and Key Vault.
The project plan tracks remaining work, including an end-to-end pilot app and
confirmation that the optional egress firewall is enabled in live deployments.

The full stack also runs locally. The dev IdP replaces Entra, Azurite replaces
Blob storage, and a local encrypted envelope replaces Key Vault. A cloud
subscription is not required for local development.

## Where to read next

| Task                         | Documentation                                          |
| ---------------------------- | ------------------------------------------------------ |
| Build and run the repo       | [README](README.md) and [AGENTS.md](AGENTS.md)         |
| Understand the architecture  | [Platform architecture](docs/platform-architecture.md) |
| Check implementation status  | [Project plan](docs/platform-project-plan.md)          |
| Work on a feature            | [Feature docs](docs/features/README.md)                |
| Review authentication        | [Auth review guide](docs/auth-review-guide.md)         |
| Read a subsystem design      | [Design docs](docs/design/)                            |
| Get a product-level overview | [System overview](docs/OVERVIEW.md)                    |
| Find or add documentation    | [Docs index](docs/README.md)                           |
