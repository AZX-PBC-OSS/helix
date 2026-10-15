import { describe, expect, test } from "vitest";

import { INSTRUCTION_HEADER, JobErrorMessages, JOBS_MAX_INPUT_BYTES } from "@azx-pbc/shared";

import { buildApp } from "./app.js";
import type { JobsLifecycleApplyResult } from "./lifecycle.js";
import {
  appWithLifecycle,
  appWithReceiver,
  instructionHeaders,
  makeReceiver,
  mint,
  MemoryLifecycle,
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
 * The operations' semantics are later tickets' seams — until one lands its
 * route answers the protocol's retryable unavailable error, and the tests pin
 * that the placeholder cannot be mistaken for a served operation.
 */

const JSON_HEADERS = { "content-type": "application/json" };
const UNAVAILABLE_BODY = {
  code: "jobs_unavailable",
  message: JobErrorMessages.jobs_unavailable,
};
const UNAUTHORIZED_BODY = {
  code: "unauthorized",
  message: JobErrorMessages.unauthorized,
};

async function readyApp() {
  const receiver = makeReceiver();
  const { app, storage } = await appWithReceiver(receiver);
  return { receiver, app, storage };
}

async function close(app: Awaited<ReturnType<typeof readyApp>>["app"], storage: unknown) {
  await app.close();
  await (storage as { stop(): Promise<void> }).stop();
}

describe("the signed operation routes", () => {
  test("a valid submit instruction reaches its operation, answered 503 with the protocol's retryable error", async () => {
    const { app, storage } = await readyApp();
    try {
      const token = await mint(submitSpec());
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { ...JSON_HEADERS, ...instructionHeaders(token, "retry-key-1") },
        payload: TEST_BODY,
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.json()).toEqual(UNAVAILABLE_BODY);
    } finally {
      await close(app, storage);
    }
  });

  test("each other operation accepts its own instruction and nothing else", async () => {
    const { app, storage } = await readyApp();
    try {
      // Snapshot, result, cancel: the bodyless operations on their routes,
      // still placeholder-served until their tickets land.
      for (const operation of ["snapshot", "result", "cancel"] as const) {
        const token = await mint({
          operation,
          server: "jobs",
          identity: { ...TEST_IDENTITY },
          jobId: TEST_JOB_ID,
          iatS: TEST_IAT,
        });
        const res = await app.inject({
          method: operation === "cancel" ? "DELETE" : "GET",
          url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}${operation === "result" ? "/result" : ""}`,
          headers: instructionHeaders(token),
        });
        expect(res.statusCode, operation).toBe(503);
        expect(res.json(), operation).toEqual(UNAVAILABLE_BODY);
      }

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
      expect(first.statusCode).toBe(503); // accepted, placeholder-served

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
      expect(retry.statusCode).toBe(503);
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
      expect(retried.statusCode).toBe(503); // accepted on the retry
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
    const app = buildApp({ storage, instructions: receiver.auth, lifecycle });
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
        return { appliedGeneration: "007", changed: true };
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
