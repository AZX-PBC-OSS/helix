import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { request as undiciRequest } from "undici";
import type { FastifyInstance } from "fastify";
import { jobRequestError } from "@azx-pbc/shared";
import {
  INSTR_JOBS_SUBMISSIONS,
  JOBS_SUBMISSION_OUTCOMES,
  SPAN_JOBS_SUBMIT_EDGE,
  type JobsSubmissionOutcome,
} from "@azx-pbc/shared/telemetry";
import {
  startRecordingTelemetry,
  type RecordedMetric,
  type RecordingTelemetry,
} from "@azx-pbc/telemetry/testing";
import { SESSION_COOKIE } from "../auth/cookies.js";
import {
  buildDisabledJobsEdge as buildDisabledJobsEdgeHarness,
  buildJobsEdge as buildJobsEdgeHarness,
  FakeJobsForwarder,
  JOBS_APP_ID as APP_ID,
  JOBS_HOST as HOST,
  JOBS_ORIGIN as ORIGIN,
  seedJobsSession as seedSession,
  type JobsHarness,
} from "../test/jobsGateway.js";
import { until, withServer } from "../test/socket.js";

/**
 * The submission route's outcome telemetry (ADR-0037 + the observability
 * inventory): every early return lands its own `JOBS_SUBMISSION_OUTCOMES` word
 * on both the `helix.jobs.submissions` counter and the route span, one point
 * per request including the local refusals, and the two uncertain answers stay
 * distinguishable in the evidence an operator reads — the span's `helix.outcome`
 * and the bounded warn events — while the caller-facing answer is identical.
 * The route's responses themselves are pinned in `gateway/jobs.test.ts`.
 */

const { logLines } = vi.hoisted(() => ({ logLines: [] as Record<string, unknown>[] }));

vi.mock(import("@azx-pbc/shared/logging"), async (importOriginal) => {
  const actual = await importOriginal();
  const { Writable } = await import("node:stream");
  const real = actual.loggerOption("production");
  if (real === false) throw new Error("loggerOption('production') must carry the serializers");
  // buildApp resolves its pino options through this seam; under NODE_ENV=test
  // the real one is `false` (quiet). The same options feed a capture sink so
  // the route's failure events are assertable at the log boundary. The real
  // option's inferred type carries no `stream` — no production caller hands
  // pino a sink; pino's own option shape does.
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of String(chunk).split("\n")) {
        if (line.trim() !== "") logLines.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const withSink = { ...real, level: "warn" as const, stream: sink } as typeof real;
  return { ...actual, loggerOption: () => withSink };
});

const SUBMIT_URL = "/_api/jobs/jobs/types/fetch";

const openApps: FastifyInstance[] = [];
let recording: RecordingTelemetry;

beforeAll(() => {
  recording = startRecordingTelemetry();
});

afterEach(async () => {
  for (const app of openApps) await app.close();
  openApps.length = 0;
  recording.reset();
  logLines.length = 0;
});

afterAll(async () => {
  await recording.restore();
});

/** The shared builders, wrapped so this file's afterEach closes every app. */
function buildJobsEdge(
  opts: { forwarder?: FakeJobsForwarder; visibilityMode?: "internal" | "public" } = {},
): JobsHarness {
  const harness = buildJobsEdgeHarness(opts);
  openApps.push(harness.app);
  return harness;
}

function buildDisabledJobsEdge(): JobsHarness {
  const harness = buildDisabledJobsEdgeHarness();
  openApps.push(harness.app);
  return harness;
}

