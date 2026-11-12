---
title: Error codes
description: "The status codes and error codes the /_api gateway returns, what each means, and whether retrying can help."
---

# Error codes

Most gateway errors come back as JSON shaped like
`{ "error": { "code": "…", "message": "…" } }`. Show the message to the user. A `403` means a grant is missing, and retrying won't fix it.

| Status | Code | Meaning |
| --- | --- | --- |
| `401` | — | Not signed in. Usually the session expired; reloading the page signs the user in again |
| `400` | `validation_failed` | The request body is invalid, or the model can't enforce the response schema you sent |
| `403` | `forbidden` | Not in the manifest, or no grant covers the key or prefix (including list calls) |
| `403` | `model_not_allowed` | The model isn't in `llm.models` |
| `403` | `connection_required` | The user has no connection to a provider-bound origin. Offer Connect; see [Connected accounts](./connected-accounts) |
| `412` | `conflict` | Another write to this shared key got in first. Re-read and retry with the new `ETag`; see [Shared writes](./gateway#shared-writes-are-compare-and-swap) |
| `428` | `precondition_required` | A shared write without `If-Match` or `If-None-Match`. Fix the code |
| `429` | `quota_exceeded` | The daily budget is spent. Calls already running finish; new ones are refused |
| `429` | `rate_limited` | On a `public` app: the per-IP limit for anonymous visitors |
| `429` | `rate_limited` | On an LLM call: the model provider is throttling. Retry after the `retry-after` delay |
| `502` | `upstream_error` | The vendor failed, or renewing a delegated token failed for now. The connection is kept; whether to retry later is your decision |
| `502` | `provider_misconfigured` | The OAuth provider's configuration is invalid. Administrator action |
| `503` | `provider_unavailable` | The OAuth provider was deleted or its binding is blocked. Administrator action |
| `503` | `capability_unavailable` | This deployment isn't set up for the capability |
| `502` | — | The upstream provider failed |

Neither `412` nor `428` counts against the app's daily write budget.

## On the OpenAI-compatible API

`/_api/openai/v1/*` answers with the same statuses, but in OpenAI's error
envelope, `{ "error": { "message", "type", "param", "code" } }`, so the OpenAI
SDK raises its usual typed errors. `param` names the offending request field
when there is one.

| Status | Platform code | OpenAI `type` | OpenAI `code` |
| --- | --- | --- | --- |
| `400` | `validation_failed` | `invalid_request_error` | `null` |
| `403` | `forbidden` | `invalid_request_error` | `null` |
| `403` | `model_not_allowed` | `invalid_request_error` | `model_not_found` |
| `429` | `quota_exceeded` | `insufficient_quota` | `insufficient_quota` |
| `429` | `rate_limited` | `rate_limit_exceeded` | `rate_limit_exceeded` |
| `502`, `503` | `internal`, `capability_unavailable` | `api_error` | `null` |

Responses sent before the OpenAI-compatible handler runs can have a different
shape. The session gate's `401`, an internal `500`, and body-parser errors
(`400` for malformed JSON, `413` for an oversized body, `415` for an unsupported
content type) keep the platform's `{ error: { code, message } }` envelope.
Routing and availability failures can also return plain text or HTML. Check
the status and content type before assuming an OpenAI error body; the
[app API reference](./api-reference) lists these shared responses.

The SDK retries a `429` on its own. That helps with `rate_limit_exceeded`, but
`insufficient_quota` means the day's budget is spent, and retrying can't fix
that. Show it to the user.

## On the jobs API

The `/_api/jobs/*` routes have their own codes, such as `idempotency_conflict`
and `jobs_unavailable`, and their own retry rules. See
[Errors from the jobs routes](./jobs#errors-from-the-jobs-routes).

### Service-account authentication

The fetch gateway returns HTTP 503 with `service_account_unavailable` when token
acquisition is temporarily unavailable, or `service_account_rejected` when the
configured credentials or authentication configuration need attention. The app
should display a useful failure message without collecting credentials itself.
An owner can inspect the connection's status in the portal and rotate or replace
it. Replacement requires approval. Temporary failures respect a shared cooldown,
so repeatedly retrying immediately will not force another login.
