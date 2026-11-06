# 0054. OpenAPI specs generated from zod route contracts

**Status:** Proposed (2026-11-05).
**Related:** ADR [0003](0003-dependency-minimal-edge.md) (dependency-minimal edge), [0014](0014-same-origin-api-gateway.md) (the `/_api/*` gateway), [0024](0024-portal-cli-bearer-jwt-jwks.md) (portal bearer auth), [0036](0036-deployment-capability-catalogue.md) (capability catalogue), [0037](0037-platform-observability-otlp-boundary.md) (telemetry), [0052](0052-evergreen-agent-skill-and-npx-cli.md) (docs are the reference; `/apps/` URLs are stable). **Code (planned):** `packages/shared/src/contracts/`, `scripts/openapi.mts`, `openapi/`, `apps/docs`.

## Context

Helix has two HTTP APIs that people outside the platform team build against:

- **The app API (`/_api/*` on the edge).** Hosted apps and their authoring
  agents call it: identity, LLM (native and OpenAI-compatible), app-data,
  connections, the fetch proxy, and jobs.
- **The portal API (`/api/v1/*`).** The CLI, the portal SPA, and operator
  automation call it.

Neither has a machine-readable description. The hand-written guides in
`apps/docs/src/apps/` explain how to use each capability but are not a field-level
reference. A reference written by hand would drift from the code, because nothing
would check it.

Most of the information needed for a spec already exists as code:

- Request and response shapes are zod schemas in `@azx-pbc/shared`, and zod 4
  converts them to JSON Schema natively (`z.toJSONSchema`, `.meta()`).
- Portal handlers parse request bodies and their own responses through those
  schemas, for example `apps/portal/src/routes/platformSettings.ts`.
- The edge's LLM and OpenAI-compatible routes do the same.

What is missing is the link from a route to its schemas. Handlers call
`Schema.parse()` inside their bodies, and no route uses Fastify's `schema:`
option, so there is nothing a tool can read to learn which schemas belong to
which method and path. Some routes also have no response schema at all. The
edge's app-data handlers (`apps/edge/src/gateway/data-handler.ts`) send
hand-built objects such as `{ key, value }`.

The standard Fastify approach is `fastify-type-provider-zod` with
`@fastify/swagger`. It moves the zod schemas into each route's `schema:` option
and builds the spec from the registered routes at runtime. That approach doesn't
fit Helix:

- **It adds runtime dependencies to the edge.** Every package there is in the
  trusted path (ADR-0003), and generating documentation is not a reason to add
  code there.
- **The edge's routing doesn't map onto it.** One URL is registered once and
  dispatched by host class (`req.hostClass`). `/_api/fetch/*` sits in its own
  scope with a passthrough body parser. Fastify-level validation would run
  before the host-class check and change which error an app sees.
- **Using it for the portal only would give two mechanisms**, one per service,
  for the same job.

## Decision

1. **Route contracts are declared as data in `@azx-pbc/shared`.** Every route in
   a published API has one entry in a contract table, made with a typed
   `defineRoute` helper. An entry holds:
   - method and path;
   - `params`, `query`, and `body` schemas, where the route has them;
   - `responses`, a schema per status code, including the shared error envelope;
   - security scheme, tag, summary, and description.

   The contract is the single source for both validation and documentation.
   Handlers parse with the contract's schema (`contract.body.parse(req.body)`),
   not a separately imported one, so the schema that is enforced is the schema
   that is documented. Routes keep their existing Fastify registration, and the
   edge keeps its host-class dispatch. This is a change to where schemas live,
   not to how routing works.

2. **The spec is generated at build time, never at runtime.** A script
   (`scripts/openapi.mts`) turns the contract tables into OpenAPI 3.1 documents
   with `zod-openapi` (zod 4 native). It is a root dev dependency, so no
   service, and in particular not the edge, gains a runtime package. The script
   writes two documents:
   - `openapi/app-api.json` for `/_api/*`;
   - `openapi/portal-api.json` for `/api/v1/*`.

3. **The generated specs are committed, and CI rejects a stale one.**
   `check-and-lint.sh` regenerates both documents and fails when the result
   differs from the committed files. Any change to the API therefore shows up as
   a readable spec diff in review.

