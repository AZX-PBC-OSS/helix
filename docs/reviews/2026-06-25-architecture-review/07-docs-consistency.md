# [MINOR] Documentation consistency

**Component:** `docs/platform-architecture.md`, `docs/design/secrets-and-connections.md`
**Status:** doc-only

A bundle of doc-accuracy fixes. None are design flaws — they're wording that overstates or understates
what the (correct) design actually does.

## 1. Stale §3 system-overview diagram

`docs/platform-architecture.md:38-59` shows `helix-edge` with a **direct arrow to "LLM vendors"**,
contradicting (a) the same doc's line 74 ("no route to the public internet except through egress"),
(b) line 188's prose, and (c) the egress-default code (`apps/edge/src/server.ts:136`). **Fix:** route
the LLM-vendor arrow through `helix-egress` in the diagram. (This is the real stale artifact behind the
original "stale LLM diagram" report — a minor doc fix, not a blocking one.)

## 2. State edge-compromise blast radius explicitly

§10 should say plainly: a compromised edge can mint instructions for any app/origin/connection within
existing grants — it can drain any app's budget and call any granted origin. The controls (no
secret-read, no registry-write, no direct internet, audit-only INSERT) **bound** the damage, they don't
prevent it. State this rather than implying the role split makes edge compromise harmless.

## 3. Qualify the "single gateway choke point" thesis

The architecture already concedes (line 151) that CSP raises but does not eliminate exfil
(navigation, `img-src https:`, granted channels). Make the §1 "single choke point" framing consistent
with that concession — "choke point for platform *capabilities*," not total containment. Note the
fetch-shim is ergonomics, not a boundary.

## 4. Dev KEK: prefer file over `_local_kek` row

`secrets-and-connections.md` §3 offers "gitignored file **or** a `_local_kek` row" for the dev KEK. The
DB-row option co-locates key and ciphertext in the same store, self-contradicting the doc's own
"different exposure profiles" argument. Prefer the file; if a row is ever used, label it explicitly
decorative. (The doc already concedes the dev envelope is "hygiene, not a boundary" — keep that framing.)

## 5. Add a prior-art / rejected-alternatives note

The design reinvents well-known patterns (oauth2-proxy/Pomerium for the OIDC edge, SPIFFE for S2S,
RFC 8693 token-exchange for the handoff, Macaroons) without citing them or why they were rejected. A
short prior-art section (portability, wildcard-callback constraints, dependency-minimal edge) would
preempt the "why not X" question.
