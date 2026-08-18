import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";

/**
 * Bind a built app on an ephemeral loopback port and hand the callback its base
 * URL, closing the server afterwards.
 *
 * Most edge suites drive Fastify through `app.inject()`, which is faster and
 * needs no port — but `inject` is a *simulated* request/response pair, and some
 * behaviour only exists on a real socket:
 *
 * - `req.raw` emits `'close'` when the request body finishes arriving (the ended
 *   stream auto-destroys). `inject` never emits it, which is why a handler that
 *   mistook that signal for a client disconnect could break every body-bearing
 *   method in production while the whole suite stayed green.
 * - A mid-stream destroy is a *truncation* (status already flushed, body cut
 *   short), not a clean error.
 * - A client hanging up early is observable at all.
 *
 * Reach for this when the assertion is about transport behaviour; keep using
 * `inject` for everything else.
 */
export async function withServer(
  app: FastifyInstance,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    // Drop keep-alive sockets first: `close()` waits for idle connections to
    // drain, and a pooled undici socket would hold teardown past the test
    // timeout.
    app.server.closeAllConnections();
    await app.close();
  }
}

/**
 * Poll until `pred` holds, for state no response body reports — whether an
 * upstream call was cancelled, say. Sequence on an observable like this rather
 * than a fixed sleep; the suite has no configured timeout, so it inherits
 * Vitest's 5s default and a slept-through race fails as an opaque timeout.
 */
export async function until(pred: () => boolean, label: string, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
