import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import * as http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import * as https from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { Client as PgClient } from "pg";
import {
  AppSchema,
  isValidJobsServerId,
  type App,
  HealthStatusSchema,
  type HealthStatus,
} from "@azx-pbc/shared";
import { buildJobsInternalResource } from "@azx-pbc/shared/jobsSigning";

import { runAuthCodeFlow } from "../../../dev-idp/src/testing.js";
import { WEB_CLIENT_ID } from "../../../dev-idp/src/fixtures.js";
import { createJobsContractFixture, type JobsContractFixture } from "./jobsContractFixture.js";

/**
 * The real-stack journey harness: boots the whole Helix platform from its
 * NORMAL service entry points as child processes, against freshly provisioned
 * and migrated databases under the real runtime roles, and hands out clients
 * that speak to it the way real callers do — raw exact-header requests, real
 * dev-IdP logins, and a controlled JSON origin for outbound fetch work.
 *
 * DNS: the children resolve the stack's normal hostnames
 * (`*.local.helix.azxlabs.io`), which resolve publicly to 127.0.0.1. The test
 * process itself never depends on that resolution — every request it makes
 * forces the connection to 127.0.0.1 (`lookup`), presents the request host as
 * the TLS `servername`, and trusts only the harness's freshly minted
 * self-signed certificate.
 *
 * A failure to boot is a failure, never a skip: a missing ambient variable
 * throws naming the key, and any readiness timeout throws with the last
 * observation and the service's log tail. Each stack claims a port offset
 * whose ports are all free at boot, so several can run side by side.
 */

export type StackServiceName = "idp" | "portal" | "egress" | "jobs" | "edge" | "devGateway";

export interface HttpReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json(): unknown;
}

export interface RealStack {
  readonly suffix: string;
  readonly baseDomain: string;
  readonly ports: Record<string, number>;
  readonly portalUrl: string;
  readonly devGatewayOrigin: string;
  readonly logDir: string;
  /** Owner DSN of this stack's platform database (helix role) — for teardown and for tests that must read a durable fact no route exposes; tests should prefer routes. */
  readonly platformOwnerDsn: string;
  /** Owner DSN of this stack's jobs database (helix role) — for tests that must read (or, to stand in for an older platform version, rewrite) a durable fact no route exposes; tests should prefer routes. */
  readonly jobsOwnerDsn: string;
  /** The faultable edge→jobs relay, when the stack was started with `jobsLink: true`; otherwise null. */
  readonly jobsLink: JobsLink | null;
  /** The contract fixture servers, by id, when started with `jobsFixtures`; otherwise empty. */
  readonly jobsFixtures: Readonly<Record<string, JobsContractFixture>>;
  /**
   * Rewrite the three jobs documents for the services' NEXT start: each listed
   * fixture with its state; a fixture left out is removed from every document
   * (the operator's removal after the retirement barrier). Running services are
   * untouched — restart the ones that must read it.
   */
  configureJobsFixtures(states: Readonly<Record<string, "serving" | "retiring">>): void;
  appOrigin(slug: string): string;
  /** Raw HTTPS/HTTP request with exact headers (no implicit Sec-Fetch-*); `signal` aborts the request. */
  request(
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string | Buffer;
      signal?: AbortSignal;
    },
  ): Promise<HttpReply>;
  /** Portal API as a real dev-IdP user (authorization-code + PKCE through the real IdP). */
  portalAs(email: string): Promise<PortalClient>;
  /** Portal API as the PORTAL_DEV_TOKEN actor (CI/dev fallback principal). */
  portalAsDevToken(): PortalClient;
  /** Real end-user login on an app host through the edge + dev IdP. */
  appSession(slug: string, email: string): Promise<AppSession>;
  /** Dev-gateway client for a minted dev token presented from `origin`. */
  devClient(slug: string, token: string, origin: string): DevClient;
  /** Stop / start / restart one service by name (same env, same entry point). */
  stop(name: StackServiceName): Promise<void>;
  start(name: StackServiceName): Promise<void>;
  restart(name: StackServiceName): Promise<void>;
  /** SIGKILLs a running service (no grace, no drain): models a process dying mid-request — in-flight requests get no reply. Restart it with start(). No-op if not running. */
  crash(name: StackServiceName): Promise<void>;
  logTail(name: StackServiceName, lines?: number): string;
  close(): Promise<void>;
}

export interface PortalClient {
  readonly bearer: string;
  get(path: string): Promise<HttpReply>;
  post(path: string, body?: unknown): Promise<HttpReply>;
  put(path: string, body: unknown): Promise<HttpReply>;
  delete(path: string): Promise<HttpReply>;
  /** multipart/form-data upload of a zip as field `bundle` (POST /api/v1/apps/:slug/versions). */
  uploadBundle(slug: string, zip: Buffer): Promise<HttpReply>;
}

