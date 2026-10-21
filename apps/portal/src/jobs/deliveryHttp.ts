import { context, propagation } from "@opentelemetry/api";
import {
  INSTRUCTION_HEADER,
  JobRequestErrorSchema,
  JobsLifecycleUpdateAckSchema,
} from "@azx-pbc/shared";
import {
  buildJobsInternalResource,
  JobsOperations,
  mintJobsInstruction,
} from "@azx-pbc/shared/jobsSigning";

import {
  JOBS_DELIVERY_TIMEOUT_MS,
  type LifecycleDeliveryAnswer,
  type LifecycleDeliveryAttempt,
} from "./delivery.js";

/**
 * The portal sender's production transport (ADR-0002): mint one freshly
 * stamped lifecycle instruction per attempt — a retry is a new token with a
 * new `jti`, so the receiver's burn never rejects a legitimate redelivery —
 * and carry the exact body bytes to the target's internal route over global
 * fetch.
 *
 * The contract is the edge forwarder's, narrowed to the one operation this
 * plane mints:
 *
 * - **Bounded.** The whole mint→body wait rides one abort signal — a target
 *   that answers slowly, trickles, or never answers is a verdict
 *   (`unreachable`), not a hung pass.
 * - **Never redirects.** `redirect: "error"` — a signed instruction must not
 *   be re-presented to a host the target's answer chose; a redirect attempt
 *   rejects into `unreachable` and nothing is retried within the pass.
 * - **Classified, never fabricated.** Every ending is one of
 *   `LifecycleDeliveryAnswer`'s kinds: a validated 200 ack, a validated jobs
 *   error response, no answer, or an unusable answer. A body that parses as
 *   neither the ack nor the protocol's error envelope is
 *   `invalid_response`, never a fabricated acknowledgement.
 * - **Inward trace context only.** The active span (the delivery attempt's)
 *   is injected onto the hop so the receiver can join the trace after it
 *   verifies; nothing is extracted from any response.
 */
export class HttpLifecycleDelivery {
  readonly #timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.#timeoutMs = opts.timeoutMs ?? JOBS_DELIVERY_TIMEOUT_MS;
  }

  async deliver(attempt: LifecycleDeliveryAttempt): Promise<LifecycleDeliveryAnswer> {
    // The resource comes from the operation matrix — the signed claim and the
    // requested path are the same string, both derived here.
    const resource = buildJobsInternalResource("lifecycle", { appId: attempt.appId });
    const instruction = await mintJobsInstruction(
      {
        operation: "lifecycle",
        server: attempt.server,
        appId: attempt.appId,
        body: attempt.body,
        iatS: Math.floor(Date.now() / 1_000),
      },
      attempt.key,
    );

    // Inject-only, like every process that terminates untrusted traffic: the
    // receiver extracts only after its own verification.
    const traceContext: Record<string, string> = {};
    propagation.inject(context.active(), traceContext);

    try {
      const res = await fetch(`${attempt.endpoint}${resource}`, {
        method: JobsOperations.lifecycle.method,
        headers: {
          "content-type": "application/json",
          [INSTRUCTION_HEADER]: instruction,
          ...traceContext,
        },
        body: Buffer.from(attempt.body),
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      // The ack and the error envelope are both tiny; the abort signal above
      // bounds the body read along with everything else.
      const text = await res.text();
      const parsed = parseAnswerBody(text);
      if (res.status === 200) {
        const ack = JobsLifecycleUpdateAckSchema.safeParse(parsed);
        if (!ack.success) return { kind: "invalid_response", status: res.status };
        return { kind: "acknowledged", appliedGeneration: ack.data.appliedGeneration };
      }
      if (res.status >= 400 && res.status <= 599) {
        const error = JobRequestErrorSchema.safeParse(parsed);
        if (!error.success) return { kind: "invalid_response", status: res.status };
        return { kind: "refused", status: res.status, error: error.data };
      }
      return { kind: "invalid_response", status: res.status };
    } catch (err) {
      return { kind: "unreachable", error: err };
    }
  }
}

/** The answered body as parsed JSON, or undefined when it is not JSON at all. */
function parseAnswerBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
