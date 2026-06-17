# Capabilities & manifests

**What it is.** Every app carries a **manifest** that declares the capabilities the gateway will
enforce (architecture §6.3). It is the contract between the control plane (which grants) and the
data plane (which enforces): the portal writes it, the registry projection carries it to the
edge, and the LLM/app-data handlers gate every call against it. Nothing an app does at runtime
can exceed its manifest.

Schema: `packages/shared/src/manifest.ts`. Visibility: `packages/shared/src/visibility.ts`.

## The shape

```ts
Capabilities = {
  llm?:  { models: string[]; tokensPerDay?: int }
  data?: { user: boolean
           collections: string[]      // append-only; no app-facing read
           sharedRead: string[]       // world-readable-within-gate keys
           sharedWrite: string[]      // narrower; write never implies read
           writesPerDay?: int; bytesPerDay?: int }
  mcp: string[]                        // platform-registered MCP servers (default [])
  externalOrigins: URL[]               // extra CSP connect-src (default [])
}

AppManifest = { app: slug; visibility: Visibility; capabilities: Capabilities }
```

`Visibility` is a discriminated union — `private` | `group` (+ `groupId`) | `password` |
`public` — stored flattened in the DB (`visibilityMode` + `visibilityGroupId`) and reassembled
by the mappers.

## How grants flow and are enforced

1. **Author** edits the manifest in the portal: `GET`/`PUT /api/v1/apps/:slug/manifest`
   (`apps/portal/src/routes/apps.ts`), validated through `CapabilitiesSchema`. The PUT is a full
   **replace** and writes an `app.manifest.set` audit event.
2. **Project** — the new `capabilities` JSONB lands in `apps`, and the edge's LISTEN/NOTIFY
   projection picks it up (`apps/edge/src/registry/projection.ts`, parsing `llm`/`data`
   fail-closed). The live registry entry now carries `entry.llm` / `entry.data`.
3. **Enforce** — each gateway handler checks the relevant grant per request:
   - LLM: `entry.llm` must exist and `chat.model ∈ entry.llm.models`; `tokensPerDay` bounds the
     daily budget (see [llm-gateway.md](./llm-gateway.md)).
   - Data: `entry.data` gates the scope, and `collections` / `sharedRead` / `sharedWrite` are
     per-name allowlists; `writesPerDay` bounds writes (see [app-data-gateway.md](./app-data-gateway.md)).
   - CSP: `externalOrigins` extends `connect-src` at the edge (see [edge-serving.md](./edge-serving.md)).

The asymmetry is deliberate: read and write are independent grants because the writer and reader
of app-data can be different principals (an anonymous visitor appends to a collection the owner
later drains).

## Where it shows up in the UI

The portal SPA has a **real** manifest editor (the Capabilities tab) wired to the live GET/PUT —
LLM models + token budget, the data flags/lists, external origins, and MCP grants. See
[portal-web.md](./portal-web.md).

## Planned / not yet built

- **Approval policy** — grants "above a baseline" (arbitrary MCP servers / external origins, high
  LLM budgets) are meant to require admin approval (§6.3). The schema is shape-only; the approval
  workflow is a `PREVIEW · M4` screen, not yet enforced.
- **MCP** — `mcp` is carried in the manifest but has no gateway transport yet; the
  MCP-as-REST design is in `docs/platform-custom-backends-and-apis.md`.
- **`bytesPerDay`** is declared but not yet enforced (app-data design §7).
