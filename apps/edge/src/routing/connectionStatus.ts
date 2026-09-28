import { trace } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ConnectionStatusRequestSchema, type ConnectionStatusResponse } from "@azx-pbc/shared";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import {
  ATTR_APP_SLUG,
  ATTR_METHOD,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  type ConsentStatusOutcome,
  ROUTE_CONSENT_STATUS,
  SPAN_CONSENT_STATUS_EDGE,
} from "@azx-pbc/shared/telemetry";
import type { EdgeConfig } from "../config.js";
import { sendApiError } from "../gateway/llmCodec.js";
import { sendNotFound } from "../errors.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import type { SessionStore } from "../auth/sessions.js";
import type { RegistryReader } from "../registry/projection.js";
import { spanRoute } from "../telemetry.js";
import { callStatus } from "./consultCall.js";
import type { PortalProvider } from "./portalProvider.js";
import { usableSession } from "./consentStart.js";

/**
 * `GET /_api/connections/:ref/status` — the app-facing connection-status read
 * (ADR-0031 as amended). How a static app learns whether the signed-in user
 * has a live connection to one of the providers its manifest binds, without
 * firing a real provider-bound call and without opening a consent popup: the
 * answer is Helix's own row state, collapsed exactly the way the delegated
 * call's error table collapses.
 *
 * The posture is the `/_api/me` read posture, not the start route's: this is
 * a JSON read for page script — session-gated with `usableSession` (a
 * pseudonym or an anonymous visitor is refused the same way, criterion 21),
 * `no-store` because the answer is identity-scoped, and **no Origin/CSRF
 * check** (a read — there is nothing to forge). The ref parses before it
 * touches a span attribute or a portal call: a malformed ref is a probe, not
 * a state (the start route's posture). The portal decides — the edge gains no
 * grant on `user_connections` (ADR-0006 part 2), and the read forwards over
 * the same internal seam the consult and cancel ride.
 *
 * The response body is the status word and nothing else: no provider
 * metadata, no identity, no connection detail.
 */

export interface ConnectionStatusRuntime {
  config: EdgeConfig;
  registry: RegistryReader;
  /** null ⇒ no auth stack on this edge; every request is unauthorized. */
  sessions: SessionStore | null;
  /** null ⇒ EDGE_PORTAL_URL unset; the read can't run — fail-closed 503. */
  portal: PortalProvider | null;
  /** null ⇒ HELIX_INTERNAL_SECRET unset; the same fail-closed answer. */
  internalKey: Buffer | null;
}

export function makeConnectionStatusHandler(rt: ConnectionStatusRuntime) {
  return spanRoute(
    SPAN_CONSENT_STATUS_EDGE,
    (req) => ({
      "http.route": ROUTE_CONSENT_STATUS,
      [ATTR_METHOD]: req.method,
      ...spanUrlAttributes(req.url),
    }),
    async function handleConnectionStatus(
      req: FastifyRequest,
      reply: FastifyReply,
      slug: string,
    ): Promise<void> {
      const setOutcome = (outcome: ConsentStatusOutcome): void => {
        trace.getActiveSpan()?.setAttributes({ [ATTR_OUTCOME]: outcome });
      };

      const entry = resolveServingEntry(rt.registry, slug, reply);
      if (!entry) {
        setOutcome("unavailable");
        return;
      }

      const refParam = (req.params as { ref?: string }).ref ?? "";
      const ref = ConnectionStatusRequestSchema.shape.providerRef.safeParse(refParam);
      if (!ref.success) {
        sendNotFound(reply); // no signal: a malformed ref is a probe, not a state
        return;
      }
      const providerRef = ref.data;
      trace.getActiveSpan()?.setAttributes({
        [ATTR_PROVIDER_REF]: providerRef,
        [ATTR_APP_SLUG]: slug,
      });

      const session = await usableSession(rt.sessions, req, entry);
      if (!session) {
        setOutcome("unauthorized");
        sendApiError(reply, 401, "unauthorized", "sign in to ask about connection status");
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

      const statusRequest = ConnectionStatusRequestSchema.parse({
        identity: { kind: "user", userOid: session.user.oid },
        appSlug: slug,
        providerRef,
      });

      // Abort the read if the caller goes away — the shared seam wiring.
      const abort = new AbortController();
      reply.raw.on("close", () => {
        if (!reply.raw.writableEnded) abort.abort();
      });

      let response: ConnectionStatusResponse;
      try {
        response = await callStatus(
          rt.portal,
          rt.internalKey,
          statusRequest,
          String(req.id),
          abort.signal,
        );
      } catch {
        // Fixed-string log fields only; the 503 grades the span ERROR.
        req.log.warn(
          { event: "consent.status_call_failed", providerRef },
          "connection status call failed",
        );
        setOutcome("error");
        sendApiError(reply, 503, "capability_unavailable", "couldn't read the connection status");
        return;
      }

      setOutcome(response.status);
      reply.header("cache-control", "no-store").send(response);
    },
  );
}
