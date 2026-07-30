import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { SecretStore } from "./store.js";

/** Scheme tag on dev `material`, so a store can dispatch on format. */
export const DEV_SCHEME = "aesgcm";
/** HKDF info — domain-separates connection-secret keys from password keys. */
const KEY_INFO = "helix-connection-secret-v1";
const MIN_KEY_BYTES = 32;

/**
 * AES-256-GCM envelope store for dev/local (and CI). The AES key is HKDF-derived
 * from a master KEK (the dev KEK file — see {@link readDevKey}) so the same file
 * can key multiple purposes without reuse. `material` is `aesgcm:iv:tag:ct`, all
 * hex — the same shape the password credential uses (`access/password.ts`).
 *
 * **Not a security boundary** (ADR-0006). The KEK sits on the same host as the
 * database it protects; anyone who can read the row can read the key. Its job is
 * to keep plaintext credentials out of local dumps and `pg_dump` output, and to
 * make the dev and prod call sites identical.
 *
 * There is **no KEK rotation or rekey path** — explicitly deferred (ADR-0006).
 * Rotating the dev KEK invalidates every existing `material`; the recovery is to
 * re-enter the dev secrets, which is acceptable precisely because it is dev.
 */
export class DevEnvelopeSecretStore implements SecretStore {
  readonly #key: Buffer;

  constructor(opts: { masterKey: Buffer }) {
    if (opts.masterKey.byteLength < MIN_KEY_BYTES) {
      throw new Error(`secret-store dev master key must be >= ${MIN_KEY_BYTES} bytes`);
    }
    this.#key = Buffer.from(hkdfSync("sha256", opts.masterKey, Buffer.alloc(0), KEY_INFO, 32));
  }

  // `async` (not a sync function returning a Promise) so that a malformed/tamper
  // failure surfaces as a rejection callers can `.catch`, not a synchronous throw.
  async seal(value: string): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [DEV_SCHEME, iv.toString("hex"), tag.toString("hex"), ct.toString("hex")].join(":");
  }

  async open(material: string): Promise<string> {
    const [scheme, ivHex, tagHex, ctHex] = material.split(":");
    if (scheme !== DEV_SCHEME || !ivHex || !tagHex || !ctHex) {
      throw new Error("malformed secret material");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    const out = Buffer.concat([decipher.update(Buffer.from(ctHex, "hex")), decipher.final()]);
    return out.toString("utf8");
  }

  // Takes `material` it does not use, matching {@link SecretStore} rather than eliding
  // the parameter — a zero-arg `destroy()` still satisfies the interface structurally but
  // cannot be overridden with the real signature (which test doubles need to do).
  async destroy(material: string): Promise<void> {
    void material;
    // The ciphertext lives in the DB row; deleting the row is the deletion.
  }
}

/**
 * Read the dev KEK file (generated once by `.devcontainer/post-create.sh`, like
 * the mkcert certs). Read-only on purpose — generation is a bootstrap step, not
 * a runtime one, so the portal and egress processes can never race to create it.
 * Throws if missing or too short rather than running under a weak/absent key.
 */
export function readDevKey(path: string): Buffer {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    throw new Error(
      `dev secret KEK not found at ${path} — run .devcontainer/post-create.sh to generate it`,
    );
  }
  // Accept either raw bytes or a hex/base64 text file; normalize to bytes.
  const text = raw.toString("utf8").trim();
  const key = /^[0-9a-fA-F]{64,}$/.test(text)
    ? Buffer.from(text, "hex")
    : /^[A-Za-z0-9+/=]{44,}$/.test(text)
      ? Buffer.from(text, "base64")
      : raw;
  if (key.byteLength < MIN_KEY_BYTES) {
    throw new Error(`dev secret KEK at ${path} must decode to >= ${MIN_KEY_BYTES} bytes`);
  }
  return key;
}
