import { describe, expect, it } from "vitest";
import { type BinaryLike, scrypt as scryptCb, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";
import { SCRYPT_PARAMS } from "@azx-pbc/shared";
import {
  SCRYPT_KEYLEN,
  appPublicUrl,
  decryptPassword,
  encryptPassword,
  generatePassphrase,
  hashPassword,
} from "./password.js";
import { WORDLIST } from "./wordlist.js";

// Pin the options-bearing overload — see apps/portal/src/access/password.ts.
const scrypt = promisify(scryptCb) as (
  password: BinaryLike,
  salt: BinaryLike,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

// The crypto module reads PORTAL_SECRET lazily; the harness sets it, but these
// tests don't import the harness, so pin it here too.
process.env.PORTAL_SECRET ??= "test-portal-secret-test-portal-secret-32b";

describe("wordlist", () => {
  it("is a large pool of unique, lowercase, alphabetic words", () => {
    // Entropy of a 4-word passphrase is 4·log2(N); keep the pool honest.
    expect(WORDLIST.length).toBeGreaterThanOrEqual(256);
    expect(new Set(WORDLIST).size).toBe(WORDLIST.length);
    for (const w of WORDLIST) expect(w).toMatch(/^[a-z]+$/);
  });
});

describe("generatePassphrase", () => {
  it("joins N pool words with hyphens", () => {
    const pass = generatePassphrase();
    const parts = pass.split("-");
    expect(parts).toHaveLength(4);
    for (const p of parts) expect(WORDLIST).toContain(p);
  });

  it("varies between calls", () => {
    const seen = new Set(Array.from({ length: 20 }, () => generatePassphrase()));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe("hashPassword", () => {
  it("is verifiable by re-deriving scrypt with the stored salt at the shared cost (the edge's check)", async () => {
    const { hash, salt } = await hashPassword("correct-horse-battery-staple");
    const redo = (await scrypt(
      "correct-horse-battery-staple",
      Buffer.from(salt, "hex"),
      SCRYPT_KEYLEN,
      SCRYPT_PARAMS,
    )) as Buffer;
    expect(redo.toString("hex")).toBe(hash);
  });

  it("hashes at OWASP's N=2^17 (not Node's 2^14 default) — ADR-0004 ISSUE-08", async () => {
    // A hash derived at the old default cost must differ from the stored one for
    // the same salt: proof the bump is actually in effect, not the default.
    const { hash, salt } = await hashPassword("same");
    const oldCost = (await scrypt("same", Buffer.from(salt, "hex"), SCRYPT_KEYLEN, {
      N: 2 ** 14,
      r: 8,
      p: 1,
    })) as Buffer;
    expect(SCRYPT_PARAMS.N).toBe(2 ** 17);
    expect(oldCost.toString("hex")).not.toBe(hash);
  });

  it("uses a fresh salt each call", async () => {
    const a = await hashPassword("same");
    const b = await hashPassword("same");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("encryptPassword / decryptPassword", () => {
  it("round-trips", () => {
    const enc = encryptPassword("amber-otter-canyon-pixel");
    expect(enc).not.toContain("amber");
    expect(decryptPassword(enc)).toBe("amber-otter-canyon-pixel");
  });

  it("rejects a tampered ciphertext", () => {
    const enc = encryptPassword("amber-otter-canyon-pixel");
    const [iv, tag, ct] = enc.split(":");
    const flipped = ct!.slice(0, -1) + (ct!.endsWith("0") ? "1" : "0");
    expect(() => decryptPassword([iv, tag, flipped].join(":"))).toThrow();
  });
});

describe("appPublicUrl", () => {
  it("prefixes the slug onto APP_PUBLIC_BASE", () => {
    const prev = process.env.APP_PUBLIC_BASE;
    process.env.APP_PUBLIC_BASE = "https://azx-labs.com";
    try {
      expect(appPublicUrl("demo")).toBe("https://demo.azx-labs.com");
    } finally {
      if (prev === undefined) delete process.env.APP_PUBLIC_BASE;
      else process.env.APP_PUBLIC_BASE = prev;
    }
  });
});
