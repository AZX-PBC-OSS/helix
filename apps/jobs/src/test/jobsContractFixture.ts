import { randomBytes } from "node:crypto";
import * as http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import {
  IDEMPOTENCY_KEY_HEADER,
  INSTRUCTION_HEADER,
  JOB_TERMINAL_STATUSES,
  JOBS_SERVICE_NAME,
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobSnapshotSchema,
  JobsLifecycleUpdateAckSchema,
  JobsLifecycleUpdateSchema,
  isValidJobsServerId,
  jobError,
  jobRequestError,
  type JobStatus,
  type JobsLifecycleUpdate,
} from "@azx-pbc/shared";
import {
  buildJobsInternalResource,
  deriveJobsInstructionKey,
  sha256BodyDigest,
  verifyJobsInstruction,
  type JobsInstructionClaims,
  type JobsOperationName,
} from "@azx-pbc/shared/jobsSigning";

/**
 * An in-memory, independent implementation of the jobs wire/signing contract
 * (`@azx-pbc/shared` + `@azx-pbc/shared/jobsSigning`) — one loopback HTTP
 * server per named server, used to prove multi-server routing and isolation
 * through the real edge and portal processes. This is contract testing, not a
 * second production runner: the fixture verifies the same signed instructions
 * the real receiver does, keeps every record in memory, installs one
 * synthetic type `<server>:echo` that no catalogue advertises, and records
 * every exchange so a suite can assert exactly what arrived and how it was
 * answered.
 */

export const FIXTURE_LOCAL_TYPE = "echo";

/** Three independently generated 32-byte roots, canonical base64 — one per signing direction. */
export interface FixtureRoots {
  edgeToJobs: string;
  jobsToEdge: string;
  portalToJobs: string;
}

export interface FixtureExchange {
  operation: "submit" | "snapshot" | "result" | "cancel" | "lifecycle" | "unrouted";
  method: string;
  /** `req.url` as received — path plus any query. */
  path: string;
  /** The instruction header as received, when it is a single non-empty string. */
  instruction: string | null;
  /** The exact request body bytes (empty when the body blew the size cap). */
  body: Buffer;
  /** The instruction verified for THIS server. */
  verified: boolean;
  /** The verifier's reason, or a request-level class (`missing`, `replayed`, `resource`, `unrouted`, `payload_too_large`) when not verified. */
  rejectReason: string | null;
  claims: JobsInstructionClaims | null;
  /** The status this fixture answered. */
  status: number;
}

export interface FixtureJob {
  jobId: string;
  /** Qualified: `${server}:echo`. */
  type: string;
  appId: string;
  env: "prod" | "dev";
  ownerKind: "user" | "dev";
  ownerOid: string;
  generation: string;
  idempotencyKey: string | null;
  /** SHA-256 hex digest of the submitted input bytes. */
  bodySha256: string;
  status: JobStatus;
  cancellationRequested: boolean;
  /** The result `complete()` stored; meaningful once the status is `succeeded`. */
  result: unknown;
}

export interface JobsContractFixture {
  readonly server: string;
  readonly roots: FixtureRoots;
  /** `http://127.0.0.1:<port>` — valid only after the first start(). */
  readonly endpoint: string;
  /** Every exchange this fixture answered, in arrival order (including refusals). */
  readonly exchanges: FixtureExchange[];
  /** The applied lifecycle per appId: highest applied generation + archived flag. */
  readonly lifecycle: ReadonlyMap<string, { generation: string; archived: boolean }>;
  /** Intake posture: false ⇒ a NEW submission answers 503 jobs_disabled (retained-key replay still works). Default true. */
  accepting: boolean;
  /** Queue explicit job ids for the next accepted submissions (FIFO); otherwise ids are `job-1`, `job-2`, … per fixture. */
  queueJobIds(...ids: string[]): void;
  job(jobId: string): FixtureJob | undefined;
  jobs(): FixtureJob[];
  /** Mark a job succeeded with this JSON result (throws if unknown). */
  complete(jobId: string, result: unknown): void;
  /** The cleanup barrier: physically remove every record and retry key; returns how many records were removed. */
  purge(): number;
  /** Listen (first call picks a free port; later calls re-listen on the same port). */
  start(): Promise<void>;
  /** Outage: stop listening and destroy open connections, KEEPING all in-memory state. Idempotent. */
  stop(): Promise<void>;
  readonly listening: boolean;
}

const MAX_REQUEST_BODY_BYTES = 70_000;
const EMPTY_BODY = Buffer.alloc(0);

