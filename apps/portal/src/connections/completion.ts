import { randomUUID } from "node:crypto";
import type { Span } from "@opentelemetry/api";
import {
  ConnectionMaterialSchema,
  CONNECT_MESSAGE_VERSION,
  EXCHANGE_AUTH_HEADER,
  HELIX_CONNECT_MESSAGE_SOURCE,
  type ConnectOutcomeMessage,
  ExchangeRequestSchema,
  ExchangeResponseSchema,
  type ExchangeResponse,
  ConsentStateSchema,
} from "@azx-pbc/shared";
import {
  ATTR_APP_ID,
  ATTR_CONSENT_OPERATION,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  type ConsentCallbackOutcome,
  ROUTE_CONNECTIONS_CALLBACK,
  ROUTE_EGRESS_EXCHANGE,
  SPAN_CONSENT_CALLBACK,
} from "@azx-pbc/shared/telemetry";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import { Prisma, type PrismaClient } from "../db/client.js";
import { claimConsentAttempt, type ClaimedConsentAttempt } from "./consent.js";
import { connectionsCallbackUrl, resolveEgressBaseUrl } from "../deployment.js";
import { deriveExchangeKey, mintExchangeToken, resolveExchangeSecret } from "../internalJwt.js";
import { withSpan, instruments } from "../telemetry.js";

/**
 * The consent callback's completion state machine (I-02 T-0020; architecture
 * ADR-0001 §Decision) — the control-plane half of consent completion, and the
 * OIDC-handoff-class surface of this initiative: the vendor's redirect becomes
 * a saved connection or a legible failure, atomically and against forgery.
 *
 * The route (`routes/connectionsPages.ts`) parses the query and renders the
 * pages; every state decision lives here. The order is fixed by ADR-0001:
 *
 * 1. **Claim** the attempt by `state` — atomic single-use (T-0012's probe; a
 *    DELETE is the claim, so exactly one completion can ever win an attempt).
 *    A forged, reused, or cross-context `state` claims nothing; a cancelled or
 *    expired one refuses without being consumed.
 * 2. **Delegate** the code exchange to egress (`POST /exchange`, T-0019) under
 *    a freshly minted portal→egress JWT. The portal never handles plaintext
 *    delegated tokens — egress validates the criterion-27 gate at receipt and
 *    seals there; the response is metadata plus sealed references only.
 * 3. **Save** with the CAS/upsert contract (Q23 as amended): at most one
 *    current connection per (userOid, providerId, env). A live row cannot be
 *    replaced here — a racing loser renders conflict and its sealed material
 *    is ledger-marked for the egress sweep in the SAME transaction (ADR-0008);
 *    a dead row upserts. There is no portal-side destroy, ever.
 *
 * The completion message's target origin is the attempt's recorded
 * `openerOrigin` and nothing else (ADR-0002 §Shared ground); the messages
 * carry outcomes only.
 */

/** How long the portal waits for egress to answer the exchange. Egress bounds
 * its own vendor call (`EGRESS_TIMEOUT_MS`); the portal's budget is tighter on
 * purpose — a code exchange is a seconds-long call, so a hung mechanism plane
 * degrades to the failed-service page instead of holding the popup open for
 * the full proxied-call budget. */
const EXCHANGE_TIMEOUT_MS = 30_000;

/** One counter add for the callback — bounded dims, never identity. */
function count(outcome: string): void {
  instruments().consentOperations.add(1, {
    [ATTR_CONSENT_OPERATION]: "callback",
    [ATTR_OUTCOME]: outcome,
  });
}

/**
 * What the route renders for one callback hit.
 *
 * - `page: "refusal"` — the fixed, scriptless refusal page `pages.ts` ships
 *   (T-0016's), for a `state` that claims nothing: malformed, forged, reused,
 *   or cross-context. No message exists (no recorded origin), no provider is
 *   named, and every shape of nothing renders identically — a failed lookup
 *   must not become an oracle for which states exist. The span outcome is
 *   `denied`, the vocabulary's word for this class.
 * - `page: "completion"` — a design page-table page. `message` +
 *   `targetOrigin` are set together (all-or-nothing): the outcome message and
 *   its exact postMessage target, the opener origin recorded on the pending
 *   attempt (ADR-0002 §Shared ground — derived by nothing else). Null posts
 *   nothing. Messages carry outcomes only, never credentials (criterion 22).
 */
