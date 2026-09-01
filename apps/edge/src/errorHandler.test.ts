import { Writable } from "node:stream";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { loggerOption } from "@azx-pbc/shared/logging";
import { edgeErrorHandler } from "./errors.js";

/**
 * The edge's unhandled-throw handler.
 *
 * `buildApp` can't be used: `loggerOption()` resolves to `false` under
 * NODE_ENV=test, and half of what is under test here is what reaches the log.
 * So these build a bare instance carrying the same handler, the same way
 * `logging.test.ts` does for the serializer.
 */

function captureLogs(): { lines: unknown[]; stream: Writable } {
  const lines: unknown[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(line));
      cb();
    },
  });
  return { lines, stream };
}

/**
 * A bare Fastify carrying THE handler — imported, not re-implemented. A copy
 * here could pass while `app.ts` drifted, which would make this suite worse
 * than no suite.
 */
function buildErrorApp(stream: Writable): FastifyInstance {
  const option = loggerOption("production");
  if (option === false) throw new Error("unreachable");
  const app = Fastify({ logger: { ...option, stream } });
  app.setErrorHandler(edgeErrorHandler);
  return app;
}

const SECRET = "session-key-material-nobody-should-see";

describe("the edge unhandled-error handler", () => {
  it("never puts the thrown message in the body", async () => {
    // The whole reason this exists: Fastify's stock handler sends `err.message`,
    // and on the edge that body is read by untrusted app code.
    const { stream } = captureLogs();
    const app = buildErrorApp(stream);
    app.get("/boom", async () => {
      throw new Error(`decrypt failed for ${SECRET}`);
    });

    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain(SECRET);
    expect(res.body).not.toContain("decrypt failed");
    expect(res.body).toBe("Internal server error\n");
    expect(res.headers["cache-control"]).toBe("no-store");
    await app.close();
  });

  it("says nothing about which handler threw", async () => {
    // `errors.ts`'s senders are deliberately indistinguishable so a guard does
    // not disclose which one fired; an unhandled 500 must not be the exception.
    const { stream } = captureLogs();
    const app = buildErrorApp(stream);
    app.get("/a", async () => {
      throw new Error("in the session store");
    });
    app.get("/b", async () => {
      throw new Error("in the blob reader");
    });

    const a = await app.inject({ method: "GET", url: "/a" });
    const b = await app.inject({ method: "GET", url: "/b" });
    expect(a.body).toBe(b.body);
    expect(a.statusCode).toBe(b.statusCode);
    await app.close();
  });

  it("logs the error with its stack, exactly once", async () => {
    const { lines, stream } = captureLogs();
    const app = buildErrorApp(stream);
    app.get("/boom", async () => {
      throw new Error("kaboom");
    });
    await app.inject({ method: "GET", url: "/boom" });
    await app.close();

    const errors = lines.filter(
      (l): l is { event: string; err: { stack: string; message: string } } =>
        typeof l === "object" && l !== null && "event" in l,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]?.event).toBe("edge.unhandled_error");
    // The diagnosis has to land somewhere — it just isn't the response body.
    expect(errors[0]?.err.message).toBe("kaboom");
    expect(errors[0]?.err.stack).toContain("Error: kaboom");
  });

  it("keeps the gateway error envelope on /_api/* so an app's client can parse it", async () => {
    const { stream } = captureLogs();
    const app = buildErrorApp(stream);
    app.get("/_api/llm/chat", async () => {
      throw new Error("boom");
    });

    const res = await app.inject({ method: "GET", url: "/_api/llm/chat" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal", message: "internal server error" } });
    await app.close();
  });

  it("preserves a real 4xx rather than blanket-500ing it", async () => {
    // The edge's hand-rolled content-type parsers produce genuine 400s, and
    // Fastify raises its own 413/415. Turning those into 500s would be a
    // behaviour regression the handler introduced.
    const { stream } = captureLogs();
    const app = buildErrorApp(stream);
    app.get("/bad", async () => {
      throw Object.assign(new Error("malformed"), { statusCode: 400 });
    });
    app.get("/big", async () => {
      throw Object.assign(new Error("too large"), { statusCode: 413 });
    });

    // A 5xx from below is still normalised — we do not forward an upstream's status.
    app.get("/upstream", async () => {
      throw Object.assign(new Error("bad gateway"), { statusCode: 502 });
    });

    expect((await app.inject({ method: "GET", url: "/bad" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/big" })).statusCode).toBe(413);
    expect((await app.inject({ method: "GET", url: "/upstream" })).statusCode).toBe(500);
    await app.close();
  });

  it("destroys the socket instead of sending once the response has started", () => {
    // `reply.send()` after headers raises FST_ERR_REP_ALREADY_SENT — one of the
    // exactly two Fastify messages that interpolate the RAW request url into a
    // log message, which the `req` serializer cannot reach. On
    // `/_auth/complete` that url carries the handoff token, so this guard is a
    // redaction control and not merely double-send hygiene.
    //
    // Driven directly rather than through `inject`: a hijacked reply never
    // settles, so the request would hang rather than assert.
    const sent: unknown[] = [];
    let destroyed = false;
    const reply = {
      sent: false,
      raw: { headersSent: true, destroy: () => (destroyed = true) },
      status: () => reply,
      header: () => reply,
      type: () => reply,
      send: (body: unknown) => sent.push(body),
    } as unknown as Parameters<typeof edgeErrorHandler>[2];
    const logged: unknown[] = [];
    const req = {
      url: "/_auth/complete?token=eyJhbGciOiJIUzI1NiJ9.handoff.signature&rd=/",
      log: { error: (o: unknown) => logged.push(o) },
    } as unknown as Parameters<typeof edgeErrorHandler>[1];

    edgeErrorHandler(new Error("late failure"), req, reply);

    expect(destroyed).toBe(true);
    expect(sent).toHaveLength(0);
    // And the log line it did write carries no hand-rolled url of its own — the
    // `req` serializer owns that field and redacts it.
    expect(JSON.stringify(logged)).not.toContain("handoff.signature");
  });
});
