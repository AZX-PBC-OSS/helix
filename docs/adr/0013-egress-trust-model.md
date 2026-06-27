# 0013. Egress trust model: harden the attested-instruction seam

**Status:** Proposed (direction chosen 2026-06-26; long-tail key strategy still open)
**Related:** ADR [0001](0001-three-runtime-split.md), [0005](0005-ssrf-egress-controls.md), [0006](0006-secret-custody-seam.md); review ADR-candidate, ISSUE-04

## Context

The edge authorizes a fetch/LLM call and forwards it to egress with a short-lived **attested instruction** `(app, user, capability, origin, connection, request-id)`. Egress trusts the instruction and does not re-authenticate the user — by design (the policy/mechanism split).

Today the instruction is an **`HS256` MAC over a single shared `HELIX_INSTRUCTION_SECRET`**. _(Correction 2026-06-26: for the **`fetch`** path egress **does** authorize — it scopes the secret by `appId` and re-checks `app_secret_grants` for `global` secrets, `apps/egress/src/secrets.ts:48-92`; step 2 below is already implemented there.)_ The residual is narrower: the **`llm`/platform** path resolves a platform secret **by name only**; the instruction binds `origin` but **not method/path**; there is **no `aud`** and **no replay burn (`jti`)**; and — the load-bearing one — because the key is a **shared symmetric secret, the `appId` claim itself is forgeable**, so the grant-check only constrains a *well-behaved* edge.

Consequence: the headline claim *"an edge RCE reaches no secret"* is too strong. A compromised edge cannot *exfiltrate* plaintext (egress injects server-side) but **can use any connection's credential** and read the upstream response.

## Decision (direction)

**Harden the seam** rather than accept it as-is or immediately re-architect:

1. **Now (cheap):** add a `jti` one-time-use burn (bounded seen-set / table at egress) and `aud: "azx-egress"`, asserted in `jwtVerify`. Closes replay and token-passthrough (ISSUE-04).
2. **Before multi-tenant:** **already done for `fetch`** (`secrets.ts:48-92` scopes by `appId` + grants); extend the same per-action check to the `llm`/platform path and **bind `method`+`path`** into the instruction (not just `origin`, `proxy.ts:101`). Caveat: this only constrains a *well-behaved* edge — the forgeable-`appId` root cause is step 3.
3. **Post-M5 (open):** move from the shared symmetric secret to **asymmetric** signing — **Ed25519** (edge holds the private key; egress holds only the public verification key). Model the instruction on **IETF Transaction Tokens** (`draft-ietf-oauth-transaction-tokens`): a short-lived signed JWT with a required **scope** representing the specific purpose/intent of the call (here: capability + origin + connection + method + path), an `aud` naming the egress trust domain, and a short `exp`. (Per-app-derived symmetric keys were evaluated and **rejected** — see the Challenge-outcome note: both planes hold the master, so it delivers no isolation.) Scope: the *leak-surface* win below, not edge-compromise containment.

## Consequences

- Steps 1–2 keep the current architecture and meaningfully shrink the "edge can use any secret" gap.
- Step 3 is a larger change (key management, rotation) deferred until after the prod cutover.
- Egress becomes a true **credential broker** (authorizes each action) rather than a signature checker.

## Best-practice grounding (2026-06-26)

- Shared symmetric HMAC across services is an explicit anti-pattern — *"any compromised service can forge tokens for the entire system"* (Ping Identity; WorkOS RS256-vs-HS256). `Brave ✗` on the current design.
- Egress matches the **credential-broker** pattern (SANS `draft-hartman-credential-broker-4-agents`; Anthropic vault-proxy; Cloudflare Outbound Workers). Best practice: broker **authorizes each action**, **validates `aud` / forbids token passthrough**, issues **short-lived one-time** capabilities.
- The literature names this exact residual: a compromised deputy *can use but not read* the credential → mitigate with per-action scope at the broker, not just signature verification.
- **IETF Transaction Tokens** (`draft-ietf-oauth-transaction-tokens`) is the standard to model the instruction on: a service mints a short-lived signed token capturing the downstream transaction's intent, with a required `scope` ("MUST represent the specific purpose or intent of the transaction"), `aud`, and short `exp` — exactly the shape of our attested instruction. Adopt its vocabulary (scope = intent) for step 3.

## Open question (needs sign-off)

Choose the long-tail key strategy: **(a)** keep symmetric but add broker-side per-app authorization (cheaper, step 2 only), or **(b)** go asymmetric / per-app-derived keys (stronger, step 3). Decide whether (b) is required before onboarding external app owners or can wait until post-M5.

## Review notes (2026-06-25)

Genuinely contested across the model panel (Critical "boundary broken" vs "signing sound, hardening only"); surfaced rather than resolved by vote. Maintainer selected "harden the seam" as the direction.

## Challenge outcome (2026-06-26)

Facts re-verified (Context corrected above); the proposed **step-1 key fix is unsound and must not be adopted as written**.

**`HKDF(master, appId)` per-app keys do NOT deliver cross-app isolation.** Both the edge and egress must hold `master` — the edge to mint for any app it serves, egress to verify any `kid=appId` — so a compromised edge derives any app's key and forges cross-app instructions exactly as today. And binding `appId` into the *key* is redundant with the HMAC already authenticating the `appId` claim in the signed body (a no-key attacker already can't relabel A→B). The literal goal "an edge compromise cannot forge cross-app instructions" is **architecturally unattainable in this topology by any key scheme** — a single multi-tenant minter can always forge any tenant.

What actually helps — and what it does *not*: **asymmetric** signing (edge private-signs; egress holds a verify-only public key) keeps **signing material off the internet-attached plane**. Its real benefit is shrinking the **shared-secret leak surface**: today the symmetric `HELIX_INSTRUCTION_SECRET` sits on *both* planes (and in CI / config / backups), so a leak from anywhere forges everything; with asymmetric, a leaked verify-key is useless. Note it does **not** "contain a compromised egress" — a fully compromised egress already resolves every plaintext secret and makes arbitrary outbound calls, so forging an instruction to itself adds nothing; asymmetric defends against secret *leak* short of full RCE, not against owning the egress process. And it does **not** stop a compromised *edge* (the legitimate minter holds the private key regardless) — that goal is architecturally unattainable by any key scheme. The channel-level defense (authenticate the caller, encrypt the hop) is **mTLS / workload identity** — issue #5, orthogonal to signing. Keep asymmetric as **step 3** (larger, key-mgmt/rotation), not step 1. The cheap, real wins now are the **`jti`/`aud` burn** (step 1, **#3**) and **binding method+path** (**#6**) — both independent of the key strategy.
