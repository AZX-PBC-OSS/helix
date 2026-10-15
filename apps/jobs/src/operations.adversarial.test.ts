import { describe, expect, test } from "vitest";

import {
  IDEMPOTENCY_KEY_HEADER,
  INSTRUCTION_HEADER,
  JOBS_MAX_INPUT_BYTES,
  JOBS_SERVER_NAME,
  JobErrorMessages,
} from "@azx-pbc/shared";

import {
  appWithReceiver,
  instructionHeaders,
  makeReceiver,
  mint,
  submitSpec,
  TEST_IAT,
  TEST_IDENTITY,
  TEST_JOB_ID,
} from "./test/instructions.js";

/**
 * Adversarial legs for the signed operation routes' body binding: the digest
 * is the only integrity control on a body-carrying instruction, so a body the
 * receiver cannot bind to exact bytes must be refused — never verified against
 * empty — and the platform's input bound must apply to every body the route
 * accepts for parsing, whatever media type claims to carry it. Each test names
 * the contract it attacks; the nonce-spent assertions read the receiver's own
 * burn record, so a refusal that spent the token deciding is a failure too.
 */

const UNAUTHORIZED_BODY = {
  code: "unauthorized",
  message: JobErrorMessages.unauthorized,
};
const SMUGGLED_BODY = '{"url":"https://example.com/smuggled.json"}';

