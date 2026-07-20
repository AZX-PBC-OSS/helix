import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AzureBlobConfig } from "../config.js";
import { UndiciBlobReader } from "./client.js";
import type { TokenProvider } from "./token.js";

/**
 * Unit test for the managed-identity bearer path (issue #15) against a local
 * HTTP stand-in for Blob. undici's MockAgent can't intercept the reader's
 * directly-constructed Pool, so we bind a real loopback server and assert the
 * exact headers on the wire — proving the edge sends a Bearer token and never
 * SharedKey.
 */

const fakeToken = (value = "fake-access-token"): TokenProvider => ({
  getToken: async () => value,
  close: async () => {},
});

describe("UndiciBlobReader — managed-identity bearer path", () => {
  let server: Server;
  let received: IncomingMessage[] = [];
  let respond: (req: IncomingMessage) => {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  };
  let reader: UndiciBlobReader;

  beforeEach(async () => {
    received = [];
    respond = () => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<h1>hi</h1>",
    });
    server = createServer((req, res) => {
      received.push(req);
      req.resume();
      req.on("end", () => {
        const r = respond(req);
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const config: AzureBlobConfig = {
      provider: "azure",
      endpoint: `http://127.0.0.1:${port}`,
      container: "app-bundles",
      auth: {
        mode: "managed-identity",
        clientId: "client-guid",
        identityEndpoint: "http://169.254.169.254/msi/token",
        identityHeader: "hdr",
      },
    };
    reader = new UndiciBlobReader(config, fakeToken());
  });

  afterEach(async () => {
    await reader.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends a Bearer token + x-ms-version, and never a SharedKey/x-ms-date header", async () => {
    const result = await reader.get("apps/a/1/index.html", { method: "GET" });
    expect(result.kind).toBe("found");

    const headers = received[0]!.headers;
    expect(headers.authorization).toBe("Bearer fake-access-token");
    expect(headers.authorization).not.toContain("SharedKey");
    expect(headers["x-ms-version"]).toBe("2021-12-02");
    expect(headers["x-ms-date"]).toBeUndefined();
  });

  it("forwards if-none-match on the bearer path", async () => {
    await reader.get("apps/a/1/index.html", { method: "GET", ifNoneMatch: '"etag-1"' });
    expect(received[0]!.headers["if-none-match"]).toBe('"etag-1"');
  });

  it("maps 200/304/404 like the SharedKey path", async () => {
    respond = () => ({
      status: 200,
      headers: { "content-type": "application/json", etag: '"e"' },
      body: "{}",
    });
    expect((await reader.get("k", { method: "GET" })).kind).toBe("found");

    respond = () => ({ status: 304 });
    expect((await reader.get("k", { method: "GET" })).kind).toBe("not-modified");

    respond = () => ({ status: 404 });
    expect((await reader.get("k", { method: "GET" })).kind).toBe("not-found");

    respond = () => ({ status: 500 });
    await expect(reader.get("k", { method: "GET" })).rejects.toThrow(/blob request failed/);
  });
});
