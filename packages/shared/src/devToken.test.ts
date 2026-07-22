import { describe, expect, it } from "vitest";
import { DEV_TOKEN_PREFIX, hashDevToken, newDevToken } from "./devToken.js";

describe("dev token primitive", () => {
  it("mints a prefixed, high-entropy opaque token", () => {
    const token = newDevToken();
    expect(token.startsWith(DEV_TOKEN_PREFIX)).toBe(true);
    // 32 random bytes → 43 base64url chars (no padding), after the prefix.
    const body = token.slice(DEV_TOKEN_PREFIX.length);
    expect(Buffer.from(body, "base64url")).toHaveLength(32);
    expect(newDevToken()).not.toBe(token); // fresh each call
  });

  it("hashes deterministically over the full token (the value the dev-gateway recomputes)", () => {
    const token = newDevToken();
    const h = hashDevToken(token);
    expect(h).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
    expect(hashDevToken(token)).toBe(h); // stable
    expect(hashDevToken(newDevToken())).not.toBe(h); // distinct tokens → distinct hashes
    // The stored hash never contains the plaintext.
    expect(h).not.toContain(token);
  });
});
