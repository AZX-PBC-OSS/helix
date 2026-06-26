# ADR Challenge — independent verification (2026-06-26)

Each row of `2026-06-26-adr-challenge.md` was re-checked against source by an independent read-only
agent. Verdicts: **✅ Holds** (challenge correct, lands new evidence the ADR doesn't disclose) ·
**⚠️ Holds-but-overstated** (concrete facts true, but the ADR already self-discloses most of it; framing
oversells) · **❌ Refuted** (a load-bearing claim is wrong).

## Summary table

| ADR | Verdict | Core facts | New vs. already-disclosed | Action |
|---|---|---|---|---|
| 0001 three-runtime | ✅ Holds | Edge holds Blob key, OIDC/auth/instruction secrets; dials Blob+IdP directly — all CONFIRMED | "materially false" only of the unqualified Decision bullet; Context/Consequences already say "third-party/arbitrary" | Reword Decision bullet to match the rest of the doc |
| 0002 role split + RLS | ⚠️ Overstated | owner-DSN fallback (`config.ts:304`), portal connects as **owner** not `helix_portal` (dead grants), `sessions` full DML, implicit NOBYPASSRLS, test early-returns — all CONFIRMED | "silently defeats split" overstates: live compose runs least-privilege DSNs; sessions-DML + NOBYPASSRLS already in ADR review notes. **New**: owner-DSN fallback + portal-as-owner | Boot-fail without role DSN; realise/clarify portal role; explicit NOBYPASSRLS |
| 0003 dep-minimal | ✅ Holds (partly re-states) | Unbounded SSE buffer + **LF-only/CRLF** parse bug, UTF-16 vs byte cap, no `statement_timeout`, no CI gate, `import * as oidc` — all CONFIRMED | no-CI-gate + oidc-wholesale already conceded by ADR; **new & damaging**: the 3 hand-rolled bugs | Fix SSE cap/CRLF, UTF-16 cap, add `statement_timeout`; add CI dep-allowlist |
| 0004 auth model | ⚠️ Overstated | scrypt N=2^14, throttle TOCTOU+N×, ≤60min group staleness, no admin-kill, handoff UPHELD — all CONFIRMED | all already in ADR review notes/ISSUE-08/11/15; "demo-only" already stated softly | Move staleness/TOCTOU into Consequences; add hard "no-prod-data" for password mode |
| 0005 SSRF/egress | ✅ Holds | blocklist-not-safelist (`authorization` leak), IPv6 gaps, SNI-refutation — CONFIRMED; **`http://` accepted on secret-injection path** — CONFIRMED & undocumented | http-cleartext is **new**; rest tracks ISSUE-01/09 | Reject `http://` when a connection secret is injected; safelist responses; fix IPv6 |
| 0006 custody seam | ✅ Holds (1 mild) | `open()` returns unzeroable `string`, no KEK rotation, `destroy()` diverges, prod `open()` is an unwired `nope()` stub (no timeout/retry) — CONFIRMED | "presented as equivalent to KV" is the one overstatement — ADR is *silent*, not asserting equivalence | Mark rotation deferred; state dev≠boundary; spec prod open() timeout/retry |
| **0007 portal authz** | ✅ **Holds — live BOLA** | `ownerId` exists, owner/admin check ships at `approvals.ts:42`; secrets routes (`secrets.ts` list/create/rotate/delete) do **no** ownership check — any authed user mutates any app's secrets — CONFIRMED | ADR concedes the gap (DEC-01) but the **BOLA is live now** | **Highest-value code fix.** `ownsApp` preHandler on secrets + app-mutating routes; M5 exit-criterion test. Mind nullable `ownerId` |
| **0008 LLM via egress** | ✅ **Holds — worse** | Fallback is **ungated** (zero `NODE_ENV` in server.ts), active whenever egress absent + key present; tests use `FakeLlmProvider`; `pnpm dev:egress` exists — CONFIRMED | challenge said "NODE_ENV-guarded"; reality = **no guard at all** | **Remove** `AnthropicProvider` from runtime selection (test-only). Breaks no tests |
| 0009 relaxed CSP | ✅ Holds (fix minor) | `object-src` absent, `connect-src` locked but `img-src`/nav open, anonymous shared-writes → 3rd-party stored content — CONFIRMED | the **third-party (not author) XSS** attacker is genuinely unaddressed; `object-src 'none'` already noted in ADR open-q & is marginal (inherits `default-src 'self'`) | Add `object-src 'none'`; flag relaxed-CSP risk on public/shared-write apps |
| 0010 anon shared-writes | ✅ Holds | single per-app `writesPerDay` summed over user.put+collection.append+shared.put → anon flood self-DoSes app's own writes; not approval-gated; RLS `userOid IS NULL` disjunct — all CONFIRMED | clean, no overreach | Separate/attribute the budget; approval-gate `public`+`sharedWrite` |
| **0011 in-memory throttle** | ✅ **Holds — premise false** | `maxReplicas=3` (edge inherits, no override), `loginThrottle.sweep()` never scheduled, TOCTOU live, `trustProxy` unset — CONFIRMED (NAT-collapse consequence is PARTIAL/infra-inferred) | premise-falsifying `maxReplicas=3` is the headline; sweep/TOCTOU already in ADR | **Before M5:** pin `maxReplicas=1` or land a shared atomic counter; schedule sweep; set `trustProxy` |
| 0012 edge/portal co-deploy | ❌ **Refuted** | NOT co-deployed today (separate Dockerfiles/entrypoints, no shared-pool process); `platform` HostClass kind is **actively used** (router catch-all) — challenge's two load-bearing claims are WRONG | only survivor: **no CI gate** enforcing the split (CONFIRMED) | Keep the "add a CI co-deploy gate" rec; drop the "DB-split-moot / platform-kind-unused / no-scaffolding" justification |
| 0013 egress trust | ✅ facts / ❌ fix | (a) fetch path IS app-scoped+grant-checked (`secrets.ts:67-81`) — ADR's "doesn't re-check grants" is a factual error; (b) llm name-only; (c) method/path unbound (origin IS bound); (d) appId forgeable under shared HS256 — all CONFIRMED | the grant-check **doesn't** close the residual (egress authorizes the *forgeable* appId) | **HKDF(master,appId) fix is FLAWED** — see below. Bind method+path (real). Asymmetric only shrinks *egress-side* forgeability |

## The ADR-0013 fix is unsound (independently confirmed)

The original row recommends *"adopt per-app-derived keys `HKDF(master, appId)` at step 1 — delivers
step-3 cross-app isolation at step-1 cost."* **It does not, on two independent grounds:**

1. **Both edge and egress must hold `master`** — the edge to mint for any app it serves, egress to
   verify any app's `kid=appId`. A compromised edge derives `HKDF(master, victimApp)` itself and forges
   cross-app instructions exactly as today. Per-app derivation from a shared master buys zero isolation
   against the edge-RCE threat the ADR names.
2. **Against a capture-and-relabel attacker (no key), it's redundant** — HS256 already authenticates the
   `appId` claim inside the signed body, so relabeling A→B already requires the key. Binding `appId` into
   the *key* duplicates binding it into the MAC'd *payload*.

Corollary: the grant-check at `secrets.ts:67-81` (the (a) correction) only constrains a *well-behaved*
edge — a forged instruction sets `appId=victim` and the grant join resolves the victim's secret
correctly, because from egress's view the request *is* the victim. So ADR-0013's conclusion ("a
compromised edge can use any credential") still stands, for a different reason than the ADR gives.

**What actually helps:** asymmetric signing (egress holds a verify-only public key) reduces forgeability
*against a compromised egress* — the higher-value target, since egress holds plaintext secrets. It does
**not** give cross-app isolation against a compromised *edge*: a single multi-tenant minter can always
forge any tenant — that goal is architecturally unattainable in this topology by any key scheme. Plus
**bind method+path** into the instruction (real, cheap, independent of the key strategy).

## Net — issues worth acting on (ranked)

1. **0007 secrets-route BOLA (live)** — any authenticated user can rotate/delete another app's secrets. Code fix + M5 exit test. *Already filed as #6-class? No — this is portal authz, distinct. File it.*
2. **0011 single-replica premise false** — `maxReplicas=3` ships the in-memory-throttle weakening into the pilot. Fix before M5.
3. **0008 ungated LLM fallback** — remove `AnthropicProvider` from runtime selection (no NODE_ENV guard exists today).
4. **0005 `http://` on the secret-injection path** — cleartext credential; reject it at egress. (Pairs with #7 echo-back, #8 body-cap already filed.)
5. **0003 hand-rolled bugs** — SSE unbounded buffer/CRLF, UTF-16 cap, no `statement_timeout`.
6. **0010 shared-budget self-DoS**, **0009 third-party stored-XSS**, **0006 no KEK rotation** — real, lower urgency.
7. **Doc-accuracy (0001/0002/0004/0013a):** ADRs state target-state in present tense; separate *decided* from *delivered*. (Cross-cutting meta-finding #1 — confirmed across the panel.)
8. **0012:** challenge refuted on its load-bearing claims; keep only the "add a CI co-deploy gate" recommendation.
