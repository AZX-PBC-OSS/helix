import { z } from "zod";

import { SLUG_PATTERN } from "./app.js";
import { ProviderRefSchema } from "./providers.js";

/**
 * The consent-flow operation contracts (I-02 architecture ADR-0002 §Shared
 * ground) — the one definition for the internal edge→portal **consult** and
 * **cancel** operations. The edge's start route (T-0014), the dev gateway
 * (T-0016), the helper's cancellation (T-0017), and the callback (T-0020, via
 * the portal's claim probe) all build against these schemas; none restates a
 * field.
 *
 * The control plane owns all consent-flow state: the edge attests *who* is
 * asking (identity verified on its side, carried here as data), and the portal
 * decides — binding effectiveness, connection status — and writes the pending
 * attempt. `helix_edge` holds no grant on the flow table (ADR-0006 part 2), so
 * every write happens behind these operations.
 *
 * The wire deliberately carries **no `env` field**. The identity union's kind
 * pins the tier portal-side — a `user` consult is a `prod` consult, a `dev`
 * consult is a `dev` consult — so no caller can parameterize the environment
 * (spec criterion 22; T-0016's constraint). ADR-0002's "developerOid + env:
 * dev" is this union's dev kind: the tier marker is the kind itself.
 */

/** The consent attempt's lifetime (spec criterion 25): five minutes from consult. */
export const CONSENT_ATTEMPT_TTL_SECONDS = 300;

/**
 * The OAuth `state` parameter: 256 bits of entropy, base64url — 43 unreserved
 * characters. It is the attempt's lookup key on the callback and the cancel
 * (unique, single-use), and the one value binding a vendor redirect to a
 * pending attempt, so its entropy is the anti-forgery property (spec
 * criterion 28). The same bound shapes the PKCE verifier (RFC 7636 §4.1).
 */
export const ConsentStateSchema = z.string().min(43).max(128);
/** The dev journey's single-use handoff nonce — same entropy discipline as state. */
export const ConsentNonceSchema = z.string().min(16).max(128);

/**
 * Who the consult (or cancel) is for, as the edge attested it:
 *
 * - `user` — a signed-in Helix user on the app host; the prod tier. `userOid`
 *   is the session's verified principal oid (ADR-0048).
 * - `dev` — a dev-token caller through the dev gateway (T-0016); the dev
 *   tier. The attempt keys to the token's `developerOid` in the dev
 *   environment and carries the journey's single-use `nonce`, which the
 *   dev-gateway start route has already generated for the popup URL it will
 *   return. The nonce's entry/redemption route is T-0016's; the consult only
 *   writes it (unique — a replayed handoff URL cannot mint a second attempt).
 *
 * Anonymous visitors and shared-password pseudonyms are absent on purpose:
 * they can never establish a delegated connection (spec criterion 21), so
 * there is no identity shape that could carry one — the parse refuses them
 * upstream of any state decision.
 */
export const ConsentIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), userOid: z.string().min(1).max(128) }),
  z.strictObject({
    kind: z.literal("dev"),
    developerOid: z.string().min(1).max(128),
    nonce: ConsentNonceSchema,
  }),
]);
export type ConsentIdentity = z.infer<typeof ConsentIdentitySchema>;

/** http(s) URL without userinfo — the shape of both URL fields below. The
 * userinfo refusal is the provider-endpoint rule (client auth never rides a
 * URL), applied to the two consult-carried URLs for the same reason. */