export interface AppSession {
  readonly slug: string;
  /** `__Host-session=<value>` — the edge's session cookie for this app host. */
  readonly cookie: string;
  /** Navigation: GET with Sec-Fetch-Mode: navigate, Sec-Fetch-Dest: document, Accept: text/html. */
  navigate(path?: string): Promise<HttpReply>;
  /** Same-origin script request from the served page: sends Cookie, Origin: appOrigin, Sec-Fetch-Site: same-origin, Sec-Fetch-Mode: cors, SecFetch-Dest: empty; `signal` aborts the request. */
  api(
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<HttpReply>;
}

export interface DevClient {
  /** `${devGatewayOrigin}/${slug}${path}` with Authorization: Bearer <token> and Origin: <origin>. */
  api(
    method: string,
    path: string,
    init?: { headers?: Record<string, string>; body?: string },
  ): Promise<HttpReply>;
}

export interface ControlledJsonOrigin {
  readonly origin: string;
  readonly requests: Array<{
    method: string;
    path: string;
    headers: Record<string, string | string[] | undefined>;
    at: number;
  }>;
  /** Next request(s) to `path` answer with this. Default for unknown paths: 404 JSON. */
  respond(
    path: string,
    reply: { status?: number; json?: unknown; rawBody?: string; contentType?: string },
  ): void;
  /** Hold responses to `path` until the returned release() is called (bounded by the caller). Resolves `arrived` when the first request is in. */
  hold(path: string): { arrived: Promise<void>; release(): void };
  close(): Promise<void>;
}

// ── composition constants ────────────────────────────────────────────────────

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
/**
 * Offsets the harness may claim: 5000, 5100, … 8900. Each candidate's ports
 * come from scripts/stack-env.mjs (which also refuses fetch-blocked ports);
 * the first candidate whose every port is free wins, so suites in parallel
 * vitest workers each get their own stack.
 */
const OFFSET_CANDIDATES = Array.from({ length: 40 }, (_, i) => 5000 + i * 100);
const BOOT_LISTENER_TIMEOUT_MS = 90_000;
const READY_TIMEOUT_MS = 90_000;
const REQUEST_SOCKET_TIMEOUT_MS = 120_000;
const STOP_GRACE_MS = 10_000;
const MAX_LOGIN_HOPS = 20;
const POLL_INTERVAL_MS = 500;

const REQUIRED_AMBIENT_KEYS = [
  "DATABASE_URL",
  "PORTAL_DATABASE_URL",
  "EDGE_DATABASE_URL",
  "EDGE_DEV_DATABASE_URL",
  "EGRESS_DATABASE_URL",
  "AZURE_STORAGE_CONNECTION_STRING",
  "EDGE_OIDC_CLIENT_ID",
  "EDGE_OIDC_CLIENT_SECRET",
  "EDGE_AUTH_SECRET",
  "HELIX_INSTRUCTION_SECRET",
  "HELIX_INTERNAL_SECRET",
  "HELIX_EXCHANGE_SECRET",
  "PORTAL_OIDC_AUDIENCE",
  "PORTAL_DEV_TOKEN",
  "PORTAL_ADMIN_GROUP_ID",
] as const;

const SCRUBBED_KEY_PREFIXES = ["JOBS_", "HELIX_JOBS_", "OTEL_", "EDGE_TLS_"];
const SCRUBBED_KEYS = new Set([
  "EDGE_JOBS_CONFIG",
  "PORTAL_JOBS_CONFIG",
  "PORTAL_JOBS_CATALOGUE",
  "HELIX_STACK_ENV",
  "HELIX_PORT_OFFSET",
  "HELIX_STACK_SUFFIX",
  "NODE_EXTRA_CA_CERTS",
  "PORT",
  "HOST",
  "NODE_ENV",
  "PORTAL_ALLOW_SELF_APPROVE",
]);

const SERVICE_NAMES = ["idp", "portal", "egress", "jobs", "edge", "devGateway"] as const;

interface ServiceSpec {
  cwd: string;
  entry: string;
}

const SERVICE_SPECS: Record<StackServiceName, ServiceSpec> = {
  idp: { cwd: "apps/dev-idp", entry: "src/server.ts" },
  portal: { cwd: "apps/portal", entry: "src/server.ts" },
  egress: { cwd: "apps/egress", entry: "src/server.ts" },
  jobs: { cwd: "apps/jobs", entry: "src/server.ts" },
  edge: { cwd: "apps/edge", entry: "src/server.ts" },
  devGateway: { cwd: "apps/edge", entry: "src/devGateway/server.ts" },
};

// ── small helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The query values whose presence in an error would leak a live credential. */
const REDACTED_PARAMS = new Set(["code", "token", "state"]);

function redactUrlForError(url: string): string {
  try {
    const u = new URL(url);
    for (const name of REDACTED_PARAMS) {
      if (u.searchParams.has(name)) u.searchParams.set(name, "<redacted>");
    }
    return u.toString();
  } catch {
    return "<unparsable-url>";
  }
}

function headerLocation(res: HttpReply): string | null {
  const loc = res.headers["location"];
  const value = Array.isArray(loc) ? loc[0] : loc;
  return value ?? null;
}

/** stdout/stderr of one service, kept as lines under a fixed bound. */
class BoundedLog {
  private readonly lines: string[] = [];
  private carry = "";

  append(chunk: string): void {
    const parts = (this.carry + chunk).split("\n");
    this.carry = parts.pop() ?? "";
    this.lines.push(...parts);
    if (this.lines.length > 400) this.lines.splice(0, this.lines.length - 400);
  }

  tail(lines: number): string {
    return this.lines.slice(-lines).join("\n");
  }
}

interface ServiceState {
  spec: ServiceSpec;
  child: ChildProcess | null;
  fd: number | null;
  ring: BoundedLog;
  logPath: string;
}

interface StackInternals {
  serviceEnv: NodeJS.ProcessEnv;
  logDir: string;
  services: Map<StackServiceName, ServiceState>;
  ports: Record<string, number>;
  baseDomain: string;
  portalUrl: string;
  devGatewayOrigin: string;
  platformOwnerDsn: string;
  jobsOwnerDsn: string;
  databaseNames: string[];
  jobsLink: JobsLink | null;
  jobsFixtures: ReadonlyMap<string, JobsContractFixture>;
  tlsCa: Buffer;
  tlsDir: string;
  request(url: string, init?: RawRequestInit): Promise<HttpReply>;
  closed: boolean;
}

interface RawRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  signal?: AbortSignal;
}

// ── raw HTTP with exact headers ──────────────────────────────────────────────

/**
 * A raw request, the way node:https sends it: exactly the headers given (no
 * implicit `Sec-Fetch-*`, which the edge's gate treats as authoritative),
 * forced onto 127.0.0.1, and — for HTTPS — trusting only the harness's own
 * minted certificate. Redirects are never followed; callers walk them by hand
 * so cookies accumulate per host.
 */
