import { Readable } from "node:stream";
import {
  CancelResponseSchema,
  ConsultResponseSchema,
  type CancelRequest,
  type CancelResponse,
  type ConsultRequest,
  type ConsultResponse,
} from "@azx-pbc/shared";
import { mintInternalToken } from "../internalJwt.js";
import type { PortalProvider } from "./portalProvider.js";

/**
 * The edge→portal consult and cancel calls (I-02 ADR-0002 §Decision) — shared
 * by the consumers of the consult seam, the prod start route
 * (`consentStart.ts`) and the dev-gateway's start route
 * (`devGateway/consentStart.ts`), and by the cancel-acknowledgement route
 * (`consentCancel.ts`), so the wire contract, the response cap, and the
 * per-call internal JWT are written once. A call failure of any shape —
 * transport, non-200, malformed body — throws; each caller renders its own
 * failure posture (the terminal page, a JSON 503).
 */

/** The consult's path on the portal (apps/portal/src/routes/connectionsInternal.ts). */
const CONSULT_TARGET = "/internal/connections/consult";
/** The cancel's path on the portal (same module). */
const CANCEL_TARGET = "/internal/connections/cancel";

/** The consult/cancel JSON answer is tiny; anything bigger is not a response. */
export const MAX_CONSULT_RESPONSE_BYTES = 1024 * 1024;

/** Read a JSON body under a hard cap (the portal is a trusted plane, but a cap
 * is cheaper than trusting that). */
export async function readCappedJson(body: Readable): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > MAX_CONSULT_RESPONSE_BYTES) {
      throw new Error("consult response exceeded the size cap");
    }
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** The one POST-body plumbing both internal calls share (below). */
async function postInternal(
  portal: PortalProvider,
  internalKey: Buffer,
  target: string,
  request: ConsultRequest | CancelRequest,
  correlationId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const internalToken = await mintInternalToken(internalKey);
  const res = await portal.proxy({
    method: "POST",
    target,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(request))]),
    signal,
    correlationId,
    internalToken,
  });
  if (res.status !== 200) {
    throw new Error("internal call did not answer 200");
  }
  return readCappedJson(res.body);
}

/**
 * One consult call over the portal seam: a per-call minted internal JWT
 * (T-0006, `aud: portal`), the shared request contract on the wire, and the
 * response parsed through the shared schema. Throws on every failure mode —
 * the callers' fixed-message catches are the only thing an operator sees.
 */
export async function callConsult(
  portal: PortalProvider,
  internalKey: Buffer,
  consultRequest: ConsultRequest,
  correlationId: string,
  signal: AbortSignal,
): Promise<ConsultResponse> {
  const parsed = await postInternal(
    portal,
    internalKey,
    CONSULT_TARGET,
    consultRequest,
    correlationId,
    signal,
  );
  return ConsultResponseSchema.parse(parsed);
}

/**
 * One cancel call over the portal seam (T-0012's own-attempts-only cancel) —
 * the same discipline as {@link callConsult}: per-call JWT, the shared
 * CancelRequest contract, the response parsed through the shared schema.
 * Throws on every failure mode; the caller's catch is the operator's signal.
 */
export async function callCancel(
  portal: PortalProvider,
  internalKey: Buffer,
  cancelRequest: CancelRequest,
  correlationId: string,
  signal: AbortSignal,
): Promise<CancelResponse> {
  const parsed = await postInternal(
    portal,
    internalKey,
    CANCEL_TARGET,
    cancelRequest,
    correlationId,
    signal,
  );
  return CancelResponseSchema.parse(parsed);
}