export type ConsentCompletion =
  | { page: "refusal"; outcome: "denied" }
  | {
      page: "completion";
      outcome: ConsentCallbackOutcome;
      message: ConnectOutcomeMessage | null;
      targetOrigin: string | null;
      /** The provider's display name, when the provider row was readable. */
      displayName: string | null;
    };

/**
 * The bounded message each outcome posts (design.md §Completion message —
 * outcomes only, never credentials). `conflict` is the design's one explicit
 * error-reason pairing ("a losing saver reports error/conflict", criterion
 * 32); the other failures post the plain `error` word — the schema's legal
 * null-reason form, because the bounded reason list has no honest word for
 * them. `expired` posts the helper's `timeout` outcome: criterion 25 makes
 * timeout distinguishable from cancellation to the app, and this message is
 * where the distinction travels.
 */
function messageFor(
  providerRef: string,
  outcome: ConsentCallbackOutcome,
): ConnectOutcomeMessage | null {
  let word: ConnectOutcomeMessage["outcome"];
  let reason: ConnectOutcomeMessage["reason"] = null;
  switch (outcome) {
    case "connected":
      word = "connected";
      break;
    case "already_connected":
      word = "already_connected";
      break;
    case "denied":
      word = "denied";
      break;
    case "expired":
      word = "timeout";
      break;
    case "cancelled":
      word = "cancelled";
      break;
    case "conflict":
      word = "error";
      reason = "conflict";
      break;
    default:
      // disconnected, failed_permissions, failed_provider, failed_service.
      word = "error";
      break;
  }
  return {
    source: HELIX_CONNECT_MESSAGE_SOURCE,
    version: CONNECT_MESSAGE_VERSION,
    provider: providerRef,
    outcome: word,
    reason,
  };
}

/** The callback's query, as the route parsed it: one value per parameter (or
 * null when absent or repeated — a repeated parameter is a probe). */
export interface CompletionQuery {
  state: string | null;
  code: string | null;
  /** The OAuth error parameter's PRESENCE is the declined case; its value is
   * vendor-chosen text and is never read, logged, or rendered. */
  error: string | null;
}

/**
 * The completion flow for one callback hit. Never throws for a flow outcome —
 * every failure class is a page — but DB failures propagate (the route's error
 * handler answers them; nothing was saved).
 */
export async function completeConsentCallback(
  prisma: PrismaClient,
  query: CompletionQuery,
): Promise<ConsentCompletion> {
  return withSpan(
    SPAN_CONSENT_CALLBACK,
    {
      "http.route": ROUTE_CONNECTIONS_CALLBACK,
      ...spanUrlAttributes(ROUTE_CONNECTIONS_CALLBACK),
    },
    async (span) => {
      try {
        const result = await complete(prisma, query, span);
        span.setAttributes({ [ATTR_OUTCOME]: result.outcome });
        count(result.outcome);
        return result;
      } catch (err) {
        span.setAttributes({ [ATTR_OUTCOME]: "failed_service" });
        count("failed_service");
        throw err;
      }
    },
  );
}

