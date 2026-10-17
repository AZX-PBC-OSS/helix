import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JOBS_MAX_INPUT_BYTES, jobRequestError } from "@azx-pbc/shared";
import { deriveJobsInstructionKey, JobsOperations } from "@azx-pbc/shared/jobsSigning";
import { HttpJobsForwarder, type JobsSubmitSpec } from "./forwarder.js";
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
