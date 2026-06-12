import fp from "fastify-plugin";
import { AzureBlobStore, type BlobStore } from "../blob/store.js";

export interface BlobPluginOptions {
  /** Inject a store (tests / fakes). When omitted, an Azure store is built. */
  store?: BlobStore;
  connectionString?: string;
  container?: string;
}

const DEFAULT_CONTAINER = "app-bundles";

/** Decorates the app with a {@link BlobStore} for version-asset uploads. */
export const blobPlugin = fp<BlobPluginOptions>(
  async (app, opts) => {
    let store = opts.store;
    if (!store) {
      const connectionString = opts.connectionString ?? process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!connectionString) {
        throw new Error("AZURE_STORAGE_CONNECTION_STRING is not set");
      }
      const container = opts.container ?? process.env.BLOB_CONTAINER ?? DEFAULT_CONTAINER;
      store = AzureBlobStore.fromConnectionString(connectionString, container);
    }
    app.decorate("blobStore", store);
  },
  { name: "blob" },
);
