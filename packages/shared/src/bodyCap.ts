import { Transform, type Readable, pipeline } from "node:stream";

/**
 * Framing-independent body-size enforcement for the streaming proxy (issue #8).
 *
 * The fetch-proxy streams bodies through untouched (a passthrough content-type
 * parser hands back `req.raw`, piped straight to undici; `upstream.body` piped
 * straight to `reply.send`), so a `content-length` fast-path is the *only* thing
 * the old cap enforced — and it is trivially bypassed by a chunked/CL-absent
 * body or a lying (small header, large body) `content-length`. The counter here
 * runs over the actual bytes, so it holds regardless of framing and is the real
 * enforcement. Wrap it on both hops (edge and egress) and in both directions
 * (request re-stream and response re-stream); keep the `content-length` check
 * only as a cheap fast-path that rejects a known-oversized body without draining
 * the connection.
 */

export type BodyDirection = "request" | "response";

/** Raised by the byte-cap transform the instant a body exceeds its limit. */
export class BodyTooLargeError extends Error {
  readonly limit: number;
  readonly direction: BodyDirection;
  constructor(limit: number, direction: BodyDirection) {
    super(`${direction} body exceeded the ${limit}-byte cap`);
    this.name = "BodyTooLargeError";
    this.limit = limit;
    this.direction = direction;
  }
}

/**
 * A pass-through `Transform` that counts bytes and destroys the stream with a
 * `BodyTooLargeError` the instant the running total exceeds `limit`.
 */
export function byteCapStream(limit: number, direction: BodyDirection): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: unknown, _enc, cb) {
      const n = Buffer.isBuffer(chunk)
        ? chunk.length
        : typeof chunk === "string"
          ? Buffer.byteLength(chunk)
          : 0;
      seen += n;
      if (seen > limit) {
        cb(new BodyTooLargeError(limit, direction));
        return;
      }
      cb(null, chunk);
    },
  });
}

/**
 * Pipe `source` through a byte cap and return the capped `Readable` to hand to a
 * consumer (an undici request body, a Fastify `reply.send`). Teardown is wired
 * with `stream.pipeline`, so a cap trip destroys `source` (stopping the upstream
 * read — the point is to *not* pay for the excess bytes) and a `source` error
 * tears down the cap. `onTrip` fires once if the cap is exceeded; a request-side
 * caller uses it to turn the overflow into a 413. A response-side caller has
 * already flushed status + headers by the time the cap trips, so it can only
 * truncate the body — an accepted transparent-proxy residual (issue #8).
 */
export function capBody(
  source: Readable,
  limit: number,
  direction: BodyDirection,
  onTrip?: () => void,
): Readable {
  const cap = byteCapStream(limit, direction);
  // Fire onTrip on the cap's `error` emit — synchronous with the moment the
  // transform decides to overflow, and thus set *before* a downstream consumer
  // (undici) surfaces its own error. A request-side caller reads this flag in
  // its `catch` to answer 413 rather than a generic upstream error; relying on
  // pipeline's completion callback instead would race that catch.
  if (onTrip) {
    cap.once("error", (err) => {
      if (err instanceof BodyTooLargeError) onTrip();
    });
  }
  // pipeline wires teardown both ways: a trip destroys `source` (stop reading),
  // a `source` error destroys the cap. The error is already surfaced to the
  // consumer, so the callback only needs to exist to satisfy the signature.
  pipeline(source, cap, () => {});
  return cap;
}
