import type { FastifyReply } from "fastify";

/**
 * An `AbortController` that fires when the **client** disconnects before the
 * response is complete — used to cut a long upstream call (the LLM stream, the
 * egress fetch-proxy round-trip) loose when the user navigates away or closes
 * the tab, so we don't hold the vendor/egress connection open for a caller who
 * is gone.
 *
 * Guarded on the **response** socket (`reply.raw`), deliberately NOT `req.raw`:
 * an `IncomingMessage` emits `close` as soon as its request body has been fully
 * read (and effectively immediately for a bodyless GET), which for a handler
 * still awaiting an upstream would abort a perfectly live request mid-flight —
 * a bug invisible to `light-my-request` inject tests (their mock socket doesn't
 * emit `close` like a real connection) but fatal against a real browser/curl.
 *
 * `reply.raw`'s `close` fires in exactly two situations, and `writableFinished`
 * tells them apart: after we finished writing the response (`true` → normal
 * completion, no abort) or on a premature client disconnect (`false` → abort).
 *
 * Regression coverage: `clientAbort.integration.test.ts` drives this over a
 * real socket (the only way to reproduce the original defect).
 */
export function abortOnClientDisconnect(reply: FastifyReply): AbortController {
  const controller = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) controller.abort();
  });
  return controller;
}
