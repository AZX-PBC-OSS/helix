import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import { INTERNAL_AUTH_HEADER } from "@azx-pbc/shared";
import { context, propagation } from "@opentelemetry/api";
import { REQUEST_ID_HEADER } from "@azx-pbc/shared/logging";

/**
 * The edge → portal seam (I-02 architecture ADR-0002, parts 1 and 3), shaped
 * like the `EgressProvider`: the auth host's `/connections/*` reverse proxy
 * forwards the browser-facing consent surface to `helix-portal` — on ACA one
 * hostname binds one container app, so the portal cannot answer at the auth
 * host directly — and the consent start route's internal consult (T-0014)
 * calls the same client. Authorization is T-0006's per-call internal JWT
 * (`aud: portal`), minted by the caller and written here; the upstream body
 * streams through untouched.
 */
export interface PortalProxyRequest {
  method: string;
  /**
   * Path + query on the portal. Two shapes ride this seam: the auth host's
   * browser-facing proxy forwards under the `/connections` prefix, and the
   * consent start route's internal consult (T-0014) targets
   * `/internal/connections/consult`.
   */
  target: string;
  /**
   * Safelisted request headers to forward upstream. Never includes
   * {@link INTERNAL_AUTH_HEADER} — the minted token is written after this
   * spread, so an inbound (forged) version cannot survive the hop.
   */
  headers: Record<string, string>;
  /**
   * Request body for non-GET/HEAD methods; null otherwise. Always a `Readable`
   * — the proxy streams the browser's body, never buffers it.
   */
  body: Readable | null;
  signal: AbortSignal;
  /**
   * The edge's own request id, so both halves of this call land on one value in
   * two different Log Analytics workspaces (the same job `correlationId` does
   * on the egress seam).
   */
  correlationId: string;
  /** The edge-minted internal JWT (T-0006, `aud: portal`). */
  internalToken: string;
}

export interface PortalProxyResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Readable;
}

export interface PortalProvider {
  proxy(req: PortalProxyRequest): Promise<PortalProxyResponse>;
  close(): Promise<void>;
}

export class PortalProviderError extends Error {}

/** undici-backed client to the portal's `/connections` surface. */
export class HttpPortalProvider implements PortalProvider {
  readonly #base: string;
  readonly #dispatcher: Agent;

  constructor(portalUrl: string, opts: { timeoutMs?: number } = {}) {
    this.#base = portalUrl.replace(/\/+$/, "");
    this.#dispatcher = new Agent({
      headersTimeout: opts.timeoutMs ?? 30_000,
      bodyTimeout: opts.timeoutMs ?? 30_000,
    });
  }

  async proxy(req: PortalProxyRequest): Promise<PortalProxyResponse> {
    // Trace context, inward only (ADR-0037 decision 7) — the same inject-only
    // posture as the egress seam; `propagation.inject` writes nothing when no
    // SDK is registered, the platform's default state.
    //
    // Platform headers go AFTER `req.headers` — the safelisted set forwarded
    // from the browser's request — so a client-supplied value can never shadow
    // ours. The internal header in particular: the caller has already stripped
    // any inbound version at the safelist, and this ordering is the guarantee
    // that does not depend on that list (ADR-0003 §Implementation Notes).
    const traceContext: Record<string, string> = {};
    propagation.inject(context.active(), traceContext);

    try {
      const res = await request(`${this.#base}${req.target}`, {
        method: req.method,
        headers: {
          ...req.headers,
          [INTERNAL_AUTH_HEADER]: req.internalToken,
          [REQUEST_ID_HEADER]: req.correlationId,
          ...traceContext,
        },
        body: req.body ?? undefined,
        signal: req.signal,
        dispatcher: this.#dispatcher,
      });
      return {
        status: res.statusCode,
        headers: res.headers as Record<string, string | string[]>,
        body: res.body,
      };
    } catch (err) {
      // Fixed wrapper message: the span's recordException reaches a retained
      // backend, and undici's own error text is not audited for URL content.
      throw new PortalProviderError("portal request failed", { cause: err });
    }
  }

  async close(): Promise<void> {
    await this.#dispatcher.close();
  }
}
