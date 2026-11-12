import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, request } from "undici";
import { describe, expect, it } from "vitest";
import { ResourceDeadline } from "./resourceDeadline.js";

async function fixture() {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.write("first");
    const timer = setTimeout(() => res.end("last"), 1000);
    res.on("close", () => clearTimeout(timer));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const dispatcher = new Agent({ bodyTimeout: 3000 });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    dispatcher,
    async close() {
      await dispatcher.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe("service-account resource deadline", () => {
  it("keeps streaming after the dispatch budget expires once headers have arrived", async () => {
    const f = await fixture();
    try {
      const deadline = new ResourceDeadline(new AbortController().signal, 500);
      const response = await deadline.run((signal) =>
        request(f.url, { dispatcher: f.dispatcher, signal }),
      );
      expect(await response.body.text()).toBe("firstlast");
      await expect(deadline.run(async () => "too late")).rejects.toThrow(
        "resource deadline exceeded",
      );
    } finally {
      await f.close();
    }
  });
  it("still cancels the response stream when the caller disconnects after headers", async () => {
    const f = await fixture();
    try {
      const caller = new AbortController();
      const deadline = new ResourceDeadline(caller.signal, 500);
      const response = await deadline.run((signal) =>
        request(f.url, { dispatcher: f.dispatcher, signal }),
      );
      const body = response.body.text();
      caller.abort();
      await expect(body).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
  it("bounds recovery waits before headers", async () => {
    const deadline = new ResourceDeadline(new AbortController().signal, 30);
    await expect(deadline.run((signal) => delay(1000, undefined, { signal }))).rejects.toThrow();
  });
});
