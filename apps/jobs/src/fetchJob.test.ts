import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import {
  INSTRUCTION_HEADER,
  JOBS_MAX_RESULT_BYTES,
  JOBS_FETCH_QUALIFIED_TYPE,
  JobErrorMessages,
  type JobErrorCode,
} from "@azx-pbc/shared";
import { verifyJobsInstruction, type JobsFetchCallbackClaims } from "@azx-pbc/shared/jobsSigning";
import {
  ATTR_OUTCOME,
  ATTR_REASON,
  INSTR_JOBS_FETCH_DISPATCHES,
  SPAN_JOBS_FETCH_DISPATCH,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";

import { JobsExecutionError, type JobsExecutionContext } from "./execution.js";
import { makeFetchJobHandler, type FetchJobHandlerOptions } from "./fetchJob.js";

/**
 * The production outbound fetch handler's caller side — the governed dispatch
 * and the bounded result interpretation, against an injected transport (the
 * true network boundary) and an injected clock. The receiver's own decisions
 * are the callback ticket's; its real routes are joined in
 * `fetchJob.integration.test.ts`.
 */

const SERVER_ID = "jobs";
const PROD_BASE = "https://edge.internal.helix";
const DEV_BASE = "https://edge.dev.internal.helix";
const CALLBACK_PATH = "/internal/jobs/v1/fetch";
const TARGET = "https://upstream.example/data.json";

const clock = (): number => 1_800_000_123_456;

function handlerOptions(
  over: Partial<FetchJobHandlerOptions> = {},
): FetchJobHandlerOptions & { fetchCalls: FetchCall[] } {
  const fetchCalls: FetchCall[] = [];
  return {
    serverId: SERVER_ID,
    prodCallbackUrl: PROD_BASE,
    devCallbackUrl: DEV_BASE,
    jobsToEdgeKey: new Uint8Array(32).fill(7),
    timeoutMs: 30_000,
    clock,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
    fetchImpl:
      over.fetchImpl ??
      (async (...args: Parameters<typeof fetch>) => {
        fetchCalls.push(captureCall(args));
        throw new Error("the leg's fetchImpl was not armed");
      }),
    fetchCalls,
  };
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

function captureCall(args: Parameters<typeof fetch>): FetchCall {
  return { url: String(args[0]), init: (args[1] ?? {}) as RequestInit };
}

function record(
  over: Partial<JobsExecutionContext["record"]> = {},
): JobsExecutionContext["record"] {
  return {
    server: SERVER_ID,
    jobId: "job-123",
    type: JOBS_FETCH_QUALIFIED_TYPE,
    appId: "0b9e8c3e-6f2a-4c9b-9e1f-2a4b6c8d0e2f",
    env: "prod",
    ownerKind: "user",
    ownerOid: "4f7a2b3c-9d1e-4a5b-8c6d-0e2f4a6b8c0d",
    generation: "1",
    ...over,
  };
}

function context(
  over: {
    input?: unknown;
    signal?: AbortSignal;
    report?: JobsExecutionContext["report"];
    record?: Partial<JobsExecutionContext["record"]>;
  } = {},
): JobsExecutionContext {
  return {
    input: over.input ?? { url: TARGET },
    attempt: 1,
    record: record(over.record),
    signal: over.signal ?? new AbortController().signal,
    report: over.report ?? (async () => "persisted"),
  };
}

/** A transport stub that answers one fixed response and records the call. */
function answeringFetch(response: Response, calls: FetchCall[]): typeof fetch {
  return (async (...args: Parameters<typeof fetch>) => {
    calls.push(captureCall(args));
    return response;
  }) as typeof fetch;
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The jobs error envelope for one code — the fixed message the schema requires. */
function jobsErrorBody(code: string): string {
  return JSON.stringify({ code, message: JobErrorMessages[code as keyof typeof JobErrorMessages] });
}

/** The reason a handler died with, typed — every terminal exit is a JobsExecutionError. */
async function failureOf(run: () => Promise<unknown>): Promise<JobErrorCode> {
  try {
    await run();
  } catch (error) {
    if (error instanceof JobsExecutionError) return error.code;
    throw error;
  }
  throw new Error("the handler did not fail");
}

let recording: RecordingTelemetry;

beforeAll(() => {
  recording = startRecordingTelemetry();
});
afterEach(() => {
  recording.reset();
});

describe("the governed dispatch", () => {
  test("one dispatch, one POST to the tier's callback, the signed instruction and the {url} body", async () => {
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(jsonResponse(200, '{"answer":42}'), calls),
    });
    const handler = makeFetchJobHandler(opts);
    const result = await handler(context());

    expect(result).toEqual({ answer: 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${PROD_BASE}${CALLBACK_PATH}`);
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>)["content-type"]).toBe(
      "application/json",
    );
    // The signed contract binds one resource: a redirect answer is not it.
    expect(calls[0]!.init.redirect).toBe("error");
    // The body is exactly the validated input, once, as bytes.
    expect(new TextDecoder().decode(calls[0]!.init.body as Uint8Array)).toBe(
      JSON.stringify({ url: TARGET }),
    );
  });

  test("the minted instruction verifies against this server's jobs→edge key with the exact bindings", async () => {
    const calls: FetchCall[] = [];
    const key = new Uint8Array(32).fill(9);
    const opts = handlerOptions({
      jobsToEdgeKey: key,
      fetchImpl: answeringFetch(jsonResponse(200, "null"), calls),
    });
    const result = await makeFetchJobHandler(opts)(context());
    expect(result).toBeNull(); // JSON null is a result

    const token = (calls[0]!.init.headers as Record<string, string>)[INSTRUCTION_HEADER] ?? "";
    const body = new TextEncoder().encode(
      new TextDecoder().decode(calls[0]!.init.body as Uint8Array),
    );
    const verdict = await verifyJobsInstruction(
      token,
      key,
      {
        server: SERVER_ID,
        operation: "fetch",
        method: "POST",
        resource: CALLBACK_PATH,
        body,
      },
      Math.floor(clock() / 1_000),
    );
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const claims = verdict.claims as JobsFetchCallbackClaims;
    expect(claims).toMatchObject({
      server: SERVER_ID,
      operation: "fetch",
      method: "POST",
      resource: CALLBACK_PATH,
      appId: record().appId,
      env: "prod",
      ownerKind: "user",
      ownerOid: record().ownerOid,
      type: JOBS_FETCH_QUALIFIED_TYPE,
      jobId: "job-123",
      generation: "1",
    });
  });

  test("a dev job dispatches to the dev destination — no fallback between tiers", async () => {
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(jsonResponse(200, "null"), calls),
    });
    await makeFetchJobHandler(opts)(context({ record: { env: "dev" } }));
    expect(calls[0]!.url).toBe(`${DEV_BASE}${CALLBACK_PATH}`);
  });

  test("an input off the fetch contract never dispatches — the handler's own parse is the third reader of the one schema", async () => {
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(jsonResponse(200, "1"), calls),
    });
    await expect(
      makeFetchJobHandler(opts)(context({ input: { url: "ftp://upstream.example/data" } })),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("the attempt's abort signal is presented to the transport alongside the outbound bound", async () => {
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(jsonResponse(200, "null"), calls),
    });
    const controller = new AbortController();
    await makeFetchJobHandler(opts)(context({ signal: controller.signal }));
    const signal = calls[0]!.init.signal as AbortSignal;
    expect(signal).toBeDefined();
    // The combined signal aborts when the attempt's own does — the handler
    // hands the transport exactly one signal that carries both aborts.
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("the bounded result interpretation", () => {
  test("the complete upstream JSON value is the result — scalars included", async () => {
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(jsonResponse(200, "42"), calls),
    });
    expect(await makeFetchJobHandler(opts)(context())).toBe(42);
  });

  test("JSON null is a result, and the one progress unit completes only now", async () => {
    const calls: FetchCall[] = [];
    const reports: unknown[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(jsonResponse(200, "null"), calls),
    });
    await makeFetchJobHandler(opts)(
      context({ report: async (progress) => (reports.push(progress), "persisted") }),
    );
    expect(reports).toEqual([{ step: 1, of: 1, label: "fetched" }]);
  });

  test("a failed dispatch never reports progress", async () => {
    const reports: unknown[] = [];
    const opts = handlerOptions({
      fetchImpl: async () => jsonResponse(403, jobsErrorBody("outbound_forbidden")),
    });
    await expect(
      failureOf(() =>
        makeFetchJobHandler(opts)(
          context({ report: async (progress) => (reports.push(progress), "persisted") }),
        ),
      ),
    ).resolves.toBe("outbound_forbidden");
    expect(reports).toEqual([]);
  });

  test("a body over the result allowance stops the stream and fails oversized — the excess bytes are never read", async () => {
    let reads = 0;
    let cancelled = false;
    const chunk = Buffer.alloc(4096, 0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        calls.push(captureCall(args));
        return new Response(stream, { status: 200 });
      }) as typeof fetch,
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("result_too_large");
    expect(cancelled).toBe(true);
    // The stream was stopped within a read or two past the cap — never read
    // to its end (the stub would have produced chunks forever).
    expect(reads).toBeLessThan(JOBS_MAX_RESULT_BYTES / 4096 + 4);
  });

  test("a body the edge ended cleanly one byte past the allowance fails oversized, never invalid", async () => {
    // The edge caps the callback's stream at JOBS_MAX_RESULT_BYTES + 1 and
    // ends it normally there (`apps/edge/src/jobs/resultCap.ts`). The bytes
    // before the cut are a complete JSON value; the classification must still
    // be the size, not a parse of a short body.
    const text = `${JSON.stringify("x".repeat(JOBS_MAX_RESULT_BYTES - 2))} `;
    expect(Buffer.byteLength(text)).toBe(JOBS_MAX_RESULT_BYTES + 1);
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(new Response(text, { status: 200 }), calls),
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("result_too_large");
  });

  test("a body exactly at the allowance is accepted — the bound is inclusive", async () => {
    // 65,536 bytes of valid JSON text (a quoted string of the exact size).
    const text = JSON.stringify("x".repeat(JOBS_MAX_RESULT_BYTES - 2));
    expect(Buffer.byteLength(text)).toBe(JOBS_MAX_RESULT_BYTES);
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(new Response(text, { status: 200 }), calls),
    });
    expect(await makeFetchJobHandler(opts)(context())).toBe("x".repeat(JOBS_MAX_RESULT_BYTES - 2));
  });

  test("a result at the byte cap's maximum legal nesting depth round-trips the handler — the wire parse holds where the seam's walk accepts", async () => {
    // The contract lets a result nest ~32,766 deep at the 64-KiB cap — past
    // the engine's recursive serializer's stack — and the handler's own
    // `JSON.parse` of the wire bytes is the one step the seam's iterative walk
    // cannot protect: if that parse threw, a value the value contract calls
    // legal would never reach the seam (the seam's own half of the depth is
    // pinned in execution.test.ts; this leg pins the handler's).
    const depth = (JOBS_MAX_RESULT_BYTES - 4) / 2;
    const wire = "[".repeat(depth) + "null" + "]".repeat(depth);
    expect(Buffer.byteLength(wire)).toBe(JOBS_MAX_RESULT_BYTES);
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: answeringFetch(new Response(wire, { status: 200 }), calls),
    });
    const result = await makeFetchJobHandler(opts)(context());
    // The value is the deep array itself — verified by an iterative descent
    // (a recursive deep-equality would throw before any assertion could answer).
    let remaining = depth;
    let node: unknown = result;
    while (remaining > 0) {
      expect(Array.isArray(node), `at remaining depth ${remaining}`).toBe(true);
      node = (node as unknown[])[0];
      remaining -= 1;
    }
    expect(node).toBeNull();
  });

  test("missing and invalid JSON are distinct from an oversized body — both terminal, nothing stored", async () => {
    for (const body of ["", "  ", "{not json", '{"truncated": ']) {
      const calls: FetchCall[] = [];
      const opts = handlerOptions({
        fetchImpl: answeringFetch(jsonResponse(200, body), calls),
      });
      expect(
        await failureOf(() => makeFetchJobHandler(opts)(context())),
        JSON.stringify(body),
      ).toBe("result_invalid");
    }
  });

  test("a bodyless 200 is not a JSON-null result — absence of a body is absence of a value", async () => {
    // A response with no body at all (the transport's answer to a 204-shaped
    // success, say) reads as zero bytes: JSON null is the two-byte value the
    // upstream sent, never what its absence decodes to.
    const opts = handlerOptions({
      fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("result_invalid");
  });

  test("a refused progress report does not fail the dispatch — the value is still returned for the fence to judge", async () => {
    const opts = handlerOptions({
      fetchImpl: answeringFetch(jsonResponse(200, '"ok"'), []),
    });
    const result = await makeFetchJobHandler(opts)(context({ report: async () => "refused" }));
    expect(result).toBe("ok");
  });
});

describe("the callback refusals — distinct terminal reasons", () => {
  test.each([
    [403, "outbound_forbidden", "outbound_forbidden"],
    [403, "delegated_unattended", "delegated_unattended"],
    [429, "outbound_quota_exceeded", "outbound_quota_exceeded"],
    [502, "upstream_error", "upstream_error"],
  ])("the callback's %i %s becomes the job's terminal reason", async (status, code, expected) => {
    const opts = handlerOptions({
      fetchImpl: async () => jsonResponse(status, jobsErrorBody(code)),
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe(expected);
  });

  test.each([
    [401, "unauthorized"],
    [503, "jobs_unavailable"],
    [503, "jobs_disabled"],
    [400, "payload_invalid"],
    [413, "payload_too_large"],
  ])("the callback's own machinery failing (%i %s) is a platform failure", async (status, code) => {
    const opts = handlerOptions({
      fetchImpl: async () => jsonResponse(status, jobsErrorBody(code)),
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("platform_error");
  });

  test("a failure status outside the protocol's error envelope is a platform failure", async () => {
    for (const body of ["<html>gateway error</html>", "", JSON.stringify({ message: "no code" })]) {
      const opts = handlerOptions({
        fetchImpl: async () => jsonResponse(502, body),
      });
      expect(await failureOf(() => makeFetchJobHandler(opts)(context())), body).toBe(
        "platform_error",
      );
    }
  });

  test("a refusal body past the result allowance is refused inside the bound — the excess never read", async () => {
    // The bounded read protects the failure path too: the callback's answer
    // is read under the same allowance as a success, so a drifting receiver
    // cannot stream unbounded bytes into the job under a failure status.
    let reads = 0;
    let cancelled = false;
    const chunk = Buffer.alloc(4096, 0x61);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        controller.enqueue(new Uint8Array(chunk));
      },
      cancel() {
        cancelled = true;
      },
    });
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        calls.push(captureCall(args));
        return new Response(stream, { status: 502 });
      }) as typeof fetch,
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("platform_error");
    expect(cancelled).toBe(true);
    expect(reads).toBeLessThan(JOBS_MAX_RESULT_BYTES / 4096 + 4);

    const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_FETCH_DISPATCH);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[ATTR_OUTCOME]).toBe("invalid_response");
    expect(spans[0]!.attributes[ATTR_REASON]).toBe("refusal_over_cap");
  });

  test("a refusal body that fails mid-read is the classified upstream failure — never a partial refusal", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('{"code":')));
        controller.error(new Error("connection reset"));
      },
    });
    const opts = handlerOptions({
      fetchImpl: (async () => new Response(stream, { status: 502 })) as typeof fetch,
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("upstream_error");
  });
});

describe("the bounded waits", () => {
  /**
   * A transport that mimics undici's abort discipline: an already-aborted
   * signal rejects immediately (the mint's own await can lose the race with
   * the test's abort), an in-flight one rejects when the signal fires, and
   * otherwise the call never answers.
   */
  function hangingFetch(calls: FetchCall[]): typeof fetch {
    return (async (...args: Parameters<typeof fetch>) => {
      calls.push(captureCall(args));
      const signal = (args[1]?.signal as AbortSignal | undefined) ?? null;
      return new Promise<Response>((_, reject) => {
        if (signal?.aborted) {
          reject(new Error("The operation was aborted", { cause: signal.reason }));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new Error("The operation was aborted", { cause: signal.reason })),
          { once: true },
        );
      });
    }) as typeof fetch;
  }

  test("the attempt's abort stops the dispatch — the job's reason is the cancellation", async () => {
    const calls: FetchCall[] = [];
    const opts = handlerOptions({ fetchImpl: hangingFetch(calls) });
    const controller = new AbortController();
    const run = makeFetchJobHandler(opts)(context({ signal: controller.signal }));
    const failed = failureOf(() => run);
    controller.abort();
    expect(await failed).toBe("cancelled");
    const signal = calls[0]!.init.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  });

  test("the outbound bound stops the dispatch — the job's reason is the timeout", async () => {
    const calls: FetchCall[] = [];
    const opts = handlerOptions({ fetchImpl: hangingFetch(calls), timeoutMs: 50 });
    const failed = failureOf(() => makeFetchJobHandler(opts)(context()));
    await new Promise((r) => setTimeout(r, 150));
    await expect(failed).resolves.toBe("timeout");
    const signal = calls[0]!.init.signal as AbortSignal;
    expect(signal.aborted).toBe(true);
  }, 10_000);

  test("the outbound bound stops a trickling response MID-STREAM — the job's reason is the timeout, no partial result", async () => {
    // Headers arrive fast; the body trickles past the bound. A real
    // transport errors the body stream when the dispatch's signal aborts
    // (the connection is destroyed — a pending read rejects, it never
    // presents a truncation as the end); the stub's stream mimics exactly
    // that discipline.
    const observed: { signal: AbortSignal | null } = { signal: null };
    let errorController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const trickling = new ReadableStream<Uint8Array>({
      start(controller) {
        errorController = controller;
        controller.enqueue(new Uint8Array(Buffer.from('{"partial":')));
      },
      pull() {
        // Never enqueues again — the next read pends until the abort.
      },
    });
    const opts = handlerOptions({
      timeoutMs: 80,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        observed.signal = (args[1]?.signal as AbortSignal | undefined) ?? null;
        // The stream errors when the transport's own signal aborts — the
        // discipline undici's connection teardown gives the body stream.
        observed.signal?.addEventListener(
          "abort",
          () => errorController?.error(new Error("The operation was aborted")),
          { once: true },
        );
        return new Response(trickling, { status: 200 });
      }) as typeof fetch,
    });
    const failed = failureOf(() => makeFetchJobHandler(opts)(context()));
    await new Promise((r) => setTimeout(r, 250));
    expect(await failed).toBe("timeout");
    expect(observed.signal?.aborted).toBe(true);
  }, 10_000);

  test("a transport failure without an abort is a platform failure", async () => {
    const opts = handlerOptions({
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("platform_error");
  });

  test("a cancellation is the honest reason even when the outbound bound has also expired", async () => {
    // Both aborts dead when the transport answers: the attempt's own abort
    // decides (a cancelled job is never misattributed as a timeout), the
    // bound's expiry being only the other way the wait can end.
    const calls: FetchCall[] = [];
    const opts = handlerOptions({
      timeoutMs: 40,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        calls.push(captureCall(args));
        // Answer only after both aborts are dead — the attempt's abort (the
        // test's controller, fired below) and the 40ms bound — then fail at
        // the transport the way a torn connection's would.
        return new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new Error("The operation was aborted")), 150);
        });
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const failed = failureOf(() =>
      makeFetchJobHandler(opts)(context({ signal: controller.signal })),
    );
    controller.abort();
    expect(await failed).toBe("cancelled");
    expect((calls[0]!.init.signal as AbortSignal).aborted).toBe(true);
  }, 10_000);

  test("the cancellation outranks the expired bound on a mid-read failure too — the refusal stream dies after both aborts", async () => {
    const observed: { signal: AbortSignal | null } = { signal: null };
    const opts = handlerOptions({
      timeoutMs: 40,
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        observed.signal = (args[1]?.signal as AbortSignal | undefined) ?? null;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // The refusal's envelope never finishes: the stream dies only
              // after both aborts are dead (the attempt's abort fired below,
              // the 40ms bound expires well before this), then the read
              // fails the way a torn connection's would.
              setTimeout(() => controller.error(new Error("connection reset")), 150);
            },
          }),
          { status: 502 },
        );
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const failed = failureOf(() =>
      makeFetchJobHandler(opts)(context({ signal: controller.signal })),
    );
    controller.abort();
    expect(await failed).toBe("cancelled");
    expect(observed.signal?.aborted).toBe(true);
  }, 10_000);

  test("a mid-stream failure after the headers is the upstream failure — never a partial result", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from('{"partial":')));
        controller.error(new Error("connection reset"));
      },
    });
    const opts = handlerOptions({
      fetchImpl: (async () => new Response(stream, { status: 200 })) as typeof fetch,
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("upstream_error");
  });
});

describe("the dispatch telemetry", () => {
  test("the dispatch span carries the bounded outcome and reason — and never any URL, token or owner value", async () => {
    const opts = handlerOptions({
      fetchImpl: async () => jsonResponse(403, jobsErrorBody("outbound_forbidden")),
    });
    // The dispatch's own verdict is asserted — the leg's subject is the span
    // it settles, never a discarded error.
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("outbound_forbidden");

    const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_FETCH_DISPATCH);
    expect(spans).toHaveLength(1);
    const attrs: Record<string, unknown> = { ...spans[0]!.attributes };
    expect(attrs[ATTR_OUTCOME]).toBe("refused");
    expect(attrs[ATTR_REASON]).toBe("outbound_forbidden");
    expect(attrs["helix.app_id"]).toBe(record().appId);
    expect(attrs["helix.jobs.job_id"]).toBe("job-123");
    // The grading contract: a designed refusal stays UNSET — the platform
    // working as designed (the execute span's own rule).
    expect(spans[0]!.status.code).toBe(SpanStatusCode.UNSET);
    // The privacy rule, over EVERY attribute: no URL of any kind (the
    // forbidden keys, the target, or the callback base), no token, no owner.
    const serialized = JSON.stringify(attrs);
    expect(serialized).not.toContain("upstream.example");
    expect(serialized).not.toContain("edge.internal");
    expect(serialized).not.toContain("ey"); // no JWT fragment
    expect(serialized).not.toContain(record().ownerOid);
    for (const key of Object.keys(attrs)) {
      expect(["url.full", "http.url", "http.target", "url.query"]).not.toContain(key);
    }
  });

  test("the callback seam failing grades the dispatch span ERROR — a platform fault, not a job's answer", async () => {
    const opts = handlerOptions({
      fetchImpl: async () => jsonResponse(503, jobsErrorBody("jobs_unavailable")),
    });
    expect(await failureOf(() => makeFetchJobHandler(opts)(context()))).toBe("platform_error");

    const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_FETCH_DISPATCH);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.attributes[ATTR_OUTCOME]).toBe("callback_unavailable");
    expect(spans[0]!.attributes[ATTR_REASON]).toBe("jobs_unavailable");
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  test("a successful dispatch counts on the dispatch counter with the dispatched outcome", async () => {
    // Cumulative counters live in the shared provider (a second registration
    // is a no-op), so the assertion is the before/after delta of the
    // dispatched outcome's point — the module's own lifecycle pattern.
    const dispatchedDelta = async (): Promise<number> =>
      (await recording.metrics())
        .filter((p) => p.name === INSTR_JOBS_FETCH_DISPATCHES)
        .filter((p) => p.attributes[ATTR_OUTCOME] === "dispatched")
        .reduce((n, p) => n + p.value, 0);
    const before = await dispatchedDelta();
    const opts = handlerOptions({
      fetchImpl: async () => jsonResponse(200, "null"),
    });
    await makeFetchJobHandler(opts)(context());
    expect((await dispatchedDelta()) - before).toBe(1);
  });

  test("the dispatch span is a CLIENT child of the attempt's active span — the jobs side of the hop's story", async () => {
    // The hop's taxonomy: the dispatch continues whatever span is active (in
    // production, the attempt's `helix.jobs.execute` root) as a CLIENT span —
    // never a new root, which is the receiver's own rule when it answers.
    const opts = handlerOptions({
      fetchImpl: async () => jsonResponse(200, "null"),
    });
    await trace.getTracer("test").startActiveSpan("test.execute", async (parent) => {
      await makeFetchJobHandler(opts)(context());
      parent.end();
    });
    const spans = recording.spans();
    const dispatch = spans.find((s) => s.name === SPAN_JOBS_FETCH_DISPATCH);
    expect(dispatch?.kind).toBe(SpanKind.CLIENT);
    expect(dispatch?.parentSpanContext?.spanId).toBe(
      spans.find((s) => s.name === "test.execute")?.spanContext().spanId,
    );
  });
});
