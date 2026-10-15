import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { propagation } from "@opentelemetry/api";

import { ATTR_OUTCOME } from "@azx-pbc/shared/telemetry";
import { propagatorFor } from "@azx-pbc/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { JobsOperations } from "@azx-pbc/shared/jobsSigning";

import {
  appWithLifecycle,
  appWithReceiver,
  instructionHeaders,
  makeReceiver,
  MemoryLifecycle,
  mint,
  submitSpec,
  TEST_BODY,
  TEST_IDENTITY,
  TEST_IAT,
  TEST_JOB_ID,
  TEST_KEYS,
} from "./test/instructions.js";

/**
 * The instruction seam's telemetry, recorded in-process: the attempt counter
 * carries the bounded operation/outcome vocabulary, every outcome is the
 * seam's own bounded class, and — the red line — no span attribute anywhere
 * carries the token, a claim value, a retry key or a URL. The scan below
 * walks EVERY attribute of EVERY emitted span rather than one field, so a
 * span added later without thought fails here instead of leaking quietly.
 */

type App = Awaited<ReturnType<typeof appWithReceiver>>["app"];

async function submitOnce(app: App, token: string): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/internal/jobs/v1/jobs",
    headers: { "content-type": "application/json", ...instructionHeaders(token, "retry-key-1") },
    payload: TEST_BODY,
  });
}

/** A submit presentation carrying an untrusted caller's trace headers. */
async function submitOnceWithTrace(app: App, token: string, traceparent: string): Promise<void> {
  await app.inject({
    method: "POST",
    url: "/internal/jobs/v1/jobs",
    headers: {
      "content-type": "application/json",
      ...instructionHeaders(token, "retry-key-1"),
      traceparent,
      tracestate: "vendor=app-chosen",
    },
    payload: TEST_BODY,
  });
}

