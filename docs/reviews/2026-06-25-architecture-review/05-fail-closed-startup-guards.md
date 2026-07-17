# [MINOR] Prod fail-closed startup guards

**Component:** `apps/egress/src/ssrf.ts` + config; `apps/edge/src/server.ts`
**Status:** verified against the code

Two independent "fail-closed at boot" guards. Bundled because both are one-line startup assertions that
turn a silent misconfiguration into a refused boot.

## 1. `allowPrivate` has no prod-guard

`allowPrivate` is a boolean that flows from config into `resolveAndValidate`/`isBlockedAddress`
(`apps/egress/src/ssrf.ts:86-95`). It is a deliberate test/dev seam (loopback upstreams), but a
misconfigured prod deploy that sets it true **silently disables every SSRF range check** with no
assertion or log. **Fix:** assert `allowPrivate === false` at egress startup when running in
production (env/config-gated), failing the boot if mis-set.

## 2. Deprecated edge LLM key contradicts "edge holds no secrets"

The legacy direct provider path (`EDGE_LLM_ANTHROPIC_KEY` via `secrets-provider.ts`, selected at
`apps/edge/src/server.ts:136-148` when egress is absent) keeps a **plaintext vendor key in the edge** —
directly contradicting the "edge holds no secrets" invariant. It's correctly labelled a deprecated dev
fallback, but nothing prevents it from being the active path in prod. **Fix:** gate it behind
`NODE_ENV=development` and **fail startup in production** if egress is not configured (fail-closed, like
auth). This is the substantive cousin of the stale-diagram nit that kicked off this review.
