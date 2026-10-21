import { Agent, request } from "undici";
import { context, propagation } from "@opentelemetry/api";
import { IDEMPOTENCY_KEY_HEADER, INSTRUCTION_HEADER } from "@azx-pbc/shared";
import {
  JobAcceptedSchema,
  type JobAccepted,
  type JobRequestError,
  JobRequestErrorSchema,
  type JobSnapshot,
  JobSnapshotSchema,
  type JobCancellationAccepted,
  JobCancellationAcceptedSchema,
  JOBS_MAX_RESULT_BYTES,
} from "@azx-pbc/shared";
import {
  JobsOperations,
  buildJobsInternalResource,
  mintJobsInstruction,
  type JobsOperationName,
  type JobsUserOperationIdentity,
} from "@azx-pbc/shared/jobsSigning";
import { readBoundedBody } from "./boundedBody.js";

/**
 * The edge → jobs forwarding seam (background-jobs-plane design §3, ADR-0002)
 * — the minter and transport the two gateway surfaces share. The edge
 * authorizes a request against its own registry and caller resolution, then
 * hands the operation to the configured server's internal route with a signed
 * instruction bound to it; this module is everything past that decision.
 *
 * The contract all four operations share:
 *
 *  - **One instruction per presentation.** `mintJobsInstruction` binds the
 *    operation's method, resource, body digest and (for submit) retry
 *    identity; a retry is a fresh instruction with the original retry
 *    identity. The forwarder never re-mints and re-sends on failure — a lost
 *    answer is uncertainty the client resolves by keyed retry, never one this
 *    hop may double.
 *  - **Bounded.** The whole mint→answer wait is capped (the same window the
 *    instruction is valid for); a server that does not answer is a verdict,
 *    not a hang.
 *  - **Classified, never fabricated.** Every outcome is one of: a validated
 *    success response (forwarded as received), a validated jobs error response
 *    (forwarded as received), no answer (`unreachable`), or an unusable answer
 *    (`invalid_response`). The last two leave the operation's effect
 *    uncertain — the caller-facing route answers the retryable 503 for both
 *    and they stay distinguishable in the telemetry, never collapsed into a
 *    fabricated success or a false 404.
 *  - **Server- and reference-bound.** A success response that names another
 *    server — or, for the operations on an existing record, another job id —
 *    is an `invalid_response`, never a redirect: a response cannot repoint the
 *    caller at another namespace (design §1 — no cross-server aliasing).
 *
 * The submit instruction binds the original request bytes; the snapshot,
 * result and cancel instructions are bodyless and bind the empty digest.
 */

/** Why one submit forward ended — the caller-facing route maps these onto responses. */
export type JobsSubmitForward =
  | {
      /** The server answered 202 with a valid acceptance naming THIS server. */
      kind: "accepted";
      status: 202;
      accepted: JobAccepted;
      /** The exact response bytes received, forwarded unchanged. */
      rawBody: Uint8Array;
    }
  | JobsForwardRefusal
  | JobsForwardUncertain;

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

/**
 * What the route hands the forwarder for one operation on an existing job
 * record — a poll, a result read or a cancellation. The reference's routing
 * half (`jobId`) and the trusted attribution ride the signed instruction; the
 * receiver rechecks ownership and the record's type grant against them.
 */
export interface JobsRecordSpec {
  /** The configured server to forward to — already resolved by the route. */
  server: string;
  /** The trusted attribution the edge resolved (never caller input). */
  identity: JobsUserOperationIdentity;
  /** The addressed job's public id — the reference this operation routes by. */
  jobId: string;
  /** Aborts the forward when the caller goes away or the bound expires. */
  signal: AbortSignal;
}

/** A validated jobs error response — forwarded with its own status. */
export interface JobsForwardRefusal {
  kind: "refused";
  status: number;
  error: JobRequestError;
}

/** The two endings that leave the operation's effect uncertain. */
export type JobsForwardUncertain =
  | { kind: "unreachable"; error: unknown }
  | { kind: "invalid_response"; status: number };

