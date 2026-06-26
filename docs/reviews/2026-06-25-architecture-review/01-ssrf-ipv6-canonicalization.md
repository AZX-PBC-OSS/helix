# [BLOCKING] SSRF: IPv6 address forms bypass `isBlockedAddress`

**Component:** `apps/egress/src/ssrf.ts`
**Status:** verified by direct execution (see "Revalidation" below)

## Problem

`isBlockedAddress` (`apps/egress/src/ssrf.ts:55-71`) — the **sole network-layer SSRF defense** backing
the application-layer origin allowlist — returns `false` (treats as public) for several valid
representations of loopback/private addresses. It handles IPv4 only as a dotted quad, IPv6 only via
prefix string-matching, and IPv4-mapped only via a **dotted-quad-only** regex (line 65).

## Revalidation (empirical, against the real source on Node 26)

Direct invocation of the shipped `isBlockedAddress` / `resolveAndValidate`:

| Input | Means | `isBlockedAddress` | `resolveAndValidate` |
|---|---|---|---|
| `::ffff:7f00:1` | 127.0.0.1 (hex-mapped) | **`false`** ❌ | **pins it (not blocked)** |
| `::ffff:a00:1` | 10.0.0.1 (hex-mapped) | **`false`** ❌ | **pins it (not blocked)** |
| `::ffff:127.0.0.1` | 127.0.0.1 (dotted-mapped) | `true` ✅ | blocked |
| `::7f00:1` | ::127.0.0.1 (v4-compatible) | **`false`** ❌ | **pins it (not blocked)** |
| `fea0::1` | link-local `/10` | **`false`** ❌ | **pins it (not blocked)** |
| `fe80::1` | link-local `/16` | `true` ✅ | blocked |
| `::1` | loopback | `true` ✅ | blocked |

Two further empirical facts:

1. **The dotted-quad regex branch is effectively dead code for URL literals.** The WHATWG URL parser
   *normalizes the dotted form into hex*: `new URL("https://[::ffff:127.0.0.1]/").hostname` →
   `[::ffff:7f00:1]`. So the one mapped form the code catches (dotted) is the one that can never arrive
   from URL parsing; the form that *does* arrive (hex) is the one it misses.
2. **The mapped address really reaches v4 loopback.** Connecting to `[::ffff:7f00:1]` hits an
   IPv4-only `127.0.0.1` listener (HTTP 200), confirming the OS routes the mapped address to the
   embedded IPv4 — so the pin → connect step completes the SSRF.

## Reachability (corrected — this is narrower than first written)

The bug in the function is unconditional. **Reaching** it requires getting past the origin gate at
`proxy.ts:101` (`target.origin === instruction.origin`):

- **IP-literal path (low realism):** a request to `https://[::ffff:7f00:1]/` produces origin
  `https://[::ffff:7f00:1]`, which must match an *approved* origin in the manifest. An admin approving
  an IPv6-mapped-loopback literal as a proxied origin is implausible. **My earlier write-up
  overstated this** ("a request to `https://[::ffff:7f00:1]/` reaches loopback") — it's origin-gated.
- **DNS path (the real exploit):** an *approved hostname* origin (e.g. `https://api.partner.com`)
  passes the origin gate, then `resolveAndValidate` does `dnsLookup("api.partner.com")`. If that
  resolves — via attacker-controlled DNS, a compromised zone, or DNS rebinding — to a crafted `AAAA`
  whose serialized form dodges the checks (`::a.b.c.d` v4-compatible, `fea0::/10`, NAT64 `64:ff9b::/96`,
  or the `::ffff:` hex form), the range backstop is bypassed and egress pins to an internal target.
  This needs **no suspicious manifest**.

**Residual caveat to pin down during the fix:** for a *real* hostname resolution, whether `::ffff:`
addresses arrive in hex (bypass) or dotted (caught) depends on the platform's `getaddrinfo`/`inet_ntop`
normalization. The v4-compatible (`::a.b.c.d`) and link-local (`fea0::1`) misses are platform-independent.
Don't rely on resolver normalization to save the `::ffff:` case — fix the function.

## Confirmed NOT an issue

Octal/hex/**decimal** IPv4 literals (`2130706433`, `0177.0.0.1`, `0x7f000001`, `127.1`) raised in
review are **normalized to dotted `127.0.0.1` by the URL parser** before `URL.hostname` is read, and are
correctly blocked. Verified. (Add a regression test anyway.)

## Proposed handling

Replace the string/regex IPv6 handling with **numeric parsing**: expand the address to its 128-bit
value (or use a vetted parser), extract the embedded IPv4 whenever the upper bits match `::ffff:`/`::`
*regardless of notation*, and compare IPv6 against full CIDR masks — `fe80::/10`, `fc00::/7`,
`64:ff9b::/96`, `::1/128`, plus `fec0::/10` and `2001:db8::/32` for completeness. Add adversarial tests
for every row in the table above (`apps/egress/src/adversarial.test.ts`); per project plan §6 tests land
in lockstep.

## References

- OWASP SSRF Prevention Cheat Sheet — validate the *resolved IP* against the policy regardless of URL
  encoding; allowlist + IP-range denylist layering (Helix has both).
- Harden IMDS at the infra layer (IMDSv2 / Azure equivalent) as defense-in-depth — app-layer
  169.254.169.254 blocking alone isn't sufficient.
