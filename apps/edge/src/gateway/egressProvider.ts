import type { Readable } from "node:stream";
import { Agent, request } from "undici";
import { INSTRUCTION_HEADER, METHOD_HEADER, OUTCOME_HEADER, TARGET_HEADER } from "@helix/shared";

/**
 * The edge → egress seam (fetch-proxy design §7), shaped like the `LlmProvider`:
 * the edge has authorized a `/_api/fetch` call and forwards it, with the signed
 * attested instruction, to the mechanism-plane service. The edge holds no secret
 * and has no internet route — it can only ask egress to make a call it already
 * authorized. The upstream body streams back through here untouched.
 */
export interface EgressRequest {
  /** The signed attested instruction JWT. */
  instruction: string;
  /** Full target URL (origin already matched the instruction at the edge). */
  target: string;
  method: string;
  /** Safelisted request headers to forward upstream. */
  headers: Record<string, string>;
  /** Request body for non-GET/HEAD methods; null otherwise. */
  body: Readable | null;
  signal: AbortSignal;
}

export interface EgressResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Readable;
  /** The egress outcome label (OUTCOME_HEADER), for the edge to meter. */
  outcome: string;
}

export interface EgressProvider {
  proxy(req: EgressRequest): Promise<EgressResponse>;
  close(): Promise<void>;
}

export class EgressProviderError extends Error {}

/** undici-backed client to the egress service's internal `/proxy` endpoint. */
export class HttpEgressProvider implements EgressProvider {
  readonly #base: string;
  readonly #dispatcher: Agent;

  constructor(egressUrl: string, opts: { timeoutMs?: number } = {}) {
    this.#base = egressUrl.replace(/\/+$/, "");
    this.#dispatcher = new Agent({
      headersTimeout: opts.timeoutMs ?? 30_000,
      bodyTimeout: opts.timeoutMs ?? 30_000,
    });
  }

  async proxy(req: EgressRequest): Promise<EgressResponse> {
    try {
      const res = await request(`${this.#base}/proxy`, {
        method: "POST",
        headers: {
          ...req.headers,
          [INSTRUCTION_HEADER]: req.instruction,
          [TARGET_HEADER]: req.target,
          [METHOD_HEADER]: req.method,
        },
        body: req.body ?? undefined,
        signal: req.signal,
        dispatcher: this.#dispatcher,
      });
      const outcome = res.headers[OUTCOME_HEADER];
      return {
        status: res.statusCode,
        headers: res.headers as Record<string, string | string[]>,
        body: res.body,
        outcome: typeof outcome === "string" ? outcome : "error",
      };
    } catch (err) {
      throw new EgressProviderError("egress request failed", { cause: err });
    }
  }

  async close(): Promise<void> {
    await this.#dispatcher.close();
  }
}
