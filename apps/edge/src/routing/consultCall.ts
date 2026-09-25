import { Readable } from "node:stream";
import { ConsultResponseSchema, type ConsultRequest, type ConsultResponse } from "@azx-pbc/shared";
import { mintInternalToken } from "../internalJwt.js";
import type { PortalProvider } from "./portalProvider.js";

/**
 * The one edge→portal consult call (I-02 ADR-0002 §Decision) — shared by both
 * consumers of the consult seam, the prod start route (`consentStart.ts`) and
 * the dev-gateway's start route (`devGateway/consentStart.ts`), so the wire
 * contract, the response cap, and the per-call internal JWT are written once.
 * A consult failure of any shape — transport, non-200, malformed body —
 * throws; each caller renders its own failure posture (the terminal page, a
 * JSON 503).
 */

/** The consult's path on the portal (apps/portal/src/routes/connectionsInternal.ts). */
const CONSULT_TARGET = "/internal/connections/consult";

/** The consult's JSON answer is tiny; anything bigger is not a consult response. */
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
  const internalToken = await mintInternalToken(internalKey);
  const res = await portal.proxy({
    method: "POST",
    target: CONSULT_TARGET,
    headers: { "content-type": "application/json" },
    body: Readable.from([Buffer.from(JSON.stringify(consultRequest))]),
    signal,
    correlationId,
    internalToken,
  });
  if (res.status !== 200) {
    throw new Error("consult call did not answer 200");
  }
  return ConsultResponseSchema.parse(await readCappedJson(res.body));
}