async function complete(
  prisma: PrismaClient,
  query: CompletionQuery,
  span: Span,
): Promise<ConsentCompletion> {
  // 1 — the state is the attempt's only lookup key, and its entropy is the
  // anti-forgery property (spec criterion 28). A malformed or missing one is
  // a probe: the fixed refusal page, nothing claimed (the T-0016 posture for
  // the sibling redemption route — a failed lookup must not become an oracle).
  const parsedState = query.state == null ? null : ConsentStateSchema.safeParse(query.state);
  if (!parsedState?.success) {
    return { page: "refusal", outcome: "denied" };
  }
  const state = parsedState.data;

  // 2 — the atomic single-use claim. Every refusal below saves nothing.
  const claim = await claimConsentAttempt(prisma, state);
  if (!claim.claimed) {
    return completeRefusal(prisma, state, claim.reason, span);
  }
  const attempt = claim.attempt;
  span.setAttributes({ [ATTR_APP_ID]: attempt.appId });

  // 3 — the provider row as of now: the display half for the pages and the
  // audit metadata. A row that vanished post-claim (deletion kills attempts,
  // so this is a narrow race) fails closed: the failed-provider page, nothing
  // saved — never an exchange against a provider that no longer exists.
  const providerRow = await prisma.connectionProvider.findUnique({
    where: { id: attempt.providerId },
  });
  if (!providerRow) {
    return {
      page: "completion",
      outcome: "failed_provider",
      message: null,
      targetOrigin: null,
      displayName: null,
    };
  }
  span.setAttributes({ [ATTR_PROVIDER_REF]: providerRow.ref });

  // 4 — the vendor declined: any OAuth error parameter is the declined case
  // (design's page table). The attempt is consumed; nothing is saved.
  if (query.error != null) {
    return {
      page: "completion",
      outcome: "denied",
      message: messageFor(providerRow.ref, "denied"),
      targetOrigin: attempt.openerOrigin,
      displayName: providerRow.displayName,
    };
  }

  // 5 — the delegated exchange (ADR-0001: every vendor OAuth call originates
  // in the mechanism plane). The portal supplies the attempt's captured values
  // verbatim and the convention-derived callback URL; egress gates and seals.
  const response = await delegateExchange(attempt, query.code);

  switch (response.outcome) {
    case "exchanged": {
      const saved = await saveExchangedConnection(prisma, attempt, providerRow.ref, response);
      return saved
        ? {
            page: "completion",
            outcome: "connected",
            message: messageFor(providerRow.ref, "connected"),
            targetOrigin: attempt.openerOrigin,
            displayName: providerRow.displayName,
          }
        : {
            // A competing completion saved first (criterion 32): the conflict
            // page, and this attempt's sealed material is already ledger-
            // marked for the sweep by the save's transaction.
            page: "completion",
            outcome: "conflict",
            message: messageFor(providerRow.ref, "conflict"),
            targetOrigin: attempt.openerOrigin,
            displayName: providerRow.displayName,
          };
    }
    case "rejected":
      // The criterion-27 gate refused at receipt; nothing was sealed. The
      // design renders the permission case differently from the incomplete-
      // token case (its page table), both with fixed content.
      return completion(
        response.reason === "missing_permissions" ? "failed_permissions" : "failed_provider",
        providerRow,
        attempt.openerOrigin,
      );
    case "provider_unavailable":
      // Unknown/deleted provider or a stale revision stamp (ADR-0004) — the
      // operator-actionable failed-provider page.
      return completion("failed_provider", providerRow, attempt.openerOrigin);
    case "exchange_failed":
      return completion("failed_service", providerRow, attempt.openerOrigin);
  }
}

/** A completion with the provider row's display halves and the recorded
 * opener origin (the message target) filled in. */
function completion(
  outcome: ConsentCallbackOutcome,
  providerRow: { ref: string; displayName: string },
  targetOrigin: string,
): ConsentCompletion {
  return {
    page: "completion",
    outcome,
    message: messageFor(providerRow.ref, outcome),
    targetOrigin,
    displayName: providerRow.displayName,
  };
}

/**
 * The refused-claim pages. `expired` and `cancelled` have their own design
 * pages, and both post their outcome to the recorded opener — the app's wait
 * ends legibly (criterion 25 makes timeout/denial/cancellation distinguishable
 * to the app, and the message is where that travels). A cancelled attempt
 * whose connection row was invalidated renders DISCONNECTED instead: the
 * disconnect that killed this attempt (T-0010/T-0024's kill-by-cancelledAt)
 * is the reason it can no longer establish anything (criterion 44). A refused
 * attempt the sweep already removed renders the page without a message — the
 * recorded origin is gone and nothing may re-derive it (ADR-0002 §Shared
 * ground).
 */