4. **Tests reject undocumented routes and wrong responses.**
   - **Route coverage.** Each service's `buildApp()` test collects registered
     routes with Fastify's `onRoute` hook and compares them with the contract
     table in both directions. A route with no contract fails, and so does a
     contract with no route. Routes outside the published APIs are listed by
     name in an explicit exclusion list: health, auth pages, internal hops, and
     the dev gateway.
   - **Response conformance.** A test helper validates each `inject()` reply
     against the contract's schema for its status code. It is enabled across the
     existing route tests. This runs in tests only, so the edge's hot path does
     not gain a parse of every response body. Where the portal already parses
     its own responses, that stays as it is.

5. **What is published, and where.**
   - **The docs site renders both specs** as reference pages next to the
     hand-written guides (`vitepress-openapi`, a docs-only dev dependency). The
     raw JSON is served from the site as well, for agents and client generators.
     The guides stay the primary reference (ADR-0052 decision 1). The generated
     pages are field-level detail that the guides link to, not a replacement
     for them.
   - **The portal serves `GET /api/v1/openapi.json`** without authentication.
     The repository is public, so the spec discloses nothing the source doesn't.
     The file is read once at boot from the build output.
   - **The edge does not serve a spec.** The docs site is the stable address. The
     agent skill links to the docs page, which is a stable URL and not a
     per-release value, so it is allowed under ADR-0052.

6. **Internal hops are out of scope.** Egress `POST /proxy`, the jobs↔edge and
   portal→jobs signed calls, and `connectionsInternal` are not published. Their
   contracts are the signed-instruction formats, which are covered by their own
   tests and ADRs. They may move to contracts later, flagged `x-internal`, but
   that is not part of this decision.

7. **Surfaces OpenAPI describes poorly are documented honestly, not forced.**
   - **Streaming (`text/event-stream`)** on `/_api/llm/chat` and OpenAI-compatible
     streaming. The spec declares the media type, and the event schema is
     described in prose. OpenAPI 3.2's `itemSchema` would describe streams
     properly. Moving to 3.2 is follow-up work for when the generator and
     renderer support it.
   - **`/_api/fetch/*`** passes arbitrary bodies through. Its entry documents the
     path convention, the request headers the edge reads, and the refusal
     responses, with no body schema.
   - **`/_api/openai/v1/*`** is described as an OpenAI-compatible subset. The
     spec documents the fields Helix accepts and links to OpenAI's own spec
     rather than restating it.
   - **Authentication** is declared with `securitySchemes`: bearer JWT for the
     portal API (ADR-0024), and the `__Host-session` cookie for the app API.

## Consequences

- **Every published route gains a contract entry.** About 30 portal routes and
  the `/_api/*` routes need one. Migration is mechanical for routes that already
  parse through shared schemas. The edge's app-data routes need new response
  schemas, which this decision requires anyway.
- **Adding a route without a contract fails CI.** That is the point of the
  decision, but it is a new step for contributors. The failure message has to
  say where to add the entry.
- **Schemas need documentation metadata.** Descriptions, examples, and stable
  component names come from zod's `.meta()`. Schemas without an `id` are inlined,
  which keeps working but makes the spec harder to read, so shared types such as
  the error envelope get ids first.
- **The spec describes `main`, not a given deployment.** This is the same gap
  ADR-0052 accepts for the docs. The portal's `/api/v1/openapi.json` matches its
  own build, so a client that needs the deployed shape should read that.
- **The SPA and CLI are unaffected.** They already import the zod schemas
  directly. Generating a client from the spec gives them nothing they don't have.
  The spec is for everyone else.
- **New dependencies are dev-only:** `zod-openapi` at the root and
  `vitepress-openapi` in `apps/docs`. `vitepress-openapi` is pre-1.0. If it
  proves unreliable, Scalar's standalone renderer is the fallback, because both
  read the same JSON.
- **Telemetry:** no new edge or egress seam. The portal's `GET
  /api/v1/openapi.json` serves a static file. It gets a route constant
  (`ROUTE_*`) for its span like any other portal route, and no instrument
  (ADR-0037 decision 8).

## Rollout

1. Add `defineRoute`, the generator, the coverage and conformance test helpers,
   and the CI step. Convert `platformSettings.ts` and the edge app-data routes as
   the pilot, because they are the best-covered and the least-covered routes
   respectively.
2. Convert the remaining portal routes and the remaining `/_api/*` routes. The
   coverage test's exclusion list starts as every unconverted route and shrinks
   to only the intentional exclusions.
3. Publish: the docs reference pages, the portal endpoint, and a skill link to
   the docs page.
