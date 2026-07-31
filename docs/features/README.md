# Helix feature docs

> **Related ADRs:** [ADR-0001](../adr/0001-three-runtime-split.md) (three-runtime split) · [ADR-0012](../adr/0012-edge-portal-codeploy.md) (edge/portal co-deploy).

Per-feature documentation for the **Helix / AZX App Platform** — what each feature is,
how it works, the files to dive into, and what is planned but not yet built. These docs
track the **code as it stands today**; the _why_ behind the design lives in
[`../platform-architecture.md`](../platform-architecture.md), the _order_ in
[`../platform-project-plan.md`](../platform-project-plan.md), and the app-data design in
[`../design/app-data-storage.md`](../design/app-data-storage.md). Section references
("§4.2", "project plan §6", "app-data design §3.2") point back into those.

> **Status: deployed on Azure (M5); feature set M4.5 — Egress & Connections.** Everything M2/M3/M4 had (registry + deploys,
> edge serving, the OIDC auth flow, the `/_api/*` LLM + app-data gateway with a Postgres role
> split) **plus** the **`helix-egress`** mechanism plane: the fetch-proxy (`/_api/fetch/<url>`) and
> secret-backed connections, built as their own container from day one. The edge stays the policy
> plane; egress is the only component with app **connection** secrets and an **arbitrary** internet
> route (the edge is not secretless — it holds its own operational keys, and today an over-broad
> Blob key; ADR-0001). The Entra registration and the Azure deploy have both landed; still ahead
> is a real pilot app end to end.

## The platform in one paragraph

Every hosted app is **untrusted code**. The design contains the blast radius per app rather
than trying to verify app code. Three deployable containers split along that trust boundary —
**`apps/edge`** (the data/policy plane: untrusted-traffic termination, auth, serving, the
gateway), **`apps/portal`** (the control plane: registry, deploys, capability grants, secret
writes), and **`apps/egress`** (the mechanism plane: outbound HTTP + secret injection, in its
own network zone) — plus managed Postgres + Blob. The edge runs dependency-minimal with a
read-only registry projection and a least-privilege DB role; the portal owns the schema and all
migrations; egress is the only component holding plaintext **connection** secrets or an
**arbitrary** route to the internet. The edge is **not** secretless, though — it carries its own
operational keys (auth/instruction/OIDC) and today an over-broad Blob key; what it lacks is any
grant on app connection secrets and any arbitrary outbound route (ADR-0001).

## Features

| Doc | Feature | Lives in |
| --- | --- | --- |
| [edge-serving.md](./edge-serving.md) | Host routing, registry projection, Blob streaming, CSP, 404/410 | `apps/edge` |
| [authentication.md](./authentication.md) | App-user OIDC flow, sessions, the per-request gate, portal bearer JWTs | `apps/edge`, `apps/portal` |
| [llm-gateway.md](./llm-gateway.md) | `POST /_api/llm/chat` — metered, allowlisted, key-hiding LLM proxy | `apps/edge` |
| [app-data-gateway.md](./app-data-gateway.md) | `/_api/data/*` user / collection / shared storage + owner drain | `apps/edge`, `apps/portal` |
| [fetch-proxy.md](./fetch-proxy.md) | `/_api/fetch/<url>` — governed outbound HTTP via the `helix-egress` plane | `apps/edge`, `apps/egress` |
| [secrets-and-connections.md](./secrets-and-connections.md) | Connection secrets: sealed credentials injected server-side | `apps/portal`, `apps/egress`, `packages/secret-store` |
| [dev-mode.md](./dev-mode.md) | Develop an app against an isolated `env=dev` tier via the dev-gateway | `apps/edge`, `apps/portal` |
| [registry-and-deploys.md](./registry-and-deploys.md) | App CRUD, version lifecycle, zip upload, promote/rollback, archive | `apps/portal` |
| [capabilities-and-manifests.md](./capabilities-and-manifests.md) | The per-app manifest the gateway enforces | `packages/shared`, `apps/portal` |
| [cli.md](./cli.md) | The `helix` CLI: deploy + OIDC device-flow login | `packages/cli` |
| [portal-web.md](./portal-web.md) | The React/Mantine portal SPA | `apps/portal-web` |
| [onboarding.md](./onboarding.md) | The in-app "How to develop" guide + the downloadable agent skill | `packages/deploy-skill`, `apps/portal-web` |
| [dev-idp.md](./dev-idp.md) | The local OIDC issuer used in dev/test | `apps/dev-idp` |
| [examples.md](./examples.md) | Reference apps you can `helix deploy` | `examples/` |

## Milestone map (project plan §4)

- **M0** — skeleton, boot pattern, `/health`.
- **M1** — registry + deploys (portal API + `helix` CLI). _Shipped._
- **M2** — edge serving on `*.local.helix.azxlabs.io`, registry projection, Blob streaming, CSP, 404/410. _Shipped._
- **M3** — auth: OIDC handoff, sessions, the gate, CLI/portal bearer tokens, **local issuer**. _Shipped (local half); real Entra registration is the remaining tail._
- **M4** — gateway v0: the LLM proxy, then app-data, metering, and the DB role split. _Shipped locally._
- **M4.5** — the `helix-egress` mechanism plane: fetch-proxy + secret-backed connections. _Shipped locally — this milestone._
- **M5** — Azure deploy + pilot. _Ahead._

Each doc has a **Planned / not yet built** section calling out what is deferred or config-only.
The portal SPA's screens are all real and wired to `/api/v1/*`; the one not-yet-built sub-feature
(per-app RBAC roles) carries a `PreviewBadge` (`milestone="v1"`) and is never silently faked.
