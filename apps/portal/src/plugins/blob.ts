import { DefaultAzureCredential } from "@azure/identity";
import fp from "fastify-plugin";
import { AzureBlobStore, type BlobStore } from "../blob/store.js";

export interface BlobPluginOptions {
  /** Inject a store (tests / fakes). When omitted, one is built from config. */
  store?: BlobStore;
  connectionString?: string;
  container?: string;
}

const DEFAULT_CONTAINER = "app-bundles";

/**
 * Discriminated union over blob storage auth (architecture §8 — providers stay
 * behind internal seams). Two Azure modes (issue #15): managed identity in prod
 * (no account key), and the connection-string/account-key path for dev/Azurite,
 * which is refused in production.
 */
export type BlobStoreConfig =
  | { provider: "azure"; mode: "shared-key"; connectionString: string; container: string }
  | { provider: "azure"; mode: "managed-identity"; accountUrl: string; container: string };

/**
 * Resolve provider config from plugin options / the environment. Managed
 * identity is selected when AZURE_STORAGE_BLOB_ENDPOINT is set; otherwise the
 * connection string is used, and refused in production.
 */
function resolveConfig(opts: BlobPluginOptions): BlobStoreConfig {
  const container = opts.container ?? process.env.BLOB_CONTAINER ?? DEFAULT_CONTAINER;
  const accountUrl = process.env.AZURE_STORAGE_BLOB_ENDPOINT;
  const connectionString = opts.connectionString ?? process.env.AZURE_STORAGE_CONNECTION_STRING;

  if (accountUrl) {
    return { provider: "azure", mode: "managed-identity", accountUrl, container };
  }
  if (connectionString) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "SharedKey/account-key blob auth is refused in production; set " +
          "AZURE_STORAGE_BLOB_ENDPOINT to use the managed identity",
      );
    }
    return { provider: "azure", mode: "shared-key", connectionString, container };
  }
  throw new Error(
    "Blob auth requires AZURE_STORAGE_CONNECTION_STRING (dev/Azurite) or " +
      "AZURE_STORAGE_BLOB_ENDPOINT (managed identity)",
  );
}

/** Build the store for the configured provider (Azure-only in v0). */
function createBlobStore(config: BlobStoreConfig): BlobStore {
  switch (config.mode) {
    case "shared-key":
      return AzureBlobStore.fromConnectionString(config.connectionString, config.container);
    case "managed-identity":
      // AZURE_CLIENT_ID selects the user-assigned identity; DefaultAzureCredential
      // reads it automatically.
      return AzureBlobStore.fromCredential(
        config.accountUrl,
        config.container,
        new DefaultAzureCredential(),
      );
  }
}

/** Decorates the app with a {@link BlobStore} for version-asset uploads. */
export const blobPlugin = fp<BlobPluginOptions>(
  async (app, opts) => {
    app.decorate("blobStore", opts.store ?? createBlobStore(resolveConfig(opts)));
  },
  { name: "blob" },
);
