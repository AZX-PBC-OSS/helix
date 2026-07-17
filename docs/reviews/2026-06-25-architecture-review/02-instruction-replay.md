# [IMPORTANT] Attested instruction has no replay protection

**Component:** `apps/egress/src/instruction.ts`, `apps/egress/src/proxy.ts`
**Status:** verified against the code; severity revised down from Blocking → Important after a full recheck (see below)

## Problem

`verifyInstruction` (`apps/egress/src/instruction.ts:35-53`) is a stateless JWT verify: signature +
`typ` + freshness (`maxTokenAge: INSTRUCTION_TTL_SECONDS` = 30s, `clockTolerance` = 5s). The
`requestId` field is carried in the payload but **never consulted for uniqueness** — it's referenced
nowhere in `apps/egress/src`, audit correlation only. There is no `jti` and no seen-set, so the same
signed instruction succeeds every time it's POSTed to egress inside the ~35s window.

By contrast, the OIDC handoff token — the same `jose`/HKDF family — is **single-use**, burned by an
atomic redeem UPDATE (`apps/edge/src/auth/sessions.ts:13`, which explicitly treats a second redeem as
"already redeemed (replay)"). The instruction has no equivalent. (Note: the shared schema comment at
`packages/shared/src/instruction.ts:17` claims `jti`/`aud` are "handled by the signer/verifier" — but
the mint side sets neither. Stale comment; fix alongside.)

## Consequence (corrected)

A captured instruction replayed within ~35s re-runs the full proxy path: origin re-check passes
(`proxy.ts:101`, same origin), the secret is re-resolved and re-injected (`proxy.ts:112-120`), and the
outbound call fires again (`proxy.ts:141`). Two corrections to the original framing:

- **It bypasses platform accounting, it doesn't "burn the budget."** The per-app `requestsPerDay` /
  token budget is enforced on the **edge, before mint** (`apps/edge/src/gateway/fetch.ts:144-162`,
  mint at 164). A replay hits egress directly, so it never passes the edge's quota gate or writes a
  `gateway_calls` row. The real cost is **unmetered upstream vendor spend and side-effects** (Anthropic,
  paid third-party APIs) — invisible to the usage dashboards, and able to exceed the app's daily budget.
- **The response leaks to the on-path party.** Egress streams the upstream response back to whoever
  presented the instruction (`proxy.ts:164`), so a replayer also receives the secret-gated response
  body — though never the secret itself (injected server-side).

## Why Important, not Blocking

The recheck was unanimous on downgrading severity. The replay is real and unmitigated, but:

- It requires an attacker **positioned on the edge↔egress path** — not exploitable from the public
  internet. (The hop has no TLS in the seam — see issue 03 — so on that path the token can be observed
  without a deeper compromise; egress also binds `0.0.0.0` by default at `config.ts:41`, so
  "internal-only" is an operational assumption, not enforced.)
- The **secret is never exposed**, and the replay is bound to the already-authorized origin, capability,
  and connection — it can't escalate to arbitrary outbound calls.
- The window is tight (~35s) and there's no data-loss, correctness break, or privilege escalation.

This is a defense-in-depth gap with real but contained exposure. Treat it as an M4.5 production-checklist
item to ship before the Azure deploy, paired with issue 03 (transport TLS).

## Proposed handling

- Promote the existing per-call `requestId` (already `randomUUID()` at `fetch.ts:171` / `llm.ts:239`) to
  a `jti`, and reject a seen `jti` at verify time.
- **Single-instance** egress: a TTL-evicted in-memory set is enough. **Multi-instance** (prod, N
  replicas behind a LB): an in-memory set silently weakens to "probabilistically caught" — use a shared
  store (Redis) or a small `instructions(jti PK, exp)` table with `DELETE WHERE exp < now()` GC, which
  mirrors the handoff's table-driven single-use guarantee.
- Size the seen-set retention `>= maxTokenAge + clockTolerance + margin` (~45s) to cover late arrivals.
- This closes *replay* only. The instruction signs `origin`/`appId`/`capability`/`connection` but **not
  method, path/query, or body** (`proxy.ts:144` streams `req.raw`; only `origin` is re-checked) — so an
  on-path attacker can still mutate the request within the authorized origin. Pair the `jti` fix with
  binding method + a body/envelope hash — tracked in issue 04 (instruction signature scope).

Tests in lockstep (`apps/egress/src/adversarial.test.ts` — there is currently no replay test).

---

### Recheck (2026-06-25)

Five independent model reviews + a direct code trace. **Unanimous (5/5): the finding is substantively
correct, severity should be Important, not Blocking.** Verified facts: stateless verify with no
dedup; `requestId` unused in egress; ~35s window; handoff single-use contrast is fair; stale `jti`/`aud`
schema comment. Corrections folded in above: the "burns budget" framing (it bypasses edge accounting →
unmetered vendor spend), the response-leak-to-on-path-party consequence, the "plain HTTP" overstatement
(no TLS in the seam, but transport is deploy-configurable), and the fix's multi-instance + unsigned-body
gaps.
