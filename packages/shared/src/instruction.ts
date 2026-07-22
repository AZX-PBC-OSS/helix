import { z } from "zod";

import { EnvSchema } from "./env.js";

/**
 * The attested instruction (architecture §3, §6.2; secrets design §4) — the
 * signed boundary between the policy plane (`azx-edge`) and the mechanism plane
 * (`azx-egress`).
 *
 * The edge resolves identity/authz/quota for a `/_api/fetch` call, then mints a
 * short-lived JWT carrying this payload and hands it to egress. Egress *trusts*
 * the signature and never re-authenticates the end user — so a compromised
 * egress can read only what the edge attested, and a compromised edge can only
 * ask egress to make calls it already authorized. Signed with the same
 * `jose` / HKDF primitives as the OIDC handoff token (`apps/edge/src/auth`),
 * domain-separated by a distinct HKDF info string and JWT `typ`.
 *
 * Registered claims handled by the signer/verifier (not this payload schema):
 * `exp`/`iat` (freshness), `aud` = {@link INSTRUCTION_AUDIENCE} (forbids token
 * passthrough to any other verifier), and `jti` = the per-call `requestId` —
 * burned one-time at egress so a captured instruction can't be replayed within
 * its TTL (ADR-0013 Step 1, issue #3).
 */

/**
 * Capabilities that flow through egress. Grows as the mechanism plane does.
 * `llm` routes the LLM vendor call: the edge keeps all the policy (model
 * allowlist, USD budget, metering) but the vendor key is a `platform`-scoped
 * secret egress injects, so the edge never holds it (secrets design §1).
 */
export const INSTRUCTION_CAPABILITIES = ["fetch", "llm"] as const;
export const InstructionCapabilitySchema = z.enum(INSTRUCTION_CAPABILITIES);
export type InstructionCapability = z.infer<typeof InstructionCapabilitySchema>;

export const AttestedInstructionSchema = z.object({
  /** App the call is attributed to (registry app id). */
  appId: z.string().min(1),
  /** Authenticated user, or the anonymous sentinel on `public` apps. */
  userOid: z.string().min(1),
  capability: InstructionCapabilitySchema,
  /** The allowlisted origin the edge authorized (scheme + host + port). */
  origin: z.url(),
  /** Connection (secret) name to inject, if this is a secret-backed call. */
  connection: z.string().min(1).optional(),
  /** Correlates the edge audit row with the egress call. */
  requestId: z.string().min(1),
  /**
   * Environment tier this call is scoped to (dev-mode design §6). Egress resolves
   * the connection secret within this tier — a `dev` instruction can never reach a
   * `prod` connection secret and vice-versa. Carried by the attested (signed)
   * claim, never an app/request parameter; defaults `prod` so any instruction
   * minted before this field existed verifies as production.
   */
  env: EnvSchema.default("prod"),
});
export type AttestedInstruction = z.infer<typeof AttestedInstructionSchema>;

/** JWT `typ` header — keeps instructions unredeemable as handoff/flow tokens. */
export const INSTRUCTION_JWT_TYP = "helix-instruction+jwt";
/** HKDF info string for the instruction signing key (domain separation). */
export const INSTRUCTION_KEY_INFO = "helix-instruction-v1";
/** Short TTL: an instruction is minted per call and consumed immediately. */
export const INSTRUCTION_TTL_SECONDS = 30;
/**
 * JWT `aud` — the egress trust domain. The edge stamps it on mint and egress
 * asserts it on verify, so an instruction can only be redeemed at egress and
 * nowhere else (no token passthrough; ADR-0013 Step 1, issue #3).
 */
export const INSTRUCTION_AUDIENCE = "azx-egress";
/**
 * How long egress remembers a burned `jti`. Must cover the whole window in which
 * the signature still verifies: `INSTRUCTION_TTL_SECONDS` + the verifier's clock
 * tolerance (5s) + margin. After this the token itself is stale (maxTokenAge
 * rejects it), so forgetting the jti is safe (issue #3).
 */
export const INSTRUCTION_BURN_RETENTION_SECONDS = INSTRUCTION_TTL_SECONDS + 15;
