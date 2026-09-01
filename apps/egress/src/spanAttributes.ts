import type { Attributes } from "@opentelemetry/api";
import {
  ATTR_APP_ID,
  ATTR_CAPABILITY,
  ATTR_CLIENT_DISCONNECTED,
  ATTR_CONNECTION,
  ATTR_ENV,
  ATTR_METHOD,
  ATTR_OUTCOME,
  ATTR_TARGET_ORIGIN,
  ATTR_TARGET_PATH,
  ATTR_UPSTREAM_STATUS,
  capTargetPath,
} from "@azx-pbc/shared/telemetry";

/**
 * The complete set of attributes an egress span may carry (ADR-0037 decision 6).
 *
 * **An allowlist, not a blocklist, and that asymmetry is the decision.** This is
 * the one process holding plaintext connection secrets, and its own error
 * handler already returns a fixed opaque body specifically because a thrown
 * message can embed a fragment of credential material
 * (`apps/egress/src/app.ts`). A blocklist would mean every new attribute is
 * permitted until someone notices; an allowlist means every new attribute is a
 * review.
 *
 * **No header name and no header value, ever.** The injected credential *is* a
 * header — that is the whole mechanism of this service — so there is no version
 * of "just the header names" that is safe: the `header` recipe's name and
 * `hmac-timestamp`'s timestamp and signature header names are per-connection
 * configuration, and naming them narrows the search for the value. Nothing
 * derived from a response body either: an upstream that echoes its own
 * credential is an accepted transparent-proxy residual on the *body*, and must
 * not become a residual on a retained span too.
 *
 * Everything here is either edge-signed (the instruction's own claims, which
 * the edge validated against the manifest allowlist before signing) or a status
 * code. `helix.connection` is the connection's **name** — the operator-chosen
 * label under which a secret is stored, never its material — and it already
 * appears in the clear on this file's error logs.
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
  ATTR_CLIENT_DISCONNECTED,
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
