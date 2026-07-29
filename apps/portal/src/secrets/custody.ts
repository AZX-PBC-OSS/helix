import { DefaultAzureCredential } from "@azure/identity";
import {
  createSecretStore,
  readDevKey,
  type GetVaultToken,
  type SecretStore,
} from "@azx-pbc/secret-store";

/** AAD scope for the Key Vault data plane. */
const VAULT_SCOPE = "https://vault.azure.net/.default";

/**
 * Bearer tokens for Key Vault, via `@azure/identity`.
 *
 * Unlike egress (which hand-rolls the managed-identity call to stay
 * dependency-free), the portal is the privileged control plane and already
 * depends on `@azure/identity` for Blob writes — ADR-0027's line is "acceptable
 * on the privileged control plane, never the edge". Using it here also means
 * operator scripts authenticate under `az login` with no extra code.
 *
 * `AZURE_CLIENT_ID` selects the user-assigned identity; `DefaultAzureCredential`
 * reads it automatically. The credential caches tokens internally, so this is
 * cheap to call per request.
 */
export function defaultAzureVaultToken(): GetVaultToken {
  const credential = new DefaultAzureCredential();
  return async () => {
    const token = await credential.getToken(VAULT_SCOPE);
    if (!token) throw new Error("could not acquire a Key Vault token");
    return token.token;
  };
}

/**
 * Build the connection-secret custody store from the environment (secrets design
 * §3): Key Vault in prod (`AZURE_KEY_VAULT_URL`), the dev envelope under the local
 * KEK otherwise (`DEV_SECRETS_KEK_FILE`).
 *
 * Returns `null` only when **neither** is configured. A configured-but-broken
 * custody (missing/short KEK, unusable credential) **throws** — callers decide
 * whether that is fatal, and none of them may fall back to a weaker seal.
 */
export function createSecretStoreFromEnv(env: NodeJS.ProcessEnv = process.env): SecretStore | null {
  if (env.AZURE_KEY_VAULT_URL) {
    return createSecretStore({
      keyVaultUrl: env.AZURE_KEY_VAULT_URL,
      getToken: defaultAzureVaultToken(),
    });
  }
  if (env.DEV_SECRETS_KEK_FILE) {
    return createSecretStore({ devMasterKey: readDevKey(env.DEV_SECRETS_KEK_FILE) });
  }
  return null;
}
