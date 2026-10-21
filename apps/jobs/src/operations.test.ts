import { describe, expect, test } from "vitest";

import {
  INSTRUCTION_HEADER,
  JobErrorMessages,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_MAX_INPUT_BYTES,
  JOBS_MAX_RESULT_BYTES,
  resolveJobsCapacityLimits,
} from "@azx-pbc/shared";

import { buildApp } from "./app.js";
import type { JobsLifecycleApplyResult } from "./lifecycle.js";
import type { JobsSnapshotVerdict } from "./observation.js";
import {
  appWithLifecycle,
  appWithReceiver,
  appliedIntake,
  cancelSpec,
  instructionHeaders,
  makeReceiver,
  MemoryAdmission,
  MemoryCancellation,
  MemoryObservation,
  mint,
  MemoryLifecycle,
  runningCleanup,
  storageIn,
  submitSpec,
  TEST_BODY,
  TEST_IAT,
  TEST_IDENTITY,
  TEST_JOB_ID,
  TEST_KEYS,
} from "./test/instructions.js";

/**
 * The signed internal operation routes, through the real composition: a valid
 * instruction reaches exactly its own operation, every denial is the fixed
 * sanitized envelope before any effect, and the durable burn answers replays.
 * Each served operation's response mapping is pinned against its own seam's
 * in-memory double — the doubles' durability semantics are the integration
 * suites' seam, and the receiver's refusals are the same on every route.
 */

const JSON_HEADERS = { "content-type": "application/json" };
const UNAVAILABLE_BODY = {
  code: "jobs_unavailable",
  message: JobErrorMessages.jobs_unavailable,
};
const DISABLED_BODY = {
  code: "jobs_disabled",
  message: JobErrorMessages.jobs_disabled,
};
const UNAUTHORIZED_BODY = {
  code: "unauthorized",
  message: JobErrorMessages.unauthorized,
};
const NOT_FOUND_BODY = {
  code: "job_not_found",
  message: JobErrorMessages.job_not_found,
};
const FORBIDDEN_BODY = {
  code: "forbidden",
  message: JobErrorMessages.forbidden,
};

async function readyApp() {
  const receiver = makeReceiver();
  const { app, storage, admission, cancellation, observation } = await appWithReceiver(receiver);
  return { receiver, app, storage, admission, cancellation, observation };
}

async function close(app: Awaited<ReturnType<typeof readyApp>>["app"], storage: unknown) {
  await app.close();
  await (storage as { stop(): Promise<void> }).stop();
}

