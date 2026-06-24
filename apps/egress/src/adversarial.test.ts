import { randomBytes } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSTRUCTION_HEADER,
  INSTRUCTION_JWT_TYP,
  METHOD_HEADER,
  TARGET_HEADER,
} from "@helix/shared";
import { buildApp } from "./app.js";
import type { EgressConfig } from "./config.js";
import { deriveInstructionKey } from "./instruction.js";
import type { ResolvedConnection, SecretResolver } from "./secrets.js";

/**
 * The adversarial pass the fetch-proxy demands (fetch-proxy design §6): SSRF to
 * the metadata service / private ranges, header smuggling (the app must not leak
 * the session cookie outbound nor override the injected credential), and forged
 * instructions. Mirrors the edge auth adversarial suite's stance — the controls
 * are asserted directly, not assumed.
 */

const key = deriveInstructionKey(randomBytes(32));

// An echo upstream so we can see exactly what (if anything) was forwarded.
let upstream: Server;
let origin: string;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        authorization: req.headers["authorization"] ?? null,
        cookie: req.headers["cookie"] ?? null,
        xApiKey: req.headers["x-api-key"] ?? null,
      }),
    );
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

// Mirrors PgSecretResolver's capability gate: `platform` secrets resolve only on
// the `llm` path, `app`/`global` only on `fetch`.
const resolver: SecretResolver = {
  resolve: async (_a, c, capability): Promise<ResolvedConnection | null> => {
    if (capability === "llm") {
      return c === "anthropic"
        ? {
            value: "platform-vendor-key",
            injection: { kind: "header", name: "x-api-key", template: "{}" },
          }
        : null;
    }
    return c === "gh" ? { value: "injected-secret", injection: { kind: "header-bearer" } } : null;
  },
  close: async () => {},
};

function makeApp(allowPrivate: boolean) {
  const config = {
    limits: { maxBodyBytes: 1024 * 1024, timeoutMs: 5000 },
    allowPrivate,
  } as EgressConfig;
  return buildApp({ config, resolver, instructionKey: key });
}

async function mint(
  o: string,
  connection?: string,
  capability: "fetch" | "llm" = "fetch",
): Promise<string> {
  return new SignJWT({
    appId: "app-1",
    userOid: "u",
    capability,
    origin: o,
    requestId: "r",
    ...(connection ? { connection } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: INSTRUCTION_JWT_TYP })
    .setIssuedAt()
    .setExpirationTime("30s")
    .sign(key);
}

describe("egress SSRF hardening", () => {
  // The prod posture: private ranges blocked.
  for (const target of [
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/", // IMDS
    "http://127.0.0.1/secret",
    "http://10.0.0.5/internal",
    "http://[::1]/loopback",
  ]) {
    it(`refuses ${new URL(target).host}`, async () => {
      const app = makeApp(false);
      const o = new URL(target).origin;
      const res = await app.inject({
        method: "POST",
        url: "/proxy",
        headers: {
          [INSTRUCTION_HEADER]: await mint(o),
          [TARGET_HEADER]: target,
          [METHOD_HEADER]: "GET",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("blocked");
      await app.close();
    });
  }
});

describe("egress header smuggling", () => {
  it("never forwards the app's cookie or Authorization upstream", async () => {
    const app = makeApp(true);
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: await mint(origin),
        [TARGET_HEADER]: `${origin}/`,
        [METHOD_HEADER]: "GET",
        cookie: "__Host-session=stolen",
        authorization: "Bearer app-supplied",
      },
    });
    const body = res.json();
    expect(body.cookie).toBeNull(); // session never leaks outbound
    expect(body.authorization).toBeNull(); // not safelisted
    await app.close();
  });

  it("the app cannot override the server-injected credential", async () => {
    const app = makeApp(true);
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: await mint(origin, "gh"),
        [TARGET_HEADER]: `${origin}/`,
        [METHOD_HEADER]: "GET",
        authorization: "Bearer app-supplied", // dropped, then injection wins
      },
    });
    expect(res.json().authorization).toBe("Bearer injected-secret");
    await app.close();
  });
});

describe("egress platform-secret capability gate", () => {
  it("injects the platform vendor key for an llm instruction", async () => {
    const app = makeApp(true);
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: await mint(origin, "anthropic", "llm"),
        [TARGET_HEADER]: `${origin}/`,
        [METHOD_HEADER]: "GET",
      },
    });
    expect(res.json().xApiKey).toBe("platform-vendor-key");
    await app.close();
  });

  it("refuses to inject the platform key on the fetch path (404 connection)", async () => {
    const app = makeApp(true);
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        // A fetch instruction naming the platform connection resolves to nothing.
        [INSTRUCTION_HEADER]: await mint(origin, "anthropic", "fetch"),
        [TARGET_HEADER]: `${origin}/`,
        [METHOD_HEADER]: "GET",
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("forbidden");
    await app.close();
  });
});

describe("egress instruction forgery", () => {
  it("rejects a token signed with the wrong key", async () => {
    const app = makeApp(true);
    const wrong = await new SignJWT({
      appId: "app-1",
      userOid: "u",
      capability: "fetch",
      origin,
      requestId: "r",
    })
      .setProtectedHeader({ alg: "HS256", typ: INSTRUCTION_JWT_TYP })
      .setIssuedAt()
      .setExpirationTime("30s")
      .sign(deriveInstructionKey(randomBytes(32)));
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: { [INSTRUCTION_HEADER]: wrong, [TARGET_HEADER]: `${origin}/` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
