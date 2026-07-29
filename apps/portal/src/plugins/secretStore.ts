import fp from "fastify-plugin";
import type { SecretStore } from "@azx-pbc/secret-store";
import { createSecretStoreFromEnv } from "../secrets/custody.js";

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
    app.decorate("secretStore", opts.store !== undefined ? opts.store : buildFromEnv(app.log));
  },
  { name: "secret-store" },
);

function buildFromEnv(log: { error: (obj: object, msg: string) => void }): SecretStore | null {
  try {
    return createSecretStoreFromEnv();
  } catch (err) {
    // Misconfigured custody (missing/short KEK, unusable vault credential) ⇒ no
    // store; the secret routes 503 rather than seal under a weak key. Log it —
    // silently degrading to "secrets unavailable" is otherwise indistinguishable
    // from never having configured custody at all.
    log.error(
      { err },
      "secret store is configured but could not be built — secret routes will 503",
    );
    return null;
  }
}
