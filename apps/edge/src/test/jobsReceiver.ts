import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildJobsInternalResource,
  deriveJobsInstructionKey,
  verifyJobsInstruction,
  type JobsInstructionClaims,
  type JobsSubmitClaims,
} from "@azx-pbc/shared/jobsSigning";

/**
 * A stand-in jobs receiver for the edge suites: a real HTTP server on a
 * loopback port that authenticates every presented instruction through
 * the SHARED verifier — the exact check the real receiver's seam runs, with
 * the operation/method/resource derived from the route the presentation
 * ARRIVED on (never from the token) — before capturing it, so a forward whose
 * token would be refused by `helix-jobs` fails here instead of passing
 * quietly. What it answers is on cue; a verification failure answers the real
 * receiver's own 401.
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

/** One captured, instruction-verified poll, result read or cancellation. */
export interface CapturedJobsRecord {
  /** The operation the ARRIVAL's method+path named (never read from the token). */
  operation: "snapshot" | "result" | "cancel";
  claims: JobsInstructionClaims;
  jti: string;
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
  /**
   * Send the headers, write only this many bytes of `body`, then destroy the
   * socket — a receiver that dies mid-body, after its answer began.
   */
  truncateAfterBytes?: number;
  /**
   * Send the headers and this much of `body` at once, then end the response
   * after the delay WITHOUT the promised remainder — a premature close the
   * client sees only after its answer began (headers delivered, body short).
   */
  prematureEndAfterMs?: number;
}

/** The operation matrix this stand-in serves, matched against the arrival. */
const RECORD_ROUTES = [
  { method: "GET", pattern: /^\/internal\/jobs\/v1\/jobs\/([^/]+)\/result$/, operation: "result" },
  { method: "GET", pattern: /^\/internal\/jobs\/v1\/jobs\/([^/]+)$/, operation: "snapshot" },
  { method: "DELETE", pattern: /^\/internal\/jobs\/v1\/jobs\/([^/]+)$/, operation: "cancel" },
] as const;

export class FakeJobsServiceReceiver {
  /** Submissions whose instruction verified — the receivers' accepted path. */
  calls: CapturedJobsSubmit[] = [];
  /** Record operations whose instruction verified. */
  recordCalls: CapturedJobsRecord[] = [];
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

  /** The operation an arrival's method+path names, with its exact resource. */
  #routeOf(
    method: string | undefined,
    url: string,
  ):
    | { operation: "submit"; resource: string }
    | { operation: "snapshot" | "result" | "cancel"; resource: string }
    | null {
    const path = url.split("?")[0] ?? "";
    if (method === "POST" && path === "/internal/jobs/v1/jobs") {
      return { operation: "submit", resource: buildJobsInternalResource("submit") };
    }
    for (const route of RECORD_ROUTES) {
      if (method !== route.method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      const jobId = match[1] ?? "";
      try {
        return {
          operation: route.operation,
          resource: buildJobsInternalResource(route.operation, { jobId }),
        };
      } catch {
        // A path segment that is not a job id names no resource the matrix
        // binds — the stock 404, never a thrown defect in the stand-in.
        return null;
      }
    }
    return null;
  }

  async #serve(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    body: Buffer,
  ): Promise<void> {
    const route = this.#routeOf(req.method, req.url ?? "/");
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "no such route", error: "Not Found", statusCode: 404 }));
      return;
    }
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
        operation: route.operation,
        method: req.method ?? "",
        resource: route.resource,
        body: new Uint8Array(body),
        ...(route.operation === "submit" ? { idempotencyKeyHeader: presentedRetryKey } : {}),
      },
      Math.floor(Date.now() / 1_000),
    );
    if (!verdict.ok || verdict.claims.operation !== route.operation) {
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
    if (route.operation === "submit") {
      // The claims narrowed at the seam: the verifier parsed them with the
      // operation's own claim schema, so a submit arrival carries submit
      // claims (the same guard the real receiver's dispatch holds).
      this.calls.push({
        claims: verdict.claims as JobsSubmitClaims,
        jti: verdict.jti,
        presentedRetryKey,
        body,
      });
    } else {
      this.recordCalls.push({
        operation: route.operation,
        claims: verdict.claims,
        jti: verdict.jti,
        body,
      });
    }

    const a = this.answer;
    if (a.refuse) {
      res.destroy();
      return;
    }
    const answer = (): void => {
      res.writeHead(
        a.status ?? 202,
        a.prematureEndAfterMs != null
          ? // The content-length promises the WHOLE body: the early end below
            // leaves a shortfall the client can detect, not a short answer.
            {
              "content-type": a.contentType ?? "application/json",
              "content-length": String((a.body ?? "").length),
            }
          : { "content-type": a.contentType ?? "application/json" },
      );
      if (a.prematureEndAfterMs != null) {
        // The content-length promises the WHOLE body; only the prefix (or
        // nothing) is written, and the response ends early — a shortfall the
        // client can detect, not a short answer.
        res.write((a.body ?? "").slice(0, a.truncateAfterBytes ?? (a.body ?? "").length));
        const t = setTimeout(() => res.end(), a.prematureEndAfterMs);
        t.unref();
        return;
      }
      if (a.truncateAfterBytes != null) {
        res.write((a.body ?? "").slice(0, a.truncateAfterBytes));
        // Destroyed, never ended: the promised body never completes, so the
        // client's answer began but cannot finish.
        res.destroy();
        return;
      }
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
