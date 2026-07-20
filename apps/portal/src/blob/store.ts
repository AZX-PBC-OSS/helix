import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import type { TokenCredential } from "@azure/identity";
import type { Readable } from "node:stream";

export interface PutObjectOptions {
  /** Content-Type stored on the blob (served back by the edge in M2). */
  contentType?: string;
  /**
   * Fail if the key already exists — versions are immutable, so a key is
   * never overwritten. Provider-neutral; on Azure this is `If-None-Match: *`.
   */
  createOnly?: boolean;
}

/**
 * Blob storage behind a narrow interface (architecture §8 — Azure only behind
 * internal seams, and tests can supply an in-memory fake). Versions are
 * immutable, so there is no delete in M1.
 */
export interface BlobStore {
  putObject(key: string, body: Readable | Buffer, opts?: PutObjectOptions): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Azure Blob Storage (Azurite in dev) implementation of {@link BlobStore}. */
export class AzureBlobStore implements BlobStore {
  #container: ContainerClient;
  #ready: Promise<unknown> | null = null;

  constructor(container: ContainerClient) {
    this.#container = container;
  }

  static fromConnectionString(connectionString: string, container: string): AzureBlobStore {
    const service = BlobServiceClient.fromConnectionString(connectionString);
    return new AzureBlobStore(service.getContainerClient(container));
  }

  /**
   * Managed-identity (or any {@link TokenCredential}) write path (issue #15).
   * Prod authenticates with the portal's user-assigned identity + Storage Blob
   * Data Contributor — no account key. `accountUrl` is the blob endpoint, e.g.
   * `https://<account>.blob.core.windows.net`.
   */
  static fromCredential(
    accountUrl: string,
    container: string,
    credential: TokenCredential,
  ): AzureBlobStore {
    const service = new BlobServiceClient(accountUrl, credential);
    return new AzureBlobStore(service.getContainerClient(container));
  }

  /** Create the container once per process, lazily, on first use. */
  #ensureContainer(): Promise<unknown> {
    this.#ready ??= this.#container.createIfNotExists();
    return this.#ready;
  }

  async putObject(key: string, body: Readable | Buffer, opts?: PutObjectOptions): Promise<void> {
    await this.#ensureContainer();
    const block = this.#container.getBlockBlobClient(key);
    const conditions = opts?.createOnly ? { ifNoneMatch: "*" } : undefined;
    const blobHTTPHeaders = opts?.contentType ? { blobContentType: opts.contentType } : undefined;

    if (Buffer.isBuffer(body)) {
      await block.uploadData(body, { blobHTTPHeaders, conditions });
    } else {
      await block.uploadStream(body, undefined, undefined, { blobHTTPHeaders, conditions });
    }
  }

  async exists(key: string): Promise<boolean> {
    await this.#ensureContainer();
    return this.#container.getBlockBlobClient(key).exists();
  }
}
