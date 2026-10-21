import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JOBS_MAX_INPUT_BYTES, JOBS_MAX_RESULT_BYTES, jobRequestError } from "@azx-pbc/shared";
import { deriveJobsInstructionKey, JobsOperations } from "@azx-pbc/shared/jobsSigning";
import { HttpJobsForwarder, type JobsRecordSpec, type JobsSubmitSpec } from "./forwarder.js";
import { FakeJobsServiceReceiver } from "../test/jobsReceiver.js";

/**
 * The edge→jobs forwarding seam, against a REAL socket — no mock stands in for
 * the transport, because the seam's whole job is the signed HTTP hop. The
 * stand-in receiver authenticates every presentation through the SHARED
 * verifier (the exact check the jobs receiver runs), so a minter the receiver
 * would refuse fails here; its mint/verify specifics are asserted through the
 * captured claims and digests.
 */

const ROOT = Buffer.alloc(32, 1).toString("base64");
const KEY = deriveJobsInstructionKey(ROOT, "edgeToJobs");
const SERVER = "jobs";
const ACCEPTED_BODY = JSON.stringify({ server: SERVER, jobId: "job-123", status: "queued" });

function spec(overrides: Partial<JobsSubmitSpec> = {}): JobsSubmitSpec {
  return {
    server: SERVER,
    identity: {
      appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      env: "prod",
      ownerKind: "user",
      ownerOid: "alice",
      allowedTypes: ["jobs:fetch"],
    },
    type: "jobs:fetch",
    generation: "1",
    idempotencyKey: null,
    body: new TextEncoder().encode('{"url":"https://api.vendor.test/v1"}'),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("HttpJobsForwarder", () => {
  it("mints an instruction the shared verifier accepts, over the exact forwarded bytes", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const body = new TextEncoder().encode('{"url":"https://api.vendor.test/v1"}');
    const verdict = await forwarder.submit(spec({ body }));
    await forwarder.close();

    expect(receiver.verifyFailures).toEqual([]);
    expect(receiver.calls).toHaveLength(1);
    const call = receiver.calls[0]!;
    // The operation matrix owns the route: no restated path can drift from it.
    expect(call.claims.resource).toBe(JobsOperations.submit.path);
    expect(call.claims.method).toBe("POST");
    expect(call.claims).toMatchObject({
      server: SERVER,
      operation: "submit",
      appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      env: "prod",
      ownerKind: "user",
      ownerOid: "alice",
      allowedTypes: ["jobs:fetch"],
      type: "jobs:fetch",
      generation: "1",
      idempotencyKey: null,
    });
    // The exact bytes survive the hop — the digest binds them.
    expect(Buffer.from(call.body)).toEqual(Buffer.from(body));

    expect(verdict.kind).toBe("accepted");
    if (verdict.kind === "accepted") {
      expect(verdict.accepted).toEqual({
        server: SERVER,
        jobId: "job-123",
        status: "queued",
      });
      // The acceptance response is forwarded as received — byte-identical.
      expect(Buffer.from(verdict.rawBody).toString()).toBe(ACCEPTED_BODY);
    }
    await receiver.stop();
  });

  it("presents the retry key as both the signed claim and the header", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    await forwarder.submit(spec({ idempotencyKey: "retry-key-1" }));
    await forwarder.close();

    expect(receiver.verifyFailures).toEqual([]);
    const call = receiver.calls[0]!;
    expect(call.presentedRetryKey).toBe("retry-key-1");
    expect(call.claims.idempotencyKey).toBe("retry-key-1");
    await receiver.stop();
  });

  it("forwards a validated jobs error response with its own status, unchanged", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = {
      status: 400,
      body: JSON.stringify({
        code: "payload_invalid",
        message: "The job input is not valid for this job type.",
      }),
    };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const verdict = await forwarder.submit(spec());
    await forwarder.close();

    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.status).toBe(400);
      expect(verdict.error).toMatchObject({ code: "payload_invalid" });
      // The fixed, sanitized message — an echoed input is unrepresentable.
      expect(verdict.error.message).toBe("The job input is not valid for this job type.");
    }
    await receiver.stop();
  });

  it("classifies a mismatched acceptance reference as an invalid response, never a redirect", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    // A valid-shaped acceptance for ANOTHER server — a response cannot repoint
    // the caller at another namespace.
    receiver.answer = {
      status: 202,
      body: JSON.stringify({ server: "other", jobId: "job-123", status: "queued" }),
    };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const verdict = await forwarder.submit(spec());
    await forwarder.close();
    expect(verdict).toMatchObject({ kind: "invalid_response", status: 202 });
    await receiver.stop();
  });

  it("classifies garbage and redirect answers as invalid responses", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );

    receiver.answer = { status: 202, body: "<html>not json</html>" };
    expect(await forwarder.submit(spec())).toMatchObject({ kind: "invalid_response", status: 202 });

    receiver.answer = { status: 302, body: "moved" };
    expect(await forwarder.submit(spec())).toMatchObject({ kind: "invalid_response", status: 302 });

    // A 404 whose body is the runner's own stock envelope (a route that does
    // not exist — version skew) is unusable, not a protocol answer.
    receiver.answer = {
      status: 404,
      body: JSON.stringify({ message: "Route POST:/internal/jobs/v1/jobs not found" }),
    };
    expect(await forwarder.submit(spec())).toMatchObject({ kind: "invalid_response", status: 404 });

    // An oversized answer is refused, never trusted.
    receiver.answer = { status: 202, body: "x".repeat(JOBS_MAX_INPUT_BYTES + 1) };
    expect(await forwarder.submit(spec())).toMatchObject({ kind: "invalid_response" });

    await forwarder.close();
    await receiver.stop();
  });

  it("classifies a well-formed acceptance answered off 202 as an invalid response", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    // The acceptance is the 202's body, not any 2xx body: a 200 carrying a
    // valid acceptance shape is not a protocol answer.
    receiver.answer = {
      status: 200,
      body: JSON.stringify({ server: SERVER, jobId: "job-123", status: "queued" }),
    };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const verdict = await forwarder.submit(spec());
    await forwarder.close();
    expect(verdict).toMatchObject({ kind: "invalid_response", status: 200 });
    await receiver.stop();
  });

  it("forwards the receiver's own 5xx error envelope as a refusal with its status", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    // A 5xx whose body IS a valid jobs error is an answered refusal — the
    // receiver's sanitized answer travels with its status, and the telemetry
    // says `server_refused`, not the outage class.
    receiver.answer = {
      status: 503,
      body: JSON.stringify(jobRequestError("jobs_unavailable")),
    };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const verdict = await forwarder.submit(spec());
    await forwarder.close();
    expect(verdict.kind).toBe("refused");
    if (verdict.kind === "refused") {
      expect(verdict.status).toBe(503);
      expect(verdict.error).toMatchObject({ code: "jobs_unavailable" });
    }
    await receiver.stop();
  });

  it("answers unreachable on a connection refusal, with no retry", async () => {
    // A port with no listener (bind then release).
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    await receiver.stop();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const verdict = await forwarder.submit(spec());
    await forwarder.close();
    expect(verdict.kind).toBe("unreachable");
  });

  it("answers unreachable when the bound expires, with no retry", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = { delayMs: 10_000 }; // a server that never answers in time
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 150 },
    );
    const started = Date.now();
    const verdict = await forwarder.submit(spec());
    const waited = Date.now() - started;
    await forwarder.close();

    expect(verdict.kind).toBe("unreachable");
    // The bound is the answer, not a hang: well under the fake's hold time.
    expect(waited).toBeLessThan(5_000);
    // No automatic resubmit: exactly one request was ever sent.
    expect(receiver.calls).toHaveLength(1);
    await receiver.stop();
  });

  it("cuts off a slow-drip answer at the total bound — an answer that never became usable", async () => {
    // Headers arrive instantly (every per-wait ceiling is satisfied); the body
    // never ends. The answer DID arrive, so this is the invalid-response class
    // (an unusable answer), not unreachable — and the request bound is a
    // TOTAL: the route's caller-facing resolution bound holds against a server
    // whose every per-chunk wait fits the ceilings.
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = { dripEveryMs: 50 };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 200 },
    );
    const started = Date.now();
    const verdict = await forwarder.submit(spec());
    const waited = Date.now() - started;
    await forwarder.close();

    expect(verdict).toMatchObject({ kind: "invalid_response", status: 202 });
    expect(waited).toBeLessThan(5_000);
    await receiver.stop();
  });

  it("aborts the forward when the caller's signal fires", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = { delayMs: 10_000 };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 10_000 },
    );
    const abort = new AbortController();
    const pending = forwarder.submit(spec({ signal: abort.signal }));
    setTimeout(() => abort.abort(), 50);
    const verdict = await pending;
    await forwarder.close();
    expect(verdict.kind).toBe("unreachable");
    await receiver.stop();
  });

  it("throws on an unconfigured server — a wiring defect, not a request answer", async () => {
    const forwarder = new HttpJobsForwarder([], { timeoutMs: 5_000 });
    await expect(forwarder.submit(spec())).rejects.toThrow(/not configured/);
    await forwarder.close();
  });

  it("mints a fresh jti per forward — a retry is a new instruction, same identity", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    await forwarder.submit(spec({ idempotencyKey: "retry-key-1" }));
    await forwarder.submit(spec({ idempotencyKey: "retry-key-1" }));
    await forwarder.close();

    expect(receiver.verifyFailures).toEqual([]);
    expect(receiver.calls).toHaveLength(2);
    // Two presentations of the same retry identity: the nonce is never reused
    // (the receiver's burn would refuse the second presentation of one token),
    // and the bodies are byte-identical — the original bytes, never a
    // re-serialization.
    const [first, second] = receiver.calls;
    expect(first!.jti).not.toBe(second!.jti);
    expect(Buffer.from(first!.body)).toEqual(Buffer.from(second!.body));
    expect(createHash("sha256").update(first!.body).digest()).toEqual(
      createHash("sha256").update(second!.body).digest(),
    );
    await receiver.stop();
  });

  it("forwards a BINARY body byte-exact — the digest binds bytes, never text", async () => {
    // Every forwarder test so far feeds ASCII JSON. The input contract is
    // bytes (the signed digest binds them), so a body carrying NULs and every
    // one of the 256 byte values — plus the UTF-8 BOM and multibyte sequences
    // a TextDecoder/Encoder laundering pass would rewrite — must survive the
    // hop exactly.
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const body = new Uint8Array([
      ...Array.from({ length: 256 }, (_, i) => i),
      ...Buffer.from("\uFEFF\u00e9\u4e16\u{1F511}", "utf8"),
    ]);
    const verdict = await forwarder.submit(spec({ body }));
    await forwarder.close();

    expect(receiver.verifyFailures).toEqual([]);
    expect(verdict.kind).toBe("accepted");
    expect(Buffer.from(receiver.calls[0]!.body)).toEqual(Buffer.from(body));
    if (verdict.kind === "accepted") {
      // The acceptance is forwarded as received; the submitted bytes are gone.
      expect(Buffer.from(verdict.rawBody).toString()).toBe(ACCEPTED_BODY);
    }
    await receiver.stop();
  });
});