function rawRequest(tlsCa: Buffer, url: string, init: RawRequestInit = {}): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      reject(new Error(`realStack request: not a parseable URL: ${redactUrlForError(url)}`));
      return;
    }
    const secure = u.protocol === "https:";
    if (!secure && u.protocol !== "http:") {
      reject(new Error(`realStack request: unsupported protocol ${u.protocol}`));
      return;
    }
    const options: https.RequestOptions = {
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      // The test process never depends on DNS: every hop lands on loopback.
      // Node 24's lookup callback carries the autoSelectFamily record array.
      lookup(_hostname, _options, callback) {
        callback(null, [{ address: "127.0.0.1", family: 4 }]);
      },
      // Bounded: a request that never answers is an error, never a hang.
      timeout: REQUEST_SOCKET_TIMEOUT_MS,
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
      ...(secure ? { servername: u.hostname, ca: tlsCa } : {}),
    };
    const onResponse = (res: IncomingMessage): void => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const reply: HttpReply = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
          json() {
            return JSON.parse(reply.text);
          },
        };
        resolve(reply);
      });
    };
    const req = secure ? https.request(options, onResponse) : http.request(options, onResponse);
    req.on("timeout", () => {
      req.destroy(
        new Error(
          `realStack request to ${redactUrlForError(url)} exceeded ${REQUEST_SOCKET_TIMEOUT_MS}ms`,
        ),
      );
    });
    req.on("error", reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

// ── cookie jar (host-scoped, like a browser's host-only cookies) ─────────────

class CookieJar {
  private readonly jars = new Map<string, Map<string, string>>();

  headerFor(host: string): string | undefined {
    const jar = this.jars.get(host);
    if (!jar || jar.size === 0) return undefined;
    return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  store(host: string, setCookie: string | string[] | undefined): void {
    if (!setCookie) return;
    const jar = this.jars.get(host) ?? new Map<string, string>();
    for (const line of Array.isArray(setCookie) ? setCookie : [setCookie]) {
      const pair = line.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    }
    this.jars.set(host, jar);
  }

  get(host: string, name: string): string | undefined {
    return this.jars.get(host)?.get(name);
  }
}

// ── scripts/ helpers (the composition source, run the way a shell does) ──────

function runStackEnvScript(
  offset: number,
  suffix: string,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const res = spawnSync(
    process.execPath,
    [
      path.join(ROOT_DIR, "scripts", "stack-env.mjs"),
      "--env",
      "--offset",
      String(offset),
      "--suffix",
      suffix,
    ],
    { encoding: "utf8", env, timeout: 60_000 },
  );
  if (res.error !== undefined) {
    throw new Error(`realStack: could not run scripts/stack-env.mjs: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `realStack: scripts/stack-env.mjs refused the resolution (exit ${res.status}): ` +
        `${(res.stderr || res.stdout || "").slice(-2_000)}`,
    );
  }
  const parsed: Record<string, string> = {};
  for (const line of res.stdout.split("\n")) {
    if (!line) continue;
    const eq = line.indexOf("=");
    parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

function runEnsureDbScript(ownerDsn: string, jobsDsn: string): void {
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT_DIR, "scripts", "ensure-db.mjs"), ownerDsn, jobsDsn],
    { encoding: "utf8", cwd: ROOT_DIR, timeout: 300_000 },
  );
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(
      `realStack: scripts/ensure-db.mjs failed (exit ${res.status}):\n` +
        `${(res.stderr || res.stdout || "").slice(-4_000)}`,
    );
  }
}

function stackPorts(offset: number, env: NodeJS.ProcessEnv): number[] | null {
  const res = spawnSync(
    process.execPath,
    [path.join(ROOT_DIR, "scripts", "stack-env.mjs"), "--ports", "--offset", String(offset)],
    { encoding: "utf8", env, timeout: 60_000 },
  );
  // A refused candidate (a fetch-blocked port) is skipped, not fatal.
  if (res.status !== 0) return null;
  // Deduplicated: two services the harness never runs together share a number.
  return [...new Set(res.stdout.trim().split(/\s+/).map(Number))];
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

/**
 * The first candidate offset whose every port is free. Never frees a port:
 * a listener there may be another suite's live stack or a developer's
 * server. The order starts at a random candidate so parallel suites rarely
 * probe the same one; a lost race fails that suite's boot with the
 * listener's own error rather than corrupting another stack.
 */
async function claimFreeOffset(env: NodeJS.ProcessEnv): Promise<number> {
  const start = (randomBytes(1)[0] ?? 0) % OFFSET_CANDIDATES.length;
  for (let i = 0; i < OFFSET_CANDIDATES.length; i++) {
    const offset = OFFSET_CANDIDATES[(start + i) % OFFSET_CANDIDATES.length];
    if (offset === undefined) continue;
    const ports = stackPorts(offset, env);
    if (ports === null) continue;
    const free = await Promise.all(ports.map(portIsFree));
    if (free.every(Boolean)) return offset;
  }
  throw new Error(
    `realStack: no candidate port offset (${OFFSET_CANDIDATES[0]}–${OFFSET_CANDIDATES.at(-1)}) has all of its ports free`,
  );
}

function mintTlsCert(baseDomain: string): { dir: string; certFile: string; keyFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "helix-realstack-tls-"));
  const certFile = path.join(dir, "cert.pem");
  const keyFile = path.join(dir, "key.pem");
  const gen = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "2",
      "-keyout",
      keyFile,
      "-out",
      certFile,
      "-subj",
      `/CN=${baseDomain}`,
      "-addext",
      `subjectAltName=DNS:${baseDomain},DNS:*.${baseDomain}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { encoding: "utf8" },
  );
  if (gen.status !== 0 || !existsSync(certFile)) {
    throw new Error(
      `realStack: openssl could not mint the harness certificate: ` +
        `${(gen.stderr || gen.stdout || "").slice(-1_000)}`,
    );
  }
  return { dir, certFile, keyFile };
}

// ── service lifecycle ────────────────────────────────────────────────────────

/** A child killed BY A SIGNAL keeps `exitCode` null forever (`signalCode` carries the signal) — every exited test must ask both. */
function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function spawnService(stack: StackInternals, name: StackServiceName): ChildProcess {
  const state = stack.services.get(name);
  if (!state) throw new Error(`realStack: no such service: ${name}`);
  if (state.child !== null && !hasExited(state.child)) {
    throw new Error(`realStack: ${name} is already running`);
  }
  const child = spawn("node", ["--import", "tsx", state.spec.entry], {
    cwd: path.join(ROOT_DIR, state.spec.cwd),
    env: stack.serviceEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  const fd = openSync(state.logPath, "a");
  state.fd = fd;
  const onData = (chunk: Buffer): void => {
    try {
      writeSync(fd, chunk);
    } catch {
      // The log file's own failure must not kill the child's output pump.
    }
    state.ring.append(chunk.toString());
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.once("error", (err) => {
    state.ring.append(`[harness] spawn error: ${err.message}\n`);
  });
  child.once("exit", () => {
    try {
      closeSync(fd);
    } catch {
      // Already closed by a previous exit handler.
    }
    if (state.child === child) state.child = null;
    if (state.fd === fd) state.fd = null;
  });
  return child;
}

/** SIGTERM, then SIGKILL after a bound — teardown never waits forever. */
async function stopService(stack: StackInternals, name: StackServiceName): Promise<void> {
  const state = stack.services.get(name);
  if (!state) throw new Error(`realStack: no such service: ${name}`);
  const child = state.child;
  if (!child || hasExited(child)) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", resolve)),
    sleep(STOP_GRACE_MS),
  ]);
  if (!hasExited(child)) child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (hasExited(child)) resolve();
    else child.once("exit", () => resolve());
  });
}

/** SIGKILL with no grace and no drain: the modeled death is a process dying mid-request. */
async function crashService(stack: StackInternals, name: StackServiceName): Promise<void> {
  const state = stack.services.get(name);
  if (!state) throw new Error(`realStack: no such service: ${name}`);
  const child = state.child;
  if (!child || hasExited(child)) return;
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (hasExited(child)) resolve();
    else child.once("exit", () => resolve());
  });
}

function readinessUrl(stack: StackInternals, name: StackServiceName): string {
  const { ports, baseDomain } = stack;
  switch (name) {
    case "idp":
      return `http://localhost:${ports.idp}/.well-known/openid-configuration`;
    case "portal":
      return `http://localhost:${ports.portal}/health`;
    case "egress":
      return `http://localhost:${ports.egress}/health`;
    case "jobs":
      return `http://localhost:${ports.jobs}/health`;
    case "edge":
      return `https://${baseDomain}:${ports.edge}/health`;
    case "devGateway":
      return `https://dev-api.${baseDomain}:${ports.devGateway}/health`;
  }
}

function checkOk(body: HealthStatus, name: string): boolean {
  const check = body.checks?.find((c) => c.name === name);
  return check !== undefined && check.status === "ok";
}

/** The readiness predicate: `/health` answers 200 in every state — the BODY carries readiness. */
function isReady(name: StackServiceName, body: HealthStatus): boolean {
  // The dev IdP has no /health: its discovery document is the readiness body.
  // The egress reports liveness only.
  if (name === "idp" || name === "egress") return true;
  if (name === "portal" || name === "jobs") return body.status === "ok";
  return checkOk(body, "jobs_reachability");
}