/** The request URL's path half — everything before the first `?` or `#`. */
function requestPathname(rawPath: string): string {
  const query = rawPath.indexOf("?");
  const fragment = rawPath.indexOf("#");
  const cut = query === -1 ? fragment : fragment === -1 ? query : Math.min(query, fragment);
  return cut === -1 ? rawPath : rawPath.slice(0, cut);
}

/** The operations this fixture serves — the signed matrix minus the fetch callback, whose receiver is the edge. */
type FixtureOperation = Exclude<JobsOperationName, "fetch">;

type FixtureRouteParam = { readonly jobId?: string; readonly appId?: string };
type FixtureRoute =
  | { readonly operation: FixtureOperation; readonly param: FixtureRouteParam }
  | { readonly operation: "unrouted" };

/** Route matching over the exact internal paths of `JobsOperations`. */
function matchRoute(method: string, segments: readonly string[]): FixtureRoute {
  const at = (index: number): string | undefined => segments[index];
  const internal =
    segments.length >= 4 && at(0) === "internal" && at(1) === "jobs" && at(2) === "v1";
  if (internal && at(3) === "jobs") {
    if (method === "POST" && segments.length === 4) return { operation: "submit", param: {} };
    const param = at(4);
    if (param !== undefined && method === "GET" && segments.length === 6 && at(5) === "result") {
      return { operation: "result", param: { jobId: param } };
    }
    if (param !== undefined && segments.length === 5) {
      if (method === "GET") return { operation: "snapshot", param: { jobId: param } };
      if (method === "DELETE") return { operation: "cancel", param: { jobId: param } };
    }
  }
  if (internal && method === "POST" && segments.length === 5 && at(3) === "lifecycle") {
    const appId = at(4);
    if (appId !== undefined) return { operation: "lifecycle", param: { appId } };
  }
  return { operation: "unrouted" };
}

function isTerminal(status: JobStatus): boolean {
  return (JOB_TERMINAL_STATUSES as readonly JobStatus[]).includes(status);
}

class RequestBodyTooLarge extends Error {}

/** Read the exact request body bytes; rejects with `RequestBodyTooLarge` past the cap. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      total += chunk.length;
      if (total > MAX_REQUEST_BODY_BYTES) {
        over = true;
        reject(new RequestBodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on("error", () => {
      if (!over) reject(new Error("the request body failed to read"));
    });
  });
}

/** One answer an operation handler produced — recorded, then sent. */
interface OperationAnswer {
  status: number;
  body: unknown;
}

/** What an operation route hands the verifier, exactly as received. */
interface Presentation {
  method: string;
  rawPath: string;
  param: FixtureRouteParam;
  body: Buffer;
  instruction: string | null;
  idempotencyKeyHeader: string | null;
}

class JobsContractFixtureServer implements JobsContractFixture {
  readonly server: string;
  readonly roots: FixtureRoots;
  readonly exchanges: FixtureExchange[] = [];
  accepting = true;

  private readonly lifecycleState = new Map<string, { generation: string; archived: boolean }>();
  private readonly jobsById = new Map<string, FixtureJob>();
  private readonly retryKeys = new Map<string, string>();
  private readonly spentJti = new Set<string>();
  private readonly queuedIds: string[] = [];
  private jobCounter = 0;
  private httpServer: Server | null = null;
  private port: number | null = null;
  private readonly edgeKey: Uint8Array;
  private readonly portalKey: Uint8Array;

  constructor(server: string) {
    this.server = server;
    this.roots = {
      edgeToJobs: randomBytes(32).toString("base64"),
      jobsToEdge: randomBytes(32).toString("base64"),
      portalToJobs: randomBytes(32).toString("base64"),
    };
    this.edgeKey = deriveJobsInstructionKey(this.roots.edgeToJobs, "edgeToJobs");
    this.portalKey = deriveJobsInstructionKey(this.roots.portalToJobs, "portalToJobs");
  }

  get lifecycle(): ReadonlyMap<string, { generation: string; archived: boolean }> {
    return this.lifecycleState;
  }

  get listening(): boolean {
    return this.httpServer?.listening ?? false;
  }

  get endpoint(): string {
    if (this.port === null) {
      throw new Error(
        `the "${this.server}" fixture has never started — the endpoint is valid only after the first start()`,
      );
    }
    return `http://127.0.0.1:${this.port}`;
  }

  queueJobIds(...ids: string[]): void {
    this.queuedIds.push(...ids);
  }

  job(jobId: string): FixtureJob | undefined {
    return this.jobsById.get(jobId);
  }

  jobs(): FixtureJob[] {
    return [...this.jobsById.values()];
  }

