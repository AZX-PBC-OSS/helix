import { randomBytes, randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  INSTRUCTION_AUDIENCE,
  INSTRUCTION_HEADER,
  INSTRUCTION_JWT_TYP,
  METHOD_HEADER,
  OUTCOME_HEADER,
  TARGET_HEADER,
} from "@azx-pbc/shared";
import { buildApp } from "./app.js";
import type { EgressConfig } from "./config.js";
import { signTimestamp } from "./hmac.js";
import { deriveInstructionKey } from "./instruction.js";
import type { ResolvedConnection, SecretResolver } from "./secrets.js";

const secret = randomBytes(32);
const key = deriveInstructionKey(secret);

// An upstream that echoes what it received, so we can assert injection + method.
let upstream: Server;
let origin: string;
beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          path: req.url,
          authorization: req.headers["authorization"] ?? null,
          host: req.headers["host"] ?? null,
          cookie: req.headers["cookie"] ?? null,
          xDate: req.headers["x-date"] ?? null,
          // Echo the received body so tests can assert it transited intact.
          received: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => upstream.close(() => resolve())));

/** The private half of the hmac fixture pair — also the needle for leak assertions. */
const HMAC_PRIVATE = "ghp_LIVEPRIVATEKEY_abcdefghijklmnop";
const HMAC_BLOB = JSON.stringify({ credential: "pub-abc", key: HMAC_PRIVATE });
const HMAC_RECIPE = {
  kind: "hmac-timestamp",
  timestampHeader: "x-date",
  authHeader: "authorization",
  template: "Credential={credential},Signature={signature}",
} as const;

const fakeResolver: SecretResolver = {
  resolve: async (_appId, connection): Promise<ResolvedConnection | null> => {
    switch (connection) {
      case "gh":
        return { value: "ghp_secret", injection: { kind: "header-bearer" } };
      case "hmac":
        return { value: HMAC_BLOB, injection: HMAC_RECIPE };
      // A recipe⇄material mismatch: the recipe wants a blob, the material is a
      // bare token. The portal now refuses this at write time, but rows predating
      // that check exist, so the read path must fail closed and opaquely.
      case "hmac-bad":
        return { value: HMAC_PRIVATE, injection: HMAC_RECIPE };
      default:
        return null;
    }
  },
  close: async () => {},
};

function makeApp(allowPrivate: boolean, resolver: SecretResolver | null = fakeResolver) {
  const config = {
    limits: { maxBodyBytes: 1024 * 1024, timeoutMs: 5000 },
    allowPrivate,
    // Loopback echo upstreams are http; open the cleartext-injection seam so
    // these functional tests exercise injection without TLS (the prod guard and
    // its refusal path are covered in adversarial.test.ts — issue #11).
    allowInsecureConnection: true,
  } as EgressConfig;
  // No burn store here: these functional tests each mint a fresh (unique jti)
  // instruction, so replay protection is irrelevant; it's covered on its own in
  // adversarial.test.ts.
  return buildApp({ config, resolver, instructionKey: key, burnStore: null });
}

