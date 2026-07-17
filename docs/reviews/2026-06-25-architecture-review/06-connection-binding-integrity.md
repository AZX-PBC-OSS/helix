# [IMPORTANT] Connection binding has no deploy-time referential integrity

**Component:** `packages/shared` `classifyChange` (approval classifier), registry projection
**Status:** design-level

## Problem

`capabilities.fetch.origins[].connection` (fetch-proxy §5) names a secret/connection by string and is
declared `z.string().optional()`. There is **no referential-integrity check** that the named connection
actually resolves under the app's grants at deploy/approval time. A typo (`stripe-live` vs `stripe_live`)
passes validation, reaches the projection, and only **silently 403s at runtime** in egress
(`proxy.ts:117-119`, "connection not found or not granted") — a confusing failure far from its cause,
instead of a clear failure at deploy.

## Proposed handling

Add a write-gate case in `classifyChange` (`@helix/shared`, approvals §3) that requires every named
connection in `fetch.origins[].connection` to resolve to an existing, grant-eligible secret for the app
before the manifest change is accepted. Fail-classify at deploy rather than inert-403 at runtime.
