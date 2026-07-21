import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
} from "node:crypto";
import { promisify } from "node:util";
import { SCRYPT_KEYLEN, SCRYPT_PARAMS } from "@azx-pbc/shared";
import { WORDLIST } from "./wordlist.js";

/**
 * Shared-password (`password` visibility) credential handling — control-plane
 * side. The portal generates and stores the credential; the edge only ever
 * sees the one-way hash (apps/edge/src/auth/password.ts) and verifies against
 * it. Plaintext lives here, encrypted at rest, so the owner can re-display and
 * copy it (e.g. before a conference). See docs/features/authentication.md.
 *
 * Two stored representations, written together whenever the password is set:
 *  - `passwordHash` + `passwordSalt`: scrypt, **projected to the edge** to verify.
 *  - `passwordEnc`: AES-256-GCM ciphertext, **portal-only**, decryptable here for
 *    re-display. Never projected, never read by the edge.
 */

const scrypt = promisify(scryptCb);

/**
 * scrypt keylen + cost live in `@azx-pbc/shared` (the one source both planes
 * derive from — the edge verifier is apps/edge/src/auth/password.ts). Re-exported
 * so existing importers here are unaffected. The cost is OWASP's `N=2^17`
 * (ADR-0004 ISSUE-08); `maxmem` MUST be passed or scrypt throws.
 */
export { SCRYPT_KEYLEN };
const SALT_BYTES = 16;

/** Default passphrase length; 4 × log2(~410) ≈ 35 bits, fine for a throttled gate. */
const PASSPHRASE_WORDS = 4;

const ENC_INFO = "helix-app-password-v1";

/** A fresh xkcd-style passphrase, e.g. `correct-horse-battery-staple`. */
export function generatePassphrase(words = PASSPHRASE_WORDS): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) {
    out.push(WORDLIST[randomInt(WORDLIST.length)]!);
  }
  return out.join("-");
}

export interface PasswordHash {
  /** scrypt-derived key, hex. */
  hash: string;
  /** Per-password random salt, hex. */
  salt: string;
}

/** Derive `{ hash, salt }` for storage; a fresh salt is minted per call. */
export async function hashPassword(plain: string): Promise<PasswordHash> {
  const salt = randomBytes(SALT_BYTES);
  const derived = (await scrypt(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)) as Buffer;
  return { hash: derived.toString("hex"), salt: salt.toString("hex") };
}

/**
 * The AES key, HKDF-derived from `PORTAL_SECRET` (mirrors the edge's
 * secrets.ts). Resolved per call so tests/processes that set the env late still
 * work; throws if the secret is missing or too short rather than encrypting
 * under a weak key.
 */
function encryptionKey(): Buffer {
  const secret = process.env.PORTAL_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    throw new Error("PORTAL_SECRET must be set and at least 32 bytes");
  }
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret), Buffer.alloc(0), ENC_INFO, 32));
}

/** Encrypt for at-rest storage in `passwordEnc`: `iv:tag:ciphertext`, all hex. */
export function encryptPassword(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("hex"), tag.toString("hex"), ct.toString("hex")].join(":");
}

/** Inverse of {@link encryptPassword}; throws on a malformed or tampered blob. */
export function decryptPassword(enc: string): string {
  const [ivHex, tagHex, ctHex] = enc.split(":");
  if (!ivHex || !tagHex || !ctHex) {
    throw new Error("malformed password ciphertext");
  }
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]).toString(
    "utf8",
  );
}

/**
 * The app's public URL (`https://<slug>.<base>`), built from `APP_PUBLIC_BASE`
 * exactly like the stopgap dashboard (routes/dashboard.ts). Handed back with
 * the credential so the UI can offer a one-click "copy URL + password".
 */
export function appPublicUrl(slug: string): string {
  const base = new URL(process.env.APP_PUBLIC_BASE ?? "http://localtest.me:8080");
  return `${base.protocol}//${slug}.${base.host}`;
}
