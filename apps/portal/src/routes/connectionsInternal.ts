import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CancelRequestSchema,
  CancelResponseSchema,
  ConsultRequestSchema,
  ConsultResponseSchema,
  INTERNAL_AUTH_HEADER,
  type CancelRequest,
  type ConsultRequest,
} from "@azx-pbc/shared";
import type { SecretStore } from "@azx-pbc/secret-store";
import { AppError } from "../plugins/errors.js";
import { deriveInternalKey, resolveInternalSecret, verifyInternalToken } from "../internalJwt.js";
import { cancelConsentAttempt, consultConsent } from "../connections/consent.js";

/**
 * The internal edge→portal consent seam (I-02 architecture ADR-0002 parts 1–2;
 * ADR-0003 §Shared ground): the START CONSULT and the CANCEL, called by the
 * edge with a per-call minted internal JWT (`aud: azx-portal`, minted by
 * `apps/edge/src/internalJwt.ts`). These are service-to-service routes — no
 * browser reaches them (the auth-host consent pages ride the `/connections/*`
 * reverse proxy instead) — and every one of them fails closed on an
 * unverified, wrong-audience, or expired token: 401, never a degraded read.
 *
 * The state decisions live in the consent store (`connections/consent.ts`);
 * this module is authorization, parsing, and the app's wiring of prisma +
 * custody. Responses are parsed through the shared response schemas on the
 * way out, so the wire contract is asserted at the boundary, not merely
 * constructed.
 *
 * The callback (T-0020) is a portal-served page under the `/connections/*`
 * proxy prefix, not a route here; its claim-shaped probe lives in the consent
 * store and carries no route of its own.
 */

/**
 * The internal-JWT gate (ADR-0003: no internal route accepts a call without a
 * verified token). The key is derived once at registration — the boot already
 * failed on a missing/short secret (`assertInternalJwtSecrets`), so a portal
 * serving these routes always has the verify key.
 */
function internalAuth(key: Buffer) {
  return async (req: FastifyRequest): Promise<void> => {
    const raw = req.headers[INTERNAL_AUTH_HEADER];
    const token = typeof raw === "string" ? raw : raw?.[0];
    if (!(await verifyInternalToken(token, key))) {
      throw new AppError("unauthorized", "internal call rejected");
    }
  };
}

export async function connectionsInternalRoutes(app: FastifyInstance): Promise<void> {
  const auth = internalAuth(deriveInternalKey(resolveInternalSecret()));

  /** Custody is required to open a provider's client id for the authorize URL. */
  const store = (): SecretStore => {
    if (!app.secretStore) {
      throw new AppError("capability_unavailable", "secret store is not configured");
    }
    return app.secretStore;
  };

  /** Internal bodies reject with a plain 400: the caller is the edge, not a form. */
  const parseBody = <S extends z.ZodType>(schema: S, body: unknown): z.output<S> => {
    const result = schema.safeParse(body);
    if (!result.success) {
      throw new AppError("validation_failed", "internal request validation failed");
    }
    return result.data;
  };

  app.post("/internal/connections/consult", { preHandler: auth }, async (req) => {
    const body = parseBody(ConsultRequestSchema, req.body) as ConsultRequest;
    return ConsultResponseSchema.parse(await consultConsent(app.prisma, store(), body));
  });

  app.post("/internal/connections/cancel", { preHandler: auth }, async (req) => {
    const body = parseBody(CancelRequestSchema, req.body) as CancelRequest;
    return CancelResponseSchema.parse(await cancelConsentAttempt(app.prisma, body));
  });
}
