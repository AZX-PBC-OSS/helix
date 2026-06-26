# 0003. Dependency-minimal edge, hand-written SQL (no ORM)

**Status:** Accepted
**Related:** ADR [0001](0001-three-runtime-split.md)

## Context

The edge is the trusted path that faces untrusted app users. Every npm runtime dependency there is code that runs inside the blast radius of the most-exposed process; a supply-chain compromise of any of them is a platform compromise.

## Decision

Keep `apps/edge` dependency-minimal: each runtime dependency must be justified at review time. No ORM — hand-written, parameterized SQL. Hand-rolled undici (with signing) instead of vendor SDKs (Azure Blob, Anthropic). Never block the event loop; stream, never buffer.

## Consequences

- Small, auditable trusted-path dependency surface.
- More hand-written code (SQL, SSE parsing, Blob signing) to maintain and test.
- Discipline must be enforced in review; there is no automated gate today.

## Review notes (2026-06-25)

Dependency list judged minimal and justified; `openid-client` flagged as the heaviest trusted-path dependency (only JWKS fetch + ID-token verify are used) — candidate to trim to a JWKS-only verifier, not a defect. The hand-written-SQL choice is working: no injection found, `set_config` parameterized. One stylistic exception: `LISTEN ${REGISTRY_CHANNEL}` interpolates a constant identifier (safe, but breaks the no-interpolation rule).

## Challenge outcome (2026-06-26)

WEAKEN — the missing CI gate and `openid-client` heft are already noted above; the challenge adds three **concrete hand-rolled defects** the stated trade-off predicted (filed as **#12**): the LLM SSE parser has no per-event byte cap and is LF-only (a CRLF stream never frames → buffer grows unbounded; a trailing `\r` leaks into the `data:` payload); the app-data size cap counts UTF-16 code units not bytes (`JSON.stringify(value).length` — multibyte UTF-8 stores well over 64 KB); and no `statement_timeout` on any edge pool (also ISSUE-05). Lesson: hand-written code needs the same adversarial discipline as a new dependency. Consider a CI dependency-allowlist to make the rule mechanical.