function httpUrlNoUserinfo(): z.ZodType<string> {
  // Mirrors the ENDPOINT_USERINFO guard in providers.ts (see its parser-input
  // rationale); restated here rather than exported so that file's guard keeps
  // its own single reader.
  const userinfo = /^https?:\/\/[/\\]*[^/?#\\]*@/i;
  return z
    .url({ protocol: /^https?$/ })
    .refine(
      (value) => !userinfo.test(value.replace(/[\t\n\r]/g, "")),
      "URL must not carry userinfo",
    );
}

/**
 * `POST` body of the internal consult (ADR-0002 Decision — the edge sends the
 * verified caller identity, app, provider ref, opener origin, and callback
 * URL). Strict: an unknown key is a producer/consumer skew, and skew fails
 * closed (the ADR-0005 discipline).
 *
 * - `openerOrigin` — the origin of the page that opened the consent popup,
 *   verified same-origin by the edge's start guard (or the dev token's
 *   validated Origin). The completion message's **exact target origin**
 *   (spec criterion 28) is recorded from this value and derived by nothing
 *   else (ADR-0002 §Shared ground). Parsed to its canonical origin so the
 *   stored value compares equal to the postMessage target the completion page
 *   computes from it.
 * - `callbackUrl` — the edge-supplied OAuth callback URL, from the edge's own
 *   auth-host origin: the single source of that value (ADR-0001's ratified
 *   residual). The consult uses it verbatim as the authorize request's
 *   `redirect_uri` and never derives an alternative.
 */
export const ConsultRequestSchema = z.strictObject({
  identity: ConsentIdentitySchema,
  appSlug: z.string().regex(SLUG_PATTERN, "must be a lowercase DNS label (a-z, 0-9, hyphen)"),
  providerRef: ProviderRefSchema,
  openerOrigin: httpUrlNoUserinfo().transform((value) => new URL(value).origin),
  callbackUrl: httpUrlNoUserinfo(),
});
export type ConsultRequest = z.infer<typeof ConsultRequestSchema>;

/** The consult's terminal outcomes (ADR-0002 Decision) — the bounded set. */
export const CONSENT_CONSULT_OUTCOMES = ["started", "already_connected", "not_available"] as const;
export type ConsultOutcome = (typeof CONSENT_CONSULT_OUTCOMES)[number];

/**
 * The consult response: either a terminal outcome (no state written —
 * `signin_required` is detected edge-side before the consult is ever made) or
 * the pending attempt's assembled vendor authorize URL.
 *
 * `authorizeUrl` is complete: `response_type=code`, the provider's client id,
 * the edge-supplied callback URL, the fresh `state`, and the S256 PKCE
 * challenge. It carries only OAuth protocol parameters — the client secret
 * stays sealed on the provider row, and no token or bearer material ever
 * appears (spec criterion 22; the adversarial scan asserts this).
 */
export const ConsultResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("already_connected") }),
  z.strictObject({ outcome: z.literal("not_available") }),
  z.strictObject({ outcome: z.literal("started"), authorizeUrl: z.url() }),
]);
export type ConsultResponse = z.infer<typeof ConsultResponseSchema>;

/**
 * `POST` body of the internal cancel (ADR-0002 Decision — own-attempts-only;
 * the helper's acknowledged cancellation, T-0017): which attempt, and the
 * identity claiming ownership of it. The attempt is named by its `state` —
 * the same single-use key the callback redeems, so cancel and completion
 * arbitrate over one lookup key.
 */
export const CancelRequestSchema = z.strictObject({
  identity: ConsentIdentitySchema,
  state: ConsentStateSchema,
});
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

/**
 * The cancel response. `cancelled` — the caller owns the attempt, it was
 * still live, and it is now marked cancelled (a late completion cannot claim
 * it). `not_cancellable` — everything else, deliberately indistinguishable:
 * an unknown state, an expired or already-finished attempt, and an attempt
 * owned by someone else all answer the same way, so a caller holding another
 * user's state learns nothing by asking (the M3 indistinguishable-denial
 * posture; the refusal is still observable in the DB, which is what the
 * tests assert).
 */
export const CONSENT_CANCEL_OUTCOMES = ["cancelled", "not_cancellable"] as const;
export type CancelOutcome = (typeof CONSENT_CANCEL_OUTCOMES)[number];

export const CancelResponseSchema = z.strictObject({
  outcome: z.enum(CONSENT_CANCEL_OUTCOMES),
});
export type CancelResponse = z.infer<typeof CancelResponseSchema>;

/**
 * The auth-host path the dev journey's popup opens — the one-time nonce entry
 * page (design.md §Dev-tier consent journey). The edge builds the returned
 * popup URL from this constant and the portal serves the route at it, through
 * the `/connections/*` reverse proxy (T-0015): one definition, so the two
 * planes cannot drift (the `CONNECTIONS_CALLBACK_PATH` keep-in-sync
 * convention, `apps/portal/src/deployment.ts`).
 */
export const CONSENT_NONCE_ENTRY_PATH = "/connections/consent/start";

