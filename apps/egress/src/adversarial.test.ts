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
} from "@azx-pbc/shared";
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
    switch (c) {
      case "gh":
        return { value: "injected-secret", injection: { kind: "header-bearer" } };
      case "gh-key":
        return {
          value: "key-secret-xyz",
          injection: { kind: "header", name: "x-api-key", template: "{}" },
        };
      case "gh-query":
        return { value: "query-secret-abc", injection: { kind: "query", param: "access_token" } };
      default:
        return null;
    }
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

describe("egress secret echo-back (issue #7)", () => {
  // A reflecting upstream: mirrors the credentials it received back into RESPONSE
  // headers (the echo/debug/CORS-reflection case) and echoes the request URL in
  // Location (the query-recipe reflection vector). This is the shape the static
  // blocklist misses — the injected header must be stripped before it reaches us.
  let echo: Server;
  let echoOrigin: string;
  beforeAll(async () => {
    echo = createServer((req, res) => {
      const auth = req.headers["authorization"];
      // Always set an Authorization response header: reflect the injected bearer
      // when present, else a server-issued sentinel (exercises the static backstop).
      res.setHeader("authorization", typeof auth === "string" ? auth : "Bearer upstream-issued");
      const apiKey = req.headers["x-api-key"];
      if (typeof apiKey === "string") res.setHeader("x-api-key", apiKey);
      res.setHeader("location", `${echoOrigin}${req.url}`);
      res.setHeader("etag", '"v1"'); // a benign header the app relies on
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ authorization: auth ?? null, url: req.url }));
    });
    await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
    echoOrigin = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => echo.close(() => resolve())));

  async function proxy(connection?: string) {
    const app = makeApp(true);
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: await mint(echoOrigin, connection),
        [TARGET_HEADER]: `${echoOrigin}/`,
        [METHOD_HEADER]: "GET",
      },
    });
    await app.close();
    return res;
  }

  it("strips a reflected header-bearer credential from the response", async () => {
    const res = await proxy("gh");
    expect(res.statusCode).toBe(200);
    expect(res.headers["authorization"]).toBeUndefined();
  });

  it("strips a reflected arbitrary-name credential the static blocklist can't enumerate", async () => {
    const res = await proxy("gh-key");
    expect(res.statusCode).toBe(200);
    // x-api-key is NOT in RESPONSE_HEADER_BLOCKLIST — only the dynamic strip removes it.
    expect(res.headers["x-api-key"]).toBeUndefined();
  });

  it("redacts a query-recipe secret reflected in Location", async () => {
    const res = await proxy("gh-query");
    expect(res.statusCode).toBe(200);
    const location = res.headers["location"];
    expect(location).toBeDefined();
    expect(location).not.toContain("query-secret-abc");
    expect(location).toContain("access_token=REDACTED");
  });

  it("does not over-strip benign headers the app relies on", async () => {
    const res = await proxy("gh");
    expect(res.headers["etag"]).toBe('"v1"');
    expect(res.headers["content-type"]).toContain("application/json");
  });

  it("strips a server-issued Authorization via the static backstop (keyless call)", async () => {
    // Nothing injected, so the dynamic strip is inert; the shared blocklist must
    // still drop the upstream's Authorization response header.
    const res = await proxy();
    expect(res.statusCode).toBe(200);
    expect(res.headers["authorization"]).toBeUndefined();
  });

  it("does NOT close the body-echo channel (documented transparent-proxy residual)", async () => {
    // An upstream that echoes the secret into the response BODY still reaches the
    // app — no header filter closes this. Pinned so the residual is explicit.
    const res = await proxy("gh");
    expect(res.json().authorization).toBe("Bearer injected-secret");
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