/** A poll's verdict: the validated 200 snapshot naming the addressed reference. */
export type JobsSnapshotForward =
  | { kind: "found"; status: 200; snapshot: JobSnapshot; rawBody: Uint8Array }
  | JobsForwardRefusal
  | JobsForwardUncertain;

/** A result read's verdict: the validated 200 raw JSON result, bytes as received. */
export type JobsResultForward =
  | { kind: "found"; status: 200; rawBody: Uint8Array }
  | JobsForwardRefusal
  | JobsForwardUncertain;

/** A cancellation's verdict: the validated 202 acknowledgement naming the addressed reference. */
export type JobsCancelForward =
  | { kind: "accepted"; status: 202; cancellation: JobCancellationAccepted; rawBody: Uint8Array }
  | JobsForwardRefusal
  | JobsForwardUncertain;

/** The forwarding seam the gateway handlers consume (tests substitute it). */
export interface JobsForwarder {
  /** Is this server configured? The routing truth this seam was built from. */
  has(server: string): boolean;
  submit(spec: JobsSubmitSpec): Promise<JobsSubmitForward>;
  snapshot(spec: JobsRecordSpec): Promise<JobsSnapshotForward>;
  result(spec: JobsRecordSpec): Promise<JobsResultForward>;
  cancel(spec: JobsRecordSpec): Promise<JobsCancelForward>;
  close(): Promise<void>;
}

