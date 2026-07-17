import { SLUG_PATTERN } from "@azx-pbc/shared";

/**
 * Host classification — the two-router discipline (architecture §3, decision
 * 12): every request is app-subdomain traffic, auth-service traffic, or other
 * platform traffic, keyed strictly by hostname; control-plane handlers are
 * never mounted on app hosts. `auth.<base>` is the central OIDC callback host
 * (architecture §4.2, Appendix A) — its routes answer nowhere else.
 */
export type HostClass = { kind: "app"; slug: string } | { kind: "auth" } | { kind: "platform" };

/**
 * Subdomain labels that can never be apps — reserved for platform services
 * (architecture §4.2, Appendix A). Note: the portal does not yet reject these
 * at app creation; until it does, a colliding app simply never gets traffic.
 */
export const RESERVED_SUBDOMAINS = new Set(["auth", "portal", "api", "www"]);

/** Classify a raw Host header against the configured apps base domain. */
export function classifyHost(hostHeader: string | undefined, baseDomain: string): HostClass {
  if (!hostHeader || hostHeader.includes("[")) {
    return { kind: "platform" }; // absent or IPv6 literal — never an app host
  }

  const colon = hostHeader.indexOf(":");
  const host = (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase();

  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) {
    return { kind: "platform" };
  }

  const label = host.slice(0, -suffix.length);
  if (label === "auth") {
    return { kind: "auth" };
  }
  // Exactly one label (no dots), shaped like a valid app slug, not reserved.
  if (label.includes(".") || !SLUG_PATTERN.test(label) || RESERVED_SUBDOMAINS.has(label)) {
    return { kind: "platform" };
  }

  return { kind: "app", slug: label };
}
