import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { BodyTooLargeError, byteCapStream, capBody } from "./bodyCap.js";

/** Drain a readable to a Buffer, or reject with the stream's destroy error. */
function drain(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

describe("byteCapStream", () => {
  it("passes a body exactly at the limit", async () => {
    const cap = byteCapStream(4, "response");
    Readable.from([Buffer.from("ab"), Buffer.from("cd")]).pipe(cap);
    expect((await drain(cap)).toString()).toBe("abcd");
  });

  it("trips at limit + 1, cutting the stream off with BodyTooLargeError", async () => {
    const cap = byteCapStream(4, "response");
    Readable.from([Buffer.from("abcd"), Buffer.from("e")]).pipe(cap);
    await expect(drain(cap)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("sums across many small chunks (framing-independent)", async () => {
    const cap = byteCapStream(3, "request");
    Readable.from([Buffer.from("a"), Buffer.from("b"), Buffer.from("c"), Buffer.from("d")]).pipe(
      cap,
    );
    await expect(drain(cap)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("counts UTF-8 bytes for string chunks, not characters", async () => {
    const cap = byteCapStream(3, "request");
    // "€" is 3 bytes in UTF-8 (1 char) — must not be undercounted as length 1.
    const src = new Readable({ read() {} });
    src.push("€");
    src.push("x");
    src.push(null);
    src.pipe(cap);
    await expect(drain(cap)).rejects.toBeInstanceOf(BodyTooLargeError);
  });
});

describe("capBody", () => {
  it("returns the body intact when under the cap", async () => {
    const src = Readable.from([Buffer.from("hello")]);
    const out = capBody(src, 1024, "response");
    expect((await drain(out)).toString()).toBe("hello");
  });

  it("fires onTrip exactly once and destroys the source on overflow", async () => {
    let trips = 0;
    const src = Readable.from([Buffer.from("way too many bytes")]);
    const out = capBody(src, 4, "request", () => {
      trips += 1;
    });
    await expect(drain(out)).rejects.toBeInstanceOf(BodyTooLargeError);
    // onTrip fires synchronously with the error emit, before drain's rejection.
    expect(trips).toBe(1);
    // pipeline destroys the source once the cap trips (may be a tick later).
    await new Promise((r) => setImmediate(r));
    expect(src.destroyed).toBe(true);
  });

  it("does not fire onTrip for an under-cap body", async () => {
    let trips = 0;
    const out = capBody(Readable.from([Buffer.from("ok")]), 1024, "response", () => {
      trips += 1;
    });
    await drain(out);
    expect(trips).toBe(0);
  });
});
