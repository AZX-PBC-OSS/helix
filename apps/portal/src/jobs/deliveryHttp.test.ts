import { createServer, type Server } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { INSTRUCTION_HEADER, jobRequestError, JobsLifecycleUpdateAckSchema } from "@azx-pbc/shared";
import {
  JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS,
  buildJobsInternalResource,
  deriveJobsInstructionKey,
  verifyJobsInstruction,
} from "@azx-pbc/shared/jobsSigning";
import { HttpLifecycleDelivery } from "./deliveryHttp.js";
import { JOBS_DELIVERY_TIMEOUT_MS, lifecycleUpdateBytes } from "./delivery.js";

/**
 * The portal sender's production transport, against a REAL socket — no mock
 * stands in for the hop, because the transport's whole job is the signed HTTP
 * round trip. The stand-in receiver authenticates every presented instruction
 * through the SHARED verifier (the exact check the jobs receiver's seam runs)
 * before capturing it, so a token the receiver would refuse fails here
 * instead of passing quietly; what it answers is on cue.
 */

const ROOT = Buffer.alloc(32, 9).toString("base64");
const KEY = deriveJobsInstructionKey(ROOT, "portalToJobs");
const SERVER = "jobs";
const APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

class FakeLifecycleReceiver {
  /** Deliveries whose instruction verified. */
  deliveries: { appId: string; body: Buffer; jti: string }[] = [];
  /** Instructions that FAILED the shared verification, with the bounded reason. */
  verifyFailures: { reason: string }[] = [];
  answer: { status: number; body: string; headers?: Record<string, string> } = {
    status: 200,
    body: '{"appliedGeneration":"1"}',
  };
  #server: Server | null = null;