describe("the routes' body binding under media types the receiver cannot bind", () => {
  test("a submit instruction over the empty digest does not authorize a body the receiver never saw", async () => {
    // Fastify ships a built-in text/plain parser: it parses the body into
    // req.body but never captures the raw bytes, so the receiver's digest
    // binds empty. The receiver's own rule (instructionAuth's unbindable
    // body) is that a body with no exact bytes to bind is refused, never
    // verified against empty — the presentation below must therefore be
    // refused, and the nonce must not be spent deciding.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec({ body: new Uint8Array(0), idempotencyKey: null }));
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { "content-type": "text/plain", [INSTRUCTION_HEADER]: token },
        payload: SMUGGLED_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("the same refusal holds on the lifecycle route — the portal's body-carrying operation", async () => {
    // Lifecycle arms neither the retry-key check nor the unbindable-body
    // refusal (it is a body-carrying POST, so the digest is supposed to be
    // the binding) — the same parsed-but-uncaptured media type must still be
    // refused, never verified against the empty digest.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint({
        operation: "lifecycle",
        server: JOBS_SERVER_NAME,
        appId: TEST_IDENTITY.appId,
        body: new Uint8Array(0),
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "POST",
        url: `/internal/jobs/v1/lifecycle/${TEST_IDENTITY.appId}`,
        headers: { "content-type": "text/plain", [INSTRUCTION_HEADER]: token },
        payload: SMUGGLED_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("the platform input bound refuses a body over JOBS_MAX_INPUT_BYTES whatever media type carries it", async () => {
    // The bound rides the application/json parser; a text/plain body is
    // parsed by Fastify's built-in parser under the instance default (1 MiB),
    // so the same-size body the JSON pin answers 413 is here parsed into the
    // handler. Equal bodies on one route get one refusal: 413
    // payload_too_large, before anything is verified.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: { "content-type": "text/plain" },
        payload: "x".repeat(JOBS_MAX_INPUT_BYTES + 1),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({
        code: "payload_too_large",
        message: JobErrorMessages.payload_too_large,
      });
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a bodyless operation refuses an advertised body, and the nonce is not spent deciding", async () => {
    // The unbindable-body refusal has no coverage below the route layer and
    // none at it: a GET carrying a body-shaped request must be refused by the
    // receiver — the bytes were never parsed, so there is nothing to verify
    // against — and the refusal must not consume the instruction.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint({
        operation: "snapshot",
        server: JOBS_SERVER_NAME,
        identity: { ...TEST_IDENTITY },
        jobId: TEST_JOB_ID,
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: instructionHeaders(token),
        payload: "bytes",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a route param encoded to rebuild another operation's resource is refused — a result token served on the snapshot route consumes nothing", async () => {
    // The collision attempt: a result instruction for job X signs the
    // resource /internal/jobs/v1/jobs/X/result, and the snapshot route can be
    // made to rebuild exactly that string — by presenting X%2Fresult, which
    // the router decodes to the param "X/result" before the receiver sees it.
    // The defense is that the decoded param meets JobIdSchema (no slashes)
    // BEFORE substitution, so the rebuild throws and nothing verifies. The
    // router accepts the URL; only the schema stands between the two routes.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const resultToken = await mint({
        operation: "result",
        server: JOBS_SERVER_NAME,
        identity: { ...TEST_IDENTITY },
        jobId: TEST_JOB_ID,
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "GET",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}%2Fresult`,
        headers: instructionHeaders(resultToken),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a body with no content-type at all is refused before the instruction is processed", async () => {
    // No parser is registered for the typeless case (no catch-all), so the
    // framework refuses it before the seam runs — the fail-closed posture the
    // parser posture documents as "anything else is a 415".
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        payload: SMUGGLED_BODY,
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toEqual({
        code: "payload_invalid",
        message: JobErrorMessages.payload_invalid,
      });
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a duplicated instruction header is an unusable presentation, denied before the token is spent", async () => {
    // The retry-key duplicate is pinned; the instruction header's own
    // duplicate shape is not. Whatever the transport does with two copies
    // (Node joins non-special duplicates with ", "), the presentation cannot
    // name one token, so the receiver refuses it and consumes nothing.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec());
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          "content-type": "application/json",
          [INSTRUCTION_HEADER]: [token, token],
          [IDEMPOTENCY_KEY_HEADER]: "retry-key-1",
        } as unknown as Record<string, string>,
        payload: '{"url":"https://example.com/data.json"}',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a cancel instruction never serves a parsed-but-uncaptured body — DELETE is a body-carrying method", async () => {
    // The unbindable-body refusal's arms are per method AND per media type:
    // DELETE is a body-carrying method, so the text/plain parser RUNS on the
    // cancel route and captures nothing — the refusal must fire there too,
    // not only on the bodyless methods where no parser runs at all.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint({
        operation: "cancel",
        server: JOBS_SERVER_NAME,
        identity: { ...TEST_IDENTITY },
        jobId: TEST_JOB_ID,
        iatS: TEST_IAT,
      });
      const res = await app.inject({
        method: "DELETE",
        url: `/internal/jobs/v1/jobs/${TEST_JOB_ID}`,
        headers: { "content-type": "text/plain", ...instructionHeaders(token) },
        payload: "bytes",
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("a chunked text/plain body with no content-length is still an advertised body — refused, nonce unspent", async () => {
    // The advertisement check has two arms; the text/plain smuggling shape
    // must be refused through both. A chunked body with no content-length
    // reaches the parser (the framework does not treat it as empty), is
    // parsed without capture, and must be refused — never verified against
    // the empty digest.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec({ body: new Uint8Array(0), idempotencyKey: null }));
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          "content-type": "text/plain",
          "transfer-encoding": "chunked",
          [INSTRUCTION_HEADER]: token,
        },
        payload: SMUGGLED_BODY,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED_BODY);
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("zero bytes carried bind the empty digest honestly — a text/plain empty-body presentation verifies", async () => {
    // The refusal's soundness boundary from the other side: zero is not an
    // advertised body, and a zero-byte body the parser DOES run on (a
    // present content-type always parses) still binds honestly — an
    // instruction minted over the empty digest verifies against a request
    // that carried exactly zero bytes. If the advertisement check were
    // tightened to read '0' as a body, honest empty presentations would be
    // refused — the line the unbindable-body refusal stands on is
    // 'advertised and carried', not 'mentioned'.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec({ body: new Uint8Array(0), idempotencyKey: null }));
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          "content-type": "text/plain",
          "content-length": "0",
          [INSTRUCTION_HEADER]: token,
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        code: "jobs_unavailable",
        message: JobErrorMessages.jobs_unavailable,
      });
      expect(receiver.burns.seen.size).toBe(1);
    } finally {
      await app.close();
      await storage.stop();
    }
  });

  test("an empty application/json body is refused as unparseable before the instruction is processed", async () => {
    // The framework parses a body whenever the content-type is present — a
    // zero-length JSON body reaches the parser and JSON.parse('') throws. The
    // refusal is the fixed input envelope, fail closed, and the nonce is
    // never spent deciding: an empty body is not the JSON the media type
    // promised.
    const receiver = makeReceiver();
    const { app, storage } = await appWithReceiver(receiver);
    try {
      const token = await mint(submitSpec({ body: new Uint8Array(0), idempotencyKey: null }));
      const res = await app.inject({
        method: "POST",
        url: "/internal/jobs/v1/jobs",
        headers: {
          "content-type": "application/json",
          "content-length": "0",
          [INSTRUCTION_HEADER]: token,
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        code: "payload_invalid",
        message: JobErrorMessages.payload_invalid,
      });
      expect(receiver.burns.seen.size).toBe(0);
    } finally {
      await app.close();
      await storage.stop();
    }
  });
});
