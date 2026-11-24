import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
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
  if (options.expired) {
    // Re-sign with a validity window entirely in the past. OpenSSL 3.4+ has
    // explicit -not_before/-not_after and rejects the old `-days -1` trick
    // ("end date before start date"); 3.0 lacks the flags but accepts -days -1.
    // CI's runner image ships the former, the dev container the latter.
    const expiredPath = path.join(dir, "expired.pem");
    const resign = (validity: string[]) =>
      execFileSync(
        "openssl",
        ["x509", "-in", certPath, "-signkey", keyPath, ...validity, "-out", expiredPath],
        { stdio: "ignore" },
      );
    try {
      resign(["-not_before", "20000101000000Z", "-not_after", "20000102000000Z"]);
    } catch {
      resign(["-days", "-1"]);
    }
    renameSync(expiredPath, certPath);
  }
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
