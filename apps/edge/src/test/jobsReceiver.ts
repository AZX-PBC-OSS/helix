import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildJobsInternalResource,
  deriveJobsInstructionKey,
  verifyJobsInstruction,
  type JobsSubmitClaims,
} from "@azx-pbc/shared/jobsSigning";

/**
 * A stand-in jobs receiver for the edge suites: a real HTTP server on a
 * loopback port that authenticates every presented submit instruction through
 * the SHARED verifier — the exact check the real receiver's seam runs — before
 * capturing it, so a forward whose token would be refused by `helix-jobs`
 * fails here instead of passing quietly. What it answers is on cue; a
 * verification failure answers the real receiver's own 401.
 */

/** One captured, instruction-verified submission. */
export interface CapturedJobsSubmit {
  claims: JobsSubmitClaims;
  /** The verified instruction's nonce — the receiver burned it before capture. */
  jti: string;
  /** The retry-key header exactly as presented (null when absent). */
  presentedRetryKey: string | null;
  body: Buffer;
}

export interface ReceiverAnswer {
  status?: number;
  body?: string;
  contentType?: string;
  /** Hold the answer this long before answering (a hanging server). */
  delayMs?: number;
  /** Refuse the connection instead of answering. */
  refuse?: boolean;
  /** Headers at once, then one small chunk per interval, forever (slow drip). */
  dripEveryMs?: number;
}

export class FakeJobsServiceReceiver {
  /** Submissions whose instruction verified — the receivers' accepted path. */
  calls: CapturedJobsSubmit[] = [];
  /**
   * Instructions that FAILED the shared verification, with the verifier's
   * bounded reason — a minter the real receiver would refuse shows up here.
   */
  verifyFailures: { reason: string; body: Buffer }[] = [];
  answer: ReceiverAnswer = {};
  #server: Server | null = null;
  #sockets = new Set<import("node:net").Socket>();
  readonly #key: Uint8Array;
  readonly #serverId: string;

  constructor(opts: { rootBase64: string; serverId?: string }) {
    this.#key = deriveJobsInstructionKey(opts.rootBase64, "edgeToJobs");
    this.#serverId = opts.serverId ?? "jobs";
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        void this.#serve(req, res, body);
      });
    });
    this.#server.on("connection", (socket) => {
      this.#sockets.add(socket);
      socket.on("close", () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async #serve(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const presented = req.headers["idempotency-key"];
    const presentedRetryKey =
      typeof presented === "string" && presented.length > 0 ? presented : null;
    const verdict = await verifyJobsInstruction(
      typeof req.headers["x-helix-instruction"] === "string"
        ? req.headers["x-helix-instruction"]
        : "",
      this.#key,
      {
        server: this.#serverId,
        operation: "submit",
        method: "POST",
        resource: buildJobsInternalResource("submit"),
        body: new Uint8Array(body),
        idempotencyKeyHeader: presentedRetryKey,
      },
      Math.floor(Date.now() / 1_000),
    );
    if (!verdict.ok || verdict.claims.operation !== "submit") {
      this.verifyFailures.push({
        reason: verdict.ok ? "wrong-operation" : verdict.reason,
        body,
      });
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          code: "unauthorized",
          message: "The internal request is not authenticated.",
        }),
      );
      return;
    }
    this.calls.push({
      claims: verdict.claims,
      jti: verdict.jti,
      presentedRetryKey,
      body,
    });

    const a = this.answer;
    if (a.refuse) {
      res.destroy();
      return;
    }
    const answer = (): void => {
      res.writeHead(a.status ?? 202, { "content-type": a.contentType ?? "application/json" });
      if (a.dripEveryMs && a.dripEveryMs > 0) {
        const timer = setInterval(() => res.write("x"), a.dripEveryMs);
        timer.unref();
        res.on("close", () => clearInterval(timer));
        return;
      }
      res.end(
        a.body ?? JSON.stringify({ server: this.#serverId, jobId: "job-123", status: "queued" }),
      );
    };
    if (a.delayMs && a.delayMs > 0) {
      const t = setTimeout(answer, a.delayMs);
      // A client-side abort must not keep the test alive past teardown.
      t.unref();
    } else {
      answer();
    }
  }

  async stop(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }
}
