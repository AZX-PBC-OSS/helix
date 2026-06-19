import fp from "fastify-plugin";
import { createSecretStore, readDevKey, type SecretStore } from "@helix/secret-store";

export interface SecretStorePluginOptions {
  /** Inject a store (tests). When omitted, one is built from the environment. */
  store?: SecretStore | null;
}

/**
 * Decorates the portal with the connection-secret custody store (secrets design
 * §3). The portal only ever **seals** (writes) and **destroys** secrets — never
 * opens them (write-only / rotate-only; the egress service is the only reader).
 * Custody is chosen by environment: Key Vault in prod (`AZURE_KEY_VAULT_URL`),
 * the dev envelope under the local KEK otherwise (`DEV_SECRETS_KEK_FILE`). When
 * neither is configured the store is null and the secret routes 503.
 */
export const secretStorePlugin = fp<SecretStorePluginOptions>(
  async (app, opts) => {
    // Distinguish "not injected" (build from env) from an explicit null (none).
    app.decorate("secretStore", opts.store !== undefined ? opts.store : buildFromEnv());
  },
  { name: "secret-store" },
);

function buildFromEnv(): SecretStore | null {
  try {
    if (process.env.AZURE_KEY_VAULT_URL) {
      return createSecretStore({ keyVaultUrl: process.env.AZURE_KEY_VAULT_URL });
    }
    if (process.env.DEV_SECRETS_KEK_FILE) {
      return createSecretStore({ devMasterKey: readDevKey(process.env.DEV_SECRETS_KEK_FILE) });
    }
  } catch {
    // Misconfigured custody (missing/short KEK) ⇒ no store; routes 503 rather
    // than seal under a weak key.
    return null;
  }
  return null;
}
