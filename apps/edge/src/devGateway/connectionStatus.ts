import { trace } from "@opentelemetry/api";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ConnectionStatusRequestSchema, type ConnectionStatusResponse } from "@azx-pbc/shared";
import { spanUrlAttributes } from "@azx-pbc/shared/logging";
import {
  ATTR_APP_SLUG,
  ATTR_METHOD,
  ATTR_OUTCOME,
  ATTR_PROVIDER_REF,
  type ConsentStatusDevOutcome,
  ROUTE_CONSENT_STATUS_DEV,
  SPAN_CONSENT_STATUS_DEV,
} from "@azx-pbc/shared/telemetry";
import type { GatewayConfig } from "../config.js";
import { sendNotFound } from "../errors.js";
import { sendApiError } from "../gateway/llmCodec.js";
import type { CallerResolver } from "../auth/gate.js";
import { resolveServingEntry } from "../auth/routes/appHost.js";
import { callStatus } from "../routing/consultCall.js";
import type { PortalProvider } from "../routing/portalProvider.js";
import { spanRoute } from "../telemetry.js";
import type { RegistryReader } from "../registry/projection.js";

/**
 * `GET /:slug/_api/connections/:ref/status` — the dev tier's connection-status
 * read (ADR-0031 as amended), the dev twin of the prod status route. A dev
 * app's page asks, with its bearer dev token, whether its developer identity
 * holds a live dev-tier connection to a provider the app binds — without
 * firing a real provider-bound call.
 *
 * The dev start route's factories and seams are reused, exactly like every
 * other dev-gateway capability: the caller identity comes from the same
 * `CallerResolver` seam (its Origin allowlist check is this route's gate),
 * the read rides the same `callStatus` seam as the prod route, and the wire
 * contract is the shared `ConnectionStatusResponseSchema`. No nonce, no
 * attempt, no popup: a status read writes nothing, so the dev journey's
 * one-time-handoff machinery is absent by design.
 */

export interface DevConnectionStatusRuntime {
  config: GatewayConfig;
  registry: RegistryReader;
  /** The dev-token resolver (bearer + Origin allowlist) — the swapped seam. */
  resolveCaller: CallerResolver;
  /** null ⇒ EDGE_PORTAL_URL unset; the read can't run — fail-closed 503. */
  portal: PortalProvider | null;
  /** null ⇒ HELIX_INTERNAL_SECRET unset; the same fail-closed answer. */
  internalKey: Buffer | null;
}

export function makeDevConnectionStatusHandler(rt: DevConnectionStatusRuntime) {
  return spanRoute(
    SPAN_CONSENT_STATUS_DEV,
    (req) => ({
      "http.route": ROUTE_CONSENT_STATUS_DEV,
      [ATTR_METHOD]: req.method,
      ...spanUrlAttributes(req.url),
    }),
    async function handleDevConnectionStatus(
      req: FastifyRequest,
      reply: FastifyReply,
      slug: string,
    ): Promise<void> {
      const setOutcome = (outcome: ConsentStatusDevOutcome): void => {
        trace.getActiveSpan()?.setAttributes({ [ATTR_OUTCOME]: outcome });
      };

      const entry = resolveServingEntry(rt.registry, slug, reply);
      if (!entry) {
        setOutcome("unavailable");
        return;
      }

      // The provider ref must parse before it touches a span attribute or a
      // read (the prod status route's posture: a malformed ref is a probe,
      // not a state).
      const refParam = (req.params as { ref?: string }).ref ?? "";
      const ref = ConnectionStatusRequestSchema.shape.providerRef.safeParse(refParam);
      if (!ref.success) {
        sendNotFound(reply);
        return;
      }
      const providerRef = ref.data;
      trace.getActiveSpan()?.setAttributes({
        [ATTR_PROVIDER_REF]: providerRef,
        [ATTR_APP_SLUG]: slug,
      });

      // Gate — the dev resolver, BEFORE any read: bearer token validity, app
      // binding, lifetime, and the Origin allowlist.
      const caller = await rt.resolveCaller(req, reply, entry);
      if (!caller) {
        setOutcome("forbidden");
        return;
      }
      if (!caller.authenticated) {
        setOutcome("forbidden");
        sendApiError(reply, 403, "forbidden", "dev token is not valid for this app");
        return;
      }
      // The resolver must have validated and reflected an Origin for the
      // caller — the same skew guard the dev start route runs. A status read
      // uses no origin value, but a caller admitted without one would be a
      // resolver contract violation; fail closed.
      if (!req.devCorsOrigin) {
        setOutcome("forbidden");
        sendApiError(reply, 403, "forbidden", "origin is not registered for this dev token");
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

      // env is pinned by the identity kind — nothing on the request can
      // parameterize it (the resolver bakes env='dev'; the contract carries
      // no env field).
      const statusRequest = ConnectionStatusRequestSchema.parse({
        identity: { kind: "dev", developerOid: caller.oid },
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
          { event: "consent.dev_status_call_failed", providerRef },
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