async function mint(claims: {
  origin: string;
  connection?: string;
  appId?: string;
}): Promise<string> {
  // Unique requestId per call so a shared burn store (where wired) wouldn't
  // reject the second mint as a replay.
  const requestId = randomUUID();
  const jwt = new SignJWT({
    appId: claims.appId ?? "app-1",
    userOid: "user-1",
    capability: "fetch",
    origin: claims.origin,
    requestId,
    ...(claims.connection ? { connection: claims.connection } : {}),
  })
    .setProtectedHeader({ alg: "HS256", typ: INSTRUCTION_JWT_TYP })
    .setJti(requestId)
    .setAudience(INSTRUCTION_AUDIENCE)
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

  it("derives an hmac-timestamp credential the app never computed", async () => {
    const app = makeApp(true);
    const token = await mint({ origin, connection: "hmac" });
    const before = Date.now();
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
    const body = res.json();
    expect(body.authorization).toMatch(/^Credential=pub-abc,Signature=[0-9a-f]{64}$/);
    // The timestamp went out as a real, current ISO instant.
    const sent = Date.parse(body.xDate);
    expect(sent).toBeGreaterThanOrEqual(before - 1000);
    expect(sent).toBeLessThanOrEqual(Date.now() + 1000);
    // Neither the private key nor the raw blob transited to the upstream.
    expect(res.payload).not.toContain(HMAC_PRIVATE);
    expect(res.payload).not.toContain('"key"');
    await app.close();
  });

  /**
   * The end-to-end binding test: recompute the signature over the timestamp the
   * upstream actually received. It fails if the two headers ever come from
   * different clock readings, or if the transmitted timestamp format diverges from
   * the signed one — a class of bug that authenticates locally and 401s in prod.
   */
  it("signs exactly the timestamp it transmits", async () => {
    const app = makeApp(true);
    const token = await mint({ origin, connection: "hmac" });
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: token,
        [TARGET_HEADER]: `${origin}/`,
        [METHOD_HEADER]: "GET",
      },
    });
    const body = res.json();
    const signature = /Signature=([0-9a-f]{64})$/.exec(body.authorization)?.[1];
    expect(signature).toBe(signTimestamp(HMAC_PRIVATE, body.xDate));
    await app.close();
  });

  it("refuses material that does not fit its recipe, opaquely", async () => {
    const app = makeApp(true);
    const token = await mint({ origin, connection: "hmac-bad" });
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: token,
        [TARGET_HEADER]: `${origin}/`,
        [METHOD_HEADER]: "GET",
      },
    });
    // Indistinguishable from a vault failure: an app must not learn *why*.
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({
      code: "upstream_error",
      message: "connection secret unavailable",
    });
    // V8 embeds a ~10-character prefix of its input in a JSON.parse message. That
    // input is the private key here, so pin its absence explicitly rather than
    // trusting the full-string check alone.
    expect(res.payload).not.toContain(HMAC_PRIVATE);
    expect(res.payload).not.toContain(HMAC_PRIVATE.slice(0, 10));
    await app.close();
  });

  it("forwards a JSON POST body intact (not consumed by a content-type parser)", async () => {
    // Regression: Fastify's built-in application/json parser must not drain
    // req.raw before the handler re-streams it (the LLM path is always JSON).
    const app = makeApp(true);
    const token = await mint({ origin });
    const payload = JSON.stringify({ model: "claude-opus-4-8", messages: [{ role: "user" }] });
    const res = await app.inject({
      method: "POST",
      url: "/proxy",
      headers: {
        [INSTRUCTION_HEADER]: token,
        [TARGET_HEADER]: `${origin}/v1/messages`,
        [METHOD_HEADER]: "POST",
        "content-type": "application/json",
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.method).toBe("POST");
    expect(body.received).toBe(payload); // body transited byte-for-byte
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

describe("egress /proxy — connection pooling (ADR-0005 perf note)", () => {
  // The validate-and-pin moved into a shared dispatcher's connector, so repeated
  // calls to the same origin must reuse keep-alive sockets instead of paying a
  // fresh TCP+TLS handshake per call (the old per-request `Agent`). Guards against
  // a regression back to per-request dispatchers.
  it("reuses keep-alive sockets across requests to the same origin", async () => {
    let connections = 0;
    const server = createServer((_req, res) => res.end("ok"));
    server.on("connection", () => void connections++);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const localOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const app = makeApp(true);
    const requests = 6;
    for (let i = 0; i < requests; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/proxy",
        headers: {
          [INSTRUCTION_HEADER]: await mint({ origin: localOrigin }),
          [TARGET_HEADER]: `${localOrigin}/`,
          [METHOD_HEADER]: "GET",
        },
      });
      expect(res.statusCode).toBe(200);
    }

    // Per-request Agents would open one TCP connection per request; a shared,
    // pooled dispatcher opens far fewer (typically one).
    expect(connections).toBeLessThan(requests);

    await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
