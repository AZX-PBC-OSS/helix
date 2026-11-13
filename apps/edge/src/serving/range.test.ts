import { describe, expect, it } from "vitest";
import { parseSingleByteRange } from "./range.js";

describe("parseSingleByteRange", () => {
  it.each([
    ["bytes=0-1", "bytes=0-1"],
    ["bytes=0-0", "bytes=0-0"],
    ["bytes=100-", "bytes=100-"],
    ["bytes=5-5000000", "bytes=5-5000000"],
  ])("accepts %s", (header, expected) => {
    expect(parseSingleByteRange(header)).toBe(expected);
  });

  it("normalizes leading zeros away, so only parsed numbers are forwarded", () => {
    expect(parseSingleByteRange("bytes=007-010")).toBe("bytes=7-10");
  });

  it.each([
    [undefined],
    [""],
    ["bytes=-500"], // suffix: Blob storage does not serve it
    ["bytes=0-1,5-6"], // multi-range
    ["items=0-1"],
    ["bytes=5-2"], // end before start
    ["bytes=a-b"],
    ["bytes= 0-1"],
    ["bytes=0 -1"],
    ["bytes=+1-2"],
    ["bytes=0-1\r\nx-ms-foo: bar"],
    ["BYTES=0-1"],
    ["bytes=1234567890123456-"], // past what a Number holds exactly
  ])("ignores %j", (header) => {
    expect(parseSingleByteRange(header)).toBeUndefined();
  });
});
