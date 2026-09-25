import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import { z } from "zod";
import {
  CapabilitiesSchema,
  ConnectionProviderSchema,
  CONSENT_ATTEMPT_TTL_SECONDS,
  type CancelRequest,
  type CancelResponse,
  type ConsultRequest,
  type ConsultResponse,
  DeltaSchema,
  type Env,
  isProviderBindingEffective,
  parseFetchOriginKey,
  type ProviderStamp,
} from "@azx-pbc/shared";
import {
  ATTR_APP_ID,
  ATTR_APP_SLUG,
  ATTR_CONSENT_OPERATION,
  ATTR_CONSENT_SWEEP_REMOVED,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  SPAN_CONSENT_CANCEL,
  SPAN_CONSENT_CLAIM,
  SPAN_CONSENT_CONSULT,
  SPAN_CONSENT_SWEEP,
} from "@azx-pbc/shared/telemetry";
import type { SecretStore } from "@azx-pbc/secret-store";
import { Prisma, type PrismaClient } from "../db/client.js";
import { AppError } from "../plugins/errors.js";
import { isUniqueViolation } from "../db/errors.js";
import { withSpan, instruments } from "../telemetry.js";

/**
 * The consent-flow state machine (I-02 ADR-0002 — the control plane owns all
 * consent-flow state): the start consult the edge's start route and the dev
 * gateway call, the own-attempts-only cancel the helper's acknowledgement
 * rides, the claim-shaped probe the callback redeems an attempt with, and the
 * expiry sweep. The routes (`routes/connectionsInternal.ts`) authorize the
 * internal calls and parse the shared contracts; every state decision lives
 * here.
 *
 * **The edge writes nothing.** `helix_edge` holds no grant on
 * `connection_consent_attempts` (ADR-0006 part 2) — every write in this file
 * happens under the portal's own role, which is the whole reason the consult
 * exists.
 */

/** The consult/cancel identity union's tier — pinned here, never a wire field. */
function identityEnv(identity: ConsultRequest["identity"]): Env {
  return identity.kind === "dev" ? "dev" : "prod";
}

/** The principal a connection and an attempt key to, per identity kind. */
function identityOid(identity: ConsultRequest["identity"]): string {
  return identity.kind === "dev" ? identity.developerOid : identity.userOid;
}

/** One counter add for a consent operation — bounded dims, never identity. */
function count(operation: "consult" | "cancel" | "claim" | "sweep", outcome: string): void {
  instruments().consentOperations.add(1, {
    [ATTR_CONSENT_OPERATION]: operation,
    [ATTR_OUTCOME]: outcome,
  });
}

const FRESH_BYTES = 32;

/** RFC 7636 §4.1: 43+ unreserved characters — base64url of 32 random bytes. */
function newVerifier(): string {
  return randomBytes(FRESH_BYTES).toString("base64url");
}

