import { randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSTRUCTION_HEADER,
  INSTRUCTION_JWT_TYP,
  METHOD_HEADER,
  OUTCOME_HEADER,
  TARGET_HEADER,
} from "@helix/shared";
import { buildApp } from "./app.js";
import type { EgressConfig } from "./config.js";
import { deriveInstructionKey } from "./instruction.js";
import type { ResolvedConnection, SecretResolver } from "./secrets.js";

const secret = randomBytes(32);
const key = deriveInstructionKey(secret);

// An upstream that echoes what it received, so we can assert injection + method.
let upstream: Server;
let origin: string;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        method: req.method,
        path: req.url,
        authorization: req.headers["authorization"] ?? null,
        host: req.headers["host"] ?? null,
        cookie: req.headers["cookie"] ?? null,
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

const fakeResolver: SecretResolver = {
  resolve: async (_appId, connection): Promise<ResolvedConnection | null> =>
    connection === "gh" ? { value: "ghp_secret", injection: { kind: "header-bearer" } } : null,
  close: async () => {},
};

function makeApp(allowPrivate: boolean, resolver: SecretResolver | null = fakeResolver) {
  const config = {
    limits: { maxBodyBytes: 1024 * 1024, timeoutMs: 5000 },
    allowPrivate,
  } as EgressConfig;
  return buildApp({ config, resolver, instructionKey: key });
}

async function mint(claims: {
  origin: string;
  connection?: string;
  appId?: string;
}): Promise<string> {
  const jwt = new SignJWT({
    appId: claims.appId ?? "app-1",
    userOid: "user-1",
    capability: "fetch",
    origin: claims.origin,
    requestId: "req-1",
    ...(claims.connection ? { connection: claims.connection } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: INSTRUCTION_JWT_TYP })
    .setIssuedAt()
    .setExpirationTime("30s");
  return jwt.sign(key);
}

describe("egress /proxy", () => {
  it("proxies a keyless GET and streams the upstream body back", async () => {
    const app = makeApp(true);
    const token = await mint({ origin });
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: token,
        [TARGET_HEADER]: `${origin}/echo`,
        [METHOD_HEADER]: "GET",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers[OUTCOME_HEADER]).toBe("ok");
    const body = res.json();
    expect(body.method).toBe("GET");
    expect(body.path).toBe("/echo");
    expect(body.authorization).toBeNull(); // keyless: nothing injected
    await app.close();
  });

  it("injects a connection secret server-side (app never sent it)", async () => {
    const app = makeApp(true);
    const token = await mint({ origin, connection: "gh" });
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: token,
        [TARGET_HEADER]: `${origin}/`,
        [METHOD_HEADER]: "GET",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().authorization).toBe("Bearer ghp_secret");
    await app.close();
  });

  it("refuses a connection the app was not granted", async () => {
    const app = makeApp(true);
    const token = await mint({ origin, connection: "nope" });
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: token,
        [TARGET_HEADER]: `${origin}/`,
        [METHOD_HEADER]: "GET",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    await app.close();
  });

  it("rejects a forged/absent instruction", async () => {
    const app = makeApp(true);
    const missing = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: { [TARGET_HEADER]: `${origin}/` },
    });
    expect(missing.statusCode).toBe(400);

    const forged = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: { [INSTRUCTION_HEADER]: "not.a.jwt", [TARGET_HEADER]: `${origin}/` },
    });
    expect(forged.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a target whose origin does not match the instruction", async () => {
    const app = makeApp(true);
    const token = await mint({ origin: "https://api.elsewhere.com" });
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: { [INSTRUCTION_HEADER]: token, [TARGET_HEADER]: `${origin}/` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    await app.close();
  });

  it("blocks a loopback target when private ranges are not allowed (SSRF)", async () => {
    const app = makeApp(false); // prod posture
    const token = await mint({ origin });
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: { [INSTRUCTION_HEADER]: token, [TARGET_HEADER]: `${origin}/` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("blocked");
    await app.close();
  });
});
