import { spawn } from "node:child_process";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { transportTls } from "./test/transportTls.js";
import { createPrismaClient } from "../../portal/src/db/client.js";

const source = process.env.TEST_DATABASE_URL ?? "postgresql://helix:helix@db:5432/helix_test";
function command(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(binary, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end("SELECT 1;");
    let output = "";
    child.stdout.on("data", (data) => {
      output += String(data);
    });
    child.stderr.on("data", (data) => {
      output += String(data);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}
describe("database destination authentication", () => {
  it.each(["valid", "untrusted", "wrongHost", "expired"] as const)(
    "checks %s certificates in pg, Prisma adapter and psql",
    async (kind) => {
      const tls = transportTls({ wrongHost: kind === "wrongHost", expired: kind === "expired" });
      try {
        const url = new URL(await tls.postgres(source));
        if (kind === "untrusted") url.searchParams.delete("sslrootcert");
        const pool = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
        const prisma = createPrismaClient(url.toString());
        try {
          if (kind === "valid") {
            expect((await pool.query("SELECT 1 AS ok")).rows[0].ok).toBe(1);
            expect(await prisma.$queryRawUnsafe("SELECT 1 AS ok")).toEqual([{ ok: 1 }]);
          } else {
            // Untrusted tests must remove the fixture CA from Node's default trust too.
            if (kind === "untrusted") {
              const { setDefaultCACertificates, getCACertificates } = await import("node:tls");
              setDefaultCACertificates(getCACertificates("bundled"));
            }
            await expect(pool.query("SELECT 1")).rejects.toThrow(
              /certificate|self.signed|altname/i,
            );
            await expect(prisma.$queryRawUnsafe("SELECT 1")).rejects.toThrow(
              /certificate|self.signed|altname/i,
            );
          }
          const result = await command("psql", ["-X", "-d", url.toString(), "-c", "SELECT 1"], {
            PGDATABASE: url.toString(),
            PGCONNECT_TIMEOUT: "3",
            PGSSLROOTCERT:
              kind === "untrusted" ? "/etc/ssl/certs/ca-certificates.crt" : tls.certPath,
          });
          expect(result.code).toBe(kind === "valid" ? 0 : 2);
          if (kind !== "valid") expect(result.output).toMatch(/certificate|does not match/i);
          const nativeUrl = new URL(url);
          nativeUrl.searchParams.set("sslmode", "require");
          nativeUrl.searchParams.set("sslaccept", "strict");
          nativeUrl.searchParams.delete("sslrootcert");
          if (kind !== "untrusted") nativeUrl.searchParams.set("sslcert", tls.certPath);
          const native = await command(
            "pnpm",
            ["--filter", "@azx-pbc/portal", "exec", "prisma", "db", "execute", "--stdin"],
            { DATABASE_URL: nativeUrl.toString() },
          );
          expect(native.code, native.output).toBe(kind === "valid" ? 0 : 1);
          if (kind !== "valid") expect(native.output).toMatch(/certificate|TLS|ssl/i);
        } finally {
          await pool.end();
          await prisma.$disconnect();
        }
      } finally {
        await tls.close();
      }
    },
    15000,
  );
});

it("refuses a PostgreSQL server that declines TLS", async () => {
  const { createServer } = await import("node:net");
  const server = createServer((socket) => socket.once("data", () => socket.end("N")));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `postgresql://test:test@127.0.0.1:${port}/test?sslmode=verify-full`;
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 3000 });
  try {
    await expect(pool.query("SELECT 1")).rejects.toThrow(/does not support SSL/i);
    const psql = await command("psql", ["-X", "-d", url, "-c", "SELECT 1"], {
      PGCONNECT_TIMEOUT: "3",
    });
    expect(psql.code).not.toBe(0);
    expect(psql.output).toMatch(/does not support SSL/i);
    const native = await command(
      "pnpm",
      ["--filter", "@azx-pbc/portal", "exec", "prisma", "db", "execute", "--stdin"],
      { DATABASE_URL: url.replace("verify-full", "require&sslaccept=strict") },
    );
    expect(native.code).not.toBe(0);
    expect(native.output).toMatch(/TLS|SSL/i);
  } finally {
    await pool.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each([
  ["valid", undefined],
  ["untrusted", "DEPTH_ZERO_SELF_SIGNED_CERT"],
  ["wrongHost", "ERR_TLS_CERT_ALTNAME_INVALID"],
  ["expired", "CERT_HAS_EXPIRED"],
] as const)("edge egress client authenticates %s HTTPS destinations", async (kind, errorCode) => {
  const { createServer } = await import("node:http");
  const { HttpEgressProvider } = await import("../../edge/src/gateway/egressProvider.js");
  const upstream = createServer((_req, res) => res.end("upstream response"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const tls = transportTls({ wrongHost: kind === "wrongHost", expired: kind === "expired" });
  const origin = await tls.https(
    `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
  );
  if (kind === "untrusted") {
    const { setDefaultCACertificates, getCACertificates } = await import("node:tls");
    setDefaultCACertificates(getCACertificates("bundled"));
  }
  const client = new HttpEgressProvider(origin);
  try {
    const call = client.proxy({
      instruction: "fixture",
      target: "https://upstream.invalid",
      method: "GET",
      headers: {},
      body: null,
      signal: AbortSignal.timeout(3000),
      correlationId: "fixture",
    });
    if (errorCode) await expect(call).rejects.toMatchObject({ cause: { code: errorCode } });
    else {
      const result = await call;
      expect(result.status).toBe(200);
      let body = "";
      for await (const chunk of result.body) body += String(chunk);
      expect(body).toBe("upstream response");
    }
  } finally {
    await client.close();
    await tls.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
