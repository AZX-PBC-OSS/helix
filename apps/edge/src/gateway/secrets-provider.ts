/**
 * Pluggable vendor-secret source for the gateway (architecture §6.1, §8).
 *
 * The platform holds vendor keys; apps never see them. M4 backs this with the
 * process environment (a gitignored `apps/edge/.env.local` in dev, real env in
 * prod). The interface is the seam: a `KeyVaultSecretProvider` drops in for M5
 * with no change at the call site. Keys are read once at boot and never enter
 * the request path, the registry, or any log line.
 */

export type Vendor = "anthropic";

export interface SecretProvider {
  /** True when a key for this vendor is configured (gates the capability). */
  has(vendor: Vendor): boolean;
  /** The vendor key; throws if absent — callers gate on {@link has} first. */
  vendorKey(vendor: Vendor): string;
}

/** Reads vendor keys from the environment. */
export class EnvSecretProvider implements SecretProvider {
  readonly #keys: Partial<Record<Vendor, string>>;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const anthropic = env.EDGE_LLM_ANTHROPIC_KEY;
    this.#keys = anthropic ? { anthropic } : {};
  }

  has(vendor: Vendor): boolean {
    return Boolean(this.#keys[vendor]);
  }

  vendorKey(vendor: Vendor): string {
    const key = this.#keys[vendor];
    if (!key) throw new Error(`no secret configured for vendor "${vendor}"`);
    return key;
  }
}