async function completeRefusal(
  prisma: PrismaClient,
  state: string,
  reason: "not_found" | "expired" | "cancelled",
  span: Span,
): Promise<ConsentCompletion> {
  if (reason === "not_found") {
    // Forged, reused, or cross-context state: no attempt exists, so there is
    // no recorded origin to message and no provider to name — the fixed
    // scriptless refusal page, indistinguishable across the whole class.
    return { page: "refusal", outcome: "denied" };
  }

  // The refusal is not a delete — the row is still here (the sweep may remove
  // it concurrently; both refuse, so the race only narrows the page's wording,
  // never widens an outcome).
  const row = await prisma.connectionConsentAttempt.findUnique({ where: { state } });
  if (!row) {
    return {
      page: "completion",
      outcome: reason,
      message: null,
      targetOrigin: null,
      displayName: null,
    };
  }

  const providerRow = await prisma.connectionProvider.findUnique({
    where: { id: row.providerId },
  });
  if (!providerRow) {
    return {
      page: "completion",
      outcome: reason,
      message: null,
      targetOrigin: null,
      displayName: null,
    };
  }
  span.setAttributes({ [ATTR_PROVIDER_REF]: providerRow.ref });

  if (reason === "cancelled") {
    const connection = await prisma.userConnection.findUnique({
      where: {
        userOid_providerId_env: {
          userOid: row.userOid,
          providerId: row.providerId,
          env: row.env === "dev" ? "dev" : "prod",
        },
      },
    });
    if (connection?.status === "invalidated") {
      return completion("disconnected", providerRow, row.openerOrigin);
    }
  }
  return completion(reason, providerRow, row.openerOrigin);
}

/**
 * The delegated exchange: mint the portal→egress JWT (T-0006's mint side) and
 * call egress `POST /exchange` (T-0019) with the attempt's captured values
 * verbatim. Every failure — the delegation unwired, transport errors, a
 * non-200 refusal, an unparseable body — collapses to the one fixed outcome
 * word; nothing about an error travels (the request body carries
 * `code`/`codeVerifier`, so a logged error could carry credential-class
 * material).
 */
async function delegateExchange(
  attempt: ClaimedConsentAttempt,
  code: string | null,
): Promise<ExchangeResponse> {
  const exchangeFailed: ExchangeResponse = { outcome: "exchange_failed" };
  // A callback with neither `code` nor `error` is a broken or forged redirect.
  if (code == null) return exchangeFailed;
  const secret = resolveExchangeSecret();
  const base = resolveEgressBaseUrl();
  if (!secret || !base) {
    // The delegation is unwired: the callback refuses rather than degrades —
    // there is no portal-side exchange to fall back to (ADR-0001).
    return exchangeFailed;
  }

  let body: string;
  try {
    body = JSON.stringify(
      ExchangeRequestSchema.parse({
        providerId: attempt.providerId,
        providerRevision: attempt.providerRevision,
        env: attempt.env,
        code,
        codeVerifier: attempt.codeVerifier,
        // The convention-derived callback URL — the same value the authorize
        // request bound (the edge supplies the identical derivation; the
        // consistency session's test pins the two together).
        redirectUri: connectionsCallbackUrl(),
      }),
    );
  } catch {
    return exchangeFailed;
  }

  try {
    const res = await fetch(new URL(ROUTE_EGRESS_EXCHANGE, base), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [EXCHANGE_AUTH_HEADER]: await mintExchangeToken(deriveExchangeKey(secret)),
      },
      body,
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!res.ok) return exchangeFailed;
    const parsed = ExchangeResponseSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : exchangeFailed;
  } catch {
    return exchangeFailed;
  }
}

