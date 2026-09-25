import { z } from "zod";

import { EnvSchema } from "./env.js";
import { PrincipalKindSchema } from "./principal.js";
import { ProviderRefSchema } from "./providers.js";

/**
 * The attested instruction (architecture §3, §6.2; secrets design §4) — the
 * signed boundary between the policy plane (`helix-edge`) and the mechanism plane
 * (`helix-egress`).
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

/**
 * The attested instruction payload — **strict** (ADR-0005): unknown keys are
 * rejected, not stripped. The verifier that parses this payload runs on the
 * mechanism plane, so a _future_ claim an older egress does not know must fail
 * its verify closed instead of silently disappearing — a non-strict parse would
 * let a new-form instruction lose its credential field during a version skew
 * and go out unauthenticated. The registered JWT claims (`exp`/`iat`/`jti`/
 * `aud`) are the signer/verifier's business (freshness, burn key, trust
 * domain), not this schema's — a verifier must separate them from the payload
 * before this strict parse runs (`apps/egress/src/instruction.ts`).
 */
export const AttestedInstructionSchema = z
  .strictObject({
    /** App the call is attributed to (registry app id). */
    appId: z.string().min(1),
    /** Authenticated user, or the anonymous sentinel on `public` apps. */
    userOid: z.string().min(1),
    /**
     * Which kind of principal `userOid` is (the `PrincipalKind` vocabulary the
     * edge records at capture time — recorded, never inferred). The delegated
     * resolution (I-02 T-0022) refuses `anon` and `password` callers — they can
     * never hold a connection (spec criterion 21) — and serving that refusal
     * requires knowing the KIND: `userOid`'s shape proves nothing (a shared-
     * password pseudonym and an Entra `sub` share the base64url alphabet, and
     * the sentinel is only exact for `anon`). Optional on the payload as a
     * whole so secret-backed and keyless instructions keep minting unchanged;
     * mandatory on a delegated one — the refine below makes a provider-bearing
     * instruction without it unrepresentable, so an old edge cannot mint a
     * delegated call egress would have to guess about.
     */
    userKind: PrincipalKindSchema.optional(),
    capability: InstructionCapabilitySchema,
    /** The allowlisted origin the edge authorized (scheme + host + port). */
    origin: z.url(),
    /** Connection (secret) name to inject, if this is a secret-backed call. */
    connection: z.string().min(1).optional(),
    /**
     * Provider reference for a delegated call — the user's connection to this
     * provider is what egress injects (clarifications §Gateway path). Exactly
     * one credential source travels: this and `connection` are XOR-enforced
     * below (ADR-0005) — a delegated instruction carries a provider ref or a
     * secret name, never both.
     */
    provider: ProviderRefSchema.optional(),
    /** Correlates the edge audit row with the egress call. */
    requestId: z.string().min(1),
    /**
     * The HTTP method + URL pathname the edge authorized (ADR-0013 step 2, issue #6).
     * Egress refuses a mismatched verb/resource, so a captured instruction can't be
     * redirected to a different request on the same origin (origin is already bound
     * above; the `jti` burn already blocks replay — this closes the residual
     * same-origin-different-request gap). Bound to `pathname` only (not query): the
     * app controls the query, and origin + jti already constrain the call.
     *
     * Optional for rollout safety (like `env`): within one instance edge+egress
     * deploy together and instructions live 30 s, but a rolling restart may briefly
     * verify an old-edge token that lacks these. Only the edge can sign, so absence
     * means "old edge", not tampering — egress asserts ONLY when the claim is
     * present. Make required once a fleet is reliably past deploy.
     */
    method: z.string().min(1).optional(),
    path: z.string().optional(),
    /**
     * Environment tier this call is scoped to (dev-mode design §6). Egress resolves
     * the connection secret within this tier — a `dev` instruction can never reach a
     * `prod` connection secret and vice-versa. Carried by the attested (signed)
     * claim, never an app/request parameter; defaults `prod` so any instruction
     * minted before this field existed verifies as production.
     */
    env: EnvSchema.default("prod"),
  })
  .superRefine((i, ctx) => {
    if (i.connection !== undefined && i.provider !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["provider"],
        message:
          "an instruction carries exactly one credential source — a connection secret or a provider reference, never both (ADR-0005)",
      });
    }
    if (i.provider !== undefined && i.userKind === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["userKind"],
        message:
          "a delegated instruction must carry the caller's principal kind — egress refuses anonymous and shared-password callers by kind, never by inferring it from userOid (I-02 criterion 21)",
      });
    }
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
