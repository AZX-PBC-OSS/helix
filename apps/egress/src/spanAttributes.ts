import type { Attributes } from "@opentelemetry/api";
import {
  ATTR_APP_ID,
  ATTR_CAPABILITY,
  ATTR_CLIENT_DISCONNECTED,
  ATTR_CONNECTION,
  ATTR_CREDENTIAL_SOURCE,
  ATTR_ENV,
  ATTR_METHOD,
  ATTR_OUTCOME,
  ATTR_PROVIDERS,
  ATTR_TARGET_ORIGIN,
  ATTR_TARGET_PATH,
  ATTR_UPSTREAM_STATUS,
  capTargetPath,
} from "@azx-pbc/shared/telemetry";

/**
 * Allowed egress span attributes (ADR-0037 decision 6). New attributes require
 * review because this process handles plaintext credentials.
 *
 * Never record header names, header values, response-body content, or exception
 * text. Custom injection recipes configure header names, and upstream bodies
 * or errors can echo credentials.
 *
 * Allowed values come from signed instruction claims, status codes, or bounded
 * resolution outcomes. helix.credential_source is secret or managed-identity;
 * helix.connection is the configured connection name, never secret material.
 */
export const EGRESS_SPAN_ATTRS = [
  ATTR_APP_ID,
  ATTR_ENV,
  ATTR_CAPABILITY,
  ATTR_TARGET_ORIGIN,
  ATTR_TARGET_PATH,
  ATTR_METHOD,
  ATTR_OUTCOME,
  ATTR_UPSTREAM_STATUS,
  ATTR_CONNECTION,
  ATTR_CREDENTIAL_SOURCE,
  ATTR_CLIENT_DISCONNECTED,
  ATTR_PROVIDERS,
] as const;

export type EgressSpanAttr = (typeof EGRESS_SPAN_ATTRS)[number];

const ALLOWED: ReadonlySet<string> = new Set(EGRESS_SPAN_ATTRS);

/**
 * Build an egress span's attributes, dropping anything not on the allowlist.
 *
 * **The only writer.** A call site that sets an attribute directly on the span
 * bypasses this, which is why the adversarial suite asserts the recorded keys
 * are a subset of {@link EGRESS_SPAN_ATTRS} rather than trusting this function
 * to be the only path. Undefined values are dropped rather than recorded as
 * `undefined`, so an absent connection reads as absent.
 */
export function egressSpanAttributes(
  values: Partial<Record<EgressSpanAttr, string | number | boolean | undefined>>,
): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!ALLOWED.has(key)) continue;
    // The one value with a length bound, applied here so the allowlist is also
    // where the cap lives. `instruction.path` arrives from a signed claim whose
    // schema is `z.string().optional()` — no length limit — while the edge caps
    // the same value for its ledger column and for its own span. One value
    // recorded at two lengths is what the edge's comment exists to prevent.
    out[key] = key === ATTR_TARGET_PATH && typeof value === "string" ? capTargetPath(value) : value;
  }
  return out;
}
