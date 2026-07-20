import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF hardening (fetch-proxy design §6). An outbound proxy driven by untrusted
 * apps is an SSRF engine if built naively — the Capital One IMDS vector. The
 * controls here are the network-layer belt to the edge's application-layer
 * suspenders: resolve the host ourselves, refuse private/link-local/metadata
 * targets, and pin the connection to the validated address so a DNS rebind
 * between check and connect can't slip through.
 *
 * `allowPrivate` is a deliberate **test/dev** seam: integration tests point the
 * proxy at a loopback upstream, and dev may too. It is false in prod and in the
 * adversarial suite, where 127.0.0.1 / 169.254.169.254 must be refused.
 */

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`egress refused target: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

/** Parse an IPv4 dotted quad to its 32-bit integer, or null if not IPv4. */
function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return null;
  return ((o[0]! << 24) | (o[1]! << 16) | (o[2]! << 8) | o[3]!) >>> 0;
}

function inV4Cidr(ipInt: number, base: string, bits: number): boolean {
  const baseInt = ipv4ToInt(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** IPv4 ranges that must never be reachable through the proxy. */
const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8], // "this host"
  ["10.0.0.0", 8], // RFC 1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — includes 169.254.169.254 (IMDS)
  ["172.16.0.0", 12], // RFC 1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC 1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

/** True if a 32-bit IPv4 integer falls in any blocked v4 range. */
function isBlockedV4Int(ipInt: number): boolean {
  return V4_BLOCKED.some(([base, bits]) => inV4Cidr(ipInt, base, bits));
}

const MAX128 = (1n << 128n) - 1n;

/**
 * Expand a format-valid IPv6 literal to its 128-bit value. Precondition: the
 * caller has already checked `isIP(ip) === 6`, so we only expand — we do not
 * re-validate. `isIP` accepts a `%zone` suffix (only ever on non-global scopes,
 * which the blocklist catches regardless), so strip it before parsing.
 *
 * A textual embedded-IPv4 tail (`::a.b.c.d`, `::ffff:a.b.c.d`) is folded into two
 * hex groups via the existing {@link ipv4ToInt}, keeping all v4 parsing in one
 * place. Hex forms (`::ffff:7f00:1`) need no special handling — the WHATWG URL
 * parser normalizes dotted-mapped literals to hex anyway, so hex is the form that
 * actually arrives.
 */
function ipv6ToBigInt(ip: string): bigint {
  const bare = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip;

  // Fold a trailing dotted-quad (the last colon-group containing a ".") into hex.
  const lastColon = bare.lastIndexOf(":");
  const tail = bare.slice(lastColon + 1);
  let text = bare;
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 !== null) {
      const hi = (v4 >>> 16).toString(16);
      const lo = (v4 & 0xffff).toString(16);
      text = `${bare.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
  }

  let groups: string[];
  if (text.includes("::")) {
    const [head, rest] = text.split("::");
    const headParts = head ? head.split(":") : [];
    const tailParts = rest ? rest.split(":") : [];
    const fill = 8 - headParts.length - tailParts.length;
    groups = [...headParts, ...Array<string>(fill).fill("0"), ...tailParts];
  } else {
    groups = text.split(":");
  }

  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g || "0", 16)), 0n);
}

function inV6Cidr(val: bigint, base: bigint, bits: number): boolean {
  const mask = bits === 0 ? 0n : (~0n << BigInt(128 - bits)) & MAX128;
  return (val & mask) === (base & mask);
}

/**
 * IPv6 ranges (IANA IPv6 Special-Purpose Registry) that must never be reachable.
 * Embedded-IPv4 forms (`::ffff:/96` mapped, `64:ff9b::/96` NAT64, `::/96` compat)
 * are handled by extraction in {@link isBlockedAddress}, not here, so a *public*
 * embedded target stays allowed while an internal one is blocked.
 */
const V6_BLOCKED: [string, number][] = [
  ["::1", 128], // loopback (also caught by ::/96 extraction — kept for clarity)
  ["::", 128], // unspecified (ditto)
  ["fe80::", 10], // link-local — fixes the old `fe80`-prefix miss (e.g. fea0::1)
  ["fec0::", 10], // site-local (deprecated, RFC 3879)
  ["fc00::", 7], // unique-local (ULA)
  ["64:ff9b:1::", 48], // NAT64 local-use (RFC 8215) — block wholesale
  ["100::", 64], // discard-only (RFC 6666)
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (deprecated, RFC 7526)
  ["2001::", 23], // Teredo / ORCHIDv2 / benchmarking (defense-in-depth)
  ["ff00::", 8], // multicast (parity with v4 224.0.0.0/4)
];

// Parse the blocklist bases to their numeric values once, at module load.
const V6_BLOCKED_NUM: [bigint, number][] = V6_BLOCKED.map(([base, bits]) => [
  ipv6ToBigInt(base),
  bits,
]);

const V6_MAPPED = ipv6ToBigInt("::ffff:0:0"); // ::ffff:0:0/96
const V6_NAT64 = ipv6ToBigInt("64:ff9b::"); // 64:ff9b::/96

/** True if the resolved address is one we must never connect to. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return isBlockedV4Int(v4);

  if (isIP(ip) === 6) {
    const val = ipv6ToBigInt(ip);
    // Extract the embedded IPv4 and re-check it, regardless of hex/dotted notation.
    if (inV6Cidr(val, V6_MAPPED, 96)) return isBlockedV4Int(Number(val & 0xffffffffn)); // ::ffff:a.b.c.d
    if (inV6Cidr(val, V6_NAT64, 96)) return isBlockedV4Int(Number(val & 0xffffffffn)); // 64:ff9b::a.b.c.d
    if (val >> 32n === 0n) return isBlockedV4Int(Number(val)); // ::a.b.c.d compat (covers ::, ::1)
    return V6_BLOCKED_NUM.some(([base, bits]) => inV6Cidr(val, base, bits));
  }
  // Not a recognizable IP literal — refuse rather than guess.
  return true;
}

export interface ValidatedTarget {
  /** The pinned address to connect to (defeats rebind). */
  address: string;
  family: 4 | 6;
}

/**
 * Resolve a hostname and validate **every** returned address, returning the one
 * we will pin the connection to. An IP literal is validated directly. Throws
 * {@link SsrfBlockedError} if anything resolves into a blocked range — refusing
 * the whole host if any address is blocked, so a dual-A-record trick can't pick
 * the public one for the check and the private one for the connect.
 */
export async function resolveAndValidate(
  hostname: string,
  allowPrivate: boolean,
): Promise<ValidatedTarget> {
  // URL.hostname keeps IPv6 brackets ("[::1]"); strip them for isIP/lookup.
  const host =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const literal = isIP(host);
  if (literal) {
    if (!allowPrivate && isBlockedAddress(host)) {
      throw new SsrfBlockedError(`${host} is a blocked address`);
    }
    return { address: host, family: literal === 6 ? 6 : 4 };
  }

  const addrs = await dnsLookup(host, { all: true });
  if (addrs.length === 0) throw new SsrfBlockedError(`${host} did not resolve`);
  if (!allowPrivate) {
    for (const a of addrs) {
      if (isBlockedAddress(a.address)) {
        throw new SsrfBlockedError(`${hostname} resolves to blocked ${a.address}`);
      }
    }
  }
  const chosen = addrs[0]!;
  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}