  complete(jobId: string, result: unknown): void {
    const record = this.jobsById.get(jobId);
    if (record === undefined) {
      throw new Error(`complete: the "${this.server}" fixture holds no job "${jobId}"`);
    }
    record.status = "succeeded";
    record.result = result;
  }

  purge(): number {
    const removed = this.jobsById.size;
    this.jobsById.clear();
    this.retryKeys.clear();
    return removed;
  }

  async start(): Promise<void> {
    if (this.listening) return;
    if (this.httpServer === null) {
      this.httpServer = http.createServer((req, res) => {
        void this.handle(req, res);
      });
      // Listen failures reject start()'s promise below; a later runtime error
      // must never crash the test process.
      this.httpServer.on("error", () => {});
    }
    const server = this.httpServer;
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error): void => reject(error);
      server.once("error", fail);
      server.listen(this.port ?? 0, "127.0.0.1", () => {
        server.removeListener("error", fail);
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error(`the "${this.server}" fixture never bound a loopback port`);
    }
    this.port = address.port;
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    if (server === null || !server.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      await this.serve(req, res);
    } catch {
      // Never crash on a request: an unexpected failure answers the platform's
      // own retryable degradation.
      if (res.headersSent) res.destroy();
      else this.send(res, 503, jobRequestError("jobs_unavailable"));
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const rawPath = req.url ?? "/";
    const header = req.headers[INSTRUCTION_HEADER];
    const instruction = typeof header === "string" && header.length > 0 ? header : null;
    const retryHeader = req.headers[IDEMPOTENCY_KEY_HEADER];
    const idempotencyKeyHeader = typeof retryHeader === "string" ? retryHeader : null;

    let body: Buffer = EMPTY_BODY;
    let oversized = false;
    try {
      body = await readBody(req);
    } catch (error) {
      if (!(error instanceof RequestBodyTooLarge)) throw error;
      oversized = true;
    }

    const segments = requestPathname(rawPath)
      .split("/")
      .filter((segment) => segment !== "");

    // The edge's reachability probe reads this body — never recorded.
    if (method === "GET" && segments.length === 1 && segments[0] === "health") {
      if (oversized) this.send(res, 413, jobRequestError("payload_too_large"));
      else {
        this.send(res, 200, {
          status: "ok",
          service: JOBS_SERVICE_NAME,
          uptime: process.uptime(),
          checks: [],
        });
      }
      return;
    }

    const route = matchRoute(method, segments);
    if (oversized) {
      this.refuse(
        res,
        route,
        { method, rawPath, instruction },
        413,
        "payload_too_large",
        jobRequestError("payload_too_large"),
        EMPTY_BODY,
      );
      return;
    }
    if (route.operation === "unrouted") {
      this.refuse(
        res,
        route,
        { method, rawPath, instruction },
        404,
        "unrouted",
        jobRequestError("job_not_found"),
        body,
      );
      return;
    }

    const verdict = await this.authenticate(route.operation, {
      method,
      rawPath,
      param: route.param,
      body,
      instruction,
      idempotencyKeyHeader,
    });
    if (!verdict.ok) {
      this.refuse(
        res,
        route,
        { method, rawPath, instruction },
        401,
        verdict.reason,
        jobRequestError("unauthorized"),
        body,
      );
      return;
    }

    let answer: OperationAnswer;
    try {
      answer = this.apply(verdict.claims, route.param, body);
    } catch {
      answer = { status: 503, body: jobRequestError("jobs_unavailable") };
    }
    this.exchanges.push({
      operation: route.operation,
      method,
      path: rawPath,
      instruction,
      body,
      verified: true,
      rejectReason: null,
      claims: verdict.claims,
      status: answer.status,
    });
    this.send(res, answer.status, answer.body);
  }

  /** Record one refused exchange (not verified, or not routed) and answer it. */
  private refuse(
    res: ServerResponse,
    route: FixtureRoute,
    request: { method: string; rawPath: string; instruction: string | null },
    status: number,
    rejectReason: string,
    body: unknown,
    requestBytes: Buffer,
  ): void {
    this.exchanges.push({
      operation: route.operation,
      method: request.method,
      path: request.rawPath,
      instruction: request.instruction,
      body: requestBytes,
      verified: false,
      rejectReason,
      claims: null,
      status,
    });
    this.send(res, status, body);
  }

  /** The signed-instruction gate every operation route passes first. */
  private async authenticate(
    operation: FixtureOperation,
    request: Presentation,
  ): Promise<{ ok: true; claims: JobsInstructionClaims } | { ok: false; reason: string }> {
    if (request.instruction === null) return { ok: false, reason: "missing" };
    // A query or fragment makes the request a different resource than any
    // signed claim can name — refused, never stripped and compared.
    if (request.rawPath.includes("?") || request.rawPath.includes("#")) {
      return { ok: false, reason: "resource" };
    }
    let resource: string;
    try {
      resource = buildJobsInternalResource(operation, request.param);
    } catch {
      return { ok: false, reason: "resource" };
    }
    const verdict = await verifyJobsInstruction(
      request.instruction,
      operation === "lifecycle" ? this.portalKey : this.edgeKey,
      {
        server: this.server,
        operation,
        method: request.method,
        resource,
        body: request.body,
        ...(operation === "submit" ? { idempotencyKeyHeader: request.idempotencyKeyHeader } : {}),
      },
      Math.floor(Date.now() / 1_000),
    );
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    if (this.spentJti.has(verdict.jti)) return { ok: false, reason: "replayed" };
    // The burn precedes every side effect: a token is consumed by its first
    // valid presentation.
    this.spentJti.add(verdict.jti);
    return { ok: true, claims: verdict.claims };
  }

  private apply(
    claims: JobsInstructionClaims,
    param: FixtureRouteParam,
    body: Buffer,
  ): OperationAnswer {
    switch (claims.operation) {
      case "submit":
        return this.submit(claims, body);
      case "snapshot":
        return this.snapshot(claims, param);
      case "result":
        return this.result(claims, param);
      case "cancel":
        return this.cancel(claims, param);
      case "lifecycle":
        return this.lifecycleDelivery(claims, param, body);
      default:
        throw new Error("the fetch callback operation's receiver is the edge, never the fixture");
    }
  }

  private submit(
    claims: Extract<JobsInstructionClaims, { operation: "submit" }>,
    body: Buffer,
  ): OperationAnswer {
    const type = `${this.server}:${FIXTURE_LOCAL_TYPE}`;
    if (claims.type !== type || !claims.allowedTypes.includes(type)) {
      return { status: 403, body: jobRequestError("forbidden") };
    }
    const digest = sha256BodyDigest(body);
    let retryScope: string | null = null;
    if (claims.idempotencyKey !== null) {
      retryScope = [
        claims.appId,
        claims.env,
        claims.ownerKind,
        claims.ownerOid,
        claims.idempotencyKey,
      ].join("\u0000");
      const existingId = this.retryKeys.get(retryScope);
      const existing = existingId === undefined ? undefined : this.jobsById.get(existingId);
      if (existing !== undefined) {
        if (existing.bodySha256 === digest) {
          return {
            status: 202,
            body: JobAcceptedSchema.parse({
              server: this.server,
              jobId: existing.jobId,
              status: existing.status,
            }),
          };
        }
        return {
          status: 409,
          body: jobRequestError("idempotency_conflict", { status: existing.status, error: null }),
        };
      }
    }
    if (!this.accepting) return { status: 503, body: jobRequestError("jobs_disabled") };
    // A server admits an app's work only under a lifecycle generation the
    // portal has delivered to it: an app it has not been synchronized with, or
    // a newer generation than it has applied, waits (retryable 503) rather
    // than being opened by the edge's assertion; a closed generation never
    // reopens.
    const applied = this.lifecycleState.get(claims.appId);
    if (
      applied === undefined ||
      BigInt(claims.generation) > BigInt(applied.generation) ||
      (applied.archived && BigInt(claims.generation) <= BigInt(applied.generation))
    ) {
      return { status: 503, body: jobRequestError("jobs_unavailable") };
    }
    const record: FixtureJob = {
      jobId: this.takeJobId(),
      type,
      appId: claims.appId,
      env: claims.env,
      ownerKind: claims.ownerKind,
      ownerOid: claims.ownerOid,
      generation: claims.generation,
      idempotencyKey: claims.idempotencyKey,
      bodySha256: digest,
      status: "queued",
      cancellationRequested: false,
      result: undefined,
    };
    this.jobsById.set(record.jobId, record);
    if (retryScope !== null) this.retryKeys.set(retryScope, record.jobId);
    return {
      status: 202,
      body: JobAcceptedSchema.parse({
        server: this.server,
        jobId: record.jobId,
        status: "queued",
      }),
    };
  }

  private snapshot(
    claims: Extract<JobsInstructionClaims, { operation: "snapshot" }>,
    param: FixtureRouteParam,
  ): OperationAnswer {
    const record = this.findOwnedJob(claims, param.jobId);
    if (record === undefined) return { status: 404, body: jobRequestError("job_not_found") };
    if (!claims.allowedTypes.includes(record.type)) {
      return { status: 403, body: jobRequestError("forbidden") };
    }
    return {
      status: 200,
      body: JobSnapshotSchema.parse({
        server: this.server,
        jobId: record.jobId,
        type: record.type,
        status: record.status,
        attempt: null,
        progress: null,
        cancellationRequested: record.cancellationRequested,
        resultExpiresAt: null,
        recordExpiresAt: null,
        error: record.status === "cancelled" ? jobError("cancelled") : null,
      }),
    };
  }

  private result(
    claims: Extract<JobsInstructionClaims, { operation: "result" }>,
    param: FixtureRouteParam,
  ): OperationAnswer {
    const record = this.findOwnedJob(claims, param.jobId);
    if (record === undefined) return { status: 404, body: jobRequestError("job_not_found") };
    if (!claims.allowedTypes.includes(record.type)) {
      return { status: 403, body: jobRequestError("forbidden") };
    }
    if (record.status === "succeeded") return { status: 200, body: record.result };
    return {
      status: 409,
      body: jobRequestError(isTerminal(record.status) ? "job_terminal" : "job_not_ready", {
        status: record.status,
        error: record.status === "cancelled" ? jobError("cancelled") : null,
      }),
    };
  }

  private cancel(
    claims: Extract<JobsInstructionClaims, { operation: "cancel" }>,
    param: FixtureRouteParam,
  ): OperationAnswer {
    const record = this.findOwnedJob(claims, param.jobId);
    if (record === undefined) return { status: 404, body: jobRequestError("job_not_found") };
    if (!claims.allowedTypes.includes(record.type)) {
      return { status: 403, body: jobRequestError("forbidden") };
    }
    if (isTerminal(record.status)) {
      return {
        status: 409,
        body: jobRequestError("job_terminal", {
          status: record.status,
          error: record.status === "cancelled" ? jobError("cancelled") : null,
        }),
      };
    }
    record.cancellationRequested = true;
    record.status = "cancelled";
    return {
      status: 202,
      body: JobCancellationAcceptedSchema.parse({
        server: this.server,
        jobId: record.jobId,
        cancellationRequested: true,
      }),
    };
  }

  private lifecycleDelivery(
    claims: Extract<JobsInstructionClaims, { operation: "lifecycle" }>,
    param: FixtureRouteParam,
    body: Buffer,
  ): OperationAnswer {
    const appId = param.appId;
    if (appId === undefined) {
      throw new Error("the lifecycle route matched without an app id");
    }
    let update: JobsLifecycleUpdate;
    try {
      update = JobsLifecycleUpdateSchema.parse(JSON.parse(body.toString("utf8")));
    } catch {
      return { status: 400, body: jobRequestError("payload_invalid") };
    }
    const previous = this.lifecycleState.get(appId);
    if (previous === undefined || BigInt(update.generation) >= BigInt(previous.generation)) {
      this.lifecycleState.set(appId, { generation: update.generation, archived: update.archived });
      for (const record of this.jobsById.values()) {
        if (record.appId !== appId || isTerminal(record.status)) continue;
        // An archive closes everything unfinished; an unarchive into a new
        // generation cancels only the work admitted under an older one.
        if (update.archived || BigInt(record.generation) < BigInt(update.generation)) {
          record.cancellationRequested = true;
          record.status = "cancelled";
        }
      }
    }
    return {
      status: 200,
      body: JobsLifecycleUpdateAckSchema.parse({
        // A replayed older delivery acknowledges the highest applied generation.
        appliedGeneration: this.lifecycleState.get(appId)?.generation ?? update.generation,
      }),
    };
  }

  /** The record an operation on an existing job addresses — the owner must match the claims exactly. */
  private findOwnedJob(
    claims: Extract<JobsInstructionClaims, { operation: "snapshot" | "result" | "cancel" }>,
    jobId: string | undefined,
  ): FixtureJob | undefined {
    const record = jobId === undefined ? undefined : this.jobsById.get(jobId);
    if (record === undefined) return undefined;
    if (
      record.appId !== claims.appId ||
      record.env !== claims.env ||
      record.ownerKind !== claims.ownerKind ||
      record.ownerOid !== claims.ownerOid
    ) {
      return undefined;
    }
    return record;
  }

  private takeJobId(): string {
    const queued = this.queuedIds.shift();
    if (queued !== undefined) return queued;
    this.jobCounter += 1;
    return `job-${this.jobCounter}`;
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body) ?? "null");
  }
}

export function createJobsContractFixture(server: string): JobsContractFixture {
  if (!isValidJobsServerId(server)) {
    throw new Error(`createJobsContractFixture: "${server}" is not a valid jobs server id`);
  }
  return new JobsContractFixtureServer(server);
}
