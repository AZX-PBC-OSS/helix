/**
 * Cookie handling, hand-rolled: exactly two cookies exist in the platform
 * (the app-host session and the auth-host OIDC flow state), so a parser +
 * two serializers is less trusted-path surface than @fastify/cookie
 * (dep-minimal rule, project plan §6).
 *
 * Both names carry the `__Host-` prefix (architecture §4.2): browsers refuse
 * to store them with a `Domain` attribute, which is the cookie-tossing
 * defense — a malicious sibling app cannot shadow them.
 */

export const SESSION_COOKIE = "__Host-session";
export const FLOW_COOKIE = "__Host-oidc-flow";

/** Cookie-value charset we ever emit: base64url / JWS compact. */
const VALUE_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * Parse a Cookie header into a name → value map. A name sent twice with
 * different values is dropped entirely — an ambiguous credential is treated
 * as absent rather than letting attacker-ordered duplicates win.
 */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  const ambiguous = new Set<string>();

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    if (!name) continue;
    const existing = out.get(name);
    if (existing !== undefined && existing !== value) {
      ambiguous.add(name);
    }
    out.set(name, value);
  }

  for (const name of ambiguous) out.delete(name);
  return out;
}

function assertValue(value: string): void {
  if (!VALUE_PATTERN.test(value)) {
    throw new Error("cookie value contains characters outside the emitted charset");
  }
}

/**
 * `__Host-` requirements are non-negotiable: Secure, Path=/, no Domain.
 * HttpOnly keeps app JS away from it; Lax still sends it on top-level
 * navigations (the redirect back from auth).
 */
export function serializeSessionCookie(value: string, maxAgeSec: number): string {
  assertValue(value);
  return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSec)}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** Flow cookie lives only for the IdP round-trip on the auth host. */
export function serializeFlowCookie(value: string, maxAgeSec: number): string {
  assertValue(value);
  return `${FLOW_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeSec)}`;
}

export function clearFlowCookie(): string {
  return `${FLOW_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
