import { describe, expect, it } from "vitest";
import { randomBytes, scryptSync } from "node:crypto";
import { SCRYPT_KEYLEN, SCRYPT_PARAMS } from "@azx-pbc/shared";
import { newPasswordPrincipal, verifyPassword } from "./password.js";

/**
 * Unit twin for the shared-password verifier. The scrypt cost is OWASP's
 * `N=2^17` (ADR-0004 ISSUE-08); these pin the properties the cost bump depends
 * on — the params round-trip without tripping Node's `maxmem`, an old-cost hash
 * no longer verifies (the flag-day reset), and the concurrency cap doesn't
 * corrupt results under parallel load.
 */

const PASSWORD = "correct-horse-battery-staple";

function hashAt(
  password: string,
  opts: { N: number; r: number; p: number; maxmem: number },
): { hash: string; salt: string } {
  const salt = randomBytes(16);
  return {
    hash: scryptSync(password, salt, SCRYPT_KEYLEN, opts).toString("hex"),
    salt: salt.toString("hex"),
  };
}

describe("verifyPassword", () => {
  it("verifies a hash derived at the shared cost (no maxmem throw)", async () => {
    const { hash, salt } = hashAt(PASSWORD, SCRYPT_PARAMS);
    expect(await verifyPassword(PASSWORD, hash, salt)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const { hash, salt } = hashAt(PASSWORD, SCRYPT_PARAMS);
    expect(await verifyPassword("wrong-guess", hash, salt)).toBe(false);
  });

  it("does NOT verify a hash derived at the old default cost (flag-day reset)", async () => {
    // Pre-bump hashes were N=2^14. They must fail closed rather than verify, so
    // stale rows can't silently accept — the migration nulls them for re-mint.
    const { hash, salt } = hashAt(PASSWORD, { N: 2 ** 14, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
    expect(await verifyPassword(PASSWORD, hash, salt)).toBe(false);
  });

  it("fails closed on missing or malformed hash/salt", async () => {
    const { hash, salt } = hashAt(PASSWORD, SCRYPT_PARAMS);
    expect(await verifyPassword(PASSWORD, null, salt)).toBe(false);
    expect(await verifyPassword(PASSWORD, hash, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, "zz", salt)).toBe(false); // non-hex
    expect(await verifyPassword(PASSWORD, "", "")).toBe(false);
  });

  it("stays correct under concurrency beyond the cap", async () => {
    // More in-flight derivations than MAX_CONCURRENT_SCRYPT (4): every one must
    // resolve to the right answer even though most are queued behind the cap.
    const { hash, salt } = hashAt(PASSWORD, SCRYPT_PARAMS);
    const results = await Promise.all([
      ...Array.from({ length: 6 }, () => verifyPassword(PASSWORD, hash, salt)),
      ...Array.from({ length: 6 }, () => verifyPassword("nope", hash, salt)),
    ]);
    expect(results.slice(0, 6)).toEqual(Array(6).fill(true));
    expect(results.slice(6)).toEqual(Array(6).fill(false));
  });
});

describe("newPasswordPrincipal", () => {
  it("mints a fresh pw_-prefixed pseudonym each call", () => {
    const a = newPasswordPrincipal();
    const b = newPasswordPrincipal();
    expect(a).toMatch(/^pw_/);
    expect(a).not.toBe(b);
  });
});
