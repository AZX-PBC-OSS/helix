import { Agent, request } from "undici";
import { context, propagation } from "@opentelemetry/api";
import { IDEMPOTENCY_KEY_HEADER, INSTRUCTION_HEADER } from "@azx-pbc/shared";
import {
  JobAcceptedSchema,
  type JobAccepted,
  type JobRequestError,
  JobRequestErrorSchema,
  JOBS_MAX_INPUT_BYTES,
} from "@azx-pbc/shared";
import {
  JobsOperations,
  mintJobsInstruction,
  type JobsUserOperationIdentity,
} from "@azx-pbc/shared/jobsSigning";
import { readBoundedBody } from "./boundedBody.js";

/**
 * The edge → jobs forwarding seam (background-jobs-plane design §3, ADR-0002)
 * — the minter and transport the two gateway surfaces share. The edge
 * authorizes a submission against its own registry and caller resolution,
 * then hands the exact request bytes to the configured server's internal
 * route with a signed instruction bound to them; this module is everything
 * past that decision.
 *
 * The contract the consumers share (the submission routes today; the
 * observation and cancellation forwards land on the same seam):
 *
 *  - **One instruction per presentation.** `mintJobsInstruction` binds the
 *    operation's method, resource, body digest and retry identity; a retry is
 *    a fresh instruction with the original retry identity. The forwarder never
 *    re-mints and re-sends on failure — a lost answer is uncertainty the
 *    client resolves by keyed retry, never one this hop may double.
 *  - **Bounded.** The whole mint→answer wait is capped (the same window the
 *    instruction is valid for); a server that does not answer is a verdict,
 *    not a hang.
 *  - **Classified, never fabricated.** Every outcome is one of: a validated
 *    acceptance, a validated jobs error response (forwarded as received), no
 *    answer (`unreachable`), or an unusable answer (`invalid_response`). The
 *    last two leave acceptance uncertain — the caller-facing route answers
 *    the retryable 503 for both and they stay distinguishable in the
 *    telemetry, never collapsed into a fabricated 202 or 404.
 *  - **Server-bound.** An acceptance whose `server` does not match the
 *    configured destination is an `invalid_response`, never a redirect: a
 *    response cannot repoint the caller at another namespace (design §1 —
 *    no cross-server aliasing).
 */

/** Why one forward ended — the caller-facing route maps these onto responses. */
export type JobsSubmitForward =
  | {
      /** The server answered 202 with a valid acceptance naming THIS server. */
      kind: "accepted";
      status: 202;
      accepted: JobAccepted;
      /** The exact response bytes received, forwarded unchanged. */
      rawBody: Uint8Array;
    }
  | {
      /** The server answered with a validated jobs error response. */
      kind: "refused";
      status: number;
      /** The parsed, schema-validated error body — what the route forwards. */
      error: JobRequestError;
    }
  | {
      /** No answer: transport failure or the bound expired. Uncertain. */
      kind: "unreachable";
      error: unknown;
    }
  | {
      /** The server answered an unusable body (or a mismatched reference). Uncertain. */
      kind: "invalid_response";
      status: number;
    };

/** What the route hands the forwarder for one submission. */
export interface JobsSubmitSpec {
  /** The configured server to forward to — already resolved by the route. */
  server: string;
  /** The trusted attribution the edge resolved (never caller input). */
  identity: JobsUserOperationIdentity;
  /** The qualified type, granted and server-matched (checked by the route). */
  type: string;
  /** The app's current lifecycle generation from the registry projection. */
  generation: string;
  /** The optional retry key, signed into the claim (null when none). */
  idempotencyKey: string | null;
  /** The exact request body bytes received. */
  body: Uint8Array;
  /** Aborts the forward when the caller goes away or the bound expires. */
  signal: AbortSignal;
}

/** The forwarding seam the gateway handlers consume (tests substitute it). */
export interface JobsForwarder {
  /** Is this server configured? The routing truth this seam was built from. */
  has(server: string): boolean;
  submit(spec: JobsSubmitSpec): Promise<JobsSubmitForward>;
  close(): Promise<void>;
}

/**
 * undici-backed forwarder over the configured servers' internal endpoints.
 * Built once per process from the loaded configuration; `close()` releases the
 * dispatcher on every shutdown path.
 */
export class HttpJobsForwarder implements JobsForwarder {
  readonly #targets: ReadonlyMap<string, { endpoint: string; key: Uint8Array }>;
  readonly #dispatcher: Agent;
  readonly #timeoutMs: number;
  readonly #clock: () => number;

