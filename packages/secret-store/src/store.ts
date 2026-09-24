/**
 * Shared plaintext-to-material format for portal writes and egress reads
 * (ADR-0006; secrets design §3/§4). Each service manages its own database rows,
 * grants, and metadata.
 *
 * DevEnvelopeSecretStore encrypts material with AES-256-GCM and a local KEK.
 * It avoids plaintext database storage but does not protect against host
 * compromise: the key and ciphertext are on the same host.
 *
 * KeyVaultSecretStore stores the value in Key Vault and a reference in material.
 * Reading a stolen database backup alone does not reveal the values; vault
 * access requires an authorized identity.
 *
 * The edge has no app_secrets grant, decryption interface, or vault identity.
 */
export interface SecretStore {
  /** Turn a plaintext value into the stored `material` token. */
  seal(value: string): Promise<string>;
  /** Recover the plaintext from a stored `material` token. */
  open(material: string): Promise<string>;
  /**
   * Release external storage on deletion or rotation (ADR-0006 amendment).
   * Dev: no-op; deleting the row removes the ciphertext.
   * Key Vault: soft-delete the entry. The 90-day retention and purge protection
   * keep it recoverable until retention expires; this is not immediate erasure.
   * Callers must report failures because they leave a live vault entry. The
   * portal records secret.destroy_failed.
   */
  destroy(material: string): Promise<void>;
}
