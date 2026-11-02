import { Readable } from "node:stream";

/**
 * Cap a response body by ending it cleanly at exactly `limit` bytes.
 *
 * The callback route uses this for the upstream bytes it streams back to jobs,
 * with `limit` set one byte past jobs' result allowance. A trip therefore
 * delivers a body that is over the allowance by construction and ends
 * normally, so jobs' own bounded read always classifies it as
 * `result_too_large`.
 *
 * The other ways to stop a stream classify worse. `capBody` errors at the
 * chunk that crosses the limit and drops that whole chunk, so with one large
 * upstream chunk jobs would see a short body and then a broken stream
 * (`upstream_error`). A plain truncation below the allowance could hand jobs
 * a prefix that parses as valid JSON.
 *
 * At the trip the source is destroyed so the edge stops pulling the upstream
 * body, and `onTrip` fires once. When the returned stream is destroyed early
 * (jobs hung up), the source is destroyed with it.
 */
export function capResultBody(source: Readable, limit: number, onTrip: () => void): Readable {
  let seen = 0;
  let tripped = false;

  const stopSource = (): void => {
    source.removeListener("data", onData);
    // The source may still emit an error for the abort; nobody reads it now.
    source.on("error", () => {});
    if (!source.destroyed) source.destroy();
  };

  const out = new Readable({
    read() {
      if (!tripped) source.resume();
    },
    destroy(err, callback) {
      if (!tripped) {
        tripped = true;
        stopSource();
      }
      callback(err);
    },
  });

  const onData = (chunk: unknown): void => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array | string);
    const room = limit - seen;
    if (bytes.length <= room) {
      seen += bytes.length;
      if (!out.push(bytes)) source.pause();
      return;
    }
    tripped = true;
    seen = limit;
    if (room > 0) out.push(bytes.subarray(0, room));
    out.push(null);
    stopSource();
    onTrip();
  };

  source.on("data", onData);
  source.once("end", () => {
    if (!tripped) out.push(null);
  });
  source.once("error", (err) => {
    if (!tripped) out.destroy(err);
  });
  source.once("close", () => {
    // A source that closed without ending was cut off — jobs must see a
    // broken stream, never a clean end of a short body.
    if (!tripped && !source.readableEnded) out.destroy(new Error("the result stream closed early"));
  });
  source.pause();
  return out;
}