/** RFC 7636 §4.2: base64url(SHA256(verifier)) — the S256 challenge. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The stored provider row through its one shared definition (dates → ISO). */
function parseProviderRow(row: {
  id: string;
  ref: string;
  kind: string;
  displayName: string;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  requestedScopes: unknown;
  apiOrigins: unknown;
  tokenPlacement: unknown;
  env: string;
  clientIdMaterial: string;
  clientSecretMaterial: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return ConnectionProviderSchema.parse({
    ...row,
    env: row.env === "dev" ? "dev" : "prod",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * The provider stamps an approved request filed for provider-bound origin
 * adds under one ref. A malformed deltas record parses as no stamps — a
 * broken approval row must fail the consult closed (`not_available`), never
 * grant consent off an unreadable grant.
 */
function stampsFor(deltas: unknown, ref: string): { env: Env; stamp: ProviderStamp }[] {
  const parsed = z.array(DeltaSchema).safeParse(deltas);
  if (!parsed.success) return [];
  const out: { env: Env; stamp: ProviderStamp }[] = [];
  for (const d of parsed.data) {
    if (typeof d.to !== "string" || !d.path.startsWith("fetch.origins[+")) continue;
    if (parseFetchOriginKey(d.to).provider !== ref) continue;
    for (const stamp of d.providerStamps ?? []) {
      if (stamp.ref === ref) out.push({ env: stamp.env, stamp });
    }
  }
  return out;
}

export async function consultConsent(
  prisma: PrismaClient,
  secretStore: SecretStore,
  req: ConsultRequest,
): Promise<ConsultResponse> {
  const env = identityEnv(req.identity);
  const userOid = identityOid(req.identity);

  return withSpan(
    SPAN_CONSENT_CONSULT,
    {
      [ATTR_CONSENT_OPERATION]: "consult",
      [ATTR_APP_SLUG]: req.appSlug,
      [ATTR_PROVIDER_REF]: req.providerRef,
    },
    async (span) => {
      try {
        const response = await consult(prisma, secretStore, req, env, userOid, span);
        span.setAttributes({ [ATTR_OUTCOME]: response.outcome });
        count("consult", response.outcome);
        return response;
      } catch (err) {
        span.setAttributes({ [ATTR_OUTCOME]: "error" });
        count("consult", "error");
        throw err;
      }
    },
  );
}

async function consult(
  prisma: PrismaClient,
  secretStore: SecretStore,
  req: ConsultRequest,
  env: Env,
  userOid: string,
  span: Span,
): Promise<ConsultResponse> {
  // 1 — consent is available only to an identified user of an authorized app
  // binding (spec criterion 20): binding approval/effectiveness first, then
  // connection status. The app is resolved by slug — the identity the edge's
  // host routing attests.
  const appRow = await prisma.app.findUnique({ where: { slug: req.appSlug } });
  if (!appRow) return { outcome: "not_available" };
  span.setAttributes({ [ATTR_APP_ID]: appRow.id });

  const caps = CapabilitiesSchema.parse(appRow.capabilities ?? {});
  if (!(caps.fetch?.origins ?? []).some((o) => o.provider === req.providerRef)) {
    // The binding never landed in the effective manifest — unapproved.
    return { outcome: "not_available" };
  }

  // 2 — the provider row must exist in the caller's tier (env is pinned by the
  // identity kind, never a request field).
  const providerRow = await prisma.connectionProvider.findUnique({
    where: { ref_env: { ref: req.providerRef, env } },
  });
  if (!providerRow) return { outcome: "not_available" };
  const provider = parseProviderRow(providerRow);

  // 3 — the binding is effective only when an APPROVED request's filing stamp
  // still matches the row's current identity — T-0009's rule, consumed here
  // and never re-derived. A sensitive edit or a delete+recreate stale-dates
  // every stamp, and the consult reports not_available.
  const approved = await prisma.approvalRequest.findMany({
    where: { appId: appRow.id, status: "approved" },
    select: { deltas: true },
  });
  const effective = approved.some((r) =>
    stampsFor(r.deltas, req.providerRef).some(
      (s) => s.env === env && isProviderBindingEffective(s.stamp, provider),
    ),
  );
  if (!effective) return { outcome: "not_available" };

  // 4 — a working connection reports already-connected without being replaced
  // (criterion 24): no attempt, no vendor round-trip. Only `live` counts — a
  // reconnect-needed or invalidated row is replaceable through consent.
  const connection = await prisma.userConnection.findUnique({
    where: { userOid_providerId_env: { userOid, providerId: provider.id, env } },
  });
  if (connection?.status === "live") return { outcome: "already_connected" };

  // 5 — the client id is OAuth protocol state (it rides every authorize URL by
  // design); the client secret stays sealed and is never opened here. Opened
  // OUTSIDE any transaction — the vault call must never span the attempt write.
  const clientId = await secretStore.open(provider.clientIdMaterial);

  // 6 — the attempt write. The read-then-write above is made indivisible
  // against a connection landing mid-consult by re-asserting the no-live-
  // connection predicate IN the INSERT: a completion that commits between the
  // read and this statement inserts zero rows and the caller gets
  // already-connected, so a working connection is never raced into a
  // duplicate flow (criterion 24; the concurrency concern).
  const state = randomBytes(FRESH_BYTES).toString("base64url");
  const codeVerifier = newVerifier();
  const nonce = req.identity.kind === "dev" ? req.identity.nonce : null;
  const expiresAt = new Date(Date.now() + CONSENT_ATTEMPT_TTL_SECONDS * 1000);

  let inserted: Array<{ id: string }>;
  try {
    inserted = await prisma.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`INSERT INTO connection_consent_attempts
          (id, state, "codeVerifier", "userOid", "providerId", "providerRevision",
           "appId", env, "openerOrigin", nonce, "expiresAt")
        SELECT ${randomUUID()}::uuid, ${state}, ${codeVerifier}, ${userOid},
               ${provider.id}::uuid, ${provider.revision}, ${appRow.id}::uuid, ${env},
               ${req.openerOrigin}, ${nonce}, ${expiresAt}
        WHERE NOT EXISTS (
          SELECT 1 FROM user_connections
          WHERE "userOid" = ${userOid} AND "providerId" = ${provider.id}::uuid
            AND "env" = ${env} AND status = 'live'
        )
        RETURNING id`,
    );
  } catch (err) {
    // A repeated `state` cannot occur (256-bit fresh); a repeated nonce can —
    // it is the dev journey's single-use value, so a replayed consult is a
    // conflict, not a second attempt.
    if (isUniqueViolation(err)) {
      throw new AppError("conflict", "consent attempt could not be created (replayed handoff)");
    }
    throw err;
  }
  if (inserted.length === 0) return { outcome: "already_connected" };

  // 7 — assemble the vendor authorize URL: the provider's authorize endpoint
  // plus only OAuth protocol parameters (response_type, client id, the
  // edge-supplied callback URL, state, S256 challenge, requested scopes). No
  // credential, token, or secret material is ever appended (criterion 22).
  const authorizeUrl = new URL(provider.authorizeEndpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", req.callbackUrl);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  if (provider.requestedScopes.length > 0) {
    authorizeUrl.searchParams.set("scope", provider.requestedScopes.join(" "));
  }
  return { outcome: "started", authorizeUrl: authorizeUrl.toString() };
}

/**
 * Acknowledge a closed popup (own-attempts-only, ADR-0002): the attempt's
 * owning identity marks it cancelled, so a late completion cannot claim it.
 * The CAS makes the status check the write (the `claimPendingRequest`
 * pattern) — a cancel racing the callback's claim, a second cancel, or a
 * non-owner's call all lose and answer `not_cancellable`, indistinguishably
 * from "no such attempt". Consent already saved is a connection row, out of
 * cancel's reach (criterion 29).
 */
export async function cancelConsentAttempt(
  prisma: PrismaClient,
  req: CancelRequest,
): Promise<CancelResponse> {
  const env = identityEnv(req.identity);
  const userOid = identityOid(req.identity);

  return withSpan(SPAN_CONSENT_CANCEL, { [ATTR_CONSENT_OPERATION]: "cancel" }, async (span) => {
    let outcome: CancelResponse["outcome"];
    try {
      // Ownership pre-check; the CAS below re-asserts liveness, so only the
      // owner's call may even attempt the write, and anyone else's state
      // value gets the same answer an unknown one gets.
      const attempt = await prisma.connectionConsentAttempt.findUnique({
        where: { state: req.state },
      });
      const ownable =
        attempt !== null &&
        attempt.env === env &&
        attempt.userOid === userOid &&
        attempt.cancelledAt === null &&
        attempt.expiresAt.getTime() > Date.now();
      if (ownable) {
        const { count: claimed } = await prisma.connectionConsentAttempt.updateMany({
          where: { state: req.state, cancelledAt: null, expiresAt: { gt: new Date() } },
          data: { cancelledAt: new Date() },
        });
        outcome = claimed === 1 ? "cancelled" : "not_cancellable";
      } else {
        outcome = "not_cancellable";
      }
    } catch (err) {
      span.setAttributes({ [ATTR_OUTCOME]: "error" });
      count("cancel", "error");
      throw err;
    }
    span.setAttributes({ [ATTR_OUTCOME]: outcome });
    count("cancel", outcome);
    return { outcome };
  });
}

/** The claim's refusal reasons — what the callback's terminal pages key on. */
export type ConsentAttemptClaimRefusal = "not_found" | "expired" | "cancelled";

/** The claimed attempt: everything the callback's completion flow needs. */
export interface ClaimedConsentAttempt {
  id: string;
  state: string;
  codeVerifier: string;
  userOid: string;
  providerId: string;
  providerRevision: number;
  appId: string;
  env: Env;
  /** The completion message's exact target origin — recorded at consult. */
  openerOrigin: string;
  nonce: string | null;
}

export type ConsentAttemptClaim =
  | { claimed: true; attempt: ClaimedConsentAttempt }
  | { claimed: false; reason: ConsentAttemptClaimRefusal };

/**
 * The callback's claim-shaped probe (T-0020's route calls this): redeem an
 * attempt by `state`, atomically and single-use — the DELETE is the claim, so
 * exactly one concurrent completion can ever win, and the winner takes the
 * row with it. A cancelled or expired attempt (at/after the five-minute TTL)
 * refuses WITHOUT being deleted — "cancelled" / "expired" are the states the
 * callback renders — and an unknown or already-claimed state refuses as
 * "not_found". `openerOrigin` travels on the claimed attempt: the completion
 * message's target origin is the consult-recorded value and is derived by
 * nothing else (ADR-0002 §Shared ground).
 */
export async function claimConsentAttempt(
  prisma: PrismaClient,
  state: string,
): Promise<ConsentAttemptClaim> {
  return withSpan(SPAN_CONSENT_CLAIM, { [ATTR_CONSENT_OPERATION]: "claim" }, async (span) => {
    let claim: ConsentAttemptClaim;
    try {
      const rows = await prisma.$queryRaw<Array<ClaimedConsentAttempt>>(
        Prisma.sql`DELETE FROM connection_consent_attempts
          WHERE state = ${state} AND "cancelledAt" IS NULL AND "expiresAt" > now()
          RETURNING id, state, "codeVerifier", "userOid", "providerId",
                    "providerRevision", "appId", env, "openerOrigin", nonce`,
      );
      if (rows.length > 0) {
        const row = rows[0]!;
        claim = {
          claimed: true,
          attempt: { ...row, env: row.env === "dev" ? "dev" : "prod" },
        };
      } else {
        // Best-effort reason: a sweep racing this read turns "expired" into
        // "not_found". Both refuse, so the race only ever narrows a page's
        // wording, never widens an outcome.
        const row = await prisma.connectionConsentAttempt.findUnique({ where: { state } });
        claim = {
          claimed: false,
          reason: !row ? "not_found" : row.cancelledAt ? "cancelled" : "expired",
        };
      }
    } catch (err) {
      span.setAttributes({ [ATTR_OUTCOME]: "error" });
      count("claim", "error");
      throw err;
    }
    span.setAttributes({ [ATTR_OUTCOME]: claim.claimed ? "claimed" : claim.reason });
    count("claim", claim.claimed ? "claimed" : claim.reason);
    return claim;
  });
}

/**
 * Remove expired attempt rows (ADR-0002 §Implementation Notes — swept
 * portal-side; no material is involved: an attempt holds protocol state,
 * never credentials). Rows still inside their TTL — pending or cancelled —
 * are untouched. Returns the number removed. Interval-driven from
 * `server.ts` (the egress burn-sweep precedent: unref'd, cleared on close).
 */
export async function sweepExpiredConsentAttempts(prisma: PrismaClient): Promise<number> {
  return withSpan(SPAN_CONSENT_SWEEP, { [ATTR_CONSENT_OPERATION]: "sweep" }, async (span) => {
    try {
      const { count: removed } = await prisma.connectionConsentAttempt.deleteMany({
        where: { expiresAt: { lte: new Date() } },
      });
      span.setAttributes({ [ATTR_CONSENT_SWEEP_REMOVED]: removed, [ATTR_OUTCOME]: "ok" });
      count("sweep", "ok");
      return removed;
    } catch (err) {
      span.setAttributes({ [ATTR_OUTCOME]: "failed" });
      count("sweep", "failed");
      throw err;
    }
  });
}
