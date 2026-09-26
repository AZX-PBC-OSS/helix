import { trace } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  AttemptCancelRequestSchema,
  type CancelRequest,
  type CancelResponse,
} from "@azx-pbc/shared";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import {
  ATTR_METHOD,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  type ConsentCancelEdgeOutcome,
  ROUTE_CONSENT_CANCEL,
  SPAN_CONSENT_CANCEL_EDGE,
} from "@azx-pbc/shared/telemetry";
import type { EdgeConfig } from "../config.js";
import { sendApiError } from "../gateway/llmCodec.js";
import { sendForbidden } from "../errors.js";
import { isSameOrigin } from "../auth/validate.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import type { SessionStore } from "../auth/sessions.js";
import type { RegistryReader } from "../registry/projection.js";
import { spanRoute } from "../telemetry.js";
import { callCancel } from "./consultCall.js";
import type { PortalProvider } from "./portalProvider.js";
import { usableSession } from "./consentStart.js";

/**
 * `POST /_api/connections/attempt/cancel` — the connect helper's cancellation
 * acknowledgement (I-02 design.md §Consent journey; spec criterion 29). When
 * the popup closes without a completion message, only the opener-side helper
 * can see it (the rejected pagehide-beacon alternative), so the helper POSTs
 * here — session-gated, own-attempts-only — and this route wraps T-0012's
 * cancel operation over the same internal portal seam the consult rides.
 *
 * What identifies the attempt, and why the correlation lives here: the helper
 * knows only the attempt tag it put on the start URL, and the control plane's
 * cancel arbitrates over the OAuth `state` (`CancelRequestSchema`). The state
 * never crosses the completion-message contract, so the start route learns the
 * tag→state pair in the one exchange where it sees both (the consult's
 * authorize URL) and records it in {@link AttemptCorrelations} — an
 * in-memory, TTL-bounded map. The edge stays grant-free on the flow table
 * (ADR-0006 part 2); this is a cache of values it already saw, not state.
 *
 * The accepted residual: the map is per replica, so a cancel landing on a
 * different replica than the start — or after a restart — finds nothing and
 * answers the indistinguishable `not_cancellable` while the span records
 * `unknown_attempt`. The attempt is still bounded by the same five-minute
 * expiry the design gives every popup the helper cannot see, so a missed
 * acknowledgement degrades to the documented bound; it never widens access.
 *
 * Own-attempts-only is enforced twice: the correlation only matches when the
 * session's principal is the one that started the attempt, and the portal's
 * cancel re-checks ownership authoritatively (its CAS answers
 * `not_cancellable` for anyone else).
 */

/** The correlation map's size cap. An attacker holding a session can mint a
 * tag only through a real consult (one popup, one pending attempt, five-minute
 * TTL), so legitimate traffic is bounded by users-attempts; the cap makes the
 * memory bound structural — entries beyond it are dropped, and such a cancel
 * degrades to the five-minute expiry like any missed acknowledgement. */
const MAX_CORRELATIONS = 1024;

/** One correlated start: the state the consult returned, the principal it
 * started for, and when the attempt expires server-side (the portal's TTL). */
export interface CorrelatedAttempt {
  state: string;
  userOid: string;
  expiresAtMs: number;
}

/**
 * The per-instance tag→state correlation. Insertion-capped and lazily pruned:
 * entries live at most one attempt TTL, and `takeIfOwn` is destructive (a
 * single-use acknowledgement — no replay, criterion 31).
 */
export class AttemptCorrelations {
  #map = new Map<string, CorrelatedAttempt>();
  #max: number;

  constructor(max = MAX_CORRELATIONS) {
    this.#max = max;
  }

  remember(tag: string, attempt: CorrelatedAttempt): void {
    this.#prune();
    if (this.#map.size >= this.#max) return;
    this.#map.set(tag, attempt);
  }

  /** The correlated attempt when `tag` names a live attempt started by
   * `userOid`; the entry is consumed either way. */
  takeIfOwn(tag: string, userOid: string): CorrelatedAttempt | null {
    const attempt = this.#map.get(tag);
    this.#map.delete(tag);
    if (!attempt) return null;
    if (attempt.userOid !== userOid) return null;
    if (attempt.expiresAtMs <= Date.now()) return null;
    return attempt;
  }

  #prune(): void {
    const now = Date.now();
    for (const [tag, attempt] of this.#map) {
      if (attempt.expiresAtMs <= now) this.#map.delete(tag);
    }
  }

