---
title: Error codes
description: "The status codes and error codes the /_api gateway returns, what each means, and whether retrying can help."
---

# Error codes

Gateway errors come back as JSON with a `code` and a `message`. Show them to the
user as they are. A `403` means a grant is missing, and retrying won't fix it.

| Status | Code | Meaning |
| --- | --- | --- |
| `401` | — | Not signed in. Usually the session expired; reloading the page signs the user in again |
| `400` | `validation_failed` | The request body is invalid, or the model can't enforce the `responseFormat` you sent |
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