/** The raw answer of one carried hop, before any response validation. */
type HopAnswer =
  | { kind: "unreachable"; error: unknown }
  | { kind: "invalid_response"; status: number }
  | { kind: "answered"; status: number; body: Uint8Array };

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
    const target = this.#target(spec.server);
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
    const answer = await this.#carry(
      target,
      "submit",
      buildJobsInternalResource("submit"),
      instruction,
      spec.signal,
      { body: spec.body, idempotencyKey: spec.idempotencyKey },
    );
    if (answer.kind !== "answered") return answer;
    return classifySubmit(spec.server, answer.status, answer.body);
  }

  async snapshot(spec: JobsRecordSpec): Promise<JobsSnapshotForward> {
    const answer = await this.#record("snapshot", spec);
    if (answer.kind !== "answered") return answer;
    return classifySnapshot(referenceOf(spec), answer.status, answer.body);
  }

  async result(spec: JobsRecordSpec): Promise<JobsResultForward> {
    const answer = await this.#record("result", spec);
    if (answer.kind !== "answered") return answer;
    return classifyResult(answer.status, answer.body);
  }

  async cancel(spec: JobsRecordSpec): Promise<JobsCancelForward> {
    const answer = await this.#record("cancel", spec);
    if (answer.kind !== "answered") return answer;
    return classifyCancel(referenceOf(spec), answer.status, answer.body);
  }

  async close(): Promise<void> {
    await this.#dispatcher.close();
  }

  /** The configured target for one server — unreachable through `has` first. */
  #target(server: string): { endpoint: string; key: Uint8Array } {
    const target = this.#targets.get(server);
    if (!target) {
      // The route resolves the server through `has` first; reaching this is a
      // wiring defect, not a request answer.
      throw new Error(`the jobs server "${server}" is not configured on this process`);
    }
    return target;
  }

  /** Mint the record operation's bodyless instruction and carry it. */
  async #record(
    operation: Exclude<JobsOperationName, "submit" | "fetch" | "lifecycle">,
    spec: JobsRecordSpec,
  ): Promise<HopAnswer> {
    const target = this.#target(spec.server);
    // The concrete resource fills the matrix's path template — the signed
    // claim and the requested path are the same string, both derived here.
    const resource = buildJobsInternalResource(operation, { jobId: spec.jobId });
    const iatS = Math.floor(this.#clock() / 1_000);
    const instruction = await mintJobsInstruction(
      { operation, server: spec.server, identity: spec.identity, jobId: spec.jobId, iatS },
      target.key,
    );
    return this.#carry(target, operation, resource, instruction, spec.signal, {});
  }

  /**
   * Carry one minted instruction to its endpoint and classify the transport:
   * the raw answer, `unreachable` on no answer, or `invalid_response` when the
   * answer never became a bounded readable body.
   *
   * The instruction's audience and body digest bind this exact forward; the
   * undici agent does not follow redirects by design — a 3xx is the
   * invalid-response class, never a followed hop. The signal is the caller's
   * abort COMBINED with the round-trip bound: the agent's headers/body
   * timeouts are per-wait ceilings, not a total, so a server that answers fast
   * but trickles the body forever would otherwise hold the route open past the
   * request bound. The response bound is the result allowance — the largest
   * response any operation's contract permits; anything bigger is unusable.
   */
  async #carry(
    target: { endpoint: string; key: Uint8Array },
    operation: JobsOperationName,
    resource: string,
    instruction: string,
    signal: AbortSignal,
    payload: { body?: Uint8Array; idempotencyKey?: string | null },
  ): Promise<HopAnswer> {
    // Trace context, inward only (ADR-0037 decision 7) — inject-only like every
    // process that terminates untrusted traffic. This injection IS the hop's
    // correlation: the jobs receiver extracts only verified service context,
    // and mints its own request id (`trustInbound: false`), so no header of
    // ours is read over there.
    const traceContext: Record<string, string> = {};
    propagation.inject(context.active(), traceContext);

    try {
      const res = await request(`${target.endpoint}${resource}`, {
        method: JobsOperations[operation].method,
        headers: {
          ...(payload.body !== undefined ? { "content-type": "application/json" } : {}),
          [INSTRUCTION_HEADER]: instruction,
          ...(payload.body !== undefined
            ? { "content-length": String(payload.body.byteLength) }
            : {}),
          // The receiver verifies the signed idempotencyKey claim against the
          // PRESENTED header — the header must travel with the token, or a
          // keyed submission is refused as an idempotency mismatch. The
          // record operations present none: their claims bind no retry key.
          ...(payload.idempotencyKey != null
            ? { [IDEMPOTENCY_KEY_HEADER]: payload.idempotencyKey }
            : {}),
          ...traceContext,
        },
        ...(payload.body !== undefined ? { body: Buffer.from(payload.body) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.#timeoutMs)]),
        dispatcher: this.#dispatcher,
      });
      const bounded = await readBoundedBody(res.body, JOBS_MAX_RESULT_BYTES);
      if (bounded.over || bounded.failed) {
        return { kind: "invalid_response", status: res.statusCode };
      }
      return { kind: "answered", status: res.statusCode, body: bounded.bytes };
    } catch (err) {
      return { kind: "unreachable", error: err };
    }
  }
}

/** The `{server, jobId}` reference a record forward must come back naming. */
function referenceOf(spec: JobsRecordSpec): { server: string; jobId: string } {
  return { server: spec.server, jobId: spec.jobId };
}

/** The answered body as parsed JSON, or the invalid-response class. */
function parseBody(
  status: number,
  body: Uint8Array,
): { kind: "invalid_response"; status: number } | { kind: "parsed"; parsed: unknown } {
  try {
    return { kind: "parsed", parsed: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return { kind: "invalid_response", status };
  }
}

/**
 * Map an answered non-success onto its verdict: a jobs error response parsed
 * against the protocol's error schema (any 4xx/5xx — the receiver's own
 * sanitized refusals travel with their statuses), or the invalid-response
 * class for anything else (a redirect, a bare envelope).
 */
function classifyRefusal(
  status: number,
  parsed: unknown,
): JobsForwardRefusal | { kind: "invalid_response"; status: number } {
  if (status >= 400 && status <= 599) {
    const verdict = JobRequestErrorSchema.safeParse(parsed);
    if (!verdict.success) return { kind: "invalid_response", status };
    return { kind: "refused", status, error: verdict.data };
  }
  return { kind: "invalid_response", status };
}

/**
 * Map an answered submit forward onto its verdict: a 202 whose body parses as
 * an acceptance naming the addressed server, a validated jobs error response,
 * or the invalid-response class for anything else — an unparseable body, a 2xx
 * that is not the acceptance, or a redirect.
 */
function classifySubmit(
  expectedServer: string,
  status: number,
  body: Uint8Array,
): JobsSubmitForward {
  const verdict = parseBody(status, body);
  if (verdict.kind === "invalid_response") return verdict;
  if (status === 202) {
    const accepted = JobAcceptedSchema.safeParse(verdict.parsed);
    if (!accepted.success) return { kind: "invalid_response", status };
    // The reference names the server this forward was addressed to, or the
    // answer is unusable — a response cannot repoint the caller.
    if (accepted.data.server !== expectedServer) {
      return { kind: "invalid_response", status };
    }
    return { kind: "accepted", status: 202, accepted: accepted.data, rawBody: body };
  }
  return classifyRefusal(status, verdict.parsed);
}

/**
 * Map an answered poll onto its verdict: a 200 whose body parses as the
 * complete snapshot naming the addressed reference, a validated jobs error
 * response, or the invalid-response class for anything else — an unparseable
 * body, a 2xx that is not the snapshot, or a success for another server or
 * another job.
 */
function classifySnapshot(
  expected: { server: string; jobId: string },
  status: number,
  body: Uint8Array,
): JobsSnapshotForward {
  const verdict = parseBody(status, body);
  if (verdict.kind === "invalid_response") return verdict;
  if (status === 200) {
    const snapshot = JobSnapshotSchema.safeParse(verdict.parsed);
    if (!snapshot.success) return { kind: "invalid_response", status };
    // The snapshot names the reference the poll addressed, or the answer is
    // unusable — a response cannot repoint the caller at another server or
    // another job.
    if (snapshot.data.server !== expected.server || snapshot.data.jobId !== expected.jobId) {
      return { kind: "invalid_response", status };
    }
    return { kind: "found", status: 200, snapshot: snapshot.data, rawBody: body };
  }
  return classifyRefusal(status, verdict.parsed);
}

/**
 * Map an answered result read onto its verdict: a 200 whose body IS a JSON
 * value (the raw result — a successful JSON `null` included — forwarded as
 * the exact bytes received, never re-serialized), a validated jobs error
 * response, or the invalid-response class for anything else.
 */
function classifyResult(status: number, body: Uint8Array): JobsResultForward {
  if (status === 200) {
    // Parsing IS the validation here: the result contract is "any JSON value",
    // and a parsed body is one. A body that does not parse is unusable.
    try {
      JSON.parse(new TextDecoder().decode(body));
    } catch {
      return { kind: "invalid_response", status };
    }
    return { kind: "found", status: 200, rawBody: body };
  }
  const verdict = parseBody(status, body);
  if (verdict.kind === "invalid_response") return verdict;
  return classifyRefusal(status, verdict.parsed);
}

/**
 * Map an answered cancellation onto its verdict: a 202 whose body parses as
 * the acknowledgement naming the addressed reference (the receiver's durable
 * intent, not a terminal outcome), a validated jobs error response, or the
 * invalid-response class.
 */
function classifyCancel(
  expected: { server: string; jobId: string },
  status: number,
  body: Uint8Array,
): JobsCancelForward {
  const verdict = parseBody(status, body);
  if (verdict.kind === "invalid_response") return verdict;
  if (status === 202) {
    const ack = JobCancellationAcceptedSchema.safeParse(verdict.parsed);
    if (!ack.success) return { kind: "invalid_response", status };
    // The acknowledgement names the reference the request addressed, or it is
    // unusable — a response cannot repoint the caller.
    if (ack.data.server !== expected.server || ack.data.jobId !== expected.jobId) {
      return { kind: "invalid_response", status };
    }
    return { kind: "accepted", status: 202, cancellation: ack.data, rawBody: body };
  }
  return classifyRefusal(status, verdict.parsed);
}
