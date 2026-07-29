import { timingSafeEqual } from "node:crypto";
import { DevEnvelopeSecretStore } from "./dev.js";
import { KeyVaultSecretStore } from "./keyvault.js";
import type { SecretStore } from "./store.js";
import type { GetVaultToken } from "./token.js";

export type { SecretStore } from "./store.js";
export { DEV_SCHEME, DevEnvelopeSecretStore, readDevKey } from "./dev.js";
export { KeyVaultError, KeyVaultSecretStore } from "./keyvault.js";
export type { KeyVaultSecretStoreOptions } from "./keyvault.js";
export {
  ManagedIdentityTokenProvider,
  TokenError,
  managedIdentityTokenProviderFromEnv,
} from "./token.js";
export type {
  FetchToken,
  GetVaultToken,
  ManagedIdentityTokenProviderOptions,
  TokenFetchResult,
  TokenProvider,
} from "./token.js";

export interface SecretStoreConfig {
  /** When set, use Key Vault (prod). Otherwise the dev envelope store. */
  keyVaultUrl?: string;
  /** Bearer-token source for the vault; required when `keyVaultUrl` is set. */
  getToken?: GetVaultToken;
  /** Dev master KEK (>= 32 bytes); required when `keyVaultUrl` is unset. */
  devMasterKey?: Buffer;
}

/** Pick the custody model from config: Key Vault when a URL is given, else dev. */
export function createSecretStore(config: SecretStoreConfig): SecretStore {
  if (config.keyVaultUrl) {
    if (!config.getToken) {
      // Fail at construction, not at first use. A store that boots fine and then
      // 500s on every secret read is the failure mode the M5 stub had.
      throw new Error("secret-store: getToken is required when keyVaultUrl is set");
    }
    return new KeyVaultSecretStore({ vaultUrl: config.keyVaultUrl, getToken: config.getToken });
  }
  if (!config.devMasterKey) {
    throw new Error("secret-store: devMasterKey is required when keyVaultUrl is unset");
  }
  return new DevEnvelopeSecretStore({ masterKey: config.devMasterKey });
}

/** Constant-time compare, re-exported for callers checking opaque tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
