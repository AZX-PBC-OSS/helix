# OpenAPI specs

> **Related ADRs:** [ADR-0054](../adr/0054-openapi-generated-from-zod-route-contracts.md) (OpenAPI generated from zod route contracts).

Helix publishes two OpenAPI 3.1 documents:

- **The app API** (`/_api/*` on the edge), which hosted apps call from the browser.
- **The portal API** (`/api/v1/*`), which the CLI, the portal UI and operator
  automation call.

Neither is written by hand. Both are generated from **route contracts**: one zod
declaration per route that the handler also validates with. A route cannot be
added, removed or changed without the spec changing too, because tests and a
CI step compare them.

## Where they are published

| Where | What |
| --- | --- |
| `packages/openapi/spec/{app,portal}-api.json` | The committed documents. A change to an API shows up in review as a diff here. |
| `GET /api/v1/openapi.json` on a portal | The portal API document of that portal's own release. Public. |
| `https://azx-pbc-oss.github.io/helix/openapi/{app,portal}-api.json` | Both documents, for the latest release, published by the docs build. |
| Docs pages `apps/api-reference` and `deploy/portal-api-reference` | Rendered references, linked from the gateway guide. |
| The agent skill | Links the app API document. |

The edge does not serve a spec. The docs site is the stable address for app
authors and agents.

## How a route is declared

Contracts live in `packages/shared/src/contracts/`, imported as
`@azx-pbc/shared/contracts`:

- `portal/<route-file>.ts`: one file per portal route file, using `portalRoute`,
  which adds the error responses every portal route can return (400, 401, 403,
  404 for owner routes, 500).
- `app/<group>.ts`: the edge's `/_api/*` routes, using `appRoute`.
- `define.ts`: the contract type and the helpers (`jsonBody`, `jsonResponse`,
  `emptyResponse`, `media`, `parseRequest`, `responseBody`).

The module is pure zod. The edge loads `@azx-pbc/shared` at runtime, so nothing
under `contracts/` may import an OpenAPI or Fastify package.

**Portal handlers** register with `contractRoute` (`apps/portal/src/plugins/contractRoute.ts`).
It takes the method and path from the contract and adds `authenticate` for
`auth: "bearer"` and `ownsApp` for `owner: true`, so the documented and the
enforced auth come from one declaration. Handlers validate input with
`parseRequest(contract, req)` and build JSON responses with
`responseBody(contract, status, value)`.

**Edge handlers** keep their own host-class dispatch. Only their paths come from
the contracts, and the edge adds no response parsing on the hot path.

### Adding or changing a route

1. Write or change the contract, declaring every status the route can return.
2. Register the route from the contract.
3. Run `pnpm openapi` and commit the regenerated `spec/*.json`.

## What keeps the spec honest

- **Route coverage.** `apps/portal/src/contracts.test.ts` and
  `apps/edge/src/contracts.test.ts` collect every registered route through a
  test-only `onRoute` seam on `buildApp` and compare the set with the contracts
  in both directions. A route that is deliberately unpublished (health, auth
  pages, internal hops, static serving) is listed with its reason.
- **Response conformance.** The portal test harness, and the edge test builders
  that exercise `/_api`, record every response a test provokes and check its
  status, content type and JSON body against the contract. A violation fails
  the test file when its app closes. Streamed SSE replies hijack the socket and
  are not seen; their event schemas are asserted by the LLM tests. A streamed
  fetch-proxy passthrough is checked for status and media type, not body.
- **Spec freshness.** The `openapi` step of `./check-and-lint.sh` regenerates
  both documents in memory and fails when a committed file differs. `--fix`
  regenerates them.
- **Generator checks.** `packages/openapi/src/build.test.ts` validates both
  documents against the official OpenAPI 3.1 JSON Schema, and checks that ids
  are unique, path parameters are declared, every component reference
  resolves, and a query parameter is published as required only when omitting
  it is refused. A freshness check alone cannot catch a generator that writes
  an invalid document.

## Request errors

`parseRequest` throws `RequestValidationError`, which the portal maps to `400
validation_failed`. Any other `ZodError` in the portal is a server-side value
that broke its own schema, and is a `500 internal`. Fastify's own client errors
(malformed JSON, an unsupported content type, an oversized body) keep their 4xx
status. They are recognized by their `FST_` code, not by status alone: an SDK
error such as a Blob `RestError` also carries a 4xx status, and it is the
platform's failure, so it stays a logged 500.

## Known gaps

- **Streaming is described in prose.** OpenAPI 3.1 has no per-event schema for
  `text/event-stream`. OpenAPI 3.2's `itemSchema` would fix this once the
  generator and renderer support it.
- **`/_api/fetch/*` has no body schema.** It passes the upstream's status and
  body through, which the contract declares as its `default` response. The
  platform's refusal statuses (400, 403, 413, 429, 502, 503) can also be the
  upstream's own, so each allows either a `FetchProxyError` or the upstream's
  body. Refusals carry no marker header; a client tells them apart by the body.
- **The app API has several error envelopes.** `ApiError`, the fetch proxy's
  `{code, message}`, `JobRequestError`, the OpenAI error shape, and plain-text
  404s from host dispatch. The spec documents them as they are (see `TODO.md`).
- **A defaulted query needs `.default()`, not only `.catch()`.** The published
  `required` flag comes from the schema's input type, and `.catch()` alone
  leaves it required. Use `.catch(x).default(x)`.
- **Response transforms cannot be described.** zod-openapi cannot render the
  output of a `.transform()` inside a response schema. Use `.overwrite()` for a
  normalization that keeps the type.
- **The dev gateway is not in the spec.** It mirrors the app API under `/:slug`
  for local development.
