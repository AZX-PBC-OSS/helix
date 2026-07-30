# Instruction signature scope + key rotation

**Component:** `apps/edge/src/gateway/instruction.ts`, `apps/egress/src/instruction.ts`, `apps/egress/src/proxy.ts`
**Status:** facts verified against the code; restructured after a full recheck into two findings of different severity (see below)

The original issue grouped three gaps as one "Important." The recheck found they differ in severity and
that the security-relevant one was *understated*. Split into **A (Important, conditional)** and
**B (Minor, hygiene)**.

## A — [IMPORTANT, conditional] Instruction binds only the origin; method, path/query, and body ride unsigned

Egress re-checks only `target.origin === instruction.origin` (`proxy.ts:101`). The method comes from an
unsigned header (`proxy.ts:83`), the **full URL path and query** come from the unsigned `TARGET_HEADER`
and are never bound (only the origin is compared), and the body is `req.raw`, streamed unsigned
(`proxy.ts:144`). The instruction payload carries `origin` but no path/method/body
(`packages/shared/src/instruction.ts`).

The real exposure is the **path/query gap**, which the original wording understated by focusing on
method: an attacker positioned on the edge↔egress hop, holding one valid instruction for an authorized
origin (e.g. `https://api.vendor.com/v1/chat`), can redirect it — with the secret egress injects
server-side — to *any* endpoint on that origin (`DELETE /v1/admin/...` and other state-changing paths).
Method mutation (GET→DELETE) is the smaller piece.

**Scope it honestly:** the manifest authorizes fetch at **origin** granularity (`capabilities.fetch.origins`),
so the *app itself* may already call any path on an allowed origin by design — binding the path does
**not** tighten the app's own authority. What it defends against is an **on-path attacker tampering with
a request in flight**. That makes this gap **fully conditional on issue 03** (the cleartext hop is what
gives the attacker a position): fixing issue 03 (east-west TLS) removes the precondition and reduces this
to pure defense-in-depth; fixing issue 02 (replay) alone does **not** neutralize it. Binding the
authorized target into the signature is the correct belt-and-suspenders regardless.

Headers are a secondary concern: `safeRequestHeaders` (`proxy.ts:44`) forwards only a safelist and drops
`cookie`/`authorization`, and the credential is injected server-side — so header tampering is bounded.

**Fix:** bind the authorized target — at minimum method + path (or an explicit path prefix), ideally the
normalized URL — into `AttestedInstructionSchema` and assert strict equality in `proxy.ts` (not just
`origin`). Binding **method only**, as the original wrote, is insufficient — it leaves path/query
mutable. A body (SHA-256) digest claim is **impractical here**: egress streams `req.raw`, so hashing the
body would force buffering the whole request and defeat the streaming design — method + path binding is
the achievable fix; leave body integrity to the (conditional) transport in issue 03.

## B — [MINOR] Audience claim + key rotation (hygiene / forward-compat)

Two forward-compat gaps with no concrete exposure today:

1. **No `aud`.** `mintInstruction` sets no audience (`instruction.ts:40-42`); verify passes no `audience`
   option (`egress/instruction.ts:41-46`). The handoff token does both (`handoff.ts:40`). But the `typ`
   header (`helix-instruction+jwt`) and the distinct HKDF info string (`helix-instruction-v1`) already
   domain-separate the key, and no second service shares `HELIX_INSTRUCTION_SECRET` — so the "leaked
   instruction accepted anywhere" premise is overstated. Add `setAudience("helix-egress")` + an `audience`
   verify option as cheap insurance before any second consumer of the secret appears.

2. **No key rotation.** A single HS256 key is HKDF-derived on both sides (`instruction.ts:23-28`); no
   `kid` header, no multi-key acceptance — rotating requires a coordinated restart with a signature gap.
   Not a current exposure; it just makes rotation / compromise-recovery disruptive. Add a `kid` header +
   primary/previous key acceptance during a rotation window. This is also the natural seam to graduate to
   EdDSA (noted at `instruction.ts:15-17`) or mTLS / workload identity (issue 03).

---

### Recheck (2026-06-25)

Five independent reviews + a direct code trace. **Unanimous:** all three facts confirmed, but the
grouping was wrong — part 2 is the real Important item and was understated (the *path/query* gap, not just
method; the method-only fix is insufficient), while `aud` and key rotation are Minor hygiene/forward-compat.
Split applied above. Three corrections folded in: headers are safelisted (`proxy.ts:44`), so "headers
unsigned" is secondary; origin-granular authz means part A is in-flight-tampering defense-in-depth
(conditional on issue 03), not an app-privilege hole; and a body-digest claim is impractical for the
streaming proxy, so the fix is method + path binding.
