import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { jobRequestError } from "@azx-pbc/shared";
import {
  JOBS_REFERENCE_OUTCOMES,
  ROUTE_JOBS_SNAPSHOT,
  ROUTE_JOBS_SNAPSHOT_DEV,
  SPAN_JOBS_CANCEL_EDGE,
  SPAN_JOBS_RESULT_EDGE,
  SPAN_JOBS_SNAPSHOT_DEV,
  SPAN_JOBS_SNAPSHOT_EDGE,
  type JobsReferenceOutcome,
} from "@azx-pbc/shared/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import {
  buildDevJobsEdge,
  buildDisabledJobsEdge,
  buildJobsEdge,
  FakeJobsForwarder,
  JOBS_APP_ID as APP_ID,
  JOBS_HOST as HOST,
  JOBS_ORIGIN as ORIGIN,
  seedJobsSession as seedSession,
  type JobsHarness,
} from "../test/jobsGateway.js";
import { SESSION_COOKIE } from "../auth/cookies.js";

/**
 * The reference routes' outcome telemetry (ADR-0037 + the observability
 * inventory): every early return of the shared record handler lands its own
 * `JOBS_REFERENCE_OUTCOMES` word on the route span — one span per surface and
 * operation — and the two uncertain answers stay distinguishable in the
 * evidence an operator reads (the span's `helix.outcome` and the bounded warn
 * events) while the caller-facing answer is the identical retryable 503.
 * The routes' responses themselves are pinned in `gateway/jobsRecord.test.ts`.
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

const openApps: { close(): Promise<void> }[] = [];
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

function buildJobsEdgeTracked(
  opts: { forwarder?: FakeJobsForwarder; visibilityMode?: "internal" | "public" } = {},
): JobsHarness {
  const harness = buildJobsEdge(opts);
  openApps.push(harness.app);
  return harness;
}

function buildDisabledTracked(): JobsHarness {
  const harness = buildDisabledJobsEdge();
  openApps.push(harness.app);
  return harness;
}

async function seed(sessions: JobsHarness["sessions"]): Promise<string> {
  // The owner's identity is the value that must never reach a span; plant it
  // so the dump-scan proves that on every outcome's span.
  return seedSession(sessions, "PLANTED-OWNER-alice");
}

async function get(
  harness: JobsHarness,
  url: string,
  token: string | null,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await harness.app.inject({
    method: "GET",
    url,
    headers: {
      host: HOST.host,
      "sec-fetch-mode": "cors",
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
      ...headers,
    },
  });
  return { status: res.statusCode, body: res.body };
}

async function cancel(
  harness: JobsHarness,
  url: string,
  token: string | null,
  origin: string | null = ORIGIN,
): Promise<{ status: number; body: string }> {
  const res = await harness.app.inject({
    method: "DELETE",
    url,
    headers: {
      host: HOST.host,
      "sec-fetch-mode": "cors",
      ...(origin ? { origin } : {}),
      ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}),
    },
  });
  return { status: res.statusCode, body: res.body };
}

type RecordedSpan = ReturnType<RecordingTelemetry["spans"]>[number];

describe("the reference routes' outcome telemetry", () => {
  it("every early return lands its own vocabulary word on its surface's span", async () => {
    const std = buildJobsEdgeTracked();
    const publicEdge = buildJobsEdgeTracked({ visibilityMode: "public" });
    const disabled = buildDisabledTracked();
    const token = await seed(std.sessions);
    const disabledToken = await seed(disabled.sessions);
    // A distinctive job id rides EVERY case's request, so the dump-scan below
    // holds for every outcome's span, not just the found one: an unbounded
    // attribute added on any refusal path — a "helpful debug" field echoing
    // the reference or the owner — fails here.
    const plantedId = (word: string): string => `PLANTED-JOB-${word}`;

    const cases: { word: JobsReferenceOutcome; run: () => Promise<unknown> }[] = [
      {
        word: "unavailable",
        run: () => get(std, "/_api/jobs/jobs/x", token, { host: "nosuch.local.helix.azxlabs.io" }),
      },
      {
        word: "unauthorized",
        run: () => get(std, `/_api/jobs/jobs/${plantedId("unauthorized")}`, null),
      },
      {
        word: "forbidden",
        run: () => get(publicEdge, `/_api/jobs/jobs/${plantedId("forbidden")}`, null),
      },
      {
        word: "server_unknown",
        run: () => get(std, `/_api/jobs/nosuch/${plantedId("server_unknown")}`, token),
      },
      {
        word: "reference_invalid",
        run: () => get(std, `/_api/jobs/jobs/${plantedId("reference_invalid")}!`, token),
      },
      {
        word: "disabled",
        run: () => get(disabled, `/_api/jobs/jobs/${plantedId("disabled")}`, disabledToken),
      },
      {
        word: "found",
        run: () => get(std, `/_api/jobs/jobs/${plantedId("found")}`, token),
      },
      {
        word: "server_refused",
        run: () => {
          std.forwarder.snapshotVerdict = {
            kind: "refused",
            status: 404,
            error: jobRequestError("job_not_found"),
          };
          return get(std, `/_api/jobs/jobs/${plantedId("server_refused")}`, token);
        },
      },
      {
        word: "unreachable",
        run: () => {
          std.forwarder.snapshotVerdict = { kind: "unreachable", error: new Error("no answer") };
          return get(std, `/_api/jobs/jobs/${plantedId("unreachable")}`, token);
        },
      },
      {
        word: "invalid_response",
        run: () => {
          std.forwarder.snapshotVerdict = { kind: "invalid_response", status: 200 };
          return get(std, `/_api/jobs/jobs/${plantedId("invalid_response")}`, token);
        },
      },
      // The result route's own answer word, on its own span.
      {
        word: "server_refused",
        run: () => {
          std.forwarder.resultVerdict = {
            kind: "refused",
            status: 404,
            error: jobRequestError("job_not_found"),
          };
          return get(std, `/_api/jobs/jobs/${plantedId("result_refused")}/result`, token);
        },
      },
      // The cancel route's own answer words, on its own span.
      {
        word: "forbidden",
        run: () =>
          cancel(
            std,
            `/_api/jobs/jobs/${plantedId("cancel-forbidden")}`,
            token,
            "https://evil.example",
          ),
      },
      {
        word: "found",
        run: () => cancel(std, `/_api/jobs/jobs/${plantedId("cancel-found")}`, token),
      },
    ];

    for (const c of cases) {
      await c.run();
      // The span ends with the response; the last one is this case's request.
      const names = [SPAN_JOBS_SNAPSHOT_EDGE, SPAN_JOBS_RESULT_EDGE, SPAN_JOBS_CANCEL_EDGE];
      const spans = recording
        .spans()
        .filter((s) => names.includes(s.name as (typeof names)[number]));
      const span = spans.at(-1)!;
      expect(span.attributes["helix.outcome"], c.word).toBe(c.word);
    }

    // The staged attribution, per the inventory: the slug rides once the
    // serving entry resolves; the app id and the validated reference only
    // once the request is on its way to a forward — where each span stops
    // saying which tells an operator where the request died. The snapshot
    // spans, in the case order above: unavailable, unauthorized, forbidden,
    // server_unknown, reference_invalid, disabled, found, server_refused,
    // unreachable, invalid_response.
    const spansOf = (name: string): RecordedSpan[] =>
      recording.spans().filter((s) => s.name === name);
    const snapshotSpans = spansOf(SPAN_JOBS_SNAPSHOT_EDGE);
    expect(snapshotSpans).toHaveLength(10);
    expect(snapshotSpans[0]!.attributes["helix.app.slug"]).toBeUndefined();
    expect(snapshotSpans[0]!.attributes["helix.app_id"]).toBeUndefined();
    expect(snapshotSpans[5]!.attributes).toMatchObject({
      "helix.outcome": "disabled",
      "helix.app.slug": "demo",
    });
    expect(snapshotSpans[5]!.attributes["helix.app_id"]).toBeUndefined();
    expect(snapshotSpans[6]!.attributes).toMatchObject({
      "helix.outcome": "found",
      "helix.app.slug": "demo",
      "helix.app_id": APP_ID,
      "helix.jobs.job_id": "PLANTED-JOB-found",
      "helix.jobs.operation": "snapshot",
      "http.route": ROUTE_JOBS_SNAPSHOT,
    });
    // No url.path: the route's segments are caller-chosen.
    for (const span of recording.spans()) {
      expect(span.attributes["url.path"]).toBeUndefined();
      expect(span.attributes["url.full"]).toBeUndefined();
    }

    // The every-span scan, over the two value classes a poll carries: the
    // OWNER identity (never a span attribute anywhere) and the planted
    // references on the PRE-forward refusals — the forward outcomes
    // (server_refused, unreachable, invalid_response, found) legitimately
    // carry the validated reference, and the found span's staging above pins
    // that.
    const dump = JSON.stringify(recording.spans().map((s) => s.attributes));
    expect(dump).not.toContain("PLANTED-OWNER");
    const preForwardWords: JobsReferenceOutcome[] = [
      "unavailable",
      "unauthorized",
      "forbidden",
      "server_unknown",
      "reference_invalid",
      "disabled",
    ];
    for (const word of preForwardWords) {
      expect(dump, word).not.toContain(`PLANTED-JOB-${word}`);
    }

    // The whole vocabulary is pinned: every word above is in the shared
    // constant, and the constant carries nothing else.
    for (const c of cases) {
      expect(JOBS_REFERENCE_OUTCOMES).toContain(c.word);
    }
  });

  it("the uncertain answers stay distinguishable in the evidence while identical on the wire", async () => {
    const harness = buildJobsEdgeTracked();
    const token = await seed(harness.sessions);
    logLines.length = 0;

    harness.forwarder.snapshotVerdict = { kind: "unreachable", error: new Error("no answer") };
    const r1 = await get(harness, `/_api/jobs/jobs/PLANTED-JOB-VALUE`, token);
    harness.forwarder.snapshotVerdict = { kind: "invalid_response", status: 200 };
    const r2 = await get(harness, "/_api/jobs/jobs/job-123", token);

    expect(r1.status).toBe(503);
    expect(r2.status).toBe(503);
    expect(r1.body).toContain("jobs_unavailable");

    const events = logLines.filter(
      (line) =>
        typeof line.event === "string" && String(line.event).startsWith("edge.jobs_snapshot."),
    );
    expect(events.map((e) => e.event)).toEqual([
      "edge.jobs_snapshot.unreachable",
      "edge.jobs_snapshot.invalid_response",
    ]);
    // Both warn, both carrying the bounded app id; only the unusable-answer
    // event carries the status that arrived.
    for (const event of events) {
      expect(event.level).toBe(40);
      expect(event.appId).toBe(APP_ID);
      expect(event).not.toHaveProperty("err");
    }
    expect(events[0]).not.toHaveProperty("status");
    expect(events[1]?.status).toBe(200);

    // Bounded by construction: the reference is never in any log line.
    expect(JSON.stringify(logLines)).not.toContain("PLANTED-JOB-VALUE");
  });

  it("the dev surface's poll span names its own route", async () => {
    const devApp = await buildDevJobsEdge(new FakeJobsForwarder("jobs"));
    openApps.push(devApp);
    const res = await devApp.inject({
      method: "GET",
      url: "/myapp/_api/jobs/jobs/job-123",
      headers: { host: "dev-api.local.helix.azxlabs.io", origin: "https://myapp.lovable.app" },
    });
    expect(res.statusCode).toBe(401); // no bearer — the resolver's refusal
    const devSpans = recording.spans().filter((s) => s.name === SPAN_JOBS_SNAPSHOT_DEV);
    expect(devSpans).toHaveLength(1);
    expect(devSpans[0]!.attributes["http.route"]).toBe(ROUTE_JOBS_SNAPSHOT_DEV);
    expect(devSpans[0]!.attributes["helix.outcome"]).toBe("unauthorized");
  });
});
