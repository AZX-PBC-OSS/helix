import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * The `SecretStore` custody seam (design `docs/design/secrets-and-connections.md`
 * §3/§4). It is intentionally **low-level**: the one thing that must stay
 * byte-for-byte identical between the portal (which writes a secret) and the
 * `azx-egress` service (which reads it back to inject) is how a plaintext value
 * becomes the stored `material` token and back. DB-row management (the
 * `app_secrets` / `app_secret_grants` rows, grants, metadata) stays in each
 * service — the portal via Prisma, egress via hand-written SQL under its own
 * least-privilege role.
 *
 * Two custody models behind one interface (architecture §8 portability):
 *  - **dev:** `DevEnvelopeSecretStore` — AES-256-GCM, value encrypted into the
 *    `material` column. Key from a locally-generated dev KEK (never an env var
 *    that tempts cross-environment reuse).
 *  - **prod:** `KeyVaultSecretStore` — the value lives in Key Vault; `material`
 *    is only a reference. Read via managed identity (no app-held key). Wired in
 *    M5; the seam exists now so callers never change.
 */
export interface SecretStore {
  /** Turn a plaintext value into the stored `material` token. */
  seal(value: string): Promise<string>;
  /** Recover the plaintext from a stored `material` token. */
  open(material: string): Promise<string>;
  /**
   * Release any external storage backing a `material` token (dev: no-op — the
   * ciphertext is the DB row and dies with it; prod: delete the vault entry).
   * Called on secret delete/rotate so old vault versions don't leak.
   */
  destroy(material: string): Promise<void>;
}

// ── dev: envelope encryption into the `material` column ───────────────────────

/** Scheme tag on dev `material`, so a future store can dispatch on format. */
const DEV_SCHEME = "aesgcm";
/** HKDF info — domain-separates connection-secret keys from password keys. */
const KEY_INFO = "helix-connection-secret-v1";
const MIN_KEY_BYTES = 32;

/**
 * AES-256-GCM envelope store for dev/local (and CI). The AES key is HKDF-derived
 * from a master KEK (the dev KEK file — see {@link readDevKey}) so the same file
 * can key multiple purposes without reuse. `material` is `aesgcm:iv:tag:ct`, all
 * hex — the same shape the password credential uses (`access/password.ts`).
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

  async destroy(): Promise<void> {
    // The ciphertext lives in the DB row; deleting the row is the deletion.
  }
}

// ── prod: Key Vault as the store (seam present; wired in M5) ──────────────────

/**
 * Vault-as-store for prod (secrets design §3): the value lives in Azure Key
 * Vault, `material` is a reference, access is via managed identity (no app-held
 * key). Implemented in M5 (`@azure/keyvault-secrets`); kept as an explicit seam
 * so the portal/egress call sites are already correct.
 *
 *   seal:    setSecret(randomName, value) → return `kv:<name>/<version>`
 *   open:    getSecret(name, version)     → value
 *   destroy: beginDeleteSecret(name)
 */
export class KeyVaultSecretStore implements SecretStore {
  constructor(private readonly vaultUrl: string) {}
  private nope(): never {
    throw new Error(`KeyVaultSecretStore (${this.vaultUrl}) is not wired yet — see M5`);
  }
  async seal(): Promise<string> {
    return this.nope();
  }
  async open(): Promise<string> {
    return this.nope();
  }
  async destroy(): Promise<void> {
    return this.nope();
  }
}

// ── factory + dev key loading ─────────────────────────────────────────────────

export interface SecretStoreConfig {
  /** When set, use Key Vault (prod). Otherwise the dev envelope store. */
  keyVaultUrl?: string;
  /** Dev master KEK (>= 32 bytes); required when `keyVaultUrl` is unset. */
  devMasterKey?: Buffer;
}

/** Pick the custody model from config: Key Vault when a URL is given, else dev. */
export function createSecretStore(config: SecretStoreConfig): SecretStore {
  if (config.keyVaultUrl) return new KeyVaultSecretStore(config.keyVaultUrl);
  if (!config.devMasterKey) {
    throw new Error("secret-store: devMasterKey is required when keyVaultUrl is unset");
  }
  return new DevEnvelopeSecretStore({ masterKey: config.devMasterKey });
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

/** Constant-time compare, re-exported for callers checking opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