/**
 * The dev-tier start route's response (I-02 design decision 4 — the one-time
 * popup handoff): the dev app POSTs with its bearer token and receives either
 * a terminal outcome or a single-use popup URL.
 *
 * `popupUrl` is {@link CONSENT_NONCE_ENTRY_PATH} on the auth host with the
 * attempt's single-use `nonce` as the one query parameter — every component is
 * nonce/reference material, because the dev bearer token must never leave the
 * authenticated POST (spec criterion 22). The vendor authorize URL is
 * deliberately **not** carried: the consult's assembled URL answers the prod
 * start route, and the dev journey re-derives it at nonce redemption from the
 * portal's stored attempt data (ADR-0002 §Implementation Notes), keeping the
 * PKCE verifier server-side.
 */
export const DevConsentStartResponseSchema = z.discriminatedUnion("outcome", [
  z.strictObject({ outcome: z.literal("started"), popupUrl: z.url() }),
  z.strictObject({ outcome: z.literal("already_connected") }),
  z.strictObject({ outcome: z.literal("not_available") }),
]);
export type DevConsentStartResponse = z.infer<typeof DevConsentStartResponseSchema>;

/**
 * The app-facing outcome message every consent popup page posts to its opener
 * through `window.postMessage` before closing (I-02 design.md §Completion
 * message). Three parties build or consume this exact shape — the edge's
 * start-route terminal pages (T-0014), the documented helper's receiver
 * (T-0017), and the portal's completion pages (T-0020) — so it is defined once,
 * here, and parsed at every producer; a receiver that type-checks its
 * `message` events against this schema can trust nothing else about the event.
 *
 * It is a notification, never an authorization grant: completion messages
 * carry outcomes only — never credentials, dev bearer tokens, or token values
 * (spec criterion 22) — and a message alone can never read as successful
 * consent to the platform (criterion 28's verification is about who sent it,
 * enforced on the receiving side).
 */
export const HELIX_CONNECT_MESSAGE_SOURCE = "helix-connect";
/** The message contract's version — bumped only for a breaking shape change. */
export const CONNECT_MESSAGE_VERSION = 1;

/** The correlation tag an app may attach to a consent start (`?attempt=`). */
export const ConsentAttemptTagSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._~-]+$/, "must be URL-safe punctuation, letters, or digits");

/**
 * The message's outcome vocabulary — the helper's observable outcome set
 * (design.md §The connect helper). Platform pages post a subset of it; the
 * full set is the contract so a receiver's parsing never has to widen.
 */
export const CONSENT_MESSAGE_OUTCOMES = [
  "connected",
  "already_connected",
  "denied",
  "cancelled",
  "timeout",
  "blocked",
  "signin_required",
  "error",
] as const;

/**
 * Why an `error` outcome happened (design.md §The connect helper — `reason`
 * rides outcome `error` only). Bounded so an app can branch on it.
 */
export const CONSENT_MESSAGE_REASONS = [
  "conflict",
  "provider_unavailable",
  "provider_misconfigured",
  "provider_incompatible",
  "service_unavailable",
] as const;

/**
 * Strict: an unknown key is a producer skew and the message is a notification —
 * a receiver dropping an unexpected shape is the fail-closed posture (the
 * ADR-0005 discipline). `attempt` is the app-supplied correlation tag, present
 * only when the start URL carried one; receivers verify it matches when
 * supplied (criterion 28). `reason` is `null` unless the outcome is `error`
 * (design.md §The connect helper: "`reason` — outcome `error` only").
 */
export const ConnectOutcomeMessageSchema = z
  .strictObject({
    source: z.literal(HELIX_CONNECT_MESSAGE_SOURCE),
    version: z.literal(CONNECT_MESSAGE_VERSION),
    attempt: ConsentAttemptTagSchema.optional(),
    provider: ProviderRefSchema,
    outcome: z.enum(CONSENT_MESSAGE_OUTCOMES),
    reason: z.enum(CONSENT_MESSAGE_REASONS).nullable(),
  })
  .refine((message) => message.outcome === "error" || message.reason === null, {
    error: "reason is only carried with the error outcome",
  });
export type ConnectOutcomeMessage = z.infer<typeof ConnectOutcomeMessageSchema>;
