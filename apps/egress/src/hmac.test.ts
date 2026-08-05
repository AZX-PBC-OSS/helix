import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacTimestampNow, renderHmacAuth, signTimestamp } from "./hmac.js";

describe("signTimestamp", () => {
  /**
   * A hardcoded vector, which is the point of this file. It breaks if anyone
   * changes *what* gets signed, swaps the key and the message, switches the digest
   * encoding, or starts decoding the key before use — none of which a
   * recompute-it-the-same-way assertion would catch.
   */
  it("matches a pinned vector", () => {
    expect(signTimestamp("test-private-key", "2026-08-04T12:34:56.789Z")).toBe(
      "f896fef99ef5b75b57b8161c878ec83cb545a1874bcbe934a823159af6d0d830",
    );
  });

  /**
   * A second vector taken from a published worked example of this scheme in the
   * wild (its documented sample key pair, not a live credential). It is here as an
   * *independent* oracle: it confirms the key is used as its UTF-8 bytes rather
   * than hex-decoded first, which is the one construction detail this family of
   * schemes varies on and the one a self-consistent test cannot detect. Decoding
   * the key first yields `549ac1a5…` and would authenticate against nothing.
   */
  it("uses the key's UTF-8 bytes, not its decoded bytes", () => {
    const key = "63170612a05596173c61115373b195ab10dae3121d56391c6524f0c29427e2ed";
    expect(signTimestamp(key, "2017-06-19T13:22:19.701Z")).toBe(
      "7d1752a91fd9e507c11a4111fa096059edf11bf6401581642d48f96955466f0d",
    );
    expect(signTimestamp(Buffer.from(key, "hex").toString("binary"), "x")).not.toBe(
      signTimestamp(key, "x"),
    );
  });

  it("emits 64 lowercase hex characters", () => {
    expect(signTimestamp("k", "2026-08-04T00:00:00.000Z")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic per (key, timestamp) and varies with each", () => {
    const a = signTimestamp("k1", "2026-08-04T00:00:00.000Z");
    expect(signTimestamp("k1", "2026-08-04T00:00:00.000Z")).toBe(a);
    expect(signTimestamp("k1", "2026-08-04T00:00:00.001Z")).not.toBe(a);
    expect(signTimestamp("k2", "2026-08-04T00:00:00.000Z")).not.toBe(a);
  });

  it("signs the timestamp alone — the signature is independent of any request", () => {
    // Structural, not behavioural: the function takes no method, path, or body, so
    // there is nothing else it could mix in. Pinned against a hand-rolled HMAC.
    const ts = "2026-08-04T12:34:56.789Z";
    expect(signTimestamp("k", ts)).toBe(createHmac("sha256", "k").update(ts).digest("hex"));
  });
});

describe("hmacTimestampNow", () => {
  it("renders ISO-8601 with milliseconds from the injected clock", () => {
    expect(hmacTimestampNow(new Date(Date.UTC(2017, 5, 19, 13, 22, 19, 701)))).toBe(
      "2017-06-19T13:22:19.701Z",
    );
  });

  it("defaults to the wall clock", () => {
    expect(hmacTimestampNow()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("renderHmacAuth", () => {
  it("substitutes both placeholders", () => {
    expect(renderHmacAuth("Credential={credential},Signature={signature}", "pub", "sig")).toBe(
      "Credential=pub,Signature=sig",
    );
  });

  it("handles a template that omits {credential}", () => {
    expect(renderHmacAuth("Signature={signature}", "pub", "sig")).toBe("Signature=sig");
  });

  it("substitutes every occurrence, not just the first", () => {
    expect(renderHmacAuth("{signature} {signature}", "pub", "sig")).toBe("sig sig");
  });

  it("leaves an unknown placeholder verbatim rather than blanking it", () => {
    expect(renderHmacAuth("{nonce}/{signature}", "pub", "sig")).toBe("{nonce}/sig");
  });

  /**
   * `String.replace` would read `$&` in the *replacement* as a substitution
   * pattern and silently mangle the credential into an authentication failure with
   * no diagnosable cause. `split`/`join` treats it as data.
   */
  it("treats $-sequences in the credential as literal data", () => {
    expect(renderHmacAuth("c={credential},s={signature}", "a$&b", "x$'y")).toBe("c=a$&b,s=x$'y");
  });
});
