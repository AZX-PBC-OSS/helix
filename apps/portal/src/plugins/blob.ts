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
 * Discriminated union over blob storage providers (architecture §8 — providers
 * stay behind internal seams). Azure-only in v0: a new provider is a new
 * member here plus a {@link BlobStore} implementation selected in
 * `createBlobStore`; consumers of `app.blobStore` never see the difference.
 */
export type BlobStoreConfig = {
  provider: "azure";
  connectionString: string;
  container: string;
};

/**
 * Resolve provider config from plugin options / the environment. Azure is the
 * only v0 provider, so its connection string is the only blob config input; a
 * future BLOB_PROVIDER switch dispatches here to build a different member.
 */
function resolveConfig(opts: BlobPluginOptions): BlobStoreConfig {
  const connectionString = opts.connectionString ?? process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
  }
  const container = opts.container ?? process.env.BLOB_CONTAINER ?? DEFAULT_CONTAINER;
  return { provider: "azure", connectionString, container };
}

/** Build the store for the configured provider (Azure-only in v0). */
function createBlobStore(config: BlobStoreConfig): BlobStore {
  switch (config.provider) {
    case "azure":
      return AzureBlobStore.fromConnectionString(config.connectionString, config.container);
  }
}

/** Decorates the app with a {@link BlobStore} for version-asset uploads. */
export const blobPlugin = fp<BlobPluginOptions>(
  async (app, opts) => {
    app.decorate("blobStore", opts.store ?? createBlobStore(resolveConfig(opts)));
  },
  { name: "blob" },
);
