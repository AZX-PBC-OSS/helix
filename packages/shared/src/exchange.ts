import { z } from "zod";

import { HttpUrlNoUserinfoSchema } from "./consent.js";
import { EnvSchema } from "./env.js";
import { ScopeTokenSchema } from "./providers.js";

/**
 * The portal→egress **code-exchange** operation — the one definition shared by
 * the portal's callback caller, the egress handler, and every test.
 *
 * The exchange happens in egress because that is where the vendor is reachable
 * and where custody of delegated material lives: egress runs the OAuth code
 * exchange against the provider's configured token endpoint, applies the
 * compatibility gate **at receipt, before sealing**, seals both
 * token materials into the delegated store, and returns metadata plus sealed
 * references. The portal never handles plaintext delegated tokens (ADR-0006).
 *
 * Failures are **fixed strings by construction**: the schema carries no field
 * a vendor error body could flow into. Token-endpoint failures are the single
 * `exchange_failed` outcome word — no vendor status, body, or error text
 * survives the boundary (the fixed-string discipline). The compatibility-gate
 * rejections carry a bounded reason (below) because each is rendered
 * differently; those words are platform vocabulary, never vendor content.
 */

/**
 * The OAuth grant code (RFC 6749 §4.1.2): vendor-opaque, single-use. Bounded
 * as a sanity rail on wire input, not a security limit — it is worthless
 * without its PKCE verifier and client registration.
 */
export const ExchangeCodeSchema = z.string().min(1).max(1024);

/**
 * The PKCE code verifier (RFC 7636 §4.1): 43–128 characters of the unreserved
 * set. The charset is the RFC's own — the verifier rides the token request's
 * form body, and the bound is what keeps a malformed one a clean 400 instead
 * of a vendor round-trip that can only fail.
 */
export const CodeVerifierSchema = z
  .string()
  .min(43)
  .max(128)
  .regex(/^[A-Za-z0-9\-._~]+$/, "must be an RFC 7636 code_verifier (43-128 unreserved characters)");

/**
 * `POST /exchange` body (the internal egress route). Every field is exactly
 * what the portal's pending-attempt row holds
 * (the provider stamp, the PKCE verifier, the consult's callback URL)
 * plus the grant code the vendor just redirected in — the portal's callback
 * caller supplies the row's
 * values verbatim and never derives an alternative. Strict: an unknown key is a
 * producer/consumer skew and fails closed (the strict-parse discipline).
 */
export const ExchangeRequestSchema = z.strictObject({
  providerId: z.uuid(),
  providerRevision: z.int().positive(),
  env: EnvSchema,
  code: ExchangeCodeSchema,
  codeVerifier: CodeVerifierSchema,
  redirectUri: HttpUrlNoUserinfoSchema,
});
export type ExchangeRequest = z.infer<typeof ExchangeRequestSchema>;

/**
 * Why the compatibility gate rejected the token response at receipt — the
 * bounded, vendor-content-free reasons. An omitted
 * granted-permissions field means granted and never appears here; these are
 * the explicitly-wrong shapes only.
 */
export const EXCHANGE_REJECTION_REASONS = [
  "unusable_lifetime",
  "missing_refresh_token",
  "missing_permissions",
] as const;
export const ExchangeRejectionReasonSchema = z.enum(EXCHANGE_REJECTION_REASONS);
export type ExchangeRejectionReason = (typeof EXCHANGE_REJECTION_REASONS)[number];

/**
 * The granted-scope metadata an exchanged response carries — the same bound
 * and token vocabulary the stored row's `grantedScopes` uses (RFC 6749 §3.3
 * scope tokens; duplicates tolerated as vendor behavior to display).
 */
const MAX_EXCHANGED_SCOPES = 64;
const ExchangedScopesSchema = z.array(ScopeTokenSchema).max(MAX_EXCHANGED_SCOPES);

/**
 * The exchange response's outcome union — the whole post-authorization body
 * vocabulary of `POST /exchange`. Transport-level refusals do NOT appear here:
 * an unverified caller gets 401, a malformed body 400, and an unconfigured
 * custody a fixed 503 — all with fixed bodies of their own, none of which a
 * caller parses through this schema.
 *
 * - `exchanged` — the gate passed and both materials are sealed. `access`
 *   and `refresh` carry the sealed references (`SecretStore.seal()` output —
 *   a dev envelope or a Key Vault reference, never plaintext); `grantedScopes`
 *   is what the vendor granted (the response's scope, or the provider's
 *   configured set when the response omitted it — omitted means granted);
 *   `accessExpiresAt` is the access token's absolute expiry.
 * - `rejected` — the compatibility gate failed at receipt with a
 *   distinguishable {@link EXCHANGE_REJECTION_REASONS} reason. **Nothing was
 *   sealed** (the store receives no write — this is observable, and the
 *   binding invariant of the gate's placement).
 * - `provider_unavailable` — the provider id is unknown, was deleted, or the
 *   attempt's revision stamp no longer matches the cached row.
 *   The same fixed word the delegated-call path answers — the delegated-call
 *   error table's word for the same situation.
 */
export const ExchangeResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    outcome: z.literal("exchanged"),
    access: z.string().min(1),
    refresh: z.string().min(1),
    grantedScopes: ExchangedScopesSchema,
    accessExpiresAt: z.iso.datetime(),
  }),
  z.strictObject({ outcome: z.literal("rejected"), reason: ExchangeRejectionReasonSchema }),
  z.strictObject({ outcome: z.literal("provider_unavailable") }),
  z.strictObject({ outcome: z.literal("exchange_failed") }),
]);
export type ExchangeResponse = z.infer<typeof ExchangeResponseSchema>;
