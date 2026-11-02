import type { FastifyReply } from "fastify";

/**
 * Abort an in-flight forward if the caller goes away — the RESPONSE's close,
 * not the request stream's. `req.raw` emits 'close' when the request body
 * finishes arriving (the ended stream auto-destroys), which for a proxy that
 * drains `req.raw` itself is normal completion, not a disconnect: watching it
 * aborted every POST/PUT/PATCH/DELETE the moment its body landed, long before
 * the forward answered. The ServerResponse's 'close' fires when the
 * connection actually goes away, and `writableEnded` separates "we
 * finished answering" from "they hung up". Fastify's own `request.signal` is
 * wired to the same unguarded `req.on('close')` — do not substitute it.
 *
 * `writableEnded`, not `writableFinished`: the two agree on a real socket,
 * but light-my-request's null socket never settles `writableFinished`, so
 * under `app.inject()` every ordinary response would look like a hang-up.
 */
export function abortOnClientGone(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableEnded) abort.abort();
  });
  return abort.signal;
}
