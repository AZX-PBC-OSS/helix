# Architecture review — egress attestation & SSRF (2026-06-25)

A pass over the three-plane trust split and its secret/egress/proxy mechanisms, looking for places
where the implementation is thinner than the design claims.

**The architecture itself holds up.** The three-plane split is the right cut: edge and portal can
co-locate (the portal never faces untrusted traffic), while egress earns its own container because it
has a genuinely different posture — its own network zone plus plaintext-secret custody. The
load-bearing invariant ("a secret only ever reaches plaintext inside egress") is enforced by
architecture — separate process, separate network zone, separate Postgres role — not by discipline.
This lines up with established practice: credential-proxy / secure-egress, BFF/token-handler, Key Vault
+ managed identity, OWASP SSRF.

**The gaps are implementation-level**, concentrated in the **edge→egress attestation mechanism** and
**SSRF IPv6 canonicalization** — all fixable without moving a trust boundary. Every finding below was
checked against the code (and issue 01 against running code).

The thread running through 02–04: service-to-service auth is HS256 over a shared HKDF secret, where the
usual answer is mTLS / workload identity. That's acceptable for a single internal hop today, but only
once replay, audience, rotation, and transport TLS are handled — and we should move to workload identity
before there's a second producer of instruction-bearing calls or a second region.

## Issues

| # | Severity | Title |
|---|---|---|
| [01](./01-ssrf-ipv6-canonicalization.md) | **Blocking** | SSRF: IPv6 address forms bypass `isBlockedAddress` |
| [02](./02-instruction-replay.md) | Important | Attested instruction has no replay protection |
| [03](./03-edge-egress-transport-tls.md) | Important* | Edge↔egress hop is plain HTTP (no TLS in the seam) — *conditional; → Minor once M5 infra provides east-west encryption |
| [04](./04-instruction-hardening.md) | Important*+Minor | Instruction signature scope + key rotation — split: A) bind method/path/query (*conditional on #03); B) aud + kid rotation (hygiene) |
| [05](./05-fail-closed-startup-guards.md) | Minor | `allowPrivate` + deprecated edge LLM key need prod fail-closed guards |
| [06](./06-connection-binding-integrity.md) | Important | Connection binding has no deploy-time referential integrity |
| [07](./07-docs-consistency.md) | Minor | Doc consistency: stale §3 diagram, blast-radius statement, thesis wording |

## Validated — leave as-is

- The three-plane split, and rejecting portal-as-secret-custodian (it would put plaintext in the
  highest-iterate code path).
- "App never holds the key" = BFF/token-handler, diverging correctly (Helix contains an *untrusted* SPA
  rather than protecting a trusted one).
- The "env-var KEK is decorative" argument; Key Vault + managed identity is the right prod answer.
- IP pinning is properly wired (`proxy.ts:135-145`: per-request `Agent`, connect-to-pinned-IP, SNI, no
  shared pool).
