import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { propagation } from "@opentelemetry/api";
import type { InjectOptions } from "fastify";

import {
  ATTR_OUTCOME,
  SPAN_JOBS_RESULT,
  SPAN_JOBS_SNAPSHOT,
  SPAN_JOBS_SUBMIT,
  type JobsResultOutcome,
  type JobsSnapshotOutcome,
} from "@azx-pbc/shared/telemetry";
import { propagatorFor } from "@azx-pbc/telemetry";
import { startRecordingTelemetry, type RecordingTelemetry } from "@azx-pbc/telemetry/testing";
import { JobsOperations } from "@azx-pbc/shared/jobsSigning";

import type { JobsResultVerdict, JobsSnapshotVerdict } from "./observation.js";

import {
  appWithLifecycle,
  appWithReceiver,
  cancelSpec,
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
        for (const [key, value] of Object.entries(attrs)) {
          expect(String(value), `attr ${key} carries the token`).not.toContain(token);
          expect(String(value), `attr ${key} carries a retry key`).not.toContain("retry-key-1");
          expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
            TEST_IDENTITY.ownerOid,
          );
          expect(String(value), `attr ${key} carries a job id`).not.toContain(TEST_JOB_ID);
          expect(String(value), `attr ${key} carries the body`).not.toContain(TEST_BODY);
        }
        expect(Object.keys(attrs).some((k) => k.startsWith("url."))).toBe(false);
        expect(Object.keys(attrs).some((k) => k.startsWith("http.url"))).toBe(false);
      }
      // The served submission's span carries the operation's own bounded
      // evidence — the submitting app and its admitted generation — as the
      // lifecycle delivery's span does (`appId` is the platform's bounded
      // non-personal dimension; AGENTS.md §Telemetry: "appId is a dimension;
      // userOid never is"). A refusal at the receiver carries none of it:
      // the operation never ran.
      expect(spans[0]?.attributes["helix.app_id"]).toBe(TEST_IDENTITY.appId);
      expect(spans[0]?.attributes["helix.jobs.generation"]).toBe("7");
      expect(spans[1]?.attributes["helix.app_id"]).toBeUndefined();
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

  test("a served cancellation's span carries the operation's own outcome and none of the owner's identity", async () => {
    const receiver = makeReceiver();
    const { app, storage, cancellation } = await appWithReceiver(receiver);
    try {
      // The served request's span: the verification verdict's "accepted" is
      // superseded by the operation's own outcome, and the bounded evidence
      // is the addressed app and the job's public id — the join an operator
      // can make, never the owner identity or a retry key.
      await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(await mint(cancelSpec())),
      });
      const requested = recording.spans().at(-1);
      expect(requested?.name).toBe("helix.jobs.cancel");
      expect(requested?.attributes["helix.outcome"]).toBe("requested");
      expect(requested?.attributes["helix.app_id"]).toBe(TEST_IDENTITY.appId);
      expect(requested?.attributes["helix.jobs.job_id"]).toBe(TEST_JOB_ID);
      expect(requested?.status.code).toBe(0); // UNSET — the designed answer
      for (const [key, value] of Object.entries(requested?.attributes ?? {})) {
        expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
          TEST_IDENTITY.ownerOid,
        );
      }

      // The refusals answer their own outcomes: a foreign job is the same
      // 404 an unknown job answers with, a terminal job the 409 with its
      // state — both UNSET (designed answers, not faults).
      cancellation.verdict = { outcome: "not_found" };
      await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(await mint(cancelSpec())),
      });
      expect(recording.spans().at(-1)?.attributes["helix.outcome"]).toBe("not_found");
      cancellation.verdict = { outcome: "terminal", status: "succeeded", error: null };
      await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(await mint(cancelSpec())),
      });
      expect(recording.spans().at(-1)?.attributes["helix.outcome"]).toBe("terminal");

      // A store that cannot decide is the retryable 503 — and its span
      // grades ERROR, the same rule the submit route's unavailable answers.
      cancellation.failRequests = true;
      await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(await mint(cancelSpec())),
      });
      const unavailable = recording.spans().at(-1);
      expect(unavailable?.attributes["helix.outcome"]).toBe("unavailable");
      expect(unavailable?.status.code).toBe(2); // ERROR
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a served observation read's span carries the operation's own outcome and none of the owner's identity", async () => {
    const receiver = makeReceiver();
    const { app, storage, observation } = await appWithReceiver(receiver);
    try {
      const jobId = TEST_JOB_ID;
      const snapshotRequest = (token: string): InjectOptions => ({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${jobId}`,
        headers: instructionHeaders(token),
      });
      const resultRequest = (token: string): InjectOptions => ({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${jobId}/result`,
        headers: instructionHeaders(token),
      });
      const mintSnapshot = (): Promise<string> =>
        mint({
          operation: "snapshot",
          server: "jobs",
          identity: { ...TEST_IDENTITY },
          jobId,
          iatS: TEST_IAT,
        });
      const mintResult = (): Promise<string> =>
        mint({
          operation: "result",
          server: "jobs",
          identity: { ...TEST_IDENTITY },
          jobId,
          iatS: TEST_IAT,
        });

      // The found read: the operation's own outcome supersedes the
      // verification verdict; the bounded evidence is the addressed app and
      // the job's public id — never the owner identity, never the snapshot's
      // own values.
      observation.snapshotVerdict = {
        outcome: "found",
        snapshot: {
          server: "jobs",
          jobId,
          type: "jobs:fetch",
          status: "expired",
          attempt: 1,
          progress: null,
          cancellationRequested: false,
          resultExpiresAt: "2026-10-20T12:00:00.000Z",
          recordExpiresAt: "2026-11-12T12:00:00.000Z",
          error: null,
        },
      };
      await app.inject(snapshotRequest(await mintSnapshot()));
      const found = recording.spans().at(-1);
      expect(found?.name).toBe("helix.jobs.snapshot");
      expect(found?.attributes["helix.outcome"]).toBe("found");
      expect(found?.attributes["helix.app_id"]).toBe(TEST_IDENTITY.appId);
      expect(found?.attributes["helix.jobs.job_id"]).toBe(jobId);
      expect(found?.status.code).toBe(0); // UNSET — the designed answer
      for (const [key, value] of Object.entries(found?.attributes ?? {})) {
        expect(String(value), `attr ${key} carries an owner oid`).not.toContain(
          TEST_IDENTITY.ownerOid,
        );
        expect(String(value), `attr ${key} carries the snapshot`).not.toContain("2026-10-20");
      }

      // The refusals answer their own outcomes, all UNSET (designed answers).
      observation.snapshotVerdict = { outcome: "not_found" };
      await app.inject(snapshotRequest(await mintSnapshot()));
      expect(recording.spans().at(-1)?.attributes["helix.outcome"]).toBe("not_found");
      observation.resultVerdict = { outcome: "expired" };
      await app.inject(resultRequest(await mintResult()));
      const expired = recording.spans().at(-1);
      expect(expired?.name).toBe("helix.jobs.result");
      expect(expired?.attributes["helix.outcome"]).toBe("expired");
      expect(expired?.status.code).toBe(0);

      // A store that cannot answer is the retryable 503 — and its span
      // grades ERROR, the same rule every unavailable answer follows.
      observation.failReads = true;
      await app.inject(snapshotRequest(await mintSnapshot()));
      const unavailable = recording.spans().at(-1);
      expect(unavailable?.attributes["helix.outcome"]).toBe("unavailable");
      expect(unavailable?.status.code).toBe(2); // ERROR
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("every exit of each observation vocabulary carries its own word on its span", async () => {
    // The full vocabulary, not a sample: each route's span names its
    // operation and carries the verdict's own bounded word with the uniform
    // grading (4xx answers UNSET, the 503 ERROR). Keyed by the shared
    // outcome unions, so a word added to a vocabulary without a pinned exit
    // fails to compile here instead of shipping unpinned.
    const receiver = makeReceiver();
    const { app, storage, observation } = await appWithReceiver(receiver);
    try {
      const foundSnapshot: JobsSnapshotVerdict = {
        outcome: "found",
        snapshot: {
          server: "jobs",
          jobId: TEST_JOB_ID,
          type: "jobs:fetch",
          status: "running",
          attempt: 1,
          progress: { step: 1, of: 1, label: "Fetched" },
          cancellationRequested: false,
          resultExpiresAt: null,
          recordExpiresAt: null,
          error: null,
        },
      };
      type Exit = { verdict: JobsSnapshotVerdict | null; status: number; graded: boolean };
      const snapshotExits: Record<JobsSnapshotOutcome, Exit> = {
        found: { verdict: foundSnapshot, status: 200, graded: false },
        not_found: { verdict: { outcome: "not_found" }, status: 404, graded: false },
        forbidden: { verdict: { outcome: "forbidden" }, status: 403, graded: false },
        unavailable: { verdict: null, status: 503, graded: true },
      };
      type ResultExit = { verdict: JobsResultVerdict | null; status: number; graded: boolean };
      const resultExits: Record<JobsResultOutcome, ResultExit> = {
        found: {
          verdict: { outcome: "found", resultText: '{"kept":true}' },
          status: 200,
          graded: false,
        },
        not_found: { verdict: { outcome: "not_found" }, status: 404, graded: false },
        forbidden: { verdict: { outcome: "forbidden" }, status: 403, graded: false },
        not_ready: {
          verdict: { outcome: "not_ready", status: "queued", error: null },
          status: 409,
          graded: false,
        },
        terminal: {
          verdict: { outcome: "terminal", status: "failed", error: null },
          status: 409,
          graded: false,
        },
        expired: { verdict: { outcome: "expired" }, status: 410, graded: false },
        unavailable: { verdict: null, status: 503, graded: true },
      };
      const injectRead = async (url: string, operation: "snapshot" | "result"): Promise<void> => {
        await app.inject({
          method: "GET",
          url,
          headers: instructionHeaders(
            await mint({
              operation,
              server: "jobs",
              identity: { ...TEST_IDENTITY },
              jobId: TEST_JOB_ID,
              iatS: TEST_IAT,
            }),
          ),
        });
      };
      for (const [outcome, exit] of Object.entries(snapshotExits) as [
        JobsSnapshotOutcome,
        Exit,
      ][]) {
        recording.reset();
        observation.failReads = exit.verdict === null;
        observation.snapshotVerdict = exit.verdict ?? { outcome: "not_found" };
        await injectRead(`/internal/jobs/v1/jobs/${TEST_JOB_ID}`, "snapshot");
        const span = recording.spans().at(-1);
        expect(span?.name, outcome).toBe(SPAN_JOBS_SNAPSHOT);
        expect(span?.attributes[ATTR_OUTCOME], outcome).toBe(outcome);
        expect(span?.status.code, outcome).toBe(exit.graded ? 2 : 0);
      }
      for (const [outcome, exit] of Object.entries(resultExits) as [
        JobsResultOutcome,
        ResultExit,
      ][]) {
        recording.reset();
        observation.failReads = exit.verdict === null;
        observation.resultVerdict = exit.verdict ?? { outcome: "not_found" };
        await injectRead(`/internal/jobs/v1/jobs/${TEST_JOB_ID}/result`, "result");
        const span = recording.spans().at(-1);
        expect(span?.name, outcome).toBe(SPAN_JOBS_RESULT);
        expect(span?.attributes[ATTR_OUTCOME], outcome).toBe(outcome);
        expect(span?.status.code, outcome).toBe(exit.graded ? 2 : 0);
      }
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("the admission's record-expired replay exit carries its own bounded word on the submission span", async () => {
    // The `not_found` admission outcome (an identical-bytes keyed replay of a
    // job whose public record access expired) belongs to the submit
    // vocabulary, not the observation sweep above: its span evidence is
    // pinned here — the replay's own word, UNSET like every designed 4xx
    // refusal.
    const { app, storage, admission } = await appWithReceiver(makeReceiver());
    try {
      admission.outcome = { outcome: "not_found" };
      await submitOnce(app, await mint(submitSpec()));
      const span = recording.spans().at(-1);
      expect(span?.name).toBe(SPAN_JOBS_SUBMIT);
      expect(span?.attributes[ATTR_OUTCOME]).toBe("not_found");
      expect(span?.status.code).toBe(0); // UNSET — a designed 4xx refusal
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a 401 refusal leaves the span UNSET; a 5xx reply grades it ERROR", async () => {
    const receiver = makeReceiver();
    const { app, storage, admission } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec());
      await submitOnce(app, token); // accepted — 202, the operation served
      await submitOnce(app, token); // replayed — 401
      await submitOnce(app, await mint(submitSpec(), TEST_KEYS.other)); // rejected — 401

      const [accepted, replayed, rejected] = recording.spans();
      // The 202 answer and the 401 denials stay UNSET: a served submission
      // and the receiver refusing a replay or a forgery are all working
      // exactly as designed, and marking those ERROR would bury real faults.
      expect(accepted?.status.code).toBe(0); // UNSET
      expect(replayed?.status.code).toBe(0); // UNSET
      expect(rejected?.status.code).toBe(0); // UNSET

      // The 5xx answer grades its span ERROR: an acceptance store that could
      // not decide is a fault worth seeing, even though the handler answered
      // normally instead of throwing.
      admission.failAdmits = true;
      await submitOnce(app, await mint(submitSpec()));
      const unavailable = recording.spans().at(-1);
      expect(unavailable?.attributes["helix.outcome"]).toBe("unavailable");
      expect(unavailable?.status.code).toBe(2); // ERROR
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
      // and its archived flag — all bounded, all non-personal — plus the
      // delivery's cancellation reach (the in-memory double stamps no
      // records; the durable stamping's reach is pinned against real
      // Postgres in `lifecycle.integration.test.ts`).
      const applied = spans[0];
      expect(applied?.attributes["helix.app_id"]).toBe(TEST_IDENTITY.appId);
      expect(applied?.attributes["helix.jobs.generation"]).toBe("8");
      expect(applied?.attributes["helix.jobs.archived"]).toBe(true);
      expect(applied?.attributes["helix.jobs.lifecycle.stamped"]).toBe(0);

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
    // refusal. A 5xx reply is a fault worth seeing: it grades the span ERROR
    // even though the handler answered normally instead of throwing.
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

  test("a submission's span carries the admission's own bounded outcome, one word per exit", async () => {
    const { app, storage, admission } = await appWithReceiver(makeReceiver());
    try {
      const submit = async (): Promise<void> => {
        await app.inject({
          method: "POST",
          url: "/internal/jobs/v1/jobs",
          headers: {
            "content-type": "application/json",
            ...instructionHeaders(await mint(submitSpec()), "retry-key-1"),
          },
          payload: TEST_BODY,
        });
      };
      const outcomes = [
        { canned: { outcome: "accepted", jobId: TEST_JOB_ID, status: "queued" } },
        { canned: { outcome: "recovered", jobId: TEST_JOB_ID, status: "queued" } },
        { canned: { outcome: "conflict", status: "queued", error: null } },
        { canned: { outcome: "invalid_input" } },
        { canned: { outcome: "type_unknown" } },
        { canned: { outcome: "closed" } },
        { canned: { outcome: "intake_closed" } },
        { canned: { outcome: "unseen" } },
        { canned: { outcome: "capacity_exceeded" } },
      ] as const;
      for (const o of outcomes) {
        admission.outcome = o.canned;
        await submit();
      }
      admission.failAdmits = true;
      await submit();

      // Every exit of the operation is one bounded word on its span — the
      // vocabulary the inventory lists (`JOBS_SUBMIT_OUTCOMES`), never a
      // reason string, a key, or an input.
      const expectOutcomes = [...outcomes.map((o) => o.canned.outcome), "unavailable"];
      const spans = recording.spans().slice(-expectOutcomes.length);
      expect(spans.map((s) => s.attributes[ATTR_OUTCOME])).toEqual(expectOutcomes);
      // The 202s and the fixed 4xx refusals are the route working as
      // designed — UNSET spans. Every 5xx answer grades ERROR by the uniform
      // rule, and three of this vocabulary's exits answer 503: the unseen
      // wait (a misconfigured edge submitting before the portal's delivery —
      // a run of these is visible), the closed-intake refusal, and the
      // acceptance store failing to decide. The 429 capacity refusal is an
      // ordinary busy answer — UNSET with the rest.
      expect(spans.map((s) => s.status.code)).toEqual([0, 0, 0, 0, 0, 0, 2, 2, 0, 2]);
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