async function waitListener(
  stack: StackInternals,
  name: StackServiceName,
  timeoutMs: number,
): Promise<void> {
  const url = readinessUrl(stack, name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let observation: string;
    try {
      await stack.request(url);
      return;
    } catch (error) {
      observation = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the ${name} service never answered ${url} within ${timeoutMs}ms — last observation: ${observation}\n` +
          `--- ${name} log tail ---\n${logTail(stack, name, 60)}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function waitServiceReady(
  stack: StackInternals,
  name: StackServiceName,
  timeoutMs: number,
): Promise<void> {
  const url = readinessUrl(stack, name);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let observation: string;
    try {
      const res = await stack.request(url);
      if (res.status === 200) {
        if (name === "idp") {
          const body = res.json() as { issuer?: unknown };
          if (typeof body.issuer === "string") return;
          observation = `discovery body without an issuer: ${res.text.slice(0, 200)}`;
        } else {
          const body = HealthStatusSchema.parse(res.json());
          if (isReady(name, body)) return;
          observation = JSON.stringify(body).slice(0, 800);
        }
      } else {
        observation = `HTTP ${res.status}: ${res.text.slice(0, 200)}`;
      }
    } catch (error) {
      observation = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the ${name} service never became ready within ${timeoutMs}ms — last observation: ${observation}\n` +
          `--- ${name} log tail ---\n${logTail(stack, name, 60)}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function startService(stack: StackInternals, name: StackServiceName): Promise<void> {
  spawnService(stack, name);
  await waitListener(stack, name, BOOT_LISTENER_TIMEOUT_MS);
  await waitServiceReady(stack, name, READY_TIMEOUT_MS);
}

function logTail(stack: StackInternals, name: StackServiceName, lines = 40): string {
  const state = stack.services.get(name);
  if (!state) return `<no such service: ${name}>`;
  if (existsSync(state.logPath)) {
    try {
      const text = readFileSync(state.logPath, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .slice(-lines)
        .join("\n");
      if (text) return text;
    } catch {
      // Fall through to the ring.
    }
  }
  return state.ring.tail(lines);
}

// ── teardown ─────────────────────────────────────────────────────────────────

async function dropStackDatabases(platformOwnerDsn: string, names: string[]): Promise<void> {
  // Connect as the owner to the cluster's maintenance database; WITH (FORCE)
  // ends any connection a slow SIGKILL left behind.
  const admin = new URL(platformOwnerDsn);
  admin.pathname = "/postgres";
  const client = new PgClient({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 15_000,
  });
  await client.connect();
  try {
    for (const name of names) {
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  } finally {
    await client.end();
  }
}

async function closeStack(stack: StackInternals): Promise<void> {
  if (stack.closed) return;
  stack.closed = true;
  for (const name of [...SERVICE_NAMES].reverse()) {
    await stopService(stack, name);
  }
  if (stack.jobsLink !== null) await stack.jobsLink.close();
  for (const fixture of stack.jobsFixtures.values()) await fixture.stop();
  rmSync(stack.tlsDir, { recursive: true, force: true });
  await dropStackDatabases(stack.platformOwnerDsn, stack.databaseNames);
}

// ── clients ──────────────────────────────────────────────────────────────────

function portalClient(stack: StackInternals, bearer: string): PortalClient {
  const auth = { Authorization: `Bearer ${bearer}` };
  const jsonInit = (method: string, body?: unknown): RawRequestInit => ({
    method,
    headers: body === undefined ? auth : { ...auth, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    bearer,
    get: (path) => stack.request(`${stack.portalUrl}${path}`, { headers: auth }),
    post: (path, body) => stack.request(`${stack.portalUrl}${path}`, jsonInit("POST", body)),
    put: (path, body) => stack.request(`${stack.portalUrl}${path}`, jsonInit("PUT", body)),
    delete: (path) => stack.request(`${stack.portalUrl}${path}`, jsonInit("DELETE")),
    uploadBundle(slug, zip) {
      const boundary = `helix-${randomBytes(12).toString("hex")}`;
      const head = Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="bundle"; filename="bundle.zip"\r\n` +
          `Content-Type: application/zip\r\n\r\n`,
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
      return stack.request(`${stack.portalUrl}/api/v1/apps/${slug}/versions`, {
        method: "POST",
        headers: { ...auth, "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: Buffer.concat([head, zip, tail]),
      });
    },
  };
}

async function portalAs(stack: StackInternals, email: string): Promise<PortalClient> {
  const flow = await runAuthCodeFlow({
    issuer: `http://localhost:${stack.ports.idp}`,
    clientId: WEB_CLIENT_ID,
    redirectUri: `${stack.portalUrl}/auth/callback`,
    userEmail: email,
    origin: stack.portalUrl,
  });
  return portalClient(stack, flow.accessToken);
}

/**
 * The real end-user login: navigate to the app host and follow every redirect
 * by hand — app host → auth host `/start` → IdP authorize → the interaction
 * picker (completed via its `?user=` hook) → auth host `/callback` → the app
 * host's `/_auth/complete`, which sets `__Host-session`. Cookies accumulate
 * per host, exactly as a browser's host-only `__Host-*` cookies would.
 */
async function appSession(stack: StackInternals, slug: string, email: string): Promise<AppSession> {
  const appOrigin = `https://${slug}.${stack.baseDomain}:${stack.ports.edge}`;
  const appHost = `${slug}.${stack.baseDomain}`;
  const authHost = `auth.${stack.baseDomain}`;
  const jar = new CookieJar();
  const hops: string[] = [];
  const navigationHeaders: Record<string, string> = {
    Accept: "text/html",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };

  const entry = await stack.request(`${appOrigin}/`, { headers: { ...navigationHeaders } });
  jar.store(appHost, entry.headers["set-cookie"]);
  const entryLocation = headerLocation(entry);
  hops.push(
    `GET ${redactUrlForError(`${appOrigin}/`)} → ${entry.status}` +
      (entryLocation === null ? "" : ` Location: ${redactUrlForError(entryLocation)}`),
  );
  const entryTarget = entryLocation === null ? null : new URL(entryLocation, `${appOrigin}/`);
  if (
    entry.status !== 302 ||
    entryTarget === null ||
    entryTarget.hostname !== authHost ||
    entryTarget.pathname !== "/start"
  ) {
    throw new Error(
      `the app host did not open the login flow for ${slug}: expected a 302 to the auth host's /start, ` +
        `got ${entry.status}${entryLocation === null ? " with no Location" : ` Location: ${redactUrlForError(entryLocation)}`}\n` +
        `--- edge log tail ---\n${logTail(stack, "edge", 40)}`,
    );
  }

  let current: URL = entryTarget;
  let sessionCookie: string | undefined;
  for (let hop = 0; hop < MAX_LOGIN_HOPS; hop++) {
    const onIdpInteraction =
      current.hostname === "localhost" &&
      current.port === String(stack.ports.idp) &&
      /^\/interaction\//.test(current.pathname);
    if (onIdpInteraction) {
      // Complete the login at the deterministic hook instead of the picker.
      current.searchParams.set("user", email);
    }
    const headers: Record<string, string> = { ...navigationHeaders };
    const cookie = jar.headerFor(current.hostname);
    if (cookie) headers.Cookie = cookie;
    const res = await stack.request(current.toString(), { headers });
    jar.store(current.hostname, res.headers["set-cookie"]);
    const location = headerLocation(res);
    hops.push(
      `GET ${redactUrlForError(current.toString())} → ${res.status}` +
        (location === null ? "" : ` Location: ${redactUrlForError(location)}`),
    );

    sessionCookie = jar.get(appHost, "__Host-session");
    if (sessionCookie !== undefined) break;
    if (location === null) break;
    current = new URL(location, current);
  }

  if (sessionCookie === undefined) {
    throw new Error(
      `the login walk for ${email} on ${slug} never produced a __Host-session cookie ` +
        `after ${hops.length} hop(s)\n${hops.map((h) => `  ${h}`).join("\n")}\n` +
        `--- edge log tail ---\n${logTail(stack, "edge", 40)}`,
    );
  }
  const session = `__Host-session=${sessionCookie}`;

  return {
    slug,
    cookie: session,
    navigate(path = "/") {
      return stack.request(`${appOrigin}${path}`, {
        headers: { ...navigationHeaders, Cookie: session },
      });
    },
    api(method, path, init) {
      return stack.request(`${appOrigin}${path}`, {
        method,
        headers: {
          Cookie: session,
          Origin: appOrigin,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
          ...init?.headers,
        },
        ...(init?.body === undefined ? {} : { body: init.body }),
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      });
    },
  };
}

// ── journey helpers ──────────────────────────────────────────────────────────

/**
 * A bounded poll for journey suites: run `probe` every `pollMs` (default
 * POLL_INTERVAL_MS) until it returns a value; `undefined`/`null` means "not
 * yet". The timeout is a thrown error naming `what` — a string, or a function
 * evaluated AT TIMEOUT so the probe's last observation can be quoted — plus
 * the jobs and edge services' log tails, which is where the answer usually
 * is. Never loop unbounded: every wait in a journey test goes through here.
 */
export async function waitFor<T>(
  stack: RealStack,
  what: string | (() => string),
  opts: { timeoutMs: number; pollMs?: number },
  probe: () => Promise<T | undefined | null>,
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor: ${typeof what === "function" ? what() : what} — still unsatisfied after ` +
          `${opts.timeoutMs}ms\n` +
          `--- jobs log tail ---\n${stack.logTail("jobs")}\n` +
          `--- edge log tail ---\n${stack.logTail("edge")}`,
      );
    }
    await sleep(opts.pollMs ?? POLL_INTERVAL_MS);
  }
}

/**
 * The owner journey through the real portal API, as one call: create the app
 * (`internal`), upload a bundle (`zipFiles` over `files`), promote version 1
 * to live, and wait — bounded — until the edge actually SERVES the app host
 * (its registry projection reloads on NOTIFY behind a debounce, so a request
 * in the first few hundred milliseconds would 404). After this resolves, the
 * app host opens the login flow. Every step's failure throws naming the step
 * and the body, because a half-created app leaves the journey suite nothing
 * to assert with. Returns the created App (validated through the shared wire
 * schema).
 */
export async function createLiveApp(
  stack: RealStack,
  portal: PortalClient,
  options: { slug: string; displayName?: string; files: Record<string, string | Buffer> },
): Promise<App> {
  const slug = options.slug;
  const created = await portal.post("/api/v1/apps", {
    slug,
    displayName: options.displayName ?? slug,
    visibility: { mode: "internal" },
  });
  if (created.status !== 201) {
    throw new Error(
      `createLiveApp: creating "${slug}" answered ${created.status}: ${created.text.slice(0, 400)}`,
    );
  }
  const app = AppSchema.parse(created.json());
  const uploaded = await portal.uploadBundle(slug, zipFiles(options.files));
  if (uploaded.status !== 201) {
    throw new Error(
      `createLiveApp: uploading a bundle to "${slug}" answered ${uploaded.status}: ` +
        `${uploaded.text.slice(0, 400)}`,
    );
  }
  const promoted = await portal.post(`/api/v1/apps/${slug}/versions/1/promote`);
  if (promoted.status !== 200) {
    throw new Error(
      `createLiveApp: promoting "${slug}" v1 answered ${promoted.status}: ` +
        `${promoted.text.slice(0, 400)}`,
    );
  }
  await waitFor(
    stack,
    `the edge to serve the promoted app "${slug}"`,
    { timeoutMs: 30_000 },
    async () => {
      // An internal app's unauthenticated entry request is a 302 to the auth
      // host's /start — the observable "the projection serves this app".
      const entry = await stack.request(`${stack.appOrigin(slug)}/`, {
        headers: {
          Accept: "text/html",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        },
      });
      const location = entry.headers["location"];
      const locationText = Array.isArray(location) ? (location[0] ?? "") : (location ?? "");
      return entry.status === 302 && locationText.includes("/start") ? true : undefined;
    },
  );
  return app;
}

// ── the controlled JSON origin ───────────────────────────────────────────────

interface OriginReply {
  status: number;
  body: Buffer;
  contentType: string;
}

export async function startJsonOrigin(): Promise<ControlledJsonOrigin> {
  const requests: ControlledJsonOrigin["requests"] = [];
  const responses = new Map<string, OriginReply>();
  const holds = new Map<
    string,
    { state: "held" | "open"; queue: Array<() => void>; resolveArrived: () => void }
  >();

  const answer = (res: ServerResponse, pathname: string): void => {
    const configured = responses.get(pathname);
    if (configured === undefined) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no_response_configured", path: pathname }));
      return;
    }
    res.writeHead(configured.status, { "content-type": configured.contentType });
    res.end(configured.body);
  };

  const server: Server = http.createServer((req, res) => {
    const raw = req.url ?? "/";
    const pathname = new URL(raw, "http://127.0.0.1").pathname;
    req.on("data", () => {});
    req.on("error", () => {});
    req.on("end", () => {
      requests.push({
        method: req.method ?? "GET",
        path: raw,
        headers: req.headers,
        at: Date.now(),
      });
      const hold = holds.get(pathname);
      if (hold !== undefined && hold.state === "held") {
        hold.queue.push(() => {
          // The waiter may have given up while the hold was held — a job's
          // cancellation hangs this request's socket up — and writing into a
          // destroyed socket is noise the origin never needs to make.
          if (res.writableEnded || res.destroyed) return;
          answer(res, pathname);
        });
        hold.resolveArrived();
        return;
      }
      answer(res, pathname);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("realStack: the JSON origin never bound a loopback port");
  }
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    requests,
    respond(path, reply) {
      const body =
        reply.rawBody !== undefined
          ? Buffer.from(reply.rawBody)
          : Buffer.from(JSON.stringify(reply.json ?? null));
      responses.set(path, {
        status: reply.status ?? 200,
        body,
        contentType: reply.contentType ?? "application/json",
      });
    },
    hold(path) {
      if (holds.get(path)?.state === "held") {
        throw new Error(
          `realStack: path ${path} is already held — release it before holding again`,
        );
      }
      let resolveArrived: () => void = () => {};
      const arrived = new Promise<void>((resolve) => {
        resolveArrived = resolve;
      });
      holds.set(path, { state: "held", queue: [], resolveArrived });
      return {
        arrived,
        release() {
          const hold = holds.get(path);
          if (hold === undefined || hold.state === "open") return;
          hold.state = "open";
          for (const pending of hold.queue.splice(0)) pending();
        },
      };
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

// ── the faultable edge→jobs link ─────────────────────────────────────────────

export interface JobsLinkReply {
  status: number;
  body: string;
}

export interface JobsLinkInterception {
  /** The jobs service's complete reply to the intercepted submission — proof it answered (and, for a 202, committed). */
  readonly upstreamReply: Promise<JobsLinkReply>;
  /** Resolves when the edge-side connection of the intercepted submission closed without receiving that reply. */
  readonly downstreamClosed: Promise<void>;
  /** For "hold": deliver the reply now if the edge is still waiting; a no-op otherwise, and for "drop". */
  release(): void;
}

export interface JobsLink {
  /** The relay's base URL, as the edge and dev gateway see it. */
  readonly endpoint: string;
  /** Every request the relay carried to jobs, in arrival order (method + path only). */
  readonly forwarded: ReadonlyArray<{ method: string; path: string; at: number }>;
  /**
   * Intercept the NEXT submission (POST to the internal submit resource) the relay carries:
   * forward it to jobs unchanged and read jobs' complete reply, then either
   * "drop" — destroy the edge-side connection without writing any reply (a lost reply after commit), or
   * "hold" — keep the reply until release() (a reply delayed past the caller's patience).
   * Throws if an interception is already pending.
   */
  interceptNextSubmit(mode: "drop" | "hold"): JobsLinkInterception;
  close(): Promise<void>;
}

interface PendingIntercept {
  mode: "drop" | "hold";
  res: ServerResponse | null;
  headers: Record<string, string | string[] | undefined>;
  resolveUpstream: (reply: JobsLinkReply) => void;
  rejectUpstream: (error: Error) => void;
  resolveDownstreamClosed: () => void;
  released: boolean;
  delivered: boolean;
  reply: JobsLinkReply | null;
}

/**
 * A test-only transport fault injector between the edge (and the dev gateway)
 * and the real jobs service: an in-process relay the harness points
 * `EDGE_JOBS_CONFIG` at instead of the jobs listener. The relay never alters
 * the bytes it forwards — the signed instruction stays end-to-end between the
 * real edge and the real jobs service — it only decides whether a forwarded
 * reply is delivered, held, or lost.
 */
async function startJobsLink(upstreamBase: string): Promise<JobsLink> {
  const submitResource = buildJobsInternalResource("submit");
  const forwarded: Array<{ method: string; path: string; at: number }> = [];
  let pending: PendingIntercept | null = null;

  /** Deliver a held reply: only after release(), and only if the edge is still waiting. */
  const deliverHeldReply = (intercept: PendingIntercept, res: ServerResponse): void => {
    if (intercept.mode !== "hold" || !intercept.released) return;
    if (intercept.reply === null || intercept.delivered) return;
    if (res.destroyed || res.writableEnded) return;
    intercept.delivered = true;
    const headers: Record<string, string | string[] | undefined> = { ...intercept.headers };
    // Framing headers describe the upstream's own write; the relay writes the
    // buffered body itself.
    delete headers["transfer-encoding"];
    delete headers.connection;
    delete headers["content-length"];
    res.writeHead(intercept.reply.status, headers);
    res.end(intercept.reply.body);
  };

  /**
   * One proxied exchange: the buffered edge-side request forwarded to jobs,
   * headers unchanged (the jobs service authenticates a signed instruction
   * header, and the Host header is not part of the signature).
   */
  const carry = (
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    intercept: PendingIntercept | null,
  ): void => {
    const upReq = http.request(new URL(req.url ?? "/", upstreamBase), {
      method: req.method,
      headers: req.headers,
    });
    if (intercept !== null) intercept.res = res;
    res.on("close", () => {
      if (res.writableEnded) return;
      if (intercept === null) {
        // The edge gave up first: a pass-through stops upstream too. An
        // intercepted submission never does — the point is to observe what
        // jobs committed regardless of when the edge stops waiting.
        upReq.destroy();
        return;
      }
      intercept.resolveDownstreamClosed();
    });
    upReq.on("error", (error) => {
      // The edge observes exactly what a direct connection to a dead jobs
      // service observes — a transport failure, never a fabricated HTTP
      // status.
      req.socket.destroy();
      if (intercept !== null) {
        intercept.rejectUpstream(
          new Error(
            `realStack jobsLink: the upstream ${submitResource} request failed: ${error.message}`,
          ),
        );
      }
    });
    upReq.on("response", (upRes: IncomingMessage) => {
      if (intercept === null) {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.on("error", () => req.socket.destroy());
        upRes.pipe(res);
        return;
      }
      const replyChunks: Buffer[] = [];
      intercept.headers = upRes.headers;
      upRes.on("data", (c: Buffer) => replyChunks.push(c));
      upRes.on("error", (error) => {
        intercept.rejectUpstream(
          new Error(
            `realStack jobsLink: reading the upstream ${submitResource} reply failed: ${error.message}`,
          ),
        );
      });
      upRes.on("end", () => {
        const reply: JobsLinkReply = {
          status: upRes.statusCode ?? 0,
          body: Buffer.concat(replyChunks).toString("utf8"),
        };
        intercept.reply = reply;
        intercept.resolveUpstream(reply);
        if (intercept.mode === "drop") {
          // A lost reply after commit: no bytes reach the edge.
          req.socket.destroy();
          return;
        }
        deliverHeldReply(intercept, res);
      });
    });
    upReq.end(body);
  };

  const server: Server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => {});
    req.on("end", () => {
      const method = req.method ?? "GET";
      const path = req.url ?? "/";
      forwarded.push({ method, path, at: Date.now() });
      const pathname = new URL(path, "http://127.0.0.1").pathname;
      const intercept =
        pending !== null && method === "POST" && pathname === submitResource ? pending : null;
      if (intercept !== null) pending = null;
      carry(req, res, Buffer.concat(chunks), intercept);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("realStack: the jobs link relay never bound a loopback port");
  }

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    forwarded,
    interceptNextSubmit(mode) {
      if (pending !== null) {
        throw new Error(
          "realStack: a jobs-link interception is already pending — await or release it before intercepting the next submit",
        );
      }
      let resolveUpstream!: (reply: JobsLinkReply) => void;
      let rejectUpstream!: (error: Error) => void;
      const upstreamReply = new Promise<JobsLinkReply>((resolve, reject) => {
        resolveUpstream = resolve;
        rejectUpstream = reject;
      });
      let resolveDownstreamClosed!: () => void;
      const downstreamClosed = new Promise<void>((resolve) => {
        resolveDownstreamClosed = resolve;
      });
      const intercept: PendingIntercept = {
        mode,
        res: null,
        headers: {},
        resolveUpstream,
        rejectUpstream,
        resolveDownstreamClosed,
        released: false,
        delivered: false,
        reply: null,
      };
      pending = intercept;
      return {
        upstreamReply,
        downstreamClosed,
        release() {
          // Delivering is a "hold" behavior only; "drop" never writes a reply.
          if (mode === "drop" || intercept.released) return;
          intercept.released = true;
          if (intercept.res !== null) deliverHeldReply(intercept, intercept.res);
        },
      };
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/**
 * Start the relay and repoint every `EDGE_JOBS_CONFIG` server entry at it,
 * keeping each entry's other fields (the per-direction signing roots). The
 * portal's `PORTAL_JOBS_CONFIG` is untouched: only the edge and the dev
 * gateway read the edge document, so lifecycle delivery stays direct.
 */
async function startJobsLinkRelay(serviceEnv: NodeJS.ProcessEnv): Promise<JobsLink> {
  const raw = serviceEnv.EDGE_JOBS_CONFIG;
  if (raw === undefined) {
    throw new Error(
      "realStack: jobsLink=true but the resolved stack env carries no EDGE_JOBS_CONFIG",
    );
  }
  let document: { servers?: Record<string, { endpoint?: unknown }> };
  try {
    const parsed: unknown = JSON.parse(raw);
    document = parsed as { servers?: Record<string, { endpoint?: unknown }> };
  } catch (error) {
    throw new Error(
      `realStack: EDGE_JOBS_CONFIG is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  const entries = Object.entries(document.servers ?? {});
  if (entries.length === 0) {
    throw new Error("realStack: jobsLink=true but EDGE_JOBS_CONFIG has no configured servers");
  }
  const upstreams = new Set<string>();
  for (const [id, entry] of entries) {
    if (typeof entry?.endpoint !== "string") {
      throw new Error(`realStack: EDGE_JOBS_CONFIG server "${id}" carries no endpoint`);
    }
    upstreams.add(entry.endpoint);
  }
  // One relay, one upstream: the entries the stack resolves all point at the
  // same jobs listener.
  if (upstreams.size !== 1) {
    throw new Error(
      `realStack: jobsLink forwards to one jobs endpoint, but EDGE_JOBS_CONFIG names ${upstreams.size}`,
    );
  }
  const upstreamBase = [...upstreams][0] ?? "";
  const link = await startJobsLink(upstreamBase);
  const rewritten: Record<string, { endpoint: string }> = {};
  for (const [id, entry] of entries) {
    rewritten[id] = { ...entry, endpoint: link.endpoint };
  }
  serviceEnv.EDGE_JOBS_CONFIG = JSON.stringify({ servers: rewritten });
  return link;
}

/**
 * The three jobs documents the services read at boot, rewritten for the
 * fixture servers: the edge's forwarding subset (endpoint + the two edge
 * roots), the portal's lifecycle subset (endpoint + the portal root), and the
 * credential-free catalogue projection (state + no installed types — the
 * fixtures' synthetic type is never advertised). A fixture left out of
 * `states` is removed from every document.
 */
function writeFixtureJobsConfig(
  serviceEnv: NodeJS.ProcessEnv,
  fixtures: ReadonlyMap<string, JobsContractFixture>,
  states: Readonly<Record<string, "serving" | "retiring">>,
): void {
  const edgeServers: Record<
    string,
    { endpoint: string; edgeToJobsRoot: string; jobsToEdgeRoot: string }
  > = {};
  const portalServers: Record<string, { endpoint: string; portalToJobsRoot: string }> = {};
  const catalogueServers: Record<string, { state: "serving" | "retiring"; types: [] }> = {};
  for (const [id, fixture] of fixtures) {
    const state = states[id];
    if (state === undefined) continue;
    edgeServers[id] = {
      endpoint: fixture.endpoint,
      edgeToJobsRoot: fixture.roots.edgeToJobs,
      jobsToEdgeRoot: fixture.roots.jobsToEdge,
    };
    portalServers[id] = {
      endpoint: fixture.endpoint,
      portalToJobsRoot: fixture.roots.portalToJobs,
    };
    catalogueServers[id] = { state, types: [] };
  }
  serviceEnv.EDGE_JOBS_CONFIG = JSON.stringify({ servers: edgeServers });
  serviceEnv.PORTAL_JOBS_CONFIG = JSON.stringify({ servers: portalServers });
  serviceEnv.PORTAL_JOBS_CATALOGUE = JSON.stringify({ servers: catalogueServers });
}

// ── zip (stored, hand-rolled) ────────────────────────────────────────────────

/** Fixed valid DOS timestamp (1980-01-01) — the zip fields need *a* date, and reproducibility beats realism here. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/**
 * Zip a map of file name → contents into a Buffer: stored (no compression),
 * files at the archive root, hand-rolled with node:zlib's crc32 so the harness
 * carries no dependency. The byte layout is the PKWARE APPNOTE's — local
 * headers, the central directory, the end-of-central-directory record.
 */
export function zipFiles(files: Record<string, string | Buffer>): Buffer {
  const names = Object.keys(files);
  if (names.length === 0) {
    throw new Error("zipFiles: no files given — an empty archive is never a useful fixture");
  }
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const name of names) {
    const content = files[name];
    if (content === undefined) continue;
    if (name.length > 0xffff)
      throw new Error(`zipFiles: name too long for a zip header: ${name.slice(0, 32)}…`);
    const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0 (stored entries)
    local.writeUInt16LE(0, 6); // general purpose flags
    local.writeUInt16LE(0, 8); // method 0: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    chunks.push(local, nameBytes, data);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0, 8); // flags
    entry.writeUInt16LE(0, 10); // method: stored
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra length
    entry.writeUInt16LE(0, 32); // comment length
    entry.writeUInt16LE(0, 34); // disk number start
    entry.writeUInt16LE(0, 36); // internal attributes
    entry.writeUInt32LE(0, 38); // external attributes
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralDirectory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with the central directory
  eocd.writeUInt16LE(names.length, 8);
  eocd.writeUInt16LE(names.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralDirectory, eocd]);
}

// ── the harness itself ───────────────────────────────────────────────────────

export async function startRealStack(
  options: {
    offset?: number;
    label?: string;
    jobsLink?: boolean;
    diagnostics?: boolean;
    /** Server ids of in-process contract fixtures that stand in for the real jobs process. */
    jobsFixtures?: readonly string[];
  } = {},
): Promise<RealStack> {
  const label = (options.label ?? "journey").replace(/[^a-z0-9-]/gi, "") || "journey";

  const fixtureIds = options.jobsFixtures;
  if (fixtureIds !== undefined) {
    if (options.jobsLink === true) {
      throw new Error(
        "realStack: jobsLink and jobsFixtures cannot combine — the link faults the real jobs process, which does not start under fixtures",
      );
    }
    if (fixtureIds.length === 0) {
      throw new Error("realStack: jobsFixtures requires at least one server id");
    }
    if (new Set(fixtureIds).size !== fixtureIds.length) {
      throw new Error("realStack: jobsFixtures names a server id twice — one fixture per server");
    }
    for (const id of fixtureIds) {
      if (!isValidJobsServerId(id)) {
        throw new Error(
          `realStack: jobsFixtures names "${id}", which is not a valid job server id`,
        );
      }
    }
  }

  const missing = REQUIRED_AMBIENT_KEYS.filter((key) => process.env[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `realStack: missing required ambient environment variables: ${missing.join(", ")}`,
    );
  }

  const baseEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SCRUBBED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    if (SCRUBBED_KEYS.has(key)) continue;
    baseEnv[key] = value;
  }

  const offset = options.offset ?? (await claimFreeOffset(baseEnv));

  // [a-z0-9] only: the suffix becomes a database name suffix AND a blob
  // container name (`app-bundles-<suffix>`, which forbids `_`).
  const suffix = `journey${randomBytes(4).toString("hex")}`;
  // The ambient HELIX_JOBS_* keys were scrubbed above, so the diagnostic type
  // is present only when this stack opts in, through the same resolution knob
  // a developer uses.
  const stackEnv = runStackEnvScript(
    offset,
    suffix,
    options.diagnostics === true ? { ...baseEnv, HELIX_JOBS_DIAGNOSTICS: "1" } : baseEnv,
  );

  if (stackEnv.JOBS_PORT === undefined) {
    throw new Error(
      "realStack: the resolved stack has no jobs plane (jobs disabled) — the harness requires jobs",
    );
  }
  const ports: Record<string, number> = {
    edge: Number(stackEnv.EDGE_PORT),
    egress: Number(stackEnv.EGRESS_PORT),
    devGateway: Number(stackEnv.EDGE_DEV_GATEWAY_PORT),
    portal: Number(stackEnv.PORTAL_PORT),
    idp: Number(stackEnv.IDP_PORT),
    jobs: Number(stackEnv.JOBS_PORT),
  };
  for (const [name, port] of Object.entries(ports)) {
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`realStack: the resolved stack env carries no usable ${name} port`);
    }
  }
  const appPublicBase = stackEnv.APP_PUBLIC_BASE;
  if (appPublicBase === undefined) {
    throw new Error("realStack: the resolved stack env carries no APP_PUBLIC_BASE");
  }
  const baseDomain = new URL(appPublicBase).hostname;

  const serviceEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...stackEnv,
    // The one dev-only policy relaxation: the outbound call may reach the
    // harness's loopback JSON origin. Telemetry stays off — the platform's
    // default state.
    EGRESS_ALLOW_PRIVATE: "true",
    EDGE_ALLOW_DEV_MODE: "true",
    OTEL_SDK_DISABLED: "1",
  };

  const logDir = mkdtempSync(path.join(tmpdir(), `helix-realstack-${label}-`));
  const services = new Map<StackServiceName, ServiceState>();
  for (const name of SERVICE_NAMES) {
    services.set(name, {
      spec: SERVICE_SPECS[name],
      child: null,
      fd: null,
      ring: new BoundedLog(),
      logPath: path.join(logDir, `${name}.log`),
    });
  }

  const tls = mintTlsCert(baseDomain);
  serviceEnv.EDGE_TLS_CERT_FILE = tls.certFile;
  serviceEnv.EDGE_TLS_KEY_FILE = tls.keyFile;
  serviceEnv.NODE_EXTRA_CA_CERTS = tls.certFile;
  const tlsCa = readFileSync(tls.certFile);

  const platformOwnerDsn = stackEnv.DATABASE_URL;
  const jobsDsn = stackEnv.JOBS_DATABASE_URL;
  if (platformOwnerDsn === undefined || jobsDsn === undefined) {
    throw new Error("realStack: the resolved stack env carries no platform or jobs database DSN");
  }
  // The platform owner's credentials against the jobs database: the owner DSN
  // of the jobs store.
  const jobsOwnerUrl = new URL(platformOwnerDsn);
  jobsOwnerUrl.pathname = new URL(jobsDsn).pathname;
  const jobsOwnerDsn = jobsOwnerUrl.toString();

  // The faultable link must exist before any service spawns: the edge and the
  // dev gateway read EDGE_JOBS_CONFIG once at boot, so this rewrite is the
  // only chance to point them at the relay. Started last before the stack
  // record, so every later failure reaches closeStack, which closes it.
  const jobsLink = options.jobsLink === true ? await startJobsLinkRelay(serviceEnv) : null;
  const jobsFixtures = new Map<string, JobsContractFixture>();

  const stack: StackInternals = {
    serviceEnv,
    logDir,
    services,
    ports,
    baseDomain,
    portalUrl: `http://localhost:${ports.portal}`,
    devGatewayOrigin: `https://dev-api.${baseDomain}:${ports.devGateway}`,
    platformOwnerDsn,
    jobsOwnerDsn,
    databaseNames: [
      new URL(platformOwnerDsn).pathname.replace(/^\//, ""),
      new URL(jobsDsn).pathname.replace(/^\//, ""),
    ],
    jobsLink,
    jobsFixtures,
    tlsCa,
    tlsDir: tls.dir,
    request: (url, init) => rawRequest(tlsCa, url, init),
    closed: false,
  };

  try {
    // The fixtures listen before any service spawns: the edge and the portal
    // read their jobs documents once at boot, so the rewrite below is the only
    // chance to point them at the fixtures.
    for (const id of fixtureIds ?? []) {
      const fixture = createJobsContractFixture(id);
      await fixture.start();
      jobsFixtures.set(id, fixture);
    }
    if (jobsFixtures.size > 0) {
      const serving: Record<string, "serving"> = {};
      for (const id of jobsFixtures.keys()) serving[id] = "serving";
      writeFixtureJobsConfig(serviceEnv, jobsFixtures, serving);
    }

    runEnsureDbScript(platformOwnerDsn, jobsDsn);
    // The IdP first: it must answer before the edge's and portal's OIDC
    // clients look for it.
    spawnService(stack, "idp");
    await waitListener(stack, "idp", BOOT_LISTENER_TIMEOUT_MS);
    // Under contract fixtures the real jobs process does not exist: it is not
    // spawned, not awaited, and not readiness-checked — the fixtures' own
    // /health answers the edge's reachability probe instead.
    const appServices: readonly StackServiceName[] =
      jobsFixtures.size === 0 ? ["portal", "egress", "jobs"] : ["portal", "egress"];
    for (const name of appServices) {
      spawnService(stack, name);
    }
    for (const name of appServices) {
      await waitListener(stack, name, BOOT_LISTENER_TIMEOUT_MS);
    }
    for (const name of ["edge", "devGateway"] as const) {
      spawnService(stack, name);
    }
    for (const name of ["edge", "devGateway"] as const) {
      await waitListener(stack, name, BOOT_LISTENER_TIMEOUT_MS);
    }
    // Every listener answers — now the bodies: /health answers 200 in every
    // state, so readiness is what the body says.
    const readyServices: readonly StackServiceName[] =
      jobsFixtures.size === 0
        ? ["portal", "egress", "jobs", "edge", "devGateway"]
        : ["portal", "egress", "edge", "devGateway"];
    await Promise.all(readyServices.map((name) => waitServiceReady(stack, name, READY_TIMEOUT_MS)));
  } catch (error) {
    await closeStack(stack).catch(() => {});
    throw error;
  }

  return {
    suffix,
    baseDomain,
    ports,
    portalUrl: stack.portalUrl,
    devGatewayOrigin: stack.devGatewayOrigin,
    logDir,
    platformOwnerDsn,
    jobsOwnerDsn,
    jobsLink,
    jobsFixtures: Object.fromEntries(jobsFixtures),
    configureJobsFixtures: (states) => {
      if (jobsFixtures.size === 0) {
        throw new Error(
          "realStack: configureJobsFixtures requires jobsFixtures — this stack has none",
        );
      }
      for (const id of Object.keys(states)) {
        if (!jobsFixtures.has(id)) {
          throw new Error(
            `realStack: configureJobsFixtures names "${id}", which is not a fixture of this stack`,
          );
        }
      }
      writeFixtureJobsConfig(serviceEnv, jobsFixtures, states);
    },
    appOrigin: (slug) => `https://${slug}.${baseDomain}:${ports.edge}`,
    request: stack.request,
    portalAs: (email) => portalAs(stack, email),
    portalAsDevToken: () => portalClient(stack, process.env.PORTAL_DEV_TOKEN ?? ""),
    appSession: (slug, email) => appSession(stack, slug, email),
    devClient: (slug, token, requestOrigin) => ({
      api: (method, path, init) =>
        stack.request(`${stack.devGatewayOrigin}/${slug}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Origin: requestOrigin,
            ...(init?.headers ?? {}),
          },
          ...(init?.body === undefined ? {} : { body: init.body }),
        }),
    }),
    stop: (name) => stopService(stack, name),
    start: (name) => startService(stack, name),
    restart: async (name) => {
      await stopService(stack, name);
      await startService(stack, name);
    },
    crash: (name) => crashService(stack, name),
    logTail: (name, lines) => logTail(stack, name, lines),
    close: () => closeStack(stack),
  };
}
