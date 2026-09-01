/**
 * The `SecretStore` custody seam (design `docs/design/secrets-and-connections.md`
 * §3/§4, ADR-0006). It is intentionally **low-level**: the one thing that must
 * stay byte-for-byte identical between the portal (which writes a secret) and the
 * `helix-egress` service (which reads it back to inject) is how a plaintext value
 * becomes the stored `material` token and back. DB-row management (the
 * `app_secrets` / `app_secret_grants` rows, grants, metadata) stays in each
 * service — the portal via Prisma, egress via hand-written SQL under its own
 * least-privilege role.
 *
 * Two custody models behind one interface (architecture §8 portability):
 *  - **dev:** `DevEnvelopeSecretStore` — AES-256-GCM, value encrypted into the
 *    `material` column. Key from a locally-generated dev KEK (never an env var
 *    that tempts cross-environment reuse). **This is hygiene, not a security
 *    boundary:** the ciphertext and the key that opens it live on the same host,
 *    so a host compromise recovers every value. It exists so local development
 *    never normalizes plaintext-in-the-database, not to withstand an attacker.
 *  - **prod:** `KeyVaultSecretStore` — the value lives in Azure Key Vault,
 *    `material` is only a reference. Read via managed identity (no app-held key),
 *    so a stolen database backup is inert without the vault *and* an identity
 *    that RBAC admits to it.
 *
 * The edge implements neither: it has no grant on `app_secrets`, no decryption
 * seam, and no vault identity. Grant-absence is the boundary.
 */
export interface SecretStore {
  /** Turn a plaintext value into the stored `material` token. */
  seal(value: string): Promise<string>;
  /** Recover the plaintext from a stored `material` token. */
  open(material: string): Promise<string>;
  /**
   * Release any external storage backing a `material` token. Called on secret
   * delete/rotate so old vault versions don't leak.
   *
   * **Semantics differ by custody model, deliberately** (ADR-0006 amendment):
   *  - dev: a no-op — the ciphertext *is* the DB row and dies with it.
   *  - prod: deletes the vault entry. Note `kv-connections` runs with soft-delete
   *    (90 days) and purge protection, so this is a *soft* delete: the value stays
   *    recoverable for the retention window and cannot be purged early. `destroy()`
   *    is therefore "stop serving it and start the retention clock", not "erase".
   *
   * A failure here strands a live vault entry, so callers must surface it rather
   * than swallow it — see the `secret.destroy_failed` audit event in the portal.
   */
  destroy(material: string): Promise<void>;
}
