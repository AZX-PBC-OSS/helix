import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, connect, type Socket } from "node:net";
import { createServer as createHttpsServer } from "node:https";
import { request } from "node:http";
import {
  createSecureContext,
  TLSSocket,
  getCACertificates,
  setDefaultCACertificates,
} from "node:tls";

/** Test-only TLS termination, mirroring managed ingress without disabling validation. */
export function transportTls(options: { wrongHost?: boolean; expired?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-tls-"));
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      options.wrongHost
        ? "subjectAltName=DNS:wrong.invalid"
        : "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  if (options.expired)
    execFileSync(
      "openssl",
      ["x509", "-in", certPath, "-signkey", keyPath, "-days", "-1", "-out", certPath],
      { stdio: "ignore" },
    );
  const cert = readFileSync(certPath);
  const key = readFileSync(keyPath);
  const previous = getCACertificates("default");
  setDefaultCACertificates([...previous, cert.toString()]);
  const closers: Array<() => Promise<void>> = [];
  async function listen(server: ReturnType<typeof createServer>): Promise<number> {
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return (server.address() as { port: number }).port;
  }
  return {
    certPath,
    async https(target: string): Promise<string> {
      const server = createHttpsServer({ key, cert }, (req, res) => {
        const upstream = request(
          new URL(req.url ?? "/", target),
          { method: req.method, headers: req.headers },
          (reply) => {
            res.writeHead(reply.statusCode ?? 502, reply.headers);
            reply.pipe(res);
          },
        );
        upstream.on("error", () => {
          res.statusCode = 502;
          res.end();
        });
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
      });
      return `https://127.0.0.1:${await listen(server)}`;
    },
    async postgres(dsn: string): Promise<string> {
      const target = new URL(dsn);
      const upstreamHost = target.hostname;
      const upstreamPort = Number(target.port || 5432);
      const server = createServer((socket) => {
        socket.once("data", (data) => {
          if (data.length !== 8 || data.readInt32BE(4) !== 80877103) {
            socket.destroy();
            return;
          }
          socket.write("S");
          const secure = new TLSSocket(socket, {
            isServer: true,
            secureContext: createSecureContext({ key, cert }),
          });
          const upstream = connect(upstreamPort, upstreamHost);
          secure.on("error", () => upstream.destroy());
          upstream.on("error", () => secure.destroy());
          secure.on("close", () => upstream.destroy());
          secure.pipe(upstream).pipe(secure);
        });
      });
      target.hostname = "127.0.0.1";
      target.port = String(await listen(server));
      target.searchParams.set("sslmode", "verify-full");
      target.searchParams.set("sslrootcert", certPath);
      return target.toString();
    },
    async close() {
      for (const close of closers.reverse()) await close();
      setDefaultCACertificates(previous);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
