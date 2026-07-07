import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { FastifyReply } from "fastify";
import { abortOnClientDisconnect } from "./clientAbort.js";

/**
 * Unit coverage for the disconnect guard shared by the LLM, builder, and fetch
 * handlers. The whole point is that it keys off the RESPONSE socket, not the
 * request: a `req.raw` guard aborts a live request the instant its body is read.
 * Here we fake `reply.raw` as an emitter and drive both `close` situations.
 */
function fakeReply(writableFinished: boolean): { reply: FastifyReply; raw: EventEmitter } {
  const raw = new EventEmitter() as EventEmitter & { writableFinished: boolean };
  raw.writableFinished = writableFinished;
  return { reply: { raw } as unknown as FastifyReply, raw };
}

describe("abortOnClientDisconnect", () => {
  it("aborts when the response socket closes before the response finished", () => {
    const { reply, raw } = fakeReply(false); // premature disconnect
    const controller = abortOnClientDisconnect(reply);
    expect(controller.signal.aborted).toBe(false);
    raw.emit("close");
    expect(controller.signal.aborted).toBe(true);
  });

  it("does NOT abort when the response completed normally", () => {
    const { reply, raw } = fakeReply(true); // finished, then socket closes
    const controller = abortOnClientDisconnect(reply);
    raw.emit("close");
    expect(controller.signal.aborted).toBe(false);
  });
});
