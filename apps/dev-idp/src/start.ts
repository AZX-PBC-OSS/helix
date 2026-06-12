import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { buildProvider, type DevIdpOptions } from "./provider.js";
import { handleInteraction } from "./interactions.js";

export interface StartDevIdpOptions extends DevIdpOptions {
  /** 0 (default) binds an ephemeral port — parallel test files never collide. */
  port?: number;
  /** Issuer host for the URL; the port is always the bound one. */
  host?: string;
}

export interface RunningDevIdp {
  issuer: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Bind first, then construct the provider with the real bound port — the
 * issuer string is plain construction-time metadata, so this is what lets
 * integration tests run an in-process IdP on port 0.
 */
export async function startDevIdp(opts: StartDevIdpOptions = {}): Promise<RunningDevIdp> {
  const host = opts.host ?? "localhost";

  // Reserve the port with a placeholder listener, then swap the handler in.
  const server: Server = createServer();
  server.listen(opts.port ?? 0, "0.0.0.0");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  const issuer = `http://${host}:${port}`;

  const provider = buildProvider(issuer, opts);
  const oidcCallback = provider.callback();

  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    void (async () => {
      if (!(await handleInteraction(provider, req, res, url))) {
        await oidcCallback(req, res);
      }
    })().catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end("dev-idp error");
      console.error("[dev-idp]", err);
    });
  });

  return {
    issuer,
    port,
    close: async () => {
      server.close();
      server.closeAllConnections();
      await once(server, "close");
    },
  };
}