describe("instruction telemetry", () => {
  // One recording for the file (the testing module's span-test lifecycle:
  // re-registering after a restore would leave the global cleared); the
  // metric counts are cumulative within the provider, so the counter test
  // asserts deltas across its own actions.
  let recording: RecordingTelemetry;
  beforeAll(() => {
    recording = startRecordingTelemetry();
  });
  afterEach(() => {
    recording.reset();
  });
  afterAll(async () => {
    await recording.restore();
  });

  test("the counter classifies accepted, replayed and rejected presentations", async () => {
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const count = async (outcome: string): Promise<number> =>
        (await recording.metrics())
          .filter(
            (m) =>
              m.name === "helix.jobs.instructions" &&
              m.attributes["helix.jobs.operation"] === "submit" &&
              m.attributes[ATTR_OUTCOME] === outcome,
          )
          .reduce((sum, m) => sum + m.value, 0);
      const before = {
        accepted: await count("accepted"),
        replayed: await count("replayed"),
        rejected: await count("rejected"),
      };

      const token = await mint(submitSpec());
      await submitOnce(app, token); // accepted
      await submitOnce(app, token); // replayed
      await submitOnce(app, await mint(submitSpec(), TEST_KEYS.other)); // rejected

      expect((await count("accepted")) - before.accepted).toBe(1);
      expect((await count("replayed")) - before.replayed).toBe(1);
      expect((await count("rejected")) - before.rejected).toBe(1);
      expect(receiver.burns.seen.size).toBe(1);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("no span attribute carries the token, a claim value, a retry key or a URL", async () => {
    const { app, storage } = await appWithReceiver(makeReceiver());
    try {
      const token = await mint(submitSpec());
      await submitOnce(app, token); // accepted — a complete claim set on the wire
      await submitOnce(app, token); // replayed

      const spans = recording.spans();
      expect(spans.length).toBe(2);
      expect(spans[0]?.attributes["helix.outcome"]).toBe("accepted");
      expect(spans[1]?.attributes["helix.outcome"]).toBe("replayed");
      for (const span of spans) {
        expect(span.name).toBe("helix.jobs.submit");
        const attrs = span.attributes;
        expect(attrs["helix.jobs.operation"]).toBe("submit");
        expect(attrs["http.route"]).toBe("/internal/jobs/v1/jobs");
        // The span names the route and the outcome; nothing that identifies a
        // caller, a token or a job.
        for (const [key, value] of Object.entries(attrs)) {
          expect(String(value), `attr ${key} carries the token`).not.toContain(token);
          expect(String(value), `attr ${key} carries a retry key`).not.toContain("retry-key-1");
          expect(String(value), `attr ${key} carries an app id`).not.toContain(TEST_IDENTITY.appId);
          expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
            TEST_IDENTITY.ownerOid,
          );
          expect(String(value), `attr ${key} carries a job id`).not.toContain(TEST_JOB_ID);
          expect(String(value), `attr ${key} carries the body`).not.toContain(TEST_BODY);
        }
        expect(Object.keys(attrs).some((k) => k.startsWith("url."))).toBe(false);
        expect(Object.keys(attrs).some((k) => k.startsWith("http.url"))).toBe(false);
      }
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a burn-store failure's span carries the unavailable outcome and no reason", async () => {
    const receiver = makeReceiver();
    receiver.burns.failBurns = true;
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const unavailableCount = async (): Promise<number> =>
        (await recording.metrics())
          .filter(
            (m) =>
              m.name === "helix.jobs.instructions" && m.attributes[ATTR_OUTCOME] === "unavailable",
          )
          .reduce((sum, m) => sum + m.value, 0);
      const before = await unavailableCount();
      await submitOnce(app, await mint(submitSpec()));
      const span = recording.spans().at(-1);
      expect(span?.attributes["helix.outcome"]).toBe("unavailable");
      expect(span?.attributes["helix.reason"]).toBeUndefined();
      // The unavailable presentation is counted too — all four outcomes are
      // the counter's vocabulary, and a run of unavailable is the operator's
      // burn-store-down signal.
      expect((await unavailableCount()) - before).toBe(1);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a 401 refusal leaves the span UNSET; a 5xx reply grades it ERROR", async () => {
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec());
      await submitOnce(app, token); // accepted — the placeholder answers 503
      await submitOnce(app, token); // replayed — 401
      await submitOnce(app, await mint(submitSpec(), TEST_KEYS.other)); // rejected — 401

      const [accepted, replayed, rejected] = recording.spans();
      // The 5xx answer grades its span ERROR (the accepted-but-unserved
      // placeholder state is a fault worth seeing), while the 401 denials
      // stay UNSET: the receiver refusing a replay or a forgery is working
      // exactly as designed, and marking those ERROR would bury real faults.
      expect(accepted?.status.code).toBe(2); // ERROR
      expect(replayed?.status.code).toBe(0); // UNSET
      expect(rejected?.status.code).toBe(0); // UNSET
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("each operation's route span is named for the operation the ROUTE serves", async () => {
    // The name mapping (`app.ts`'s span-name lookup) is a separate lookup from
    // the route registration: a swap of two entries type-checks and passes
    // everything else, while any dashboard or alert keyed on the inventory's
    // names (`docs/features/observability.md`) silently loses that
    // operation's traces. The submit name's mirror, for the other four.
    const { app, storage } = await appWithReceiver(makeReceiver());
    try {
      for (const operation of ["snapshot", "result", "cancel"] as const) {
        const token = await mint({
          operation,
          server: "jobs",
          identity: { ...TEST_IDENTITY },
          jobId: TEST_JOB_ID,
          iatS: TEST_IAT,
        });
        await app.inject({
          method: operation === "cancel" ? "DELETE" : "GET",
          url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}${operation === "result" ? "/result" : ""}`,
          headers: instructionHeaders(token),
        });
        const span = recording.spans().at(-1);
        expect(span?.name, operation).toBe(`helix.jobs.${operation}`);
        expect(span?.attributes["helix.jobs.operation"], operation).toBe(operation);
        expect(span?.attributes["http.route"], operation).toBe(JobsOperations[operation].path);
      }

      const lifecycleToken = await mint({
        operation: "lifecycle",
        server: "jobs",
        appId: TEST_IDENTITY.appId,
        body: new TextEncoder().encode('{"generation":"8","archived":true}'),
        iatS: TEST_IAT,
      });
      await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: {
          "content-type": "application/json",
          ...instructionHeaders(lifecycleToken),
        },
        payload: '{"generation":"8","archived":true}',
      });
      const span = recording.spans().at(-1);
      expect(span?.name).toBe("helix.jobs.lifecycle");
      expect(span?.attributes["helix.jobs.operation"]).toBe("lifecycle");
      expect(span?.attributes["http.route"]).toBe(JobsOperations.lifecycle.path);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a lifecycle delivery's span carries its own bounded evidence", async () => {
    const lifecycle = new MemoryLifecycle();
    const { app, storage } = await appWithLifecycle(makeReceiver(), lifecycle);
    try {
      const deliver = async (body: string): Promise<unknown> => {
        const token = await mint({
          operation: "lifecycle",
          server: "jobs",
          appId: TEST_IDENTITY.appId,
          body: new TextEncoder().encode(body),
          iatS: TEST_IAT,
        });
        return app.inject({
          method: "POST",
          url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
          headers: { "content-type": "application/json", ...instructionHeaders(token) },
          payload: body,
        });
      };

      await deliver('{"generation":"8","archived":true}'); // applied
      await deliver('{"generation":"8","archived":true}'); // stale (redelivery)
      await deliver('{"generation":"8"}'); // invalid body, never applied

      const spans = recording.spans();
      expect(spans).toHaveLength(3);
      expect(spans.map((s) => s.attributes[ATTR_OUTCOME])).toEqual([
        "applied",
        "stale",
        "invalid_body",
      ]);
      // The 200s and the fixed 400 stay UNSET: a served delivery and a
      // body-shape refusal are the route working as designed, never faults.
      expect(spans.map((s) => s.status.code)).toEqual([0, 0, 0]);
      // The delivery's own evidence: the target app, the delivered generation
      // and its archived flag — all bounded, all non-personal.
      const applied = spans[0];
      expect(applied?.attributes["helix.app_id"]).toBe(TEST_IDENTITY.appId);
      expect(applied?.attributes["helix.jobs.generation"]).toBe("8");
      expect(applied?.attributes["helix.jobs.archived"]).toBe(true);

      // The same every-attribute redaction scan the submit spans take: no
      // token material, no retry key, no owner identity, no URL.
      for (const span of spans) {
        for (const [key, value] of Object.entries(span.attributes)) {
          expect(String(value), `attr ${key} carries owner identity`).not.toContain(
            TEST_IDENTITY.ownerOid,
          );
        }
        expect(Object.keys(span.attributes).some((k) => k.startsWith("url."))).toBe(false);
      }
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a lifecycle delivery the store cannot answer carries the unavailable outcome and grades the span ERROR", async () => {
    // The last of the four lifecycle outcomes on the span: the retryable
    // refusal. A 5xx reply is a fault worth seeing — like the submit
    // placeholder's 503, the reply grades the span ERROR even though the
    // handler answered normally instead of throwing.
    const lifecycle = new MemoryLifecycle();
    lifecycle.failApplies = true;
    const { app, storage } = await appWithLifecycle(makeReceiver(), lifecycle);
    try {
      const token = await mint({
        operation: "lifecycle",
        server: "jobs",
        appId: TEST_IDENTITY.appId,
        body: new TextEncoder().encode('{"generation":"8","archived":true}'),
        iatS: TEST_IAT,
      });
      await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: { "content-type": "application/json", ...instructionHeaders(token) },
        payload: '{"generation":"8","archived":true}',
      });
      const span = recording.spans().at(-1);
      expect(span?.attributes[ATTR_OUTCOME]).toBe("unavailable");
      expect(span?.status.code).toBe(2); // ERROR
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("an inbound traceparent never parents a route span — the pre-auth span is always a root", async () => {
    // The ticket's binding constraint: do not trust inbound traces before
    // authentication. The wrapper opens every route span with `root: true`,
    // and nothing extracts before it — held today by absence, with no lint
    // (jobs may extract post-auth by design) and no other pin. The harshest
    // posture makes the tripwire survive the successor work correctly: full
    // propagation installed, so a careless extract above verification WOULD
    // find the caller's context and the assertion would fire — while
    // extraction inside a handler, below a span that is still a root, is the
    // permitted design and passes.
    propagation.setGlobalPropagator(propagatorFor("full"));
    const APP_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
    const APP_TRACEPARENT = `00-${APP_TRACE_ID}-00f067aa0ba902b7-01`;
    const { app, storage } = await appWithReceiver(makeReceiver());
    try {
      await submitOnceWithTrace(app, await mint(submitSpec()), APP_TRACEPARENT);
      const valid = recording.spans().at(-1);
      expect(valid?.spanContext().traceId).not.toBe(APP_TRACE_ID);
      expect(valid?.parentSpanContext).toBeUndefined();

      // A malformed traceparent is exactly as unable to parent the span.
      await submitOnceWithTrace(app, await mint(submitSpec()), "not-a-traceparent");
      const malformed = recording.spans().at(-1);
      expect(malformed?.spanContext().traceId).not.toBe(APP_TRACE_ID);
      expect(malformed?.parentSpanContext).toBeUndefined();

      // And nothing from the caller's trace headers lands anywhere.
      const dump = JSON.stringify(
        recording.spans().map((sp) => ({ ...sp.attributes, ...sp.spanContext() })),
      );
      expect(dump).not.toContain(APP_TRACE_ID);
      expect(dump).not.toContain("vendor=app-chosen");
    } finally {
      await app.close();
      await storage.stop();
    }
  });
});