  async start(): Promise<string> {
    const key = deriveJobsInstructionKey(ROOT, "portalToJobs");
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => void this.#serve(req, res, Buffer.concat(chunks), key));
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async #serve(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    body: Buffer,
    key: Uint8Array,
  ): Promise<void> {
    const appId = /^\/internal\/jobs\/v1\/lifecycle\/([^/]+)$/.exec(req.url ?? "/")?.[1];
    if (!appId || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const verdict = await verifyJobsInstruction(
      typeof req.headers[INSTRUCTION_HEADER] === "string"
        ? (req.headers[INSTRUCTION_HEADER] as string)
        : "",
      key,
      {
        server: SERVER,
        operation: "lifecycle",
        method: "POST",
        resource: buildJobsInternalResource("lifecycle", { appId }),
        body: new Uint8Array(body),
      },
      Math.floor(Date.now() / 1_000),
    );
    if (!verdict.ok || verdict.claims.operation !== "lifecycle") {
      this.verifyFailures.push({ reason: verdict.ok ? "wrong-operation" : verdict.reason });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(jobRequestError("unauthorized"));
      return;
    }
    this.deliveries.push({ appId, body, jti: verdict.jti });
    res.writeHead(this.answer.status, {
      "content-type": "application/json",
      ...this.answer.headers,
    });
    res.end(this.answer.body);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }
}

/** A TCP listener that accepts and never answers — the black-hole target. */
async function startBlackhole(): Promise<{ endpoint: string; stop(): Promise<void> }> {
  const server = net.createServer(() => {});
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe("HttpLifecycleDelivery", () => {
  let receiver: FakeLifecycleReceiver | null = null;
  let base: string | null = null;

  afterEach(async () => {
    await receiver?.stop();
    receiver = null;
    base = null;
  });

  const transport = () => new HttpLifecycleDelivery({ timeoutMs: 5_000 });

  const attempt = (body: Uint8Array) => ({
    server: SERVER,
    endpoint: base!,
    key: KEY,
    appId: APP_ID,
    body,
  });

  it("mints an instruction the shared verifier accepts, bound to the exact body bytes", async () => {
    receiver = new FakeLifecycleReceiver();
    base = await receiver.start();
    const body = lifecycleUpdateBytes({ generation: 7, archived: true });

    const answer = await transport().deliver(attempt(body));

    expect(receiver.verifyFailures).toEqual([]);
    expect(receiver.deliveries).toHaveLength(1);
    expect(receiver.deliveries[0]!.appId).toBe(APP_ID);
    expect(Buffer.from(receiver.deliveries[0]!.body)).toEqual(Buffer.from(body));
    expect(answer).toEqual({ kind: "acknowledged", appliedGeneration: "1" });
  });

  it("answers a validated ack with the applied generation the receiver named", async () => {
    receiver = new FakeLifecycleReceiver();
    receiver.answer = { status: 200, body: '{"appliedGeneration":"9"}' };
    base = await receiver.start();

    const answer = await transport().deliver(
      attempt(lifecycleUpdateBytes({ generation: 3, archived: false })),
    );

    // The ack is the receiver's highest applied generation, passed through
    // for the sender's coverage decision — never the delivered generation.
    expect(answer).toEqual({ kind: "acknowledged", appliedGeneration: "9" });
  });

  it("classifies the receiver's own unavailability as refused, with its bounded code", async () => {
    receiver = new FakeLifecycleReceiver();
    receiver.answer = { status: 503, body: JSON.stringify(jobRequestError("jobs_unavailable")) };
    base = await receiver.start();

    const answer = await transport().deliver(
      attempt(lifecycleUpdateBytes({ generation: 1, archived: false })),
    );

    expect(answer.kind).toBe("refused");
    if (answer.kind === "refused") {
      expect(answer.status).toBe(503);
      expect(answer.error.code).toBe("jobs_unavailable");
    }
  });

  it("never fabricates an acknowledgement from an off-protocol answer", async () => {
    receiver = new FakeLifecycleReceiver();
    base = await receiver.start();
    const body = lifecycleUpdateBytes({ generation: 1, archived: false });

    // A 200 that is not a valid ack (an unparseable body, then a valid-JSON
    // stranger), a 500 with no protocol error body, and a redirect: all
    // invalid_response — the receiver answering, unusably.
    for (const answer of [
      { status: 200, body: "not json" },
      { status: 200, body: '{"appliedGeneration":"01"}' },
      { status: 500, body: "exploded" },
    ]) {
      receiver.answer = answer;
      const verdict = await transport().deliver(attempt(body));
      expect(verdict).toEqual({ kind: "invalid_response", status: answer.status });
    }
  });

  it("never re-presents the signed instruction to a redirect target", async () => {
    receiver = new FakeLifecycleReceiver();
    base = await receiver.start();
    const body = lifecycleUpdateBytes({ generation: 1, archived: false });
    // A 3xx that points elsewhere: `redirect: "error"` must refuse the hop —
    // following it would present a freshly minted, unburned instruction to a
    // host the target's answer chose.
    receiver.answer = {
      status: 302,
      body: "",
      headers: { location: "http://127.0.0.1:1/captured" },
    };

    const verdict = await transport().deliver(attempt(body));

    expect(verdict.kind).toBe("unreachable");
    // The refused hop's delivery was still verified and burned here — a
    // followed redirect would have delivered it a second time.
    expect(receiver.deliveries).toHaveLength(1);
  });

  it("answers unreachable when the target never answers — slow or dark, never a hang", async () => {
    const body = lifecycleUpdateBytes({ generation: 1, archived: false });
    const blackhole = await startBlackhole();
    try {
      const verdict = await new HttpLifecycleDelivery({ timeoutMs: 250 }).deliver({
        server: SERVER,
        endpoint: blackhole.endpoint,
        key: KEY,
        appId: APP_ID,
        body,
      });
      expect(verdict.kind).toBe("unreachable");
    } finally {
      await blackhole.stop();
    }
  });

  it("mints a fresh instruction per attempt — a redelivery is a new token, never a replayed one", async () => {
    receiver = new FakeLifecycleReceiver();
    base = await receiver.start();
    const body = lifecycleUpdateBytes({ generation: 1, archived: false });
    const t = transport();

    await t.deliver(attempt(body));
    await t.deliver(attempt(body));

    const jtis = receiver.deliveries.map((d) => d.jti);
    expect(jtis).toHaveLength(2);
    expect(new Set(jtis).size).toBe(2);
  });
});

describe("the ack schema the sender depends on", () => {
  it("acknowledgements parse against the shared wire schema", () => {
    expect(JobsLifecycleUpdateAckSchema.safeParse({ appliedGeneration: "12" }).success).toBe(true);
  });
});

describe("the transport's default round-trip bound", () => {
  it("is the signed instruction's own validity window — the two cannot drift", () => {
    // ADR-0002's rule for these hops: the whole mint→answer wait is capped
    // at the lifetime the token is valid for. A re-inlined literal here
    // would let the two constants drift apart — a transport that waits
    // past the token's expiry spends its batch window on a delivery the
    // receiver must refuse, and one that gives up early never lets a slow
    // receiver answer. The default (no `timeoutMs` override) is the
    // production composition's only configuration.
    expect(JOBS_DELIVERY_TIMEOUT_MS).toBe(JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS * 1000);
  });
});
