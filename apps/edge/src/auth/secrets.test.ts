import { describe, expect, it } from "vitest";
import { deriveAuthKeys } from "./secrets.js";

describe("deriveAuthKeys", () => {
  const secret = Buffer.from("0123456789abcdef0123456789abcdef");

  it("derives deterministic 32-byte keys", () => {
    const a = deriveAuthKeys(secret);
    const b = deriveAuthKeys(secret);
    expect(a.handoffKey).toEqual(b.handoffKey);
    expect(a.flowKey).toEqual(b.flowKey);
    expect(a.handoffKey.length).toBe(32);
    expect(a.flowKey.length).toBe(32);
  });

  it("domain-separates the two keys", () => {
    const keys = deriveAuthKeys(secret);
    expect(keys.handoffKey.equals(keys.flowKey)).toBe(false);
  });

  it("different secrets give different keys", () => {
    const other = deriveAuthKeys(Buffer.from("ffffffffffffffffffffffffffffffff"));
    expect(other.handoffKey.equals(deriveAuthKeys(secret).handoffKey)).toBe(false);
  });

  it("rejects short secrets", () => {
    expect(() => deriveAuthKeys(Buffer.alloc(31))).toThrow(/32 bytes/);
  });
});
