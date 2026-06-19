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

/** True if the resolved address is one we must never connect to. */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) return V4_BLOCKED.some(([base, bits]) => inV4Cidr(v4, base, bits));

  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) return isBlockedAddress(mapped[1]!);
    return false;
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
