import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { BlobServiceClient } from "@azure/storage-blob";
import { describe, expect, it } from "vitest";
import { AzureBlobStore } from "./store.js";

// Exercises the real Azure SDK path against Azurite (in the dev container),
// catching streaming / content-type / concurrency bugs the in-memory fake can't.
//
// Older Azurite images reject the SDK's newer x-ms-version. The dev container's
// azurite runs with `--skipApiVersionCheck` (see .devcontainer/docker-compose.yml)
// — but a container built before that flag was added still rejects it, so we
// probe once and skip *loudly* rather than fail the whole suite.
const CONNECTION = process.env.AZURE_STORAGE_CONNECTION_STRING;
const CONTAINER = "app-bundles-test";

let skipReason = "";
if (!CONNECTION) {
  skipReason = "AZURE_STORAGE_CONNECTION_STRING is not set";
} else {
  try {
    await AzureBlobStore.fromConnectionString(CONNECTION, CONTAINER).exists(
      `probe/${randomUUID()}`,
    );
  } catch (err) {
    skipReason =
      (err instanceof Error ? err.message.split("\n")[0] : String(err)) || "azurite error";
  }
}
if (skipReason) {
  console.warn(`[store.test] skipping Azurite integration tests: ${skipReason}`);
}

describe.skipIf(skipReason)("AzureBlobStore against Azurite", () => {
  const store = AzureBlobStore.fromConnectionString(CONNECTION!, CONTAINER);

  async function contentTypeOf(key: string): Promise<string | undefined> {
    const props = await BlobServiceClient.fromConnectionString(CONNECTION!)
      .getContainerClient(CONTAINER)
      .getBlockBlobClient(key)
      .getProperties();
    return props.contentType;
  }

  it("uploads a buffer with its content-type and reports existence", async () => {
    const key = `test/${randomUUID()}/index.html`;
    await store.putObject(key, Buffer.from("<html></html>"), {
      contentType: "text/html; charset=utf-8",
    });
    expect(await store.exists(key)).toBe(true);
    expect(await contentTypeOf(key)).toBe("text/html; charset=utf-8");
  });

  it("uploads a readable stream", async () => {
    const key = `test/${randomUUID()}/app.js`;
    const body = Readable.from([Buffer.from("console."), Buffer.from("log(1)")]);
    await store.putObject(key, body, { contentType: "text/javascript" });
    expect(await store.exists(key)).toBe(true);
  });

  it("reports false for a missing key", async () => {
    expect(await store.exists(`test/${randomUUID()}/nope`)).toBe(false);
  });

  it("refuses to overwrite an existing key (ifNoneMatch '*')", async () => {
    const key = `test/${randomUUID()}/once.txt`;
    await store.putObject(key, Buffer.from("first"), { ifNoneMatch: "*" });
    await expect(
      store.putObject(key, Buffer.from("second"), { ifNoneMatch: "*" }),
    ).rejects.toThrow();
  });
});