  get size(): number {
    return this.#map.size;
  }
}

export interface ConsentCancelRuntime {
  config: EdgeConfig;
  registry: RegistryReader;
  /** null ⇒ no auth stack on this edge; every request is unauthorized. */
  sessions: SessionStore | null;
  /** null ⇒ EDGE_PORTAL_URL unset; the ack can't run — fail-closed 503. */
  portal: PortalProvider | null;
  /** null ⇒ HELIX_INTERNAL_SECRET unset; the same fail-closed answer. */
  internalKey: Buffer | null;
  correlations: AttemptCorrelations;
}

export function makeConsentCancelHandler(rt: ConsentCancelRuntime) {
  return spanRoute(
    SPAN_CONSENT_CANCEL_EDGE,
    (req) => ({
      "http.route": ROUTE_CONSENT_CANCEL,
      [ATTR_METHOD]: req.method,
      ...spanUrlAttributes(req.url),
    }),
    async function handleConsentCancel(
      req: FastifyRequest,
      reply: FastifyReply,
      slug: string,
    ): Promise<void> {
      const setOutcome = (outcome: ConsentCancelEdgeOutcome): void => {
        trace.getActiveSpan()?.setAttributes({ [ATTR_OUTCOME]: outcome });
      };

      const entry = resolveServingEntry(rt.registry, slug, reply);
      if (!entry) return; // a probe against an unknown/archived app — no signal

      // The logout precedent's belt: SameSite=Lax already keeps cross-site
      // POSTs from riding the session cookie; the Origin check makes it
      // explicit. A same-origin fetch POST always carries Origin.
      if (!isSameOrigin(req.headers.origin, rt.config, slug)) {
        setOutcome("unauthorized");
        sendForbidden(reply);
        return;
      }

      // Session-gated (the consent routes' machinery; a JSON API, so the
      // caller gets a JSON 401 rather than the navigation's sign-in page).
      const session = await usableSession(rt.sessions, req, entry);
      if (!session) {
        setOutcome("unauthorized");
        sendApiError(reply, 401, "unauthorized", "sign in to acknowledge a cancellation");
        return;
      }

      const body = AttemptCancelRequestSchema.safeParse(req.body);
      if (!body.success) {
        // A malformed body is a caller bug, not a consent state — no outcome
        // attribute (the start route's bad-attempt-tag posture).
        sendApiError(reply, 400, "validation_failed", "malformed cancellation body");
        return;
      }
      trace.getActiveSpan()?.setAttributes({ [ATTR_PROVIDER_REF]: body.data.provider });

      // Own-attempts-only, edge half: the tag must name an attempt this
      // replica started for this principal. A miss is deliberately
      // indistinguishable in the response body — the helper treats every
      // non-cancelled answer the same way (it never retries).
      const correlated = rt.correlations.takeIfOwn(body.data.attempt, session.user.oid);
      if (!correlated) {
        setOutcome("unknown_attempt");
        reply.header("cache-control", "no-store").send({ outcome: "not_cancellable" });
        return;
      }

      // An unconfigured seam is a service failure like any other: fail-closed.
      if (!rt.portal || !rt.internalKey) {
        setOutcome("error");
        sendApiError(
          reply,
          503,
          "capability_unavailable",
          "connections capability is not configured",
        );
        return;
      }

      const cancelRequest: CancelRequest = {
        identity: { kind: "user", userOid: session.user.oid },
        state: correlated.state,
      };

      const abort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) abort.abort();
      });

      let response: CancelResponse;
      try {
        response = await callCancel(
          rt.portal,
          rt.internalKey,
          cancelRequest,
          String(req.id),
          abort.signal,
        );
      } catch {
        // Fixed-string log fields only; the 503 grades the span ERROR.
        req.log.warn(
          { event: "consent.cancel_ack_failed", providerRef: body.data.provider },
          "cancel acknowledgement call failed",
        );
        setOutcome("error");
        sendApiError(reply, 503, "capability_unavailable", "couldn't acknowledge the cancellation");
        return;
      }
      setOutcome(response.outcome);
      reply.header("cache-control", "no-store").send(response);
    },
  );
}
