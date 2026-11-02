import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readBoundedBody } from "./boundedBody.js";

/**
 * The bounded body collector's contract: exact bytes under the cap, a refused
 * body never read past the trip, and a source error reported rather than
 * laundered into an empty body.
 */

function streamOf(chunks: Buffer[]): Readable {
  return Readable.from(chunks);
}

describe("readBoundedBody", () => {
  it("collects the exact bytes of a body inside the cap", async () => {
    const verdict = await readBoundedBody(
      streamOf([Buffer.from("hello "), Buffer.from("world")]),
      64,
    );
    expect(verdict.over).toBe(false);
    expect(verdict.failed).toBe(false);
    expect(Buffer.from(verdict.bytes).toString()).toBe("hello world");
  });

  it("collects an empty body", async () => {
    const verdict = await readBoundedBody(streamOf([]), 64);
    expect(verdict.bytes.byteLength).toBe(0);
    expect(verdict.over).toBe(false);
    expect(verdict.failed).toBe(false);
  });

  it("accepts a body exactly at the cap (inclusive)", async () => {
    const body = Buffer.alloc(10, 0x41);
    const verdict = await readBoundedBody(streamOf([body]), 10);
    expect(verdict.over).toBe(false);
    expect(verdict.bytes.byteLength).toBe(10);
  });

  it("refuses a body over the cap and never resolves the excess bytes", async () => {
    const verdict = await readBoundedBody(
      streamOf([Buffer.alloc(8, 0x41), Buffer.alloc(8, 0x42), Buffer.alloc(8, 0x43)]),
      10,
    );
    expect(verdict.over).toBe(true);
    expect(verdict.failed).toBe(false);
    expect(verdict.bytes.byteLength).toBe(0);
  });

  it("reports a source error instead of an empty success", async () => {
    const source = new Readable({
      read() {
        this.destroy(new Error("connection reset"));
      },
    });
    const verdict = await readBoundedBody(source, 64);
    expect(verdict.failed).toBe(true);
    expect(verdict.bytes.byteLength).toBe(0);
  });

  it("settles when the source is destroyed mid-read (no hang)", async () => {
    const source = streamOf([Buffer.alloc(32, 0x41)]);
    source.destroy();
    const verdict = await readBoundedBody(source, 64);
    // Either the 'close' or the 'error' path settles it; both are a verdict.
    expect(verdict.bytes.byteLength === 0 || verdict.failed).toBe(true);
  });

  it("reports a source destroyed mid-read as failed, with no partial bytes", async () => {
    // The strong form on the dangerous case: a client hang-up destroys the
    // request stream without an error of its own, after chunks exist. The
    // collector must report `failed` — the route's payload_invalid — and never
    // resolve the collected prefix as a success: a truncated body forwarded as
    // the submission would submit cut-off input under the app's identity. The
    // sibling above asserts only the disjunction, which a partial success
    // would satisfy.
    const source: Readable = new Readable({
      read() {
        const s = source as Readable & { pushed?: boolean };
        if (!s.pushed) {
          s.pushed = true;
          this.push(Buffer.alloc(16, 0x61));
        }
      },
    });
    const pending = readBoundedBody(source, 64);
    await new Promise((r) => setTimeout(r, 10)); // one chunk flows, the read stays parked
    source.destroy();
    const verdict = await pending;
    expect(verdict.failed).toBe(true);
    expect(verdict.over).toBe(false);
    expect(verdict.bytes.byteLength).toBe(0);
  });
});