describe("the signed operation routes", () => {
  test("a valid submit instruction reaches its operation and is answered 202 with the accepted reference", async () => {
    const { app, storage, admission } = await readyApp();
    try {
      const token = await mint(submitSpec());
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-1") },
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(202);
      expect(res.headers["cache-control"]).toBe("no-store");
      // The admission's own outcome, mapped onto the wire: the accepted
      // reference — server, job id, status — and nothing else.
      expect(res.json()).toEqual({
        server: "jobs",
        jobId: TEST_JOB_ID,
        status: "queued",
      });
      // The route served the operation with what the receiver verified: the
      // admission decided on those claims and those exact bytes.
      expect(admission.calls).toBe(1);
      expect(admission.lastRequest?.claims.type).toBe("jobs:fetch");
      expect(admission.lastRequest?.claims.generation).toBe("7");
      expect(new TextDecoder().decode(admission.lastRequest?.body)).toBe(TEST_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("the admission's refusals map onto the protocol's fixed responses", async () => {
    const { app, storage, admission } = await readyApp();
    try {
      const cases = [
        {
          outcome: { outcome: "conflict", status: "queued", error: null },
          status: 409,
          body: {
            code: "idempotency_conflict",
            message: JobErrorMessages.idempotency_conflict,
            status: "queued",
            error: null,
          },
        },
        {
          outcome: { outcome: "invalid_input" },
          status: 400,
          body: { code: "payload_invalid", message: JobErrorMessages.payload_invalid },
        },
        {
          outcome: { outcome: "type_unknown" },
          status: 403,
          body: { code: "forbidden", message: JobErrorMessages.forbidden },
        },
        {
          outcome: { outcome: "closed" },
          status: 403,
          body: { code: "forbidden", message: JobErrorMessages.forbidden },
        },
        {
          outcome: { outcome: "unseen" },
          status: 503,
          body: UNAVAILABLE_BODY,
        },
        {
          // A definitive refusal of new work on a closed intake — 503 (the
          // intake may reopen on the same store; the client's keyed retry
          // recovers an uncertain earlier submission), never a fabricated
          // busy answer.
          outcome: { outcome: "intake_closed" },
          status: 503,
          body: DISABLED_BODY,
        },
        {
          outcome: { outcome: "capacity_exceeded" },
          status: 429,
          body: {
            code: "jobs_capacity_exceeded",
            message: JobErrorMessages.jobs_capacity_exceeded,
          },
        },
        {
          // An identical-bytes keyed replay of a job whose public record
          // access has expired: the unknown-job 404, no work created.
          outcome: { outcome: "not_found" },
          status: 404,
          body: NOT_FOUND_BODY,
        },
      ] as const;
      for (const c of cases) {
        admission.outcome = c.outcome;
        const res = await app.inject({
          method: "POST",
          url: "/internal/jobs/v1/jobs",
          headers: {
            ...JSON_HEADERS,
            ...instructionHeaders(await mint(submitSpec()), "retry-key-1"),
          },
          payload: TEST_BODY,
        });
        expect(res.statusCode, c.outcome.outcome).toBe(c.status);
        expect(res.headers["cache-control"], c.outcome.outcome).toBe("no-store");
        expect(res.json(), c.outcome.outcome).toEqual(c.body);
      }
      // An admission the store could not decide is the retryable
      // unavailability — never a fabricated acceptance or refusal.
      admission.failAdmits = true;
      const failed = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          ...JSON_HEADERS,
          ...instructionHeaders(await mint(submitSpec()), "retry-key-1"),
        },
        payload: TEST_BODY,
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual(UNAVAILABLE_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("each operation accepts its own instruction and nothing else", async () => {
    const { app, storage, cancellation, observation } = await readyApp();
    try {
      // Snapshot and result: the bodyless operations on their routes, served
      // by the observation seam (the default in-memory verdict is the
      // not_found refusal — the claims reaching the seam is what this leg
      // pins; the verdicts' full response mapping is the next tests).
      for (const operation of ["snapshot", "result"] as const) {
        const token = await mint({
          operation,
          server: "jobs",
          identity: { ...TEST_IDENTITY },
          jobId: TEST_JOB_ID,
          iatS: TEST_IAT,
        });
        const res = await app.inject({
          method: "GET",
          url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}${operation === "result" ? "/result" : ""}`,
          headers: instructionHeaders(token),
        });
        expect(res.statusCode, operation).toBe(404);
        expect(res.json(), operation).toEqual(NOT_FOUND_BODY);
      }
      expect(observation.calls).toBe(2);
      expect(observation.lastRequest?.claims.operation).toBe("result");
      expect(observation.lastRequest?.claims.appId).toBe(TEST_IDENTITY.appId);
      expect(observation.lastRequest?.claims.env).toBe(TEST_IDENTITY.env);
      expect(observation.lastRequest?.claims.ownerKind).toBe(TEST_IDENTITY.ownerKind);
      expect(observation.lastRequest?.claims.ownerOid).toBe(TEST_IDENTITY.ownerOid);
      expect(observation.lastRequest?.claims.allowedTypes).toEqual([JOBS_FETCH_QUALIFIED_TYPE]);
      expect(observation.lastRequest?.jobId).toBe(TEST_JOB_ID);

      // Cancel: served (the owner-cancellation seam's durable intent plus
      // runner drive). Its full response mapping is the next tests; this
      // leg pins that a valid instruction reaches the operation through the
      // real composition with exactly the verified claims.
      const token = await mint(cancelSpec());
      const res = await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(token),
      });
      expect(res.statusCode).toBe(202);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        server: "jobs",
        jobId: TEST_JOB_ID,
        cancellationRequested: true,
      });
      expect(cancellation.calls).toBe(1);
      expect(cancellation.lastRequest?.claims.operation).toBe("cancel");
      expect(cancellation.lastRequest?.claims.appId).toBe(TEST_IDENTITY.appId);
      expect(cancellation.lastRequest?.claims.env).toBe(TEST_IDENTITY.env);
      expect(cancellation.lastRequest?.claims.ownerKind).toBe(TEST_IDENTITY.ownerKind);
      expect(cancellation.lastRequest?.claims.ownerOid).toBe(TEST_IDENTITY.ownerOid);
      expect(cancellation.lastRequest?.claims.allowedTypes).toEqual([JOBS_FETCH_QUALIFIED_TYPE]);
      expect(cancellation.lastRequest?.jobId).toBe(TEST_JOB_ID);

      // Lifecycle: the portal's direction, its own root — served (the
      // generation authority's apply-before-acknowledge receiver), answered
      // with the applied generation. Its durability semantics are the
      // lifecycle suites' seam; this leg pins that a valid delivery reaches
      // the operation through the real composition.
      const lifecycleToken = await mint({
        operation: "lifecycle",
        server: "jobs",
        appId: TEST_IDENTITY.appId,
        body: new TextEncoder().encode('{"generation":"8","archived":true}'),
        iatS: TEST_IAT,
      });
      const lifecycle = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: { ...JSON_HEADERS, [INSTRUCTION_HEADER]: lifecycleToken },
        payload: '{"generation":"8","archived":true}',
      });
      expect(lifecycle.statusCode).toBe(200);
      expect(lifecycle.headers["cache-control"]).toBe("no-store");
      expect(lifecycle.json()).toEqual({ appliedGeneration: "8" });
    } finally {
      await close(app, storage);
    }
  });

  test("a cancellation's verdicts map onto the protocol's fixed responses", async () => {
    const { app, storage, cancellation } = await readyApp();
    try {
      const cases = [
        {
          verdict: { outcome: "requested" },
          status: 202,
          body: { server: "jobs", jobId: TEST_JOB_ID, cancellationRequested: true },
        },
        {
          verdict: { outcome: "not_found" },
          status: 404,
          body: { code: "job_not_found", message: JobErrorMessages.job_not_found },
        },
        {
          verdict: { outcome: "forbidden" },
          status: 403,
          body: { code: "forbidden", message: JobErrorMessages.forbidden },
        },
        {
          verdict: {
            outcome: "terminal",
            status: "succeeded",
            error: null,
          },
          status: 409,
          body: {
            code: "job_terminal",
            message: JobErrorMessages.job_terminal,
            status: "succeeded",
            error: null,
          },
        },
        {
          verdict: {
            outcome: "terminal",
            status: "failed",
            error: { code: "upstream_error", message: JobErrorMessages.upstream_error },
          },
          status: 409,
          body: {
            code: "job_terminal",
            message: JobErrorMessages.job_terminal,
            status: "failed",
            error: { code: "upstream_error", message: JobErrorMessages.upstream_error },
          },
        },
      ] as const;
      for (const c of cases) {
        cancellation.verdict = c.verdict;
        const res = await app.inject({
          method: "DELETE",
          url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
          headers: instructionHeaders(await mint(cancelSpec())),
        });
        expect(res.statusCode, c.verdict.outcome).toBe(c.status);
        expect(res.headers["cache-control"], c.verdict.outcome).toBe("no-store");
        expect(res.json(), c.verdict.outcome).toEqual(c.body);
      }
      // A store that cannot decide is the retryable unavailability — never
      // a fabricated acknowledgement or refusal.
      cancellation.failRequests = true;
      const failed = await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(await mint(cancelSpec())),
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual(UNAVAILABLE_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a status poll's verdicts map onto the protocol's fixed responses", async () => {
    const { app, storage, observation } = await readyApp();
    try {
      const snapshotJobId = TEST_JOB_ID;
      const cases = [
        {
          verdict: {
            outcome: "found",
            snapshot: {
              server: "jobs",
              jobId: snapshotJobId,
              type: "jobs:fetch",
              status: "running",
              attempt: 1,
              progress: { step: 1, of: 1, label: "Fetched" },
              cancellationRequested: false,
              resultExpiresAt: null,
              recordExpiresAt: null,
              error: null,
            },
          },
          status: 200,
          body: {
            server: "jobs",
            jobId: snapshotJobId,
            type: "jobs:fetch",
            status: "running",
            attempt: 1,
            progress: { step: 1, of: 1, label: "Fetched" },
            cancellationRequested: false,
            resultExpiresAt: null,
            recordExpiresAt: null,
            error: null,
          },
        },
        { verdict: { outcome: "not_found" }, status: 404, body: NOT_FOUND_BODY },
        { verdict: { outcome: "forbidden" }, status: 403, body: FORBIDDEN_BODY },
      ] as const;
      for (const c of cases) {
        observation.snapshotVerdict = c.verdict;
        const res = await app.inject({
          method: "GET",
          url: `/internal/jobs/v1/jobs/${snapshotJobId}`,
          headers: instructionHeaders(await mint(cancelSpec({ operation: "snapshot" }))),
        });
        expect(res.statusCode, c.verdict.outcome).toBe(c.status);
        expect(res.headers["cache-control"], c.verdict.outcome).toBe("no-store");
        expect(res.json(), c.verdict.outcome).toEqual(c.body);
      }
      // A store that cannot answer is the retryable unavailability — never a
      // fabricated snapshot, and the last known state stays visibly stale.
      observation.failReads = true;
      const failed = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${snapshotJobId}`,
        headers: instructionHeaders(await mint(cancelSpec({ operation: "snapshot" }))),
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual(UNAVAILABLE_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a job id at the reference grammar's 128-character bound reaches the record route's handler", async () => {
    // Fastify 5 reads maxParamLength once, at the factory, for every
    // parametric route: the router's default (100) answered a legal
    // 128-character id before any handler ran, on these record routes the
    // same as on the edge's. The bound is the grammar's own, and the id must
    // survive the hop intact — the verified resource is built from the
    // arrival's path segment.
    const { app, storage, observation } = await readyApp();
    try {
      const jobId = "j".repeat(128);
      observation.snapshotVerdict = {
        outcome: "found",
        snapshot: {
          server: "jobs",
          jobId,
          type: "jobs:fetch",
          status: "running",
          attempt: 1,
          progress: null,
          cancellationRequested: false,
          resultExpiresAt: null,
          recordExpiresAt: null,
          error: null,
        },
      };
      const res = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${jobId}`,
        headers: instructionHeaders(await mint(cancelSpec({ operation: "snapshot", jobId }))),
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json().jobId).toBe(jobId);
      expect(observation.lastRequest?.jobId).toBe(jobId);
    } finally {
      await close(app, storage);
    }
  });

  test("a result read's verdicts map onto the protocol's fixed responses", async () => {
    const { app, storage, observation } = await readyApp();
    try {
      const resultJobId = TEST_JOB_ID;
      const cases = [
        {
          verdict: { outcome: "found", resultText: '{"kept":true}' },
          status: 200,
          body: { kept: true },
        },
        {
          verdict: {
            outcome: "not_ready",
            status: "queued",
            error: { code: "upstream_error", message: JobErrorMessages.upstream_error },
          },
          status: 409,
          body: {
            code: "job_not_ready",
            message: JobErrorMessages.job_not_ready,
            status: "queued",
            error: { code: "upstream_error", message: JobErrorMessages.upstream_error },
          },
        },
        {
          verdict: { outcome: "terminal", status: "failed", error: null },
          status: 409,
          body: {
            code: "job_terminal",
            message: JobErrorMessages.job_terminal,
            status: "failed",
            error: null,
          },
        },
        {
          verdict: { outcome: "expired" },
          status: 410,
          body: {
            code: "result_expired",
            message: JobErrorMessages.result_expired,
          },
        },
        { verdict: { outcome: "not_found" }, status: 404, body: NOT_FOUND_BODY },
        { verdict: { outcome: "forbidden" }, status: 403, body: FORBIDDEN_BODY },
      ] as const;
      for (const c of cases) {
        observation.resultVerdict = c.verdict;
        const res = await app.inject({
          method: "GET",
          url: `/internal/jobs/v1/jobs/${resultJobId}/result`,
          headers: instructionHeaders(await mint(cancelSpec({ operation: "result" }))),
        });
        expect(res.statusCode, c.verdict.outcome).toBe(c.status);
        expect(res.headers["cache-control"], c.verdict.outcome).toBe("no-store");
        expect(res.json(), c.verdict.outcome).toEqual(c.body);
      }
      // The found body is the raw JSON value itself — the content type is
      // JSON and the bytes are the stored text, never a re-serialization.
      observation.resultVerdict = { outcome: "found", resultText: '{"kept":true}' };
      const raw = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${resultJobId}/result`,
        headers: instructionHeaders(await mint(cancelSpec({ operation: "result" }))),
      });
      expect(raw.headers["content-type"]).toContain("application/json");
      expect(raw.body).toBe('{"kept":true}');

      // A result nested to the byte cap travels as the same bytes: the send
      // path never re-serializes (the engine's recursive serializer cannot
      // hold this depth — a regression there answers 500 here, visibly).
      const deepText = `${"[".repeat((JOBS_MAX_RESULT_BYTES - 4) / 2)}null${"]".repeat(
        (JOBS_MAX_RESULT_BYTES - 4) / 2,
      )}`;
      observation.resultVerdict = { outcome: "found", resultText: deepText };
      const deep = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${resultJobId}/result`,
        headers: instructionHeaders(await mint(cancelSpec({ operation: "result" }))),
      });
      expect(deep.statusCode).toBe(200);
      expect(deep.body).toBe(deepText);

      // A store that cannot answer is the retryable unavailability.
      observation.failReads = true;
      const failed = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${resultJobId}/result`,
        headers: instructionHeaders(await mint(cancelSpec({ operation: "result" }))),
      });
      expect(failed.statusCode).toBe(503);
      expect(failed.json()).toEqual(UNAVAILABLE_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a snapshot's verdict the wire schema refuses is a 500, never a malformed body on the wire", async () => {
    // The snapshot is validated against the wire schema before it is sent: a
    // store answer with a missing nullable field (here, no `error` key — the
    // explicit-null rule) is a defect answered by the route's error boundary.
    const { app, storage, observation } = await readyApp();
    try {
      const malformed: JobsSnapshotVerdict = {
        outcome: "found",
        // Intentionally malformed: the explicit `error` null is missing.
        snapshot: {
          server: "jobs",
          jobId: TEST_JOB_ID,
          type: "jobs:fetch",
          status: "queued",
          attempt: null,
          progress: null,
          cancellationRequested: false,
          resultExpiresAt: null,
          recordExpiresAt: null,
        },
      } as unknown as JobsSnapshotVerdict;
      observation.snapshotVerdict = malformed;
      const res = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(await mint(cancelSpec({ operation: "snapshot" }))),
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        code: "platform_error",
        message: JobErrorMessages.platform_error,
      });
    } finally {
      await close(app, storage);
    }
  });

  test("a cancel instruction bound to another job's resource is refused before the seam", async () => {
    const { app, storage, cancellation } = await readyApp();
    try {
      // The signed resource names one job id; the route served a different
      // one. The receiver rebuilds the resource from the ROUTE and refuses
      // before the token is spent — the seam is never reached.
      const token = await mint(cancelSpec({ jobId: "aDifferentJobId1234567" }));
      const res = await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(token),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(cancellation.calls).toBe(0);
    } finally {
      await close(app, storage);
    }
  });

  test("a missing instruction header is 401 unauthorized — no body, no verdict, no effect", async () => {
    const { app, storage } = await readyApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: JSON_HEADERS,
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a forged instruction — signed under another root — is 401 before any effect", async () => {
    const { app, storage } = await readyApp();
    try {
      const forged = await mint(submitSpec(), TEST_KEYS.other);
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(forged, "retry-key-1") },
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("an altered body fails the digest binding", async () => {
    const { app, storage } = await readyApp();
    try {
      const token = await mint(submitSpec());
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-1") },
        payload: '{"url":"https://example.com/other.json"}',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a wrong-server instruction is refused even when its signature verifies", async () => {
    const { app, storage } = await readyApp();
    try {
      // Internally consistent claims for another server, signed under THIS
      // receiver's own root: the signature verifies, the server/audience
      // rechecks refuse — a shared-root misconfiguration cannot redeem it.
      const otherServer = "ml-jobs";
      const token = await mint(
        submitSpec({
          server: otherServer,
          type: `${otherServer}:fetch`,
          identity: { ...TEST_IDENTITY, allowedTypes: [`${otherServer}:fetch`] },
        }),
        TEST_KEYS.edgeToJobs,
      );
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-1") },
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a token for one operation cannot authorize another route", async () => {
    const { app, storage } = await readyApp();
    try {
      // A cancel token (DELETE, bound to the cancel resource) presented to the
      // snapshot route: the claims parse fails before anything runs.
      const cancelToken = await mint({
        operation: "cancel",
        server: "jobs",
        identity: { ...TEST_IDENTITY },
        jobId: TEST_JOB_ID,
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(cancelToken),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("an expired instruction is refused at the receiver's clock", async () => {
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec());
      receiver.clock.nowS = TEST_IAT + 36; // lifetime 30 + tolerance 5, one past the boundary
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-1") },
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a replayed instruction is refused; a fresh token with the same retry identity is accepted", async () => {
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec());
      const present = { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-1") };
      const first = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: present,
        payload: TEST_BODY,
      });
      expect(first.statusCode).toBe(202); // accepted, served

      const replay = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: present,
        payload: TEST_BODY,
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toEqual(UNAUTHORIZED_BODY);

      // A legitimate HTTP retry mints a FRESH instruction carrying the SAME
      // retry key and bytes — accepted again, never caught by the burn.
      const retry = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          ...JSON_HEADERS,
          ...instructionHeaders(await mint(submitSpec()), "retry-key-1"),
        },
        payload: TEST_BODY,
      });
      expect(retry.statusCode).toBe(202);
    } finally {
      await close(app, storage);
    }
  });

  test("a signed claim the unsigned header contradicts is refused — no unsigned override", async () => {
    const { app, storage } = await readyApp();
    try {
      const token = await mint(submitSpec()); // signs idempotencyKey "retry-key-1"
      const mismatch = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-2") },
        payload: TEST_BODY,
      });
      expect(mismatch.statusCode).toBe(401);

      // And an unsigned key where the claim is null is equally refused.
      const keyless = await mint(submitSpec({ idempotencyKey: null }));
      const smuggled = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(keyless, "retry-key-2") },
        payload: TEST_BODY,
      });
      expect(smuggled.statusCode).toBe(401);
      expect(smuggled.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a repeated Idempotency-Key header is denied before the token is spent", async () => {
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec());
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          ...JSON_HEADERS,
          [INSTRUCTION_HEADER]: token,
          "idempotency-key": ["retry-key-1", "retry-key-1"],
        } as unknown as Record<string, string>,
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await close(app, storage);
    }
  });

  test("a burn store that cannot answer denies without a verdict — 503, retryable, no oracle", async () => {
    const receiver = makeReceiver();
    receiver.burns.failBurns = true;
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec());
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-1") },
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual(UNAVAILABLE_BODY);
      // The same token may be presented again once the store answers: the
      // failed claim consumed nothing.
      receiver.burns.failBurns = false;
      const retried = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-1") },
        payload: TEST_BODY,
      });
      expect(retried.statusCode).toBe(202); // accepted on the retry
    } finally {
      await close(app, storage);
    }
  });

  test("a route parameter that cannot name a resource is a denial, not a 500", async () => {
    const { app, storage } = await readyApp();
    try {
      // A job id outside the id schema cannot appear in any signed resource,
      // so the receiver rebuilds and refuses before verification.
      const token = await mint({
        operation: "snapshot",
        server: "jobs",
        identity: { ...TEST_IDENTITY },
        jobId: TEST_JOB_ID,
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "GET",
        url: "/internal/jobs/v1/jobs/not%20a%20job%20id",
        headers: instructionHeaders(token),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("the GET routes serve the matrix's method exactly — no HEAD alias", async () => {
    // The receiver binds the operation's method by claim, so a HEAD request
    // carrying a GET-signed instruction would verify and burn: the alias must
    // not exist, and the answer for it is the router's own (a 404 on a ready
    // service), never a served operation — and the token is never spent. Both
    // GET routes carry the refusal: the alias is closed per route, so each
    // route's closure is pinned.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      for (const operation of ["snapshot", "result"] as const) {
        const token = await mint({
          operation,
          server: "jobs",
          identity: { ...TEST_IDENTITY },
          jobId: TEST_JOB_ID,
          iatS: TEST_IAT,
        });
        const res = await app.inject({
          method: "HEAD",
          url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}${operation === "result" ? "/result" : ""}`,
          headers: instructionHeaders(token),
        });
        expect(res.statusCode, operation).toBe(404);
      }
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await close(app, storage);
    }
  });

  test("the callback direction has no receiver here — the fetch path is not a served route", async () => {
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      // `fetch`'s receiver is the edge; a wiring mistake that registered it
      // here would answer 500 through the wrapper's own direction refusal —
      // the router's 404 pins the served surface at exactly the matrix's five
      // receiving operations, and nothing was spent deciding that.
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/fetch",
        headers: JSON_HEADERS,
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(404);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await close(app, storage);
    }
  });

  test("a GET carrying an application/json body is refused with the nonce unspent", async () => {
    // Whichever way the framework treats a body on a bodyless method —
    // skipping the parser (the bytes are uncaptured: the unbindable-body
    // refusal) or running it (the bytes are captured: the digest binding —
    // a snapshot instruction binds the empty digest) — the presentation is
    // refused and the token is never spent deciding.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint({
        operation: "snapshot",
        server: "jobs",
        identity: { ...TEST_IDENTITY },
        jobId: TEST_JOB_ID,
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: { "content-type": "application/json", ...instructionHeaders(token) },
        payload: '{"smuggled":true}',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await close(app, storage);
    }
  });

  test("an oversized body is refused at the input bound", async () => {
    const { app, storage } = await readyApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: JSON_HEADERS,
        payload: "x".repeat(JOBS_MAX_INPUT_BYTES + 1),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({
        code: "payload_too_large",
        message: JobErrorMessages.payload_too_large,
      });
    } finally {
      await close(app, storage);
    }
  });

  test("a body of exactly the platform input bound is served — the bound includes 65,536 bytes", async () => {
    // The wire contract's boundary is inclusive: exactly JOBS_MAX_INPUT_BYTES
    // is within the limit and the byte above is not. A stricter comparison at
    // the transport would answer 413 here instead of serving the request.
    const { app, storage, admission } = await readyApp();
    try {
      const base = '{"url":"https://example.com/';
      const body = `${base}${"p".repeat(JOBS_MAX_INPUT_BYTES - base.length - 2)}"}`;
      expect(new TextEncoder().encode(body)).toHaveLength(JOBS_MAX_INPUT_BYTES);
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          ...JSON_HEADERS,
          ...instructionHeaders(
            await mint(submitSpec({ body: new TextEncoder().encode(body) })),
            "retry-key-1",
          ),
        },
        payload: body,
      });
      expect(res.statusCode).toBe(202);
      expect(admission.calls).toBe(1);
    } finally {
      await close(app, storage);
    }
  });

  test("a body the receiver cannot bind is never served — a valid instruction over a captured-nothing body still fails", async () => {
    // A media type the service parses without capturing (text/plain, replaced
    // with a bounded parser that captures nothing) hands the route a body with
    // no exact bytes to bind: the receiver refuses the presentation outright —
    // it is never verified against the empty digest such a body would match —
    // whatever the media type said.
    const { app, storage } = await readyApp();
    try {
      const token = await mint(submitSpec());
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { "content-type": "text/plain", ...instructionHeaders(token, "retry-key-1") },
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("a body that is not JSON is refused with the fixed envelope, never the parser's message", async () => {
    const { app, storage } = await readyApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: JSON_HEADERS,
        payload: "{not json",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        code: "payload_invalid",
        message: JobErrorMessages.payload_invalid,
      });
    } finally {
      await close(app, storage);
    }
  });

  test("an unknown media type is refused with the fixed envelope, never the framework's default body", async () => {
    // No parser exists for an unlisted media type; the refusal is the error
    // handler's bounded envelope, not the framework's own error body — whose
    // messages quote the request's own bytes back at the caller.
    const { app, storage } = await readyApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { "content-type": "text/csv" },
        payload: "a,b",
      });
      expect(res.statusCode).toBe(415);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        code: "payload_invalid",
        message: JobErrorMessages.payload_invalid,
      });
    } finally {
      await close(app, storage);
    }
  });

  test("a lifecycle delivery is served while the job store is unavailable — the lifecycle authority is its own plane", async () => {
    // The signed routes authenticate by instruction and apply through their
    // own stores; only `/health` and the unmatched-route gate read the
    // storage snapshot. A job-store outage must not refuse the portal's
    // lifecycle delivery — the convergence path stays open exactly when the
    // store is down — so pinning that distinction is what keeps a future
    // "consistency" gate off the lifecycle route.
    const receiver = makeReceiver();
    const lifecycle = new MemoryLifecycle();
    const storage = await storageIn("unavailable");
    const app = buildApp({
      storage,
      instructions: receiver.auth,
      lifecycle,
      admission: new MemoryAdmission(),
      cancellation: new MemoryCancellation(),
      observation: new MemoryObservation(),
      worker: () => ({ started: true, workerRegistered: true }),
      recovery: () => ({
        started: true,
        passes: 1,
        lastPassAt: new Date().toISOString(),
        lastOkPassAt: new Date().toISOString(),
        reconciled: 0,
        lifecycle: { outstanding: 0, oldestPendingAt: null },
      }),
      cleanup: runningCleanup,
      intake: appliedIntake,
      capacityLimits: resolveJobsCapacityLimits(),
    });
    try {
      const token = await mint({
        operation: "lifecycle",
        server: "jobs",
        appId: TEST_IDENTITY.appId,
        body: new TextEncoder().encode('{"generation":"3","archived":true}'),
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: { ...JSON_HEADERS, ...instructionHeaders(token) },
        payload: '{"generation":"3","archived":true}',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({ appliedGeneration: "3" });
      expect(lifecycle.apps.get(TEST_IDENTITY.appId)).toEqual({
        generation: "3",
        archived: true,
      });
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a lifecycle ack the store answer cannot satisfy is a 500, never a malformed body on the wire", async () => {
    // The ack is validated against the wire schema before it is sent: a
    // store answer that is not a valid generation (here one with a leading
    // zero — a generation has exactly one wire form) is a defect answered by
    // the route's error boundary, never delivered 200 off-wire.
    class BadAckLifecycle extends MemoryLifecycle {
      override async apply(): Promise<JobsLifecycleApplyResult> {
        return { appliedGeneration: "007", changed: true, stamped: 0 };
      }
    }
    const receiver = makeReceiver();
    const { app, storage } = await appWithLifecycle(receiver, new BadAckLifecycle());
    try {
      const token = await mint({
        operation: "lifecycle",
        server: "jobs",
        appId: TEST_IDENTITY.appId,
        body: new TextEncoder().encode('{"generation":"8","archived":true}'),
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: { ...JSON_HEADERS, ...instructionHeaders(token) },
        payload: '{"generation":"8","archived":true}',
      });
      expect(res.statusCode).toBe(500);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        code: "platform_error",
        message: JobErrorMessages.platform_error,
      });
    } finally {
      await close(app, storage);
    }
  });

  test("a lifecycle delivery whose body is not a lifecycle update is refused after verification — nothing applied", async () => {
    // The digest binding guarantees the bytes, not their meaning: a body the
    // lifecycle schema refuses is answered with the fixed envelope, and the
    // store is never asked to apply it (the in-memory applier stays empty).
    const lifecycle = new MemoryLifecycle();
    const receiver = makeReceiver();
    const { app, storage } = await appWithLifecycle(receiver, lifecycle);
    try {
      const body = '{"generation":"8"}'; // no `archived` half — not an update
      const token = await mint({
        operation: "lifecycle",
        server: "jobs",
        appId: TEST_IDENTITY.appId,
        body: new TextEncoder().encode(body),
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: { ...JSON_HEADERS, ...instructionHeaders(token) },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual({
        code: "payload_invalid",
        message: JobErrorMessages.payload_invalid,
      });
      expect(lifecycle.apps.size).toBe(0);
    } finally {
      await close(app, storage);
    }
  });

  test("a lifecycle delivery the store cannot apply is the retryable unavailability — nothing acknowledged", async () => {
    // The apply is fail-closed: a store that cannot answer leaves nothing
    // applied, and the answer is the protocol's retryable 503 — the portal's
    // sender delivers again with a fresh instruction.
    const lifecycle = new MemoryLifecycle();
    lifecycle.failApplies = true;
    const receiver = makeReceiver();
    const { app, storage } = await appWithLifecycle(receiver, lifecycle);
    try {
      const token = await mint({
        operation: "lifecycle",
        server: "jobs",
        appId: TEST_IDENTITY.appId,
        body: new TextEncoder().encode('{"generation":"8","archived":true}'),
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: { ...JSON_HEADERS, ...instructionHeaders(token) },
        payload: '{"generation":"8","archived":true}',
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual(UNAVAILABLE_BODY);
      expect(lifecycle.apps.size).toBe(0);

      // The delivery retries with a fresh instruction once the store answers.
      lifecycle.failApplies = false;
      const retried = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: {
          ...JSON_HEADERS,
          ...instructionHeaders(
            await mint({
              operation: "lifecycle",
              server: "jobs",
              appId: TEST_IDENTITY.appId,
              body: new TextEncoder().encode('{"generation":"8","archived":true}'),
              iatS: TEST_IAT,
            }),
          ),
        },
        payload: '{"generation":"8","archived":true}',
      });
      expect(retried.statusCode).toBe(200);
      expect(retried.json()).toEqual({ appliedGeneration: "8" });
    } finally {
      await close(app, storage);
    }
  });

  test("a 503'd lifecycle delivery's nonce is already consumed — the same token retries into a replay refusal, never a second apply", async () => {
    // Burn happens before the operation runs, so a delivery the store refused
    // is consumed all the same. That ordering is what forces the sender's
    // fresh-instruction retry: reusing the token must be answered as a replay
    // (401) without touching the store again — an apply that ran on a
    // replayed token would mean the burn moved after the operation, and the
    // crash window between apply and burn would make a failed delivery
    // unacknowledged and unrepeatable.
    const lifecycle = new MemoryLifecycle();
    lifecycle.failApplies = true;
    const receiver = makeReceiver();
    const { app, storage } = await appWithLifecycle(receiver, lifecycle);
    try {
      const headers = {
        ...JSON_HEADERS,
        ...instructionHeaders(
          await mint({
            operation: "lifecycle",
            server: "jobs",
            appId: TEST_IDENTITY.appId,
            body: new TextEncoder().encode('{"generation":"8","archived":true}'),
            iatS: TEST_IAT,
          }),
        ),
      };
      const refused = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers,
        payload: '{"generation":"8","archived":true}',
      });
      expect(refused.statusCode).toBe(503);

      lifecycle.failApplies = false;
      const replay = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers,
        payload: '{"generation":"8","archived":true}',
      });
      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toEqual(UNAUTHORIZED_BODY);
      // The store was never asked on the replay: the in-memory applier is
      // still empty, the generation still undelivered.
      expect(lifecycle.apps.size).toBe(0);
    } finally {
      await close(app, storage);
    }
  });
});