async function submit(
  edge: Pick<JobsHarness, "app" | "sessions">,
  url: string,
  opts: {
    token?: string | null;
    payload?: string;
    headers?: Record<string, string | undefined>;
  } = {},
): Promise<{ status: number; json: unknown }> {
  const res = await edge.app.inject({
    method: "POST",
    url,
    headers: {
      host: HOST.host,
      "sec-fetch-mode": "cors",
      "content-type": "application/json",
      origin: ORIGIN,
      ...(opts.token ? { cookie: `${SESSION_COOKIE}=${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
  });
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.statusCode, json };
}

function isJobsError(value: unknown, code: string): boolean {
  return typeof value === "object" && value !== null && (value as { code?: unknown }).code === code;
}

type RecordedSpan = ReturnType<RecordingTelemetry["spans"]>[number];

/** Per-word request-count delta between two cumulative counter snapshots. */
function submissionsDelta(before: RecordedMetric[], after: RecordedMetric[]): Map<string, number> {
  const base = new Map<string, number>();
  for (const point of before) {
    if (point.name === INSTR_JOBS_SUBMISSIONS) {
      base.set(String(point.attributes["helix.outcome"]), point.value);
    }
  }
  const delta = new Map<string, number>();
  for (const point of after) {
    if (point.name !== INSTR_JOBS_SUBMISSIONS) continue;
    const word = String(point.attributes["helix.outcome"]);
    delta.set(word, point.value - (base.get(word) ?? 0));
  }
  return delta;
}

describe("the submission route's outcome telemetry", () => {
  it("every early return lands its own vocabulary word on the counter and the span", async () => {
    const std = buildJobsEdge();
    const publicEdge = buildJobsEdge({ visibilityMode: "public" });
    const disabled = buildDisabledJobsEdge();
    const token = await seedSession(std.sessions, "alice");
    const disabledToken = await seedSession(disabled.sessions, "alice");
    // A distinctive key and body marker ride EVERY case's request, so the
    // dump-scan below holds for every outcome's span, not just the accepted
    // one: an unbounded attribute added on any refusal path — a "helpful
    // debug" field echoing the retry key or the input — fails here.
    const plantedPayload = (word: string): string =>
      JSON.stringify({ url: "https://api.vendor.test/", planted: `PLANTED-BODY-${word}` });
    const plantedKey = (word: string): string => `PLANTED-KEY-${word}`;

    const cases: { word: JobsSubmissionOutcome; run: () => Promise<unknown> }[] = [
      {
        word: "unavailable",
        run: () =>
          submit(std, SUBMIT_URL, {
            token,
            payload: plantedPayload("unavailable"),
            headers: {
              host: "nosuch.local.helix.azxlabs.io",
              "idempotency-key": plantedKey("unavailable"),
            },
          }),
      },
      {
        word: "unauthorized",
        run: () =>
          submit(std, SUBMIT_URL, {
            token: null,
            payload: plantedPayload("unauthorized"),
            headers: { "idempotency-key": plantedKey("unauthorized") },
          }),
      },
      {
        word: "forbidden",
        run: () =>
          submit(publicEdge, SUBMIT_URL, {
            token: null,
            payload: plantedPayload("forbidden"),
            headers: { "idempotency-key": plantedKey("forbidden") },
          }),
      },
      {
        word: "server_unknown",
        run: () =>
          submit(std, "/_api/jobs/nosuch/types/fetch", {
            token,
            payload: plantedPayload("server_unknown"),
            headers: { "idempotency-key": plantedKey("server_unknown") },
          }),
      },
      {
        word: "key_invalid",
        run: () =>
          submit(std, SUBMIT_URL, {
            token,
            payload: plantedPayload("key_invalid"),
            // The word comes FROM the invalid key: empty stays empty here.
            headers: { "idempotency-key": "" },
          }),
      },
      {
        word: "payload_too_large",
        run: () =>
          submit(std, SUBMIT_URL, {
            token,
            payload: JSON.stringify({
              url: "https://api.vendor.test/",
              planted: "PLANTED-BODY-payload_too_large",
              pad: "x".repeat(66_000),
            }),
            headers: { "idempotency-key": plantedKey("payload_too_large") },
          }),
      },
      {
        word: "accepted",
        run: () =>
          submit(std, SUBMIT_URL, {
            token,
            payload: plantedPayload("accepted"),
            headers: { "idempotency-key": plantedKey("accepted") },
          }),
      },
      {
        word: "server_refused",
        run: () => {
          std.forwarder.submitVerdict = {
            kind: "refused",
            status: 409,
            error: jobRequestError("idempotency_conflict", { status: "queued", error: null }),
          };
          return submit(std, SUBMIT_URL, {
            token,
            payload: plantedPayload("server_refused"),
            headers: { "idempotency-key": plantedKey("server_refused") },
          });
        },
      },
      {
        word: "unreachable",
        run: () => {
          std.forwarder.submitVerdict = { kind: "unreachable", error: new Error("no answer") };
          return submit(std, SUBMIT_URL, {
            token,
            payload: plantedPayload("unreachable"),
            headers: { "idempotency-key": plantedKey("unreachable") },
          });
        },
      },
      {
        word: "invalid_response",
        run: () => {
          std.forwarder.submitVerdict = { kind: "invalid_response", status: 202 };
          return submit(std, SUBMIT_URL, {
            token,
            payload: plantedPayload("invalid_response"),
            headers: { "idempotency-key": plantedKey("invalid_response") },
          });
        },
      },
      {
        word: "disabled",
        run: () =>
          submit(disabled, SUBMIT_URL, {
            token: disabledToken,
            payload: plantedPayload("disabled"),
            headers: { "idempotency-key": plantedKey("disabled") },
          }),
      },
    ];

    const before = await recording.metrics();
    const spanByWord = new Map<string, RecordedSpan>();
    for (const c of cases) {
      await c.run();
      // The span ends with the response; the last one is this case's request.
      const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_SUBMIT_EDGE);
      const span = spans.at(-1)!;
      expect(span.attributes["helix.outcome"], c.word).toBe(c.word);
      spanByWord.set(c.word, span);
    }
    const after = await recording.metrics();

    // One point per word, each worth exactly its one request, in the shared
    // vocabulary — and nothing else on the point (per-app attribution is the
    // ledger's job, never this counter's).
    const delta = submissionsDelta(before, after);
    expect([...delta.keys()].sort()).toEqual(cases.map((c) => c.word).sort());
    for (const point of after) {
      if (point.name !== INSTR_JOBS_SUBMISSIONS) continue;
      expect(Object.keys(point.attributes)).toEqual(["helix.outcome"]);
      expect(JOBS_SUBMISSION_OUTCOMES).toContain(point.attributes["helix.outcome"]);
    }
    for (const c of cases) {
      expect(delta.get(c.word), c.word).toBe(1);
    }

    // The span's attribution is staged, per the inventory's "once" clauses:
    // the slug rides once the serving entry resolves, the app id once the
    // grant check passes — where each span stops saying which tells an
    // operator where the request died.
    expect(spanByWord.get("unavailable")!.attributes["helix.app.slug"]).toBeUndefined();
    expect(spanByWord.get("unavailable")!.attributes["helix.app_id"]).toBeUndefined();
    expect(spanByWord.get("disabled")!.attributes["helix.app.slug"]).toBe("demo");
    expect(spanByWord.get("disabled")!.attributes["helix.app_id"]).toBeUndefined();
    expect(spanByWord.get("accepted")!.attributes).toMatchObject({
      "helix.jobs.operation": "submit",
      "helix.app.slug": "demo",
      "helix.app_id": APP_ID,
    });

    // The every-span scan (ADR-0037 decision 10's shape, over every outcome
    // word): the planted key and body marker rode each case's request, so any
    // unbounded attribute on ANY span — the refused or uncertain answers
    // included — fails here rather than leaking into retained telemetry.
    const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
    for (const c of cases) {
      expect(dump, c.word).not.toContain(`PLANTED-KEY-${c.word}`);
      expect(dump, c.word).not.toContain(`PLANTED-BODY-${c.word}`);
    }
  });

  it("the two uncertain answers stay distinguishable in the evidence while identical on the wire", async () => {
    // The route's known posture: unreachable and invalid_response both answer
    // the retryable 503 `jobs_unavailable` — never a fabricated 202 or 404 —
    // so the ONLY place they remain distinct is the span's outcome and the two
    // bounded warn events an operator's alert reads.
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    logLines.length = 0;

    harness.forwarder.submitVerdict = { kind: "unreachable", error: new Error("no answer") };
    const r1 = await submit(harness, SUBMIT_URL, {
      token,
      payload: '{"url":"https://api.vendor.test/PLANTED-BODY-VALUE"}',
      headers: { "idempotency-key": "PLANTED-RETRY-KEY" },
    });
    harness.forwarder.submitVerdict = { kind: "invalid_response", status: 202 };
    const r2 = await submit(harness, SUBMIT_URL, { token, payload: "{}" });

    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    expect(isJobsError(r1.json, "jobs_unavailable")).toBe(true);
    expect(isJobsError(r2.json, "jobs_unavailable")).toBe(true);

    const spans = recording.spans().filter((s) => s.name === SPAN_JOBS_SUBMIT_EDGE);
    expect(spans.map((s) => s.attributes["helix.outcome"]).sort()).toEqual([
      "invalid_response",
      "unreachable",
    ]);

    const events = logLines.filter(
      (line) =>
        typeof line.event === "string" && String(line.event).startsWith("edge.jobs_submit."),
    );
    expect(events.map((e) => e.event)).toEqual([
      "edge.jobs_submit.unreachable",
      "edge.jobs_submit.invalid_response",
    ]);
    // Both warn, both carrying the bounded app id; only the unusable-answer
    // event carries the status that arrived.
    for (const event of events) {
      expect(event.level).toBe(40);
      expect(event.appId).toBe(APP_ID);
      expect(event).not.toHaveProperty("err");
    }
    expect(events[0]).not.toHaveProperty("status");
    expect(events[1]?.status).toBe(202);

    // Bounded by construction: the submitted bytes and the retry key are never
    // in any log line.
    expect(JSON.stringify(logLines)).not.toContain("PLANTED-RETRY-KEY");
    expect(JSON.stringify(logLines)).not.toContain("PLANTED-BODY-VALUE");
  });

  it("a mid-upload hang-up lands the payload_invalid outcome — the truncated body never forwards", async () => {
    // The one outcome word no other case drives. A mid-upload disconnect dies
    // inside the body read — before the route's abort wiring exists — so the
    // collector's failed verdict maps here, and the truncated body must never
    // become a submission. The caller is gone, so the only observables are the
    // evidence and the absence of a forward; a real socket is the only way in
    // (inject delivers the whole body buffered and error-free).
    const harness = buildJobsEdge();
    const token = await seedSession(harness.sessions, "alice");
    await withServer(harness.app, async (base) => {
      const before = await recording.metrics();
      const stalled = new Readable({ read() {} });
      stalled.push(Buffer.alloc(32, 0x61)); // one chunk, then nothing — never ends
      const ac = new AbortController();
      const pending = undiciRequest(`${base}${SUBMIT_URL}`, {
        method: "POST",
        headers: {
          host: HOST.host,
          origin: ORIGIN,
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${token}`,
        },
        body: stalled,
        signal: ac.signal,
      }).catch(() => undefined);
      // Park the route inside the body read: the chunk flowed, the read cannot
      // end on its own.
      await new Promise((r) => setTimeout(r, 50));
      ac.abort();
      stalled.destroy();
      await pending;

      await until(
        () =>
          recording
            .spans()
            .some(
              (s) =>
                s.name === SPAN_JOBS_SUBMIT_EDGE &&
                s.attributes["helix.outcome"] === "payload_invalid",
            ),
        "the payload_invalid outcome",
      );
      // The verdict is the refusal, never a forward of the collected prefix.
      expect(harness.forwarder.submitSpecs).toHaveLength(0);
      expect(submissionsDelta(before, await recording.metrics()).get("payload_invalid")).toBe(1);
    });
  });
});