  constructor(
    servers: Iterable<{ server: string; endpoint: string; edgeToJobsKey: Uint8Array }>,
    opts: { timeoutMs?: number; clock?: () => number } = {},
  ) {
    this.#targets = new Map(
      [...servers].map((s) => [s.server, { endpoint: s.endpoint, key: s.edgeToJobsKey }]),
    );
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#clock = opts.clock ?? Date.now;
    this.#dispatcher = new Agent({
      headersTimeout: this.#timeoutMs,
      bodyTimeout: this.#timeoutMs,
    });
  }

  has(server: string): boolean {
    return this.#targets.has(server);
  }

  async submit(spec: JobsSubmitSpec): Promise<JobsSubmitForward> {
    const target = this.#targets.get(spec.server);
    if (!target) {
      // The route resolves the server through `has` first; reaching this is a
      // wiring defect, not a request answer.
      throw new Error(`the jobs server "${spec.server}" is not configured on this process`);
    }
    const iatS = Math.floor(this.#clock() / 1_000);
    const instruction = await mintJobsInstruction(
      {
        operation: "submit",
        server: spec.server,
        identity: spec.identity,
        type: spec.type,
        generation: spec.generation,
        idempotencyKey: spec.idempotencyKey,
        body: spec.body,
        iatS,
      },
      target.key,
    );

    // Trace context, inward only (ADR-0037 decision 7) — inject-only like every
    // process that terminates untrusted traffic. This injection IS the hop's
    // correlation: the jobs receiver extracts only verified service context,
    // and mints its own request id (`trustInbound: false`), so no header of
    // ours is read over there.
    const traceContext: Record<string, string> = {};
    propagation.inject(context.active(), traceContext);

    try {
      // The instruction's audience and body digest bind this exact forward; the
      // undici agent does not follow redirects by design — a 3xx is the
      // invalid-response class, never a followed hop. The signal is the
      // caller's abort COMBINED with the round-trip bound: the agent's
      // headers/body timeouts are per-wait ceilings, not a total, so a server
      // that answers fast but trickles the body forever would otherwise hold
      // the route open past the request bound.
      const res = await request(`${target.endpoint}${JobsOperations.submit.path}`, {
        method: JobsOperations.submit.method,
        headers: {
          "content-type": "application/json",
          [INSTRUCTION_HEADER]: instruction,
          "content-length": String(spec.body.byteLength),
          // The receiver verifies the signed idempotencyKey claim against the
          // PRESENTED header — the header must travel with the token, or a
          // keyed submission is refused as an idempotency mismatch.
          ...(spec.idempotencyKey !== null
            ? { [IDEMPOTENCY_KEY_HEADER]: spec.idempotencyKey }
            : {}),
          ...traceContext,
        },
        body: Buffer.from(spec.body),
        signal: AbortSignal.any([spec.signal, AbortSignal.timeout(this.#timeoutMs)]),
        dispatcher: this.#dispatcher,
      });
      const bounded = await readBoundedBody(res.body, JOBS_MAX_INPUT_BYTES);
      if (bounded.over || bounded.failed) {
        return { kind: "invalid_response", status: res.statusCode };
      }
      return classify(spec.server, res.statusCode, bounded.bytes);
    } catch (err) {
      return { kind: "unreachable", error: err };
    }
  }

  async close(): Promise<void> {
    await this.#dispatcher.close();
  }
}

/**
 * Map an answered forward onto its verdict: a 202 whose body parses as an
 * acceptance naming the addressed server, or a jobs error response parsed
 * against the protocol's error schema, or the invalid-response class for
 * anything else — an unparseable body, a 2xx that is not the acceptance, or a
 * redirect.
 */
function classify(expectedServer: string, status: number, body: Uint8Array): JobsSubmitForward {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { kind: "invalid_response", status };
  }
  if (status === 202) {
    const verdict = JobAcceptedSchema.safeParse(parsed);
    if (!verdict.success) return { kind: "invalid_response", status };
    // The reference names the server this forward was addressed to, or the
    // answer is unusable — a response cannot repoint the caller.
    if (verdict.data.server !== expectedServer) {
      return { kind: "invalid_response", status };
    }
    return { kind: "accepted", status: 202, accepted: verdict.data, rawBody: body };
  }
  if (status >= 400 && status <= 599) {
    const verdict = JobRequestErrorSchema.safeParse(parsed);
    if (!verdict.success) return { kind: "invalid_response", status };
    return { kind: "refused", status, error: verdict.data };
  }
  return { kind: "invalid_response", status };
}
