import type { Readable } from "node:stream";
import { capBody } from "@azx-pbc/shared/bodyCap";

/**
 * Read a request/response body stream to exact bytes under a hard cap. The
 * jobs forwarding plane needs the WHOLE body in memory — the signed
 * instruction binds its SHA-256 digest, so nothing can be streamed through —
 * and the bound is what keeps that buffering honest: a body the contract
 * refuses is never read past the trip, forwarded, or held.
 *
 * The counting rule itself is the shared `capBody`'s (framing-independent,
 * destroying the source at the trip — a lying content-length and a chunked
 * body are counted the same); this collector adds only the collection and the
 * verdict, so there is one implementation of "count and refuse" and one of
 * "collect".
 */
export interface BoundedBody {
  /** The bytes read. Empty when the body was empty or the cap tripped mid-read. */
  readonly bytes: Uint8Array;
  /** The running total passed `capBytes` — the body is refused, never trusted. */
  readonly over: boolean;
  /** The source errored before it ended (a destroyed connection, a reset). */
  readonly failed: boolean;
}

export function readBoundedBody(stream: Readable, capBytes: number): Promise<BoundedBody> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let over = false;
    let failed = false;
    let settled = false;

    const cap = capBody(stream, capBytes, "request", () => {
      // Fires synchronously at the trip, before the cap's own error reaches
      // the listener below — the refusal is decided here, and everything that
      // follows is teardown.
      over = true;
      chunks.length = 0;
    });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      cap.removeListener("data", onData);
      cap.removeListener("end", onEnd);
      cap.removeListener("error", onError);
      cap.removeListener("close", onEnd);
      resolve({ bytes: new Uint8Array(Buffer.concat(chunks)), over, failed });
    };

    const onData = (chunk: unknown): void => {
      if (over || failed) return;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
    };
    const onEnd = (): void => finish();
    const onError = (): void => {
      // The cap's trip error arrives here too — it is the refusal, not a
      // source fault; only an error that is not the trip's marks `failed`.
      if (!over) {
        failed = true;
        chunks.length = 0;
      }
      finish();
    };

    cap.on("data", onData);
    cap.once("end", onEnd);
    // The trip's teardown and a client hang-up both end in 'close' rather than
    // 'end'; without it the verdict never settles.
    cap.once("close", onEnd);
    cap.once("error", onError);
  });
}