/**
 * The CAS/upsert save (Q23 as amended) plus the `connection.connected` audit
 * event, one transaction: INSERT the connection, or — over a dead
 * (`reconnect-needed`/`invalidated`) row — UPDATE it live, ledger-marking the
 * OLD material for the egress sweep in the same UPDATE (ADR-0008's rule). A
 * LIVE row can never be replaced here: the DO UPDATE's predicate excludes it,
 * the statement returns zero rows, and the same transaction ledger-marks THIS
 * completion's sealed material on the row that beat it — the lost race's
 * compensation, never a portal-side destroy (ADR-0008; the single-slot
 * residual is T-0010's precedent). Criterion 47's sweep retires the mark
 * within its bound.
 *
 * Returns true when this completion saved, false when it lost the race.
 */
async function saveExchangedConnection(
  prisma: PrismaClient,
  attempt: ClaimedConsentAttempt,
  providerRef: string,
  exchanged: Extract<ExchangeResponse, { outcome: "exchanged" }>,
): Promise<boolean> {
  // The two sealed references ride the row's one material column as the shared
  // envelope (ConnectionMaterialSchema) — egress parses it on every renewal.
  const material = JSON.stringify(
    ConnectionMaterialSchema.parse({ access: exchanged.access, refresh: exchanged.refresh }),
  );
  const expiresAt = new Date(exchanged.accessExpiresAt);

  return prisma.$transaction(async (tx) => {
    const saved = await tx.$queryRaw<Array<{ id: string }>>(
      // "updatedAt" is set explicitly: the column's @updatedAt default is a
      // Prisma-client behavior, not a DB one, and this raw INSERT bypasses it.
      Prisma.sql`INSERT INTO user_connections
          (id, "userOid", "providerId", "providerRevision", env, status, material,
           "grantedScopes", "grantedAt", "expiresAt", "renewBeforeNext", "lastRenewedAt",
           "pendingRetire", "updatedAt")
        VALUES (${randomUUID()}::uuid, ${attempt.userOid}, ${attempt.providerId}::uuid,
                ${attempt.providerRevision}, ${attempt.env}, 'live', ${material},
                ${JSON.stringify(exchanged.grantedScopes)}::jsonb, now(), ${expiresAt},
                false, NULL, NULL, now())
        ON CONFLICT ("userOid", "providerId", "env") DO UPDATE SET
          status = 'live',
          "providerRevision" = EXCLUDED."providerRevision",
          material = EXCLUDED.material,
          "grantedScopes" = EXCLUDED."grantedScopes",
          "grantedAt" = EXCLUDED."grantedAt",
          "expiresAt" = EXCLUDED."expiresAt",
          "renewBeforeNext" = false,
          "lastRenewedAt" = NULL,
          "pendingRetire" = user_connections.material,
          "updatedAt" = now()
        WHERE user_connections.status <> 'live'
        RETURNING id`,
    );
    if (saved.length > 0) {
      // Audit in lockstep with the write (the approvals pattern): bounded
      // metadata — the connecting user (the actor), providerRef, env, appId.
      await tx.auditEvent.create({
        data: {
          appId: attempt.appId,
          actor: attempt.userOid,
          action: "connection.connected",
          metadata: { providerRef, env: attempt.env, appId: attempt.appId },
        },
      });
      return true;
    }

    // The conflict branch: the row that beat this completion is live. Mark
    // THIS attempt's sealed material for retirement in the SAME transaction —
    // the compensation ADR-0008 mandates for a lost race. The predicate
    // re-asserts liveness: a row that went dead between the two statements
    // (not reachable under the conflict's row lock, but the mark must never
    // change a non-live row's fate) leaves the material unmarked — the
    // accepted residual class, not a new failure mode.
    await tx.$executeRaw`
      UPDATE user_connections
      SET "pendingRetire" = ${material}, "updatedAt" = now()
      WHERE "userOid" = ${attempt.userOid} AND "providerId" = ${attempt.providerId}::uuid
        AND "env" = ${attempt.env} AND status = 'live'`;
    return false;
  });
}
