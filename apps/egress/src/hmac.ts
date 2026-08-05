import { createHmac } from "node:crypto";

/**
 * The `hmac-timestamp` injection recipe's crypto, kept out of the proxy handler so
 * it is unit-testable without Fastify, sockets, or a resolver.
 *
 * `node:crypto` is a builtin (egress already uses it for the instruction HKDF), so
 * this adds no dependency. The dependency-minimal rule is scoped to `apps/edge` —
 * the trusted path (ADR-0003); egress is the mechanism plane.
 */

/** Substituted in an `hmac-timestamp` template. */
const CREDENTIAL = "{credential}";
const SIGNATURE = "{signature}";

/**
 * Substitute every occurrence, without `String.replace`'s replacement-pattern
 * semantics: `replace` treats `$&`, `` $` ``, `$'` and `$1` in the *replacement*
 * as substitution patterns and only replaces the first match. A credential
 * containing `$&` would be silently mangled into an authentication failure with
 * no diagnosable cause.
 *
 * Exported because the proxy's `header`-recipe injection needs the identical
 * guarantee for its `{}` placeholder — one implementation, not two.
 */
export function substitute(input: string, placeholder: string, value: string): string {
  return input.split(placeholder).join(value);
}

/**
 * `hex(HMAC-SHA256(key, timestamp))`.
 *
 * The signed input is the timestamp string **alone** — no method, path, query, or
 * body. That is the whole scheme, and it is why this function takes no request:
 * the type makes the property structural rather than a comment. SHA-256 and
 * lowercase hex are fixed by the recipe kind, not configurable, and are pinned by
 * a hardcoded vector in the tests.
 *
 * The key is used as its UTF-8 bytes; it is deliberately *not* base64/hex-decoded
 * first. Some vendors of this scheme family decode; ours does not. If a future
 * one does, that is a new field or a sibling kind — and this note plus the test
 * vector is what makes the difference diagnosable in minutes.
 */
export function signTimestamp(key: string, timestamp: string): string {
  return createHmac("sha256", key).update(timestamp).digest("hex");
}

/**
 * The timestamp that is both sent and signed: ISO-8601 with milliseconds.
 *
 * `now` is a parameter so tests can pin it without global fake timers (the same
 * seam as `KeyVaultSecretStoreOptions.now`). Callers must take **one** reading and
 * pass the same string to {@link signTimestamp} and to the outbound header — two
 * reads would sign a timestamp that was never transmitted.
 */
export function hmacTimestampNow(now: Date = new Date()): string {
  return now.toISOString();
}

/**
 * Render an `hmac-timestamp` template into a header value. Unknown placeholders
 * are left verbatim rather than blanked, so a typo surfaces as a visible literal
 * in the upstream's rejection instead of a silently truncated credential.
 */
export function renderHmacAuth(template: string, credential: string, signature: string): string {
  return substitute(substitute(template, CREDENTIAL, credential), SIGNATURE, signature);
}