/**
 * The three record operations — poll, result read, cancellation — over the
 * same seam. The instruction is BODYLESS (the empty digest), the method and
 * resource come from the shared operation matrix, and the success response is
 * accepted only when it is schema-conformant AND names the addressed
 * reference; the receiver stand-in verifies every presentation through the
 * shared verifier, so a mint the real receiver would refuse fails here.
 */
describe("HttpJobsForwarder — the record operations", () => {
  const SNAPSHOT_BODY = JSON.stringify({
    server: SERVER,
    jobId: "job-123",
    type: "jobs:fetch",
    status: "running",
    attempt: 1,
    progress: { step: 1, of: 2, label: "halfway" },
    cancellationRequested: false,
    resultExpiresAt: null,
    recordExpiresAt: null,
    error: null,
  });

  function recordSpec(overrides: Partial<JobsRecordSpec> = {}): JobsRecordSpec {
    return {
      server: SERVER,
      identity: {
        appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        env: "prod",
        ownerKind: "user",
        ownerOid: "alice",
        allowedTypes: ["jobs:fetch"],
      },
      jobId: "job-123",
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  it("carries a poll as a GET instruction bound to the record's exact resource and the empty digest", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = { status: 200, body: SNAPSHOT_BODY };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const verdict = await forwarder.snapshot(recordSpec());
    await forwarder.close();

    expect(receiver.verifyFailures).toEqual([]);
    expect(receiver.calls).toHaveLength(0);
    expect(receiver.recordCalls).toHaveLength(1);
    const call = receiver.recordCalls[0]!;
    // The operation matrix owns the route; the instruction binds the record's
    // CONCRETE resource (the template filled with the addressed id) and the
    // empty body, and the claims carry the trusted identity and grants for
    // the receiver's own enforcement.
    expect(call.operation).toBe("snapshot");
    expect(call.claims.resource).toBe("/internal/jobs/v1/jobs/job-123");
    expect(call.claims.method).toBe("GET");
    expect(call.claims).toMatchObject({
      server: SERVER,
      operation: "snapshot",
      appId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      env: "prod",
      ownerKind: "user",
      ownerOid: "alice",
      allowedTypes: ["jobs:fetch"],
    });
    expect(call.body.byteLength).toBe(0);

    expect(verdict.kind).toBe("found");
    if (verdict.kind === "found") {
      expect(verdict.status).toBe(200);
      expect(verdict.snapshot).toMatchObject({
        server: SERVER,
        jobId: "job-123",
        status: "running",
        type: "jobs:fetch",
      });
      expect(Buffer.from(verdict.rawBody).toString()).toBe(SNAPSHOT_BODY);
    }
    await receiver.stop();
  });

  it("classifies a snapshot naming another server or another job as an invalid response", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );

    // A valid-shaped snapshot for ANOTHER server — a response cannot repoint
    // the caller at another namespace.
    receiver.answer = {
      status: 200,
      body: JSON.stringify({ ...JSON.parse(SNAPSHOT_BODY), server: "other" }),
    };
    expect(await forwarder.snapshot(recordSpec())).toMatchObject({
      kind: "invalid_response",
      status: 200,
    });

    // And for another job on the same server: the reference is the pair.
    receiver.answer = {
      status: 200,
      body: JSON.stringify({ ...JSON.parse(SNAPSHOT_BODY), jobId: "job-other" }),
    };
    expect(await forwarder.snapshot(recordSpec())).toMatchObject({
      kind: "invalid_response",
      status: 200,
    });

    await forwarder.close();
    await receiver.stop();
  });

  it("answers a redirect and a non-200 success the invalid-response class — never followed, never a verdict", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );

    // A 302 carrying a parseable body: the agent does not follow it, and a
    // JSON body does not rescue it — no redirect is a verdict on a poll.
    receiver.answer = { status: 302, body: SNAPSHOT_BODY };
    expect(await forwarder.snapshot(recordSpec())).toMatchObject({
      kind: "invalid_response",
      status: 302,
    });

    // A 2xx that is not the snapshot's 200 is unusable — an empty body never
    // reads as an empty or absent answer.
    receiver.answer = { status: 204, body: "" };
    expect(await forwarder.snapshot(recordSpec())).toMatchObject({
      kind: "invalid_response",
      status: 204,
    });

    await forwarder.close();
    await receiver.stop();
  });

  it("forwards a result read as a bodyless GET and accepts the raw JSON value — null included", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );

    // JSON null IS a result — the value the job produced.
    receiver.answer = { status: 200, body: "null" };
    const verdict = await forwarder.result(recordSpec());
    expect(verdict.kind).toBe("found");
    if (verdict.kind === "found") {
      expect(Buffer.from(verdict.rawBody).toString()).toBe("null");
    }

    // The odd spacing the server sent is what the caller reads.
    receiver.answer = { status: 200, body: '{"items":[1, 2, 3],  "nested":{"a":null}}' };
    const spaced = await forwarder.result(recordSpec());
    expect(spaced.kind).toBe("found");
    if (spaced.kind === "found") {
      expect(Buffer.from(spaced.rawBody).toString()).toBe(
        '{"items":[1, 2, 3],  "nested":{"a":null}}',
      );
    }

    // A 200 that is not JSON is an unusable answer, not an empty result.
    receiver.answer = { status: 200, body: "<html>not json</html>" };
    expect(await forwarder.result(recordSpec())).toMatchObject({ kind: "invalid_response" });

    await forwarder.close();
    await receiver.stop();
  });

  it("refuses a result over the response bound, and forwards the receiver's own refusals", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );

    receiver.answer = { status: 200, body: "x".repeat(JOBS_MAX_RESULT_BYTES + 1) };
    expect(await forwarder.result(recordSpec())).toMatchObject({ kind: "invalid_response" });

    // The stateful 409 carries the job's status and error — a valid jobs error
    // response, forwarded with its own status.
    receiver.answer = {
      status: 409,
      body: JSON.stringify(jobRequestError("job_not_ready", { status: "running", error: null })),
    };
    const notReady = await forwarder.result(recordSpec());
    expect(notReady.kind).toBe("refused");
    if (notReady.kind === "refused") {
      expect(notReady.status).toBe(409);
      expect(notReady.error).toMatchObject({ code: "job_not_ready", status: "running" });
    }

    receiver.answer = {
      status: 410,
      body: JSON.stringify(jobRequestError("result_expired")),
    };
    const expired = await forwarder.result(recordSpec());
    expect(expired.kind).toBe("refused");
    if (expired.kind === "refused") {
      expect(expired.status).toBe(410);
      expect(expired.error.code).toBe("result_expired");
    }

    await forwarder.close();
    await receiver.stop();
  });

  it("carries a cancellation as a DELETE instruction and validates the acknowledgement's reference", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );

    receiver.answer = {
      status: 202,
      body: JSON.stringify({ server: SERVER, jobId: "job-123", cancellationRequested: true }),
    };
    const verdict = await forwarder.cancel(recordSpec());
    expect(receiver.verifyFailures).toEqual([]);
    const call = receiver.recordCalls.at(-1)!;
    expect(call.operation).toBe("cancel");
    expect(call.claims.method).toBe("DELETE");
    expect(call.claims.resource).toBe("/internal/jobs/v1/jobs/job-123");
    expect(call.body.byteLength).toBe(0);
    expect(verdict.kind).toBe("accepted");
    if (verdict.kind === "accepted") {
      expect(verdict.cancellation).toEqual({
        server: SERVER,
        jobId: "job-123",
        cancellationRequested: true,
      });
      expect(Buffer.from(verdict.rawBody).toString()).toBe(
        JSON.stringify({ server: SERVER, jobId: "job-123", cancellationRequested: true }),
      );
    }

    // An acknowledgement for another job is unusable — never a redirect.
    receiver.answer = {
      status: 202,
      body: JSON.stringify({ server: SERVER, jobId: "job-other", cancellationRequested: true }),
    };
    expect(await forwarder.cancel(recordSpec())).toMatchObject({
      kind: "invalid_response",
      status: 202,
    });

    await forwarder.close();
    await receiver.stop();
  });

  it("answers the record operations unreachable with no retry, like submit", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const base = await receiver.start();
    await receiver.stop(); // a port with no listener
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    expect((await forwarder.snapshot(recordSpec())).kind).toBe("unreachable");
    expect((await forwarder.result(recordSpec())).kind).toBe("unreachable");
    expect((await forwarder.cancel(recordSpec())).kind).toBe("unreachable");
    await forwarder.close();
  });

  it("aborts a held poll when the caller's signal fires — an abandoned poll drives nothing", async () => {
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = { delayMs: 10_000 };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 10_000 },
    );
    const abort = new AbortController();
    const pending = forwarder.snapshot(recordSpec({ signal: abort.signal }));
    setTimeout(() => abort.abort(), 50);
    const verdict = await pending;
    await forwarder.close();
    expect(verdict.kind).toBe("unreachable");
    // One presentation, no re-send: the abandoned poll is an observation
    // failure, never a cancellation or a resubmission.
    expect(receiver.recordCalls).toHaveLength(1);
    await receiver.stop();
  });

  it("forwards a result of exactly the response bound — the largest legal answer", async () => {
    // The bound is inclusive (one past it is the refusal the sibling above
    // pins), and a result is any JSON value, so a result of exactly
    // JOBS_MAX_RESULT_BYTES is a legal answer the seam must forward whole.
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    const result = `"${"x".repeat(JOBS_MAX_RESULT_BYTES - 2)}"`;
    expect(Buffer.byteLength(result)).toBe(JOBS_MAX_RESULT_BYTES);
    receiver.answer = { status: 200, body: result };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const verdict = await forwarder.result(recordSpec());
    await forwarder.close();
    // An off-by-one in the seam's own cap would read this as unusable.
    expect(verdict.kind).toBe("found");
    if (verdict.kind === "found") {
      expect(Buffer.from(verdict.rawBody).toString()).toBe(result);
    }
    await receiver.stop();
  });

  it("never resolves a receiver that dies mid-body into a result — a truncated prefix is not an answer", async () => {
    // The dangerous shape: the receiver answers 200 and dies before the body
    // completes. The verdict must never be the `found` class — the sharp form
    // is the one whose truncation is STILL valid JSON: a numeric result cut
    // mid-digits parses as a different number, so a body stream that resolved
    // its prefix as a success would hand the app a silently wrong result with
    // a 200. Two shapes, distinguished by whether any answer survives:
    //
    //  - an immediate socket destroy (RST): undici rejects the request whole
    //    — no answer arrived, the `unreachable` class;
    //  - a premature end with the content-length shortfall detectable: undici
    //    resolves the headers and then emits NOTHING on the body — not end,
    //    not close, not error, and the per-wait body timeout never arms on
    //    the FIN. The forward is rescued only by the total round-trip bound
    //    (the AbortSignal.any), whose abort settles the collector's `failed`
    //    arm — the invalid-response class, a full bound later.
    const cases = [
      { name: "numeric result destroyed mid-digits", body: "12345678901234567890", keep: 4 },
      { name: "non-JSON body destroyed", body: "<html>not json</html>", keep: 10 },
    ] as const;
    for (const { name, body, keep } of cases) {
      const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
      receiver.answer = { status: 200, body, truncateAfterBytes: keep };
      const base = await receiver.start();
      const forwarder = new HttpJobsForwarder(
        [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
        { timeoutMs: 5_000 },
      );
      const started = Date.now();
      const verdict = await forwarder.result(recordSpec());
      const waited = Date.now() - started;
      await forwarder.close();
      await receiver.stop();
      expect(verdict.kind, name).not.toBe("found");
      expect(["unreachable", "invalid_response"], name).toContain(verdict.kind);
      // The dead answer is a verdict, not a hang.
      expect(waited, name).toBeLessThan(5_000);
    }

    // The premature-end shape: headers delivered, body short of its promised
    // length, FIN — and silence from the body stream. The verdict is the
    // invalid-response class, and it arrives at the total bound (pinned at
    // 1s here; the production bound is the mint window), never before, and
    // never as a success for the prefix.
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = {
      status: 200,
      body: "12345678901234567890",
      truncateAfterBytes: 4,
      prematureEndAfterMs: 50,
    };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 1_000 },
    );
    const started = Date.now();
    const verdict = await forwarder.result(recordSpec());
    const waited = Date.now() - started;
    await forwarder.close();
    await receiver.stop();
    expect(verdict).toMatchObject({ kind: "invalid_response", status: 200 });
    // The silent close costs the whole bound: nothing answers sooner.
    expect(waited).toBeGreaterThanOrEqual(1_000);
    expect(waited).toBeLessThan(5_000);
  });

  it("answers a cancellation carried off 202 — a 200 with a valid acknowledgement is unusable", async () => {
    // The acknowledgement is the 202's body, not any 2xx body: a receiver
    // answering 200 with a well-formed acknowledgement is not a protocol
    // answer, and its status must not become the caller's.
    const receiver = new FakeJobsServiceReceiver({ rootBase64: ROOT });
    receiver.answer = {
      status: 200,
      body: JSON.stringify({ server: SERVER, jobId: "job-123", cancellationRequested: true }),
    };
    const base = await receiver.start();
    const forwarder = new HttpJobsForwarder(
      [{ server: SERVER, endpoint: base, edgeToJobsKey: KEY }],
      { timeoutMs: 5_000 },
    );
    const verdict = await forwarder.cancel(recordSpec());
    await forwarder.close();
    expect(verdict).toMatchObject({ kind: "invalid_response", status: 200 });
    await receiver.stop();
  });
});
