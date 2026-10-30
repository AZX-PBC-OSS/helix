import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { connect as tlsConnect } from "node:tls";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  HealthStatusSchema,
  INSTRUCTION_HEADER,
  JOBS_FETCH_QUALIFIED_TYPE,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_MAX_INPUT_BYTES,
  JOBS_SERVER_NAME,
  JOB_TERMINAL_STATUSES,
  JOBS_SERVICE_NAME,
  JobAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  ManifestUpdateResultSchema,
  type App,
} from "@azx-pbc/shared";
import { FORBIDDEN_URL_ATTRS, SPAN_JOBS_SUBMIT_EDGE } from "@azx-pbc/shared/telemetry";
import {
  deriveJobsInstructionKey,
  JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS,
  JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS,
  mintJobsInstruction,
  sha256BodyDigest,
  type JobsInstructionMintSpec,
  type JobsUserOperationIdentity,
} from "@azx-pbc/shared/jobsSigning";

import {
  createLiveApp,
  startJsonOrigin,
  startRealStack,
  waitFor,
  type AppSession,
  type ControlledJsonOrigin,
  type DevClient,
  type HttpReply,
  type JobsLink,
  type PortalClient,
  type RealStack,
} from "./test/realStack.js";

/**
 * The assembled trust-boundary suite, over the real running platform: every
 * denial the jobs surfaces answer is byte-identical to the session gate's own
 * answer and forwards nothing; a real submission forwards only the edge's own
 * signed instruction and attribution, however the caller smuggles headers; and
 * no planted value reaches a response, a log line, or an exported signal.
 *
 * One stack serves the whole file (`jobsLink` + telemetry capture); the tests
 * are sequential and share state.
 */

// ── shared suite state ───────────────────────────────────────────────────────

let stack: RealStack;
let link: JobsLink;
let origin: ControlledJsonOrigin;
/** Platform-owner pool for the two deliberate session-table writes below. */
let platform: Pool;
/** Jobs-owner pool for the read-only job_record counting below. */
let jobsDb: Pool;

let bob: PortalClient;
let alice: PortalClient;
let appA: App;
let appB: App;
let bobA: AppSession;
let bobB: AppSession;
let danaA: AppSession;
let aliceA: AppSession;
let devToken: string;
let dev: DevClient;

/** The edge submissions this suite makes through the app host, as they go. */
const edgeAttempts = { n: 0 };

/**
 * Planted values: each stands for a class of caller-controlled material that
 * must never cross the trust boundary — a URL-query credential, retry keys,
 * a result payload secret, a forged instruction token, a grafted trace id.
 * Never print any of them in an assertion message.
 */
const PLANT = `plant${randomBytes(6).toString("hex")}`;
const QUERY_SECRET = `${PLANT}q`;
const K1 = `k1-${PLANT}`;
const K2 = `k2-${PLANT}`;
const RESULT_SECRET = `${PLANT}r`;
const SMUGGLED_INSTRUCTION = `eyJ${PLANT}.x.y`;
const PLANTED_TRACE_ID = randomBytes(16).toString("hex");
const PLANTED_TRACEPARENT = `00-${PLANTED_TRACE_ID}-00f067aa0ba902b7-01`;
const DEV_TOKEN_ORIGIN = "http://localhost:5199";
const FOREIGN_ORIGIN = "http://localhost:5200";

/** The S1 job test 3 leaves running and held at the origin, for the tests after it. */
let s1JobId: string | undefined;
let s1Token: string | undefined;
let s1Body: Buffer | undefined;
let s1Claims: Record<string, unknown> | undefined;
let holdS1: { arrived: Promise<void>; release(): void } | undefined;

/**
 * Every instruction token the suite captures from a forward or mints itself —
 * the test-8 exported-signal scan consumes this list: a token that crossed the
 * boundary must never reappear in a response, a log line or a span.
 */
const instructionTokens: string[] = [];

/**
 * Every session cookie value the suite ever holds (the shared sessions, the
 * fresh ones tests create, even the garbage value presented as one) — the
 * test-8 scans consume this: a session credential must never reappear in a
 * response, a log line or a span.
 */
const sessionCookieValues: string[] = [];

/** dana's owner oid, from her own instruction — the test-8 identity probe. */
let danaOwnerOid: string | undefined;

/** The trace id the edge injected on S1's forward — test 8's encoding probe. */
let edgeSubmitTraceId: string | undefined;

// ── small helpers ────────────────────────────────────────────────────────────

const must = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`the trust-boundary suite never produced ${what}`);
  return value;
};

/** One header of a reply or a captured forward, as a single string. */
const valueOf = (headers: Record<string, string | string[] | undefined>, name: string): string => {
  const v = headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};
const headerValue = (reply: HttpReply, name: string): string => valueOf(reply.headers, name);
const acaoOf = (reply: HttpReply): string | string[] | undefined =>
  reply.headers["access-control-allow-origin"];
const varyIncludesOrigin = (reply: HttpReply): boolean =>
  headerValue(reply, "vary")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes("origin");

/** The `{"error":{code}}` envelope's code — the session gate's answer shape. */
const envelopeErrorCode = (reply: HttpReply): string | undefined => {
  const body = reply.json() as { error?: { code?: string } };
  return body.error?.code;
};

/** Base64url-decode a JWT payload — only to read what the real edge signed. */
function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("decodeClaims: the token has no payload segment");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

// ── instruction minting as an insider would ──────────────────────────────────

/** The one configured jobs server id (the `jobs` in `/_api/jobs/jobs/…`). */
const JOBS_SERVER_ID = JOBS_SERVER_NAME;

const nowS = (): number => Math.floor(Date.now() / 1000);

const claimString = (key: string): string => {
  const value = must(s1Claims, "the decoded instruction claims")[key];
  if (typeof value !== "string") throw new Error(`the captured claims carry no ${key} string`);
  return value;
};
const claimEnv = (): "prod" | "dev" => {
  const value = claimString("env");
  if (value !== "prod" && value !== "dev") {
    throw new Error("the captured env claim is neither tier");
  }
  return value;
};
const claimOwnerKind = (): "user" | "dev" => {
  const value = claimString("ownerKind");
  if (value !== "user" && value !== "dev") {
    throw new Error("the captured ownerKind claim is neither kind");
  }
  return value;
};
const claimStringArray = (key: string): string[] => {
  const value = must(s1Claims, "the decoded instruction claims")[key];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new Error(`the captured claims carry no ${key} string array`);
  }
  return value as string[];
};

/** S1's verified identity — the receiver validated these claims when it accepted the submission. */
const s1Identity = (): JobsUserOperationIdentity => ({
  appId: claimString("appId"),
  env: claimEnv(),
  ownerKind: claimOwnerKind(),
  ownerOid: claimString("ownerOid"),
  allowedTypes: claimStringArray("allowedTypes"),
});

const jobsRoots = (): { edgeToJobs: string; jobsToEdge: string; portalToJobs: string } =>
  must(stack.jobsRoots ?? undefined, "the stack's jobs signing roots");
const edgeToJobsKey = (): Uint8Array =>
  deriveJobsInstructionKey(jobsRoots().edgeToJobs, "edgeToJobs");
const jobsToEdgeKey = (): Uint8Array =>
  deriveJobsInstructionKey(jobsRoots().jobsToEdge, "jobsToEdge");
const portalToJobsKey = (): Uint8Array =>
  deriveJobsInstructionKey(jobsRoots().portalToJobs, "portalToJobs");

/** Mint one instruction and register it for the test-8 scan. */
async function mintInstruction(spec: JobsInstructionMintSpec, key: Uint8Array): Promise<string> {
  const token = await mintJobsInstruction(spec, key);
  instructionTokens.push(token);
  return token;
}

/** A snapshot instruction for one job under one identity, signed with the edge→jobs key. */
const mintSnapshot = (
  identity: JobsUserOperationIdentity,
  snapshotJobId: string,
  iat: number,
): Promise<string> =>
  mintInstruction(
    { operation: "snapshot", server: JOBS_SERVER_ID, identity, jobId: snapshotJobId, iatS: iat },
    edgeToJobsKey(),
  );

// ── the seen() recorder (the test-8 response scan consumes these) ────────────

const seenReplies: Array<{
  what?: string;
  status: number;
  headersJson: string;
  text: string;
}> = [];

/**
 * The recorder's label for the one reply whose whole purpose is handing a
 * credential to its owner: the dev-token mint. The test-8 response scan
 * exempts that reply from the dev-token class only — everywhere else the
 * token is a leak.
 */
const MINT_REPLY_WHAT = "the dev-token mint response (it hands the fresh token to its owner)";

/** Record every HttpReply the suite receives: status, headers JSON, text. */
function seen(reply: HttpReply, what?: string): HttpReply {
  seenReplies.push({
    what,
    status: reply.status,
    headersJson: JSON.stringify(reply.headers),
    text: reply.text,
  });
  return reply;
}

/**
 * A real end-user login whose session cookie value is registered for the
 * test-8 scans. Every session the suite creates goes through here.
 */
async function sessionIn(slug: string, email: string): Promise<AppSession> {
  const session = await stack.appSession(slug, email);
  sessionCookieValues.push(session.cookie.slice("__Host-session=".length));
  return session;
}

/** How many requests the edge→jobs relay has carried so far. */
const jobsForwards = (): number => link.forwarded.length;

// ── request shapes ───────────────────────────────────────────────────────────

const SUBMIT_PATH = "/_api/jobs/jobs/types/fetch";
const statusPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}`;
const resultPath = (jobId: string): string => `/_api/jobs/jobs/${jobId}/result`;

/** The headers a served page's fetch sends — the gate's API posture. */
const apiHeaders = (appOrigin: string): Record<string, string> => ({
  Origin: appOrigin,
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
});

/** The headers a top-level navigation sends — the gate's navigation posture. */
const NAV_HEADERS: Record<string, string> = {
  Accept: "text/html",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Dest": "document",
};

type JobsApi = AppSession["api"] | DevClient["api"];

/**
 * One submission attempt series (the journey's shape): the attempt is counted,
 * and a retryable 503 is retried ONCE with the SAME key and the SAME bytes.
 * `extraHeaders` carries the caller's smuggled headers, if any.
 */
async function submitJob(
  api: JobsApi,
  idempotencyKey: string,
  body: string,
  attempts: { n: number },
  extraHeaders: Record<string, string> = {},
): Promise<HttpReply> {
  const attempt = (): Promise<HttpReply> => {
    attempts.n += 1;
    return api("POST", SUBMIT_PATH, {
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        ...extraHeaders,
      },
      body,
    }).then(seen);
  };
  const first = await attempt();
  if (first.status === 503) return attempt();
  return first;
}

// ── denial comparators ───────────────────────────────────────────────────────

/**
 * One jobs-request denial against the SAME request on `/_api/me`, same host,
 * same headers: the gate's answer must be byte-identical (status, body,
 * cache-control) — the jobs routes look like every other gated route to an
 * unauthenticated caller — and a denial must forward nothing to jobs.
 */
async function compareWithMe(
  what: string,
  hostOrigin: string,
  method: string,
  jobsPath: string,
  headers: Record<string, string>,
): Promise<HttpReply> {
  const forwardsBefore = jobsForwards();
  const jobsReply = seen(await stack.request(`${hostOrigin}${jobsPath}`, { method, headers }));
  const me = seen(await stack.request(`${hostOrigin}/_api/me`, { headers }));
  expect(jobsReply.status, `${what}: the jobs route and /_api/me agree on status`).toBe(me.status);
  expect(jobsReply.text, `${what}: the jobs route and /_api/me agree on the body`).toBe(me.text);
  expect(headerValue(jobsReply, "cache-control"), `${what}: cache-control`).toBe(
    headerValue(me, "cache-control"),
  );
  expect(jobsForwards(), `${what}: the denial forwarded nothing`).toBe(forwardsBefore);
  return jobsReply;
}

/**
 * The navigation posture: both routes must answer the SAME 302 to the auth
 * host's /start — a jobs navigation that redirected anywhere else would be a
 * distinguishable (and wrong) landing for an unauthenticated visitor.
 */
async function compareNavigationWithMe(
  what: string,
  hostOrigin: string,
  jobsPath: string,
  headers: Record<string, string>,
): Promise<HttpReply> {
  const forwardsBefore = jobsForwards();
  const jobsReply = seen(await stack.request(`${hostOrigin}${jobsPath}`, { headers }));
  const me = seen(await stack.request(`${hostOrigin}/_api/me`, { headers }));
  expect(jobsReply.status, `${what}: the jobs navigation status`).toBe(302);
  expect(me.status, `${what}: the /_api/me navigation status`).toBe(302);
  const jobsTarget = new URL(headerValue(jobsReply, "location"), `${hostOrigin}/`);
  const meTarget = new URL(headerValue(me, "location"), `${hostOrigin}/`);
  expect(`${jobsTarget.host}${jobsTarget.pathname}`, `${what}: the redirect target`).toBe(
    `${meTarget.host}${meTarget.pathname}`,
  );
  expect(jobsTarget.pathname, `${what}: the redirect is the auth host's /start`).toBe("/start");
  expect(headerValue(jobsReply, "cache-control"), `${what}: cache-control`).toBe(
    headerValue(me, "cache-control"),
  );
  expect(jobsForwards(), `${what}: the denial forwarded nothing`).toBe(forwardsBefore);
  return jobsReply;
}

/**
 * One dev-gateway denial against the same request on the models route: the
 * shared dev-token resolver produced the answer, so the jobs route must agree
 * byte for byte, reflect NO CORS origin, and forward nothing to jobs.
 */
async function compareDevDenial(
  what: string,
  jobsPath: string,
  modelsPath: string,
  headers: Record<string, string>,
): Promise<HttpReply> {
  const forwardsBefore = jobsForwards();
  const jobsReply = seen(await stack.request(`${stack.devGatewayOrigin}${jobsPath}`, { headers }));
  const models = seen(await stack.request(`${stack.devGatewayOrigin}${modelsPath}`, { headers }));
  expect(jobsReply.status, `${what}: the jobs route and the models route agree on status`).toBe(
    models.status,
  );
  expect(jobsReply.text, `${what}: the jobs route and the models route agree on the body`).toBe(
    models.text,
  );
  expect(acaoOf(jobsReply), `${what}: no CORS reflection on a denial`).toBeUndefined();
  expect(jobsForwards(), `${what}: the denial forwarded nothing`).toBe(forwardsBefore);
  return jobsReply;
}

// ── leak scanning (the test-8 scans) ─────────────────────────────────────────

/** One forbidden value, named only by its class — never by its bytes. */
type SealedValue = { label: string; value: string };

/**
 * The label of the first forbidden value present in `text`, or null. Messages
 * name the value CLASS and the place it was found; the value itself is never
 * printed — a leak report must not become a second copy of the leak.
 */
const leakIn = (text: string, sealed: readonly SealedValue[]): string | null => {
  for (const { label, value } of sealed) {
    if (value !== "" && text.includes(value)) return label;
  }
  return null;
};

/** The first forbidden URL attribute key present in OTLP JSON form, or null. */
const urlAttributeLeak = (text: string): string | null => {
  for (const key of FORBIDDEN_URL_ATTRS) {
    if (new RegExp(`"key"\\s*:\\s*"${key.replaceAll(".", "\\.")}"`).test(text)) {
      return `a forbidden URL attribute key (${key})`;
    }
  }
  return null;
};

// ── raw TLS (the framing case the HTTP clients cannot send) ──────────────────

/**
 * One raw request over TLS, read to end of stream — for a request whose
 * conflicting framing (`Content-Length` with `Transfer-Encoding`) node's HTTP
 * clients refuse to send. Bounded: a socket that never answers is destroyed
 * at the timeout. Resolves with the status line the reply carried, or rejects
 * naming the first bytes seen when it carried none.
 */
function rawTlsRequest(options: {
  port: number;
  servername: string;
  ca: Buffer;
  requestText: string;
  timeoutMs: number;
}): Promise<{ status: number; statusLine: string; raw: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let done = false;
    const socket = tlsConnect(
      { host: "127.0.0.1", port: options.port, servername: options.servername, ca: options.ca },
      () => socket.write(options.requestText, () => socket.end()),
    );
    const finish = (failure?: Error): void => {
      if (done) return;
      done = true;
      socket.destroy();
      const raw = Buffer.concat(chunks).toString("utf8");
      const statusLine = raw.split("\r\n")[0] ?? "";
      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(statusLine)?.[1]);
      if (Number.isFinite(status) && status > 0) resolve({ status, statusLine, raw });
      else
        reject(
          failure ??
            new Error(
              `the raw TLS request carried no status line — first bytes: ${JSON.stringify(raw.slice(0, 120))}`,
            ),
        );
    };
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.setTimeout(options.timeoutMs, () =>
      finish(new Error(`the raw TLS request saw no answer within ${options.timeoutMs}ms`)),
    );
    socket.on("error", (error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
    socket.on("close", () => finish());
  });
}

// ── the journey's lifecycle-delivery wait ────────────────────────────────────

/** The portal `/health` body's lifecycle-delivery reading. */
async function lifecycleDeliveryReading(): Promise<{ passes: number; synchronized: boolean }> {
  const res = seen(await stack.request(`${stack.portalUrl}/health`));
  expect(res.status, "portal /health status").toBe(200);
  const body = HealthStatusSchema.parse(res.json());
  const check = body.checks?.find((c) => c.name === JOBS_LIFECYCLE_DELIVERY_CHECK);
  const metrics = check?.metrics;
  if (!metrics) return { passes: 0, synchronized: false };
  return {
    passes: metrics.passes ?? 0,
    synchronized: (metrics.targets ?? 0) > 0 && metrics.synchronizedTargets === metrics.targets,
  };
}

/**
 * Wait — bounded — for a delivery pass that ENDED after `passesBefore` was
 * read, with every target synchronized.
 */
async function waitForLifecycleDelivery(passesBefore: number): Promise<void> {
  await waitFor(
    stack,
    "the portal's jobs_lifecycle_delivery check to end a pass (after the apps' creation) with every target synchronized",
    { timeoutMs: 90_000 },
    async () => {
      const reading = await lifecycleDeliveryReading();
      return reading.passes > passesBefore && reading.synchronized ? true : undefined;
    },
  );
}

// ── the suite ────────────────────────────────────────────────────────────────

describe("the assembled jobs trust boundary, through the real stack", () => {
  beforeAll(async () => {
    stack = await startRealStack({ label: "boundary", jobsLink: true, telemetry: true });
    const linkMaybe = stack.jobsLink;
    if (linkMaybe === null) throw new Error("the stack never started its edge→jobs link");
    link = linkMaybe;
    await stack.start("jobsReplica");

    origin = await startJsonOrigin();
    platform = new Pool({ connectionString: stack.platformOwnerDsn, max: 1 });
    jobsDb = new Pool({ connectionString: stack.jobsOwnerDsn, max: 1 });

    bob = await stack.portalAs("bob@azx.dev");
    alice = await stack.portalAs("alice@azx.dev");

    const passesBefore = (await lifecycleDeliveryReading()).passes;

    // App A: the jobs grant (baseline, applied now) plus one keyless fetch
    // origin (elevated — a pending request alice, a different admin, approves).
    const slugA = `tb-a-${randomBytes(3).toString("hex")}`;
    appA = await createLiveApp(stack, bob, {
      slug: slugA,
      files: { "index.html": "<h1>tb</h1>" },
    });
    const savedA = seen(
      await bob.put(`/api/v1/apps/${slugA}/manifest`, {
        capabilities: {
          mcp: [],
          externalOrigins: [],
          fetch: { shim: false, origins: [{ origin: origin.origin }] },
          jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE] },
        },
      }),
    );
    expect(savedA.status, "app A's grant save").toBe(200);
    const saveA = ManifestUpdateResultSchema.parse(savedA.json());
    expect(
      saveA.applied.some((d) => d.path === `jobs.types[+${JOBS_FETCH_QUALIFIED_TYPE}]`),
      "app A's jobs grant is baseline-applied",
    ).toBe(true);
    const pendingId = must(saveA.pending ?? undefined, "app A's pending approval id");
    const approved = seen(await alice.post(`/api/v1/approvals/${pendingId}/approve`));
    expect(approved.status, "alice's approval of app A's fetch origin").toBe(200);

    // App B: the jobs grant only — baseline, applied immediately, no approval.
    const slugB = `tb-b-${randomBytes(3).toString("hex")}`;
    appB = await createLiveApp(stack, bob, {
      slug: slugB,
      files: { "index.html": "<h1>tb</h1>" },
    });
    const savedB = seen(
      await bob.put(`/api/v1/apps/${slugB}/manifest`, {
        capabilities: {
          mcp: [],
          externalOrigins: [],
          fetch: { shim: false, origins: [] },
          jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE] },
        },
      }),
    );
    expect(savedB.status, "app B's grant save").toBe(200);
    expect(
      ManifestUpdateResultSchema.parse(savedB.json()).pending,
      "app B's jobs-only grant needs no approval",
    ).toBeNull();

    await waitForLifecycleDelivery(passesBefore);

    bobA = await sessionIn(appA.slug, "bob@azx.dev");
    bobB = await sessionIn(appB.slug, "bob@azx.dev");
    danaA = await sessionIn(appA.slug, "dana@azx.dev");
    aliceA = await sessionIn(appA.slug, "alice@azx.dev");
    // Every session actually authenticated on its own host — the gate admits it.
    for (const session of [bobA, bobB, danaA, aliceA]) {
      const page = seen(await session.navigate("/"));
      expect(page.status, `the session for ${session.slug} serves the app`).toBe(200);
    }

    const minted = seen(
      await bob.post(`/api/v1/apps/${slugA}/dev-tokens`, { origins: [DEV_TOKEN_ORIGIN] }),
      MINT_REPLY_WHAT,
    );
    expect(minted.status, "bob's dev-token mint").toBe(201);
    devToken = (minted.json() as { token: string }).token;
    dev = stack.devClient(appA.slug, devToken, DEV_TOKEN_ORIGIN);
  }, 300_000);

  afterAll(async () => {
    await origin?.close();
    await platform?.end();
    await jobsDb?.end();
    if (stack) await stack.close();
  });

  test(
    "hosted-app jobs routes keep the existing serving and session gate answers",
    { timeout: 120_000 },
    async () => {
      const appAOrigin = stack.appOrigin(appA.slug);
      const appBOrigin = stack.appOrigin(appB.slug);
      const wfId = randomUUID();

      // No session: every jobs route answers the session gate's own 401 —
      // byte-identical to /_api/me on the same host — and forwards nothing.
      // A jobs-specific answer would tell an unauthenticated caller that the
      // route exists behind the gate; identical bytes disclose nothing.
      const noCookie = apiHeaders(appAOrigin);
      for (const [what, method, path] of [
        ["the no-cookie submit", "POST", SUBMIT_PATH],
        ["the no-cookie status read", "GET", statusPath(wfId)],
        ["the no-cookie cancel", "DELETE", statusPath(wfId)],
      ] as const) {
        const reply = await compareWithMe(what, appAOrigin, method, path, noCookie);
        expect(reply.status, `${what}: the gate's 401`).toBe(401);
        expect(
          JobRequestErrorSchema.safeParse(reply.json()).success,
          `${what}: the gate body is not a jobs error envelope`,
        ).toBe(false);
      }

      // Navigation: the gate's login redirect — the same target /_api/me gets.
      await compareNavigationWithMe(
        "the no-cookie jobs navigation",
        appAOrigin,
        statusPath(wfId),
        NAV_HEADERS,
      );

      // A cookie is a principal only on the host that minted it: app A's
      // session on app B's host, and a garbage cookie value, are both just
      // "no session" — the same 401 as no cookie at all.
      await compareWithMe("app A's cookie on app B's host", appBOrigin, "GET", statusPath(wfId), {
        ...apiHeaders(appBOrigin),
        Cookie: bobA.cookie,
      });
      const garbageValue = randomBytes(32).toString("base64url");
      sessionCookieValues.push(garbageValue);
      await compareWithMe("a garbage session cookie", appAOrigin, "GET", statusPath(wfId), {
        ...apiHeaders(appAOrigin),
        Cookie: `__Host-session=${garbageValue}`,
      });

      // Refresh due (a deliberate time-travel write on the session row): the
      // API path's authorization boundary and the navigation's silent-refresh
      // redirect — exactly what /_api/me answers with the same session.
      const aliceB = await sessionIn(appB.slug, "alice@azx.dev");
      const tokenValue = aliceB.cookie.slice("__Host-session=".length);
      await platform.query(`UPDATE sessions SET "refreshDueAt" = $1 WHERE "tokenHash" = $2`, [
        new Date(Date.now() - 60_000),
        createHash("sha256").update(tokenValue, "utf8").digest("hex"),
      ]);
      const refreshApi = await compareWithMe(
        "the refresh-due status read",
        appBOrigin,
        "GET",
        statusPath(wfId),
        { ...apiHeaders(appBOrigin), Cookie: aliceB.cookie },
      );
      expect(envelopeErrorCode(refreshApi), "the refresh-due denial's code").toBe(
        "refresh_required",
      );
      await compareNavigationWithMe("the refresh-due navigation", appBOrigin, statusPath(wfId), {
        ...NAV_HEADERS,
        Cookie: aliceB.cookie,
      });

      // Cross-origin mutations with a VALID session: the session gate passes,
      // and the jobs check's own CSRF seam answers — a jobs error envelope,
      // no-store, and nothing forwarded. (Reads have no origin check by
      // design; the submit and the cancel are the state-changers.)
      const crossHeaders = (cookie: string): Record<string, string> => ({
        Origin: "https://evil.example",
        "Sec-Fetch-Site": "cross-site",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Dest": "empty",
        Cookie: cookie,
      });
      const forwardsBefore = jobsForwards();
      const csrfSubmit = seen(
        await stack.request(`${appAOrigin}${SUBMIT_PATH}`, {
          method: "POST",
          headers: crossHeaders(bobA.cookie),
        }),
      );
      const csrfCancel = seen(
        await stack.request(`${appAOrigin}${statusPath(wfId)}`, {
          method: "DELETE",
          headers: crossHeaders(bobA.cookie),
        }),
      );
      for (const [what, reply] of [
        ["the cross-origin submit", csrfSubmit],
        ["the cross-origin cancel", csrfCancel],
      ] as const) {
        expect(reply.status, `${what}: the CSRF refusal`).toBe(403);
        expect(JobRequestErrorSchema.parse(reply.json()).code, `${what}: the CSRF code`).toBe(
          "forbidden",
        );
        expect(String(reply.headers["cache-control"]), `${what}: cache-control`).toContain(
          "no-store",
        );
      }
      expect(jobsForwards(), "the CSRF refusals forwarded nothing").toBe(forwardsBefore);
    },
  );

  test(
    "the dev gateway keeps its token and origin denials and reflects only a registered origin",
    { timeout: 120_000 },
    async () => {
      const wfId = randomUUID();
      const unknownId = randomUUID();
      const jobsPathFor = (slug: string): string => `/${slug}/_api/jobs/jobs/${wfId}`;
      const modelsPathFor = (slug: string): string => `/${slug}/_api/openai/v1/models`;

      // Every dev-gateway denial: the jobs route answers exactly what the
      // models route answers with the same credentials (the denial is the
      // shared dev-token resolver's), reflects no CORS origin, and forwards
      // nothing. A jobs route that answered differently — or reflected an
      // unregistered origin — would disclose the capability behind an
      // unauthenticated caller.
      const denials: Array<{
        what: string;
        slug: string;
        headers: Record<string, string>;
        status: number;
      }> = [
        { what: "no authorization", slug: appA.slug, headers: {}, status: 401 },
        {
          what: "a garbage bearer",
          slug: appA.slug,
          headers: { Authorization: "Bearer garbage" },
          status: 401,
        },
        {
          what: "an unregistered origin",
          slug: appA.slug,
          headers: { Authorization: `Bearer ${devToken}`, Origin: FOREIGN_ORIGIN },
          status: 403,
        },
        {
          what: "no origin header",
          slug: appA.slug,
          headers: { Authorization: `Bearer ${devToken}` },
          status: 403,
        },
        {
          what: "origin null",
          slug: appA.slug,
          headers: { Authorization: `Bearer ${devToken}`, Origin: "null" },
          status: 403,
        },
        {
          what: "another app's path",
          slug: appB.slug,
          headers: { Authorization: `Bearer ${devToken}`, Origin: DEV_TOKEN_ORIGIN },
          status: 403,
        },
        {
          what: "a session cookie and no bearer",
          slug: appA.slug,
          headers: { Cookie: bobA.cookie, Origin: DEV_TOKEN_ORIGIN },
          status: 401,
        },
      ];
      for (const d of denials) {
        const reply = await compareDevDenial(
          d.what,
          jobsPathFor(d.slug),
          modelsPathFor(d.slug),
          d.headers,
        );
        expect(reply.status, `${d.what}: the denial status`).toBe(d.status);
      }

      // A dev token is not an app-host principal: presented to the app host it
      // is ignored exactly like no credential at all.
      const appAOrigin = stack.appOrigin(appA.slug);
      const meNoCookie = seen(
        await stack.request(`${appAOrigin}/_api/me`, { headers: apiHeaders(appAOrigin) }),
      );
      const meDevToken = seen(
        await stack.request(`${appAOrigin}/_api/me`, {
          headers: { ...apiHeaders(appAOrigin), Authorization: `Bearer ${devToken}` },
        }),
      );
      expect(meDevToken.status, "the dev bearer on the app host: status").toBe(meNoCookie.status);
      expect(meDevToken.text, "the dev bearer on the app host: body").toBe(meNoCookie.text);

      // Preflight: 204 with the registered origin reflected exactly; a foreign
      // origin gets 403 and no reflection — the browser's own gate.
      const preflight = seen(
        await stack.request(`${stack.devGatewayOrigin}/${appA.slug}/_api/jobs/jobs/types/fetch`, {
          method: "OPTIONS",
          headers: { Origin: DEV_TOKEN_ORIGIN, "Access-Control-Request-Method": "POST" },
        }),
      );
      expect(preflight.status, "the registered preflight").toBe(204);
      expect(acaoOf(preflight), "the registered preflight's reflection").toBe(DEV_TOKEN_ORIGIN);
      const refusedPreflight = seen(
        await stack.request(`${stack.devGatewayOrigin}/${appA.slug}/_api/jobs/jobs/types/fetch`, {
          method: "OPTIONS",
          headers: { Origin: FOREIGN_ORIGIN, "Access-Control-Request-Method": "POST" },
        }),
      );
      expect(refusedPreflight.status, "the foreign preflight").toBe(403);
      expect(acaoOf(refusedPreflight), "the foreign preflight reflects nothing").toBeUndefined();

      // Positive control, last: the same token from the registered origin
      // reaches jobs — the unknown-job 404 — with the registered origin
      // reflected, Vary: Origin, and no-store. This one IS forwarded.
      const forwardsBefore = jobsForwards();
      const ok = seen(await dev.api("GET", `/_api/jobs/jobs/${unknownId}`));
      expect(ok.status, "the registered-origin status read of an unknown job").toBe(404);
      expect(JobRequestErrorSchema.parse(ok.json()).code, "the unknown-job code").toBe(
        "job_not_found",
      );
      expect(acaoOf(ok), "the positive control's reflection").toBe(DEV_TOKEN_ORIGIN);
      expect(varyIncludesOrigin(ok), "the positive control's Vary: Origin").toBe(true);
      expect(String(ok.headers["cache-control"]), "the positive control's cache-control").toContain(
        "no-store",
      );
      expect(jobsForwards(), "exactly the positive control was forwarded").toBe(forwardsBefore + 1);
    },
  );

  test(
    "a real submission carries only the edge's own instruction and attribution",
    { timeout: 120_000 },
    async () => {
      origin.respond("/s1", { json: { ok: true, secret: RESULT_SECRET } });
      holdS1 = origin.hold("/s1");

      // The smuggled headers impersonate the platform's own seams: a forged
      // instruction, a grafted trace, spoofed forwarding and attribution. The
      // edge must mint its OWN instruction from the session — none of the
      // caller's values may survive the forward.
      const body = JSON.stringify({ url: `${origin.origin}/s1?token=${QUERY_SECRET}` });
      const forwardsBefore = jobsForwards();
      const smuggled: Record<string, string> = {
        [INSTRUCTION_HEADER]: SMUGGLED_INSTRUCTION,
        traceparent: PLANTED_TRACEPARENT,
        tracestate: `vendor=${PLANT}`,
        "x-forwarded-host": `evil-${PLANT}.example`,
        forwarded: `host=evil-${PLANT}`,
        "x-helix-owner": PLANT,
        "x-helix-env": "dev",
      };
      const submitted = await submitJob(bobA.api, K1, body, edgeAttempts, smuggled);
      expect(submitted.status, "the smuggled submission").toBe(202);
      const accepted = JobAcceptedSchema.parse(submitted.json());
      expect(accepted.server, "the acceptance's server").toBe("jobs");
      s1JobId = accepted.jobId;

      // What actually reached the jobs plane: the last submit forward this
      // call produced (a 503 retry would have produced two).
      const entries = link.forwarded
        .slice(forwardsBefore)
        .filter((e) => e.method === "POST" && e.path === "/internal/jobs/v1/jobs");
      expect(entries.length, "the submission was forwarded").toBeGreaterThanOrEqual(1);
      const entry = must(entries[entries.length - 1], "the forwarded submit entry");
      s1Token = valueOf(entry.headers, INSTRUCTION_HEADER);
      s1Body = Buffer.from(entry.body);

      // The instruction is the edge's own mint, never the smuggled value; no
      // planted value survives in any forwarded header — the retry key is the
      // one legitimate carrier, and it must be exactly the caller's key (the
      // receiver verifies the signed claim against the presented header); and
      // the trace is the edge's own root, never the planted one.
      expect(s1Token, "the forwarded instruction is present").toBeTruthy();
      expect(s1Token, "the smuggled instruction never travelled").not.toBe(SMUGGLED_INSTRUCTION);
      for (const [name, value] of Object.entries(entry.headers)) {
        const text = Array.isArray(value) ? value.join(", ") : (value ?? "");
        if (name === "idempotency-key") {
          expect(text, "the forwarded retry key is the caller's own").toBe(K1);
        } else {
          expect(
            text.includes(PLANT),
            `the forwarded header "${name}" carries no planted value`,
          ).toBe(false);
        }
      }
      // Telemetry is on, so the edge injects its own context on the hop: a
      // fresh trace id, never the planted one. Test 8 looks for this id in
      // the exported spans as proof that ids are exported in this encoding.
      const forwardedTraceparent = valueOf(entry.headers, "traceparent");
      const forwardedTraceId = forwardedTraceparent.split("-")[1] ?? "";
      expect(forwardedTraceId, "the edge injected its own trace context").toMatch(/^[0-9a-f]{32}$/);
      expect(forwardedTraceId, "the forwarded trace is the edge's own").not.toBe(PLANTED_TRACE_ID);
      edgeSubmitTraceId = forwardedTraceId;
      expect(
        entry.body.equals(Buffer.from(body)),
        "the forwarded body is the submitted bytes",
      ).toBe(true);

      // The instruction's identity is the edge's own trusted attribution: the
      // session's principal, the app's prod partition, the caller's retry
      // key, and the exact submitted bytes.
      s1Claims = decodeClaims(must(s1Token, "the forwarded instruction"));
      expect(s1Claims["appId"], "the instruction's app").toBe(appA.id);
      expect(s1Claims["env"], "the instruction's environment").toBe("prod");
      expect(s1Claims["ownerKind"], "the instruction's principal kind").toBe("user");
      expect(s1Claims["idempotencyKey"], "the instruction's retry key").toBe(K1);
      expect(s1Claims["bodySha256"], "the instruction's body digest").toBe(
        sha256BodyDigest(must(s1Body, "the forwarded body")),
      );

      // The job is admitted and running: its governed GET — keyless — is held
      // at the origin for the instruction tests that follow.
      let lastStatus: string | undefined;
      await waitFor(
        stack,
        () =>
          `the S1 job to read "running" while held at the origin — last snapshot status: ` +
          (lastStatus ?? "<none>"),
        { timeoutMs: 30_000 },
        async () => {
          const snap = seen(await bobA.api("GET", statusPath(must(s1JobId, "the S1 job id"))));
          if (snap.status !== 200) return undefined;
          const snapshot = JobSnapshotSchema.parse(snap.json());
          lastStatus = snapshot.status;
          return snapshot.status === "running" ? true : undefined;
        },
      );
      await holdS1.arrived;
    },
  );

  test(
    "edge→jobs instructions fail before effects when replayed, altered, redirected or raced, across a restart and a replica",
    { timeout: 300_000 },
    async () => {
      const jobId = must(s1JobId, "the S1 job id");
      const submitToken = must(s1Token, "the S1 submit instruction");
      const submitBody = must(s1Body, "the S1 submit body");
      instructionTokens.push(submitToken);

      const jobsUrl = `http://localhost:${stack.ports.jobs}`;
      const replicaUrl = `http://localhost:${stack.ports.jobsReplica}`;
      const submitResource = "/internal/jobs/v1/jobs";
      const snapshotPath = `/internal/jobs/v1/jobs/${jobId}`;

      const count = async (): Promise<number> => {
        const res = await jobsDb.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM jobs.job_record WHERE app_id = $1`,
          [appA.id],
        );
        return must(res.rows[0], "the job_record count row").n;
      };
      // The count every refusal must preserve — the submit race legitimately
      // advances it by one, and the refusals after it answer against that.
      let current = await count();

      /** Present one instruction directly to a jobs process, as the relay would. */
      const present = (
        base: string,
        method: string,
        path: string,
        token: string,
        body?: Buffer,
        extraHeaders: Record<string, string> = {},
      ): Promise<HttpReply> =>
        stack
          .request(`${base}${path}`, {
            method,
            headers: {
              [INSTRUCTION_HEADER]: token,
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
              ...extraHeaders,
            },
            ...(body === undefined ? {} : { body }),
          })
          .then(seen);

      /** Every refusal: the fixed 401 envelope, and no new record for app A. */
      const expectRefused = async (what: string, reply: HttpReply) => {
        expect(reply.status, `${what}: the refusal status`).toBe(401);
        expect(JobRequestErrorSchema.parse(reply.json()).code, `${what}: the refusal code`).toBe(
          "unauthorized",
        );
        expect(await count(), `${what}: no job record was created`).toBe(current);
      };

      // A capture-and-replay of the captured submit, at both receivers: the
      // nonce burn is the shared durable store's, so the receiver that never
      // saw the original refuses the replay too — and nothing is admitted.
      const replayJobs = await present(jobsUrl, "POST", submitResource, submitToken, submitBody, {
        "Idempotency-Key": K1,
      });
      await expectRefused("the captured submit replayed to jobs", replayJobs);
      const replayReplica = await present(
        replicaUrl,
        "POST",
        submitResource,
        submitToken,
        submitBody,
        { "Idempotency-Key": K1 },
      );
      await expectRefused("the captured submit replayed to the replica", replayReplica);

      // A tampered forward: the instruction binds the exact body bytes, so an
      // attacker who alters the target after capturing the token still gets
      // the refusal — the digest, not the header, decides.
      const altered = await present(
        jobsUrl,
        "POST",
        submitResource,
        submitToken,
        Buffer.from(JSON.stringify({ url: `${origin.origin}/altered` })),
        { "Idempotency-Key": K1 },
      );
      await expectRefused("the submit token over an altered body", altered);

      // Cross-operation reuse: a submit token presented at the cancel and
      // lifecycle routes never verifies — the operation comes from the ROUTE
      // and the claim schemas are discriminated by it, so one leaked token
      // cannot operate on other seams.
      const asCancel = await present(jobsUrl, "DELETE", snapshotPath, submitToken);
      await expectRefused("the submit token at the cancel route", asCancel);
      const asLifecycle = await present(
        jobsUrl,
        "POST",
        `/internal/jobs/v1/lifecycle/${appA.id}`,
        submitToken,
        submitBody,
      );
      await expectRefused("the submit token at the lifecycle route", asLifecycle);

      // A fresh snapshot token, captured from the edge's own forward of one
      // bobA status read — the interception material an on-path attacker has.
      const captureForwards = jobsForwards();
      const captureRead = seen(await bobA.api("GET", statusPath(jobId)));
      expect(captureRead.status, "the snapshot capture read").toBe(200);
      const snapEntries = link.forwarded
        .slice(captureForwards)
        .filter((e) => e.method === "GET" && e.path === snapshotPath);
      expect(snapEntries.length, "the status read was forwarded exactly once").toBe(1);
      const snapToken = valueOf(
        must(snapEntries[0], "the forwarded snapshot entry").headers,
        INSTRUCTION_HEADER,
      );
      expect(snapToken, "the forwarded snapshot instruction is present").toBeTruthy();
      instructionTokens.push(snapToken);

      // The snapshot token off its own route and off its own receiver: every
      // presentation is refused before any effect.
      const atResult = await present(jobsUrl, "GET", `${snapshotPath}/result`, snapToken);
      await expectRefused("the snapshot token at the result route", atResult);
      const asDelete = await present(jobsUrl, "DELETE", snapshotPath, snapToken);
      await expectRefused("the snapshot token as a cancel", asDelete);
      const snapReplay = await present(jobsUrl, "GET", snapshotPath, snapToken);
      await expectRefused("the snapshot token replayed to jobs", snapReplay);
      const snapReplayReplica = await present(replicaUrl, "GET", snapshotPath, snapToken);
      await expectRefused("the snapshot token replayed to the replica", snapReplayReplica);

      const identity = s1Identity();

      // The fixed unknown-job 404 body — from a valid instruction for a
      // well-formed id nobody created — is the byte-identity comparator for
      // every ownership refusal below.
      const unknownId = randomUUID();
      const unknownReply = await present(
        jobsUrl,
        "GET",
        `/internal/jobs/v1/jobs/${unknownId}`,
        await mintSnapshot(identity, unknownId, nowS()),
      );
      expect(unknownReply.status, "the unknown-job read").toBe(404);
      expect(JobRequestErrorSchema.parse(unknownReply.json()).code, "the unknown-job code").toBe(
        "job_not_found",
      );
      const unknownBody = unknownReply.text;

      // Positive control: the receiver serves an insider-valid snapshot of
      // S1 — every refusal below is about the claim that differs, never
      // about the presentation.
      const positive = await present(
        jobsUrl,
        "GET",
        snapshotPath,
        await mintSnapshot(identity, jobId, nowS()),
      );
      expect(positive.status, "the insider-valid snapshot of S1").toBe(200);
      expect(JobSnapshotSchema.parse(positive.json()).jobId, "the positive control's job").toBe(
        jobId,
      );

      // The receiver rechecks ownership against the record: an instruction
      // naming another owner, another app, the other environment tier or the
      // other principal kind gets the SAME 404 an unknown job gets — nothing
      // tells an insider that S1 exists.
      for (const [what, variant] of [
        ["another owner's oid", { ...identity, ownerOid: `${identity.ownerOid}-other` }],
        ["another app's id", { ...identity, appId: appB.id }],
        ["the other environment tier", { ...identity, env: "dev" }],
        ["the other principal kind", { ...identity, ownerKind: "dev" }],
      ] as const) {
        const reply = await present(
          jobsUrl,
          "GET",
          snapshotPath,
          await mintSnapshot(variant, jobId, nowS()),
        );
        expect(reply.status, `${what}: the ownership refusal`).toBe(404);
        expect(reply.text, `${what}: the refusal is the unknown-job body`).toBe(unknownBody);
        expect(await count(), `${what}: no job record was created`).toBe(current);
      }

      // Verified identity with no type authority: 403, never a snapshot.
      const ungranted = await present(
        jobsUrl,
        "GET",
        snapshotPath,
        await mintSnapshot({ ...identity, allowedTypes: [] }, jobId, nowS()),
      );
      expect(ungranted.status, "the ungranted snapshot").toBe(403);
      expect(JobRequestErrorSchema.parse(ungranted.json()).code, "the ungranted code").toBe(
        "forbidden",
      );
      expect(await count(), "the ungranted snapshot created no job record").toBe(current);

      // Wrong direction: the positive control's claims signed with the other
      // directions' keys — the signature is the direction gate, and a key for
      // one hop is worthless on another.
      for (const [what, direction] of [
        ["the jobs→edge key", "jobsToEdge"],
        ["the portal→jobs key", "portalToJobs"],
      ] as const) {
        const wrongKey = await present(
          jobsUrl,
          "GET",
          snapshotPath,
          await mintInstruction(
            { operation: "snapshot", server: JOBS_SERVER_ID, identity, jobId, iatS: nowS() },
            deriveJobsInstructionKey(jobsRoots()[direction], direction),
          ),
        );
        await expectRefused(`a snapshot signed with ${what}`, wrongKey);
      }

      // One nonce, two receivers, one burn: whichever receiver's burn lands
      // first admits exactly one presentation.
      const raceToken = await mintSnapshot(identity, jobId, nowS());
      const raceReplies = await Promise.all([
        present(jobsUrl, "GET", snapshotPath, raceToken),
        present(replicaUrl, "GET", snapshotPath, raceToken),
      ]);
      expect(
        raceReplies.map((r) => r.status).sort((a, b) => a - b),
        "the snapshot race: exactly one receiver admitted it",
      ).toEqual([200, 401]);
      expect(await count(), "the snapshot race created no job record").toBe(current);

      // The same race on a submission: exactly one admission, one record.
      origin.respond("/race", { json: { race: true } });
      const raceBody = Buffer.from(JSON.stringify({ url: `${origin.origin}/race` }));
      const raceSubmitToken = await mintInstruction(
        {
          operation: "submit",
          server: JOBS_SERVER_ID,
          identity,
          type: JOBS_FETCH_QUALIFIED_TYPE,
          generation: claimString("generation"),
          idempotencyKey: null,
          body: raceBody,
          iatS: nowS(),
        },
        edgeToJobsKey(),
      );
      const raceSubmitReplies = await Promise.all([
        present(jobsUrl, "POST", submitResource, raceSubmitToken, raceBody),
        present(replicaUrl, "POST", submitResource, raceSubmitToken, raceBody),
      ]);
      expect(
        raceSubmitReplies.map((r) => r.status).sort((a, b) => a - b),
        "the submit race: exactly one receiver admitted it",
      ).toEqual([202, 401]);
      expect(await count(), "the submit race created exactly one job record").toBe(current + 1);
      current += 1;

      // The burn outlives the receiver: spend a token, restart the process,
      // present it again inside its own validity window — still a replay.
      // Minted at the edge of the window so the restart's room cannot turn
      // the replay into an expiry refusal; if it lapses anyway, the replay
      // proves nothing and says so.
      const restartIat = nowS() + 4;
      const restartToken = await mintSnapshot(identity, jobId, restartIat);
      const spentBefore = await present(jobsUrl, "GET", snapshotPath, restartToken);
      expect(spentBefore.status, "the restart token's first presentation").toBe(200);
      await stack.restart("jobs");
      if (
        nowS() >
        restartIat +
          JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS +
          JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS
      ) {
        throw new Error(
          "the post-restart replay proved nothing: the token left its validity window while the service restarted, so a refusal would be an expiry refusal, not a replay refusal",
        );
      }
      const spentAfter = await present(jobsUrl, "GET", snapshotPath, restartToken);
      await expectRefused("the restart token presented again after the restart", spentAfter);

      // A redelivery of the state the portal already delivered: acknowledged
      // at the current watermark — and a second presentation of the same
      // token is a replay at the other receiver.
      const generation = claimString("generation");
      const redeliveryBody = Buffer.from(JSON.stringify({ generation, archived: false }));
      const redeliveryToken = await mintInstruction(
        {
          operation: "lifecycle",
          server: JOBS_SERVER_ID,
          appId: appA.id,
          body: redeliveryBody,
          iatS: nowS(),
        },
        portalToJobsKey(),
      );
      const redelivery = await present(
        jobsUrl,
        "POST",
        `/internal/jobs/v1/lifecycle/${appA.id}`,
        redeliveryToken,
        redeliveryBody,
      );
      expect(redelivery.status, "the lifecycle redelivery's acknowledgement").toBe(200);
      const ack = JSON.parse(redelivery.text) as { appliedGeneration?: unknown };
      expect(ack.appliedGeneration, "the redelivery's watermark is unchanged").toBe(generation);
      const redeliveryReplica = await present(
        replicaUrl,
        "POST",
        `/internal/jobs/v1/lifecycle/${appA.id}`,
        redeliveryToken,
        redeliveryBody,
      );
      await expectRefused("the lifecycle token replayed to the replica", redeliveryReplica);

      // An archive signed with the EDGE's key would close the app's open
      // work — cancel every running job — if the direction key were not the
      // gate. The refusal must leave S1 untouched.
      const archiveBody = Buffer.from(JSON.stringify({ generation, archived: true }));
      const archive = await present(
        jobsUrl,
        "POST",
        `/internal/jobs/v1/lifecycle/${appA.id}`,
        await mintInstruction(
          {
            operation: "lifecycle",
            server: JOBS_SERVER_ID,
            appId: appA.id,
            body: archiveBody,
            iatS: nowS(),
          },
          edgeToJobsKey(),
        ),
        archiveBody,
      );
      await expectRefused("a lifecycle archive signed with the edge's key", archive);

      // Nothing above reached S1: no replay, tamper, race or wrong-direction
      // mint cancelled it.
      const s1After = seen(await bobA.api("GET", statusPath(jobId)));
      expect(s1After.status, "the S1 snapshot after every refusal").toBe(200);
      expect(
        JobSnapshotSchema.parse(s1After.json()).cancellationRequested,
        "no refused instruction cancelled S1",
      ).toBe(false);
    },
  );

  test(
    "the jobs→edge callback is served only on the platform host and burns across an edge restart",
    { timeout: 240_000 },
    async () => {
      const jobId = must(s1JobId, "the S1 job id");
      origin.respond("/cb", { json: { cb: true } });
      const cbBody = Buffer.from(
        JSON.stringify({ url: `${origin.origin}/cb?token=${QUERY_SECRET}` }),
      );

      // The callback an executing job would present: the jobs→edge key, the
      // job's own identity and generation. Minted at the edge of its validity
      // window so the restart below cannot turn the final replay into an
      // expiry refusal.
      const cbIat = nowS() + 4;
      const cbToken = await mintInstruction(
        {
          operation: "fetch",
          server: JOBS_SERVER_ID,
          identity: {
            appId: claimString("appId"),
            env: claimEnv(),
            ownerKind: claimOwnerKind(),
            ownerOid: claimString("ownerOid"),
            type: JOBS_FETCH_QUALIFIED_TYPE,
          },
          jobId,
          generation: claimString("generation"),
          body: cbBody,
          iatS: cbIat,
        },
        jobsToEdgeKey(),
      );

      const cbSeen = (): number => origin.requests.filter((r) => r.path.startsWith("/cb")).length;
      const cbBefore = cbSeen();
      const presentCallback = (url: string, cookie?: string): Promise<HttpReply> =>
        stack
          .request(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              [INSTRUCTION_HEADER]: cbToken,
              ...(cookie === undefined ? {} : { Cookie: cookie }),
            },
            body: cbBody,
          })
          .then(seen);

      // The receiver is the platform host only: a hosted app must not be able
      // to present instructions at its own host (even with a valid session),
      // and the dev gateway's app-scoped path is no receiver either. Neither
      // presentation may produce the outbound call.
      const atAppHost = await presentCallback(
        `${stack.appOrigin(appA.slug)}/internal/jobs/v1/fetch`,
        bobA.cookie,
      );
      expect(atAppHost.status, "the callback presented at the app host").toBe(404);
      const atDevScoped = await presentCallback(
        `${stack.devGatewayOrigin}/${appA.slug}/internal/jobs/v1/fetch`,
      );
      expect(atDevScoped.status, "the callback at the dev gateway's app-scoped path").not.toBe(200);
      expect(cbSeen(), "the misrouted presentations caused no outbound call").toBe(cbBefore);

      // The platform host dispatches: the one governed GET — keyless, the
      // platform's own egress authority, no session and no bearer.
      const platformCallbackUrl = `https://${stack.baseDomain}:${stack.ports.edge}/internal/jobs/v1/fetch`;
      const dispatched = await presentCallback(platformCallbackUrl);
      expect(dispatched.status, "the callback at the platform host").toBe(200);
      expect(String(dispatched.headers["cache-control"]), "the dispatch's cache-control").toContain(
        "no-store",
      );
      const cbRequests = origin.requests.filter((r) => r.path.startsWith("/cb"));
      expect(cbRequests.length, "exactly one /cb request arrived").toBe(cbBefore + 1);
      const outbound = must(cbRequests[cbRequests.length - 1], "the dispatched /cb request");
      expect(outbound.method, "the dispatched method").toBe("GET");
      expect(
        outbound.headers["authorization"],
        "no credential leaked to the origin",
      ).toBeUndefined();
      expect(outbound.headers["cookie"], "no session leaked to the origin").toBeUndefined();

      // The burn: the same token never dispatches twice — at the production
      // edge as a replay…
      const replayed = await presentCallback(platformCallbackUrl);
      expect(replayed.status, "the callback replayed at the platform host").toBe(401);
      expect(JobRequestErrorSchema.parse(replayed.json()).code, "the replay's code").toBe(
        "unauthorized",
      );

      // …and at the dev gateway's own receiver as the wrong tier: the same
      // root verifies it, and the tier seam refuses a prod-tier instruction
      // before the dev nonce space or any dispatch is touched.
      const wrongTier = await presentCallback(`${stack.devGatewayOrigin}/internal/jobs/v1/fetch`);
      expect(wrongTier.status, "the prod callback at the dev gateway's receiver").toBe(403);
      expect(JobRequestErrorSchema.parse(wrongTier.json()).code, "the wrong tier's code").toBe(
        "forbidden",
      );

      // The burn outlives the edge: restart the receiver, replay inside the
      // validity window — the nonce is still spent.
      await stack.restart("edge");
      if (
        nowS() >
        cbIat + JOBS_INSTRUCTION_MAX_LIFETIME_SECONDS + JOBS_INSTRUCTION_CLOCK_TOLERANCE_SECONDS
      ) {
        throw new Error(
          "the post-restart callback replay proved nothing: the token left its validity window while the edge restarted, so a refusal would be an expiry refusal, not a replay refusal",
        );
      }
      const afterRestart = await presentCallback(platformCallbackUrl);
      expect(afterRestart.status, "the callback replayed after the edge's restart").toBe(401);
      expect(cbSeen(), "the restart changed nothing about the one dispatched call").toBe(
        cbBefore + 1,
      );

      // Release the held S1 execution. The jobs restart in the previous test
      // lost its single attempt — the platform's recovery projects that
      // truthfully (a crashed or timeout terminal) and never re-runs it;
      // what this suite proves is that NOTHING here cancelled it.
      holdS1?.release();
      let lastStatus: string | undefined;
      const final = await waitFor(
        stack,
        () =>
          `the S1 job to reach a terminal outcome after the hold's release — last snapshot status: ` +
          (lastStatus ?? "<none>"),
        { timeoutMs: 120_000 },
        async () => {
          const snap = seen(await bobA.api("GET", statusPath(jobId)));
          if (snap.status !== 200) return undefined;
          const snapshot = JobSnapshotSchema.parse(snap.json());
          lastStatus = snapshot.status;
          return (JOB_TERMINAL_STATUSES as readonly string[]).includes(snapshot.status)
            ? snapshot
            : undefined;
        },
      );
      expect(final.cancellationRequested, "no instruction test ever cancelled S1").toBe(false);
      expect(
        ["crashed", "failed"],
        `S1's terminal outcome is the interrupted execution's own truth, never a cancellation: ${final.status}`,
      ).toContain(final.status);
    },
  );

  test(
    "oversized and conflicting-framing submissions are refused at the edge",
    { timeout: 120_000 },
    async () => {
      // Exactly one byte over the platform's input bound, still valid JSON:
      // the refusal is the bound's own 413 — before anything is forwarded or
      // run, and with no instruction ever minted.
      const oversizeUrl = `${origin.origin}/s1`;
      const emptyPad = JSON.stringify({ url: oversizeUrl, pad: "" });
      const oversizedBody = JSON.stringify({
        url: oversizeUrl,
        pad: "x".repeat(JOBS_MAX_INPUT_BYTES + 1 - emptyPad.length),
      });
      expect(
        Buffer.byteLength(oversizedBody, "utf8"),
        "the oversized body is exactly one byte over the input bound",
      ).toBe(JOBS_MAX_INPUT_BYTES + 1);
      const forwardsBefore = jobsForwards();
      const oversized = await submitJob(bobA.api, randomUUID(), oversizedBody, edgeAttempts);
      expect(oversized.status, "the oversized submission's refusal").toBe(413);
      expect(
        JobRequestErrorSchema.parse(oversized.json()).code,
        "the oversized refusal's code",
      ).toBe("payload_too_large");
      expect(jobsForwards(), "the oversized submission forwarded nothing").toBe(forwardsBefore);

      // Conflicting framing — Content-Length AND Transfer-Encoding on one
      // request — is request-smuggling material the HTTP clients cannot send.
      // Raw over TLS: the platform refuses it at the message level, before
      // any route, session posturing or forward runs — the valid session and
      // origin headers change nothing about a request that is not well-formed
      // HTTP.
      const appAHost = `${appA.slug}.${stack.baseDomain}`;
      const requestText =
        `POST ${SUBMIT_PATH} HTTP/1.1\r\n` +
        `Host: ${appAHost}:${stack.ports.edge}\r\n` +
        `Cookie: ${bobA.cookie}\r\n` +
        `Origin: ${stack.appOrigin(appA.slug)}\r\n` +
        "Sec-Fetch-Site: same-origin\r\n" +
        "Sec-Fetch-Mode: cors\r\n" +
        "Sec-Fetch-Dest: empty\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 5\r\n" +
        "Transfer-Encoding: chunked\r\n" +
        "\r\n" +
        "5\r\nhello\r\n0\r\n\r\n";
      const forwardsBeforeFraming = jobsForwards();
      const framing = await rawTlsRequest({
        port: must(stack.ports.edge, "the edge's port"),
        servername: appAHost,
        ca: stack.tlsCa,
        requestText,
        timeoutMs: 15_000,
      });
      // Recorded for the test-8 response scan too — a reply the suite received.
      seenReplies.push({
        what: "the framing-conflict raw TLS reply",
        status: framing.status,
        headersJson: "{}",
        text: framing.raw,
      });
      expect(framing.status, `the conflicting framing's status line (${framing.statusLine})`).toBe(
        400,
      );
      expect(jobsForwards(), "the conflicting-framing request forwarded nothing").toBe(
        forwardsBeforeFraming,
      );
    },
  );

  test(
    "owner and admin get no override, and revoking access never cancels accepted execution",
    { timeout: 240_000 },
    async () => {
      origin.respond("/dana", { json: { dana: true, secret: RESULT_SECRET } });
      const holdDana = origin.hold("/dana");

      // dana — a tenant user, neither the app's owner nor an admin — submits
      // her own job, and the suite captures the instruction the edge minted
      // for it: her ownerOid feeds test 8's personal-identity scan.
      const danaBody = JSON.stringify({ url: `${origin.origin}/dana` });
      const forwardsBefore = jobsForwards();
      const submitted = await submitJob(danaA.api, K2, danaBody, edgeAttempts);
      expect(submitted.status, "dana's submission").toBe(202);
      const danaJobId = JobAcceptedSchema.parse(submitted.json()).jobId;
      const danaEntries = link.forwarded
        .slice(forwardsBefore)
        .filter((e) => e.method === "POST" && e.path === "/internal/jobs/v1/jobs");
      expect(danaEntries.length, "dana's submission was forwarded").toBeGreaterThanOrEqual(1);
      const danaToken = valueOf(
        must(danaEntries[danaEntries.length - 1], "dana's forwarded submit entry").headers,
        INSTRUCTION_HEADER,
      );
      expect(danaToken, "dana's forwarded instruction is present").toBeTruthy();
      instructionTokens.push(danaToken);
      const danaClaims = decodeClaims(danaToken);
      expect(typeof danaClaims["ownerOid"], "dana's instruction carries her ownerOid").toBe(
        "string",
      );
      danaOwnerOid = danaClaims["ownerOid"] as string;

      // The job is admitted and running, held at the origin.
      await waitFor(
        stack,
        "dana's job's outbound GET to reach the origin at /dana",
        { timeoutMs: 60_000 },
        async () => (origin.requests.some((r) => r.path === "/dana") ? true : undefined),
      );
      await holdDana.arrived;

      // The fixed unknown-job 404 body is the comparator: privilege — owning
      // the app, or administering the platform — buys NO visibility into
      // another user's job, not even its existence, on any operation.
      const unknown = seen(await danaA.api("GET", statusPath(randomUUID())));
      expect(unknown.status, "the unknown-job read's status").toBe(404);
      expect(JobRequestErrorSchema.parse(unknown.json()).code, "the unknown-job code").toBe(
        "job_not_found",
      );
      const unknownBody = unknown.text;
      for (const [who, session] of [
        ["the app's owner bob", bobA],
        ["the platform admin alice", aliceA],
      ] as const) {
        for (const [what, method, opath] of [
          ["status", "GET", statusPath(danaJobId)],
          ["result", "GET", resultPath(danaJobId)],
          ["cancel", "DELETE", statusPath(danaJobId)],
        ] as const) {
          const reply = seen(await session.api(method, opath));
          expect(reply.status, `${who}'s ${what} read of dana's job`).toBe(404);
          expect(reply.text, `${who}'s ${what} read of dana's job is the unknown-job body`).toBe(
            unknownBody,
          );
        }
      }

      // Revoking the jobs grant is the route's own seam: dana's reads of her
      // own running job turn 403 once the edge's projection has the update,
      // and new work is refused before any instruction exists.
      const revoked = seen(
        await bob.put(`/api/v1/apps/${appA.slug}/manifest`, {
          capabilities: {
            mcp: [],
            externalOrigins: [],
            fetch: { shim: false, origins: [{ origin: origin.origin }] },
          },
        }),
      );
      expect(revoked.status, "the jobs grant's revocation save").toBe(200);
      expect(
        ManifestUpdateResultSchema.parse(revoked.json()).pending,
        "the revocation needs no approval",
      ).toBeNull();
      await waitFor(
        stack,
        "dana's status read of her own job to answer 403 after the grant's revocation",
        { timeoutMs: 60_000 },
        async () => {
          const snap = seen(await danaA.api("GET", statusPath(danaJobId)));
          return snap.status === 403 ? snap : undefined;
        },
      );
      const afterRevoke = jobsForwards();
      const refusedSubmit = await submitJob(danaA.api, randomUUID(), danaBody, edgeAttempts);
      // The edge throttles 10 submissions a minute per app (refusals count):
      // the suite stays well inside it so no answer above was a throttle's.
      expect(
        edgeAttempts.n,
        "the suite's edge submissions stay inside the throttle",
      ).toBeLessThanOrEqual(6);
      expect(refusedSubmit.status, "dana's post-revocation submit").toBe(403);
      expect(
        JobRequestErrorSchema.parse(refusedSubmit.json()).code,
        "the post-revocation submit's code",
      ).toBe("forbidden");
      const refusedCancel = seen(await danaA.api("DELETE", statusPath(danaJobId)));
      expect(refusedCancel.status, "dana's post-revocation cancel").toBe(403);
      expect(
        JobRequestErrorSchema.parse(refusedCancel.json()).code,
        "the post-revocation cancel's code",
      ).toBe("forbidden");
      expect(
        link.forwarded
          .slice(afterRevoke)
          .filter((e) => e.method === "POST" && e.path === "/internal/jobs/v1/jobs").length,
        "the post-revocation refusals forwarded no submit",
      ).toBe(0);

      // Revoking the SESSION is the gate's seam, not the jobs route's: with
      // the session row gone, the same read answers the gate's own 401.
      await platform.query(`DELETE FROM sessions WHERE "tokenHash" = $1`, [
        createHash("sha256")
          .update(danaA.cookie.slice("__Host-session=".length), "utf8")
          .digest("hex"),
      ]);
      const revokedSession = seen(await danaA.api("GET", statusPath(danaJobId)));
      expect(revokedSession.status, "dana's status read after her session's revocation").toBe(401);

      // Accepted execution outlives both revocations: the held job completes
      // and keeps its result for a fresh session of the same user. (The
      // grant is back first — baseline, applied immediately — so the reads
      // are admitted again.)
      holdDana.release();
      const restored = seen(
        await bob.put(`/api/v1/apps/${appA.slug}/manifest`, {
          capabilities: {
            mcp: [],
            externalOrigins: [],
            fetch: { shim: false, origins: [{ origin: origin.origin }] },
            jobs: { types: [JOBS_FETCH_QUALIFIED_TYPE] },
          },
        }),
      );
      expect(restored.status, "the jobs grant's restoration").toBe(200);
      const freshDana = await sessionIn(appA.slug, "dana@azx.dev");
      let lastStatus: string | undefined;
      const final = await waitFor(
        stack,
        () =>
          `dana's job to reach "succeeded" after both revocations — last snapshot status: ` +
          (lastStatus ?? "<none>"),
        { timeoutMs: 120_000 },
        async () => {
          const snap = seen(await freshDana.api("GET", statusPath(danaJobId)));
          if (snap.status !== 200) return undefined;
          const snapshot = JobSnapshotSchema.parse(snap.json());
          lastStatus = snapshot.status;
          return snapshot.status === "succeeded" ? snapshot : undefined;
        },
      );
      expect(final.cancellationRequested, "neither revocation cancelled dana's job").toBe(false);
      const result = seen(await freshDana.api("GET", resultPath(danaJobId)));
      expect(result.status, "the result read after both revocations").toBe(200);
      expect(JSON.parse(result.text), "the result is the origin's own JSON").toEqual({
        dana: true,
        secret: RESULT_SECRET,
      });
    },
  );

  test(
    "no planted value or caller trace reaches a response, a log line, or an exported signal",
    { timeout: 180_000 },
    async () => {
      // The forbidden classes. Each value is named only by its class in a
      // failure — a leak report must not become a second copy of the leak.
      const roots = jobsRoots();
      const baseSealed: readonly SealedValue[] = [
        { label: "the planted retry key K1", value: K1 },
        { label: "the planted retry key K2", value: K2 },
        { label: "the planted URL-query credential", value: QUERY_SECRET },
        { label: "the planted result secret", value: RESULT_SECRET },
        { label: "the forged instruction token", value: SMUGGLED_INSTRUCTION },
        { label: "the dev token", value: devToken },
        ...instructionTokens.map((t, i) => ({
          label: `an instruction token (the suite's #${i + 1})`,
          value: t,
        })),
        { label: "an edge→jobs signing root", value: roots.edgeToJobs },
        { label: "a jobs→edge signing root", value: roots.jobsToEdge },
        { label: "a portal→jobs signing root", value: roots.portalToJobs },
        ...sessionCookieValues.map((v, i) => ({
          label: `a session cookie value (#${i + 1})`,
          value: v,
        })),
      ];
      // Results legitimately carry the result secret — only the mint response
      // legitimately carries the dev token, to its owner.
      const responseSealed = baseSealed.filter((s) => s.label !== "the planted result secret");
      for (const [i, reply] of seenReplies.entries()) {
        const sealed =
          reply.what === MINT_REPLY_WHAT
            ? responseSealed.filter((s) => s.label !== "the dev token")
            : responseSealed;
        const found = leakIn(`${reply.headersJson}\n${reply.text}`, sealed);
        expect(
          found,
          `response #${i}${reply.what === undefined ? "" : ` (${reply.what})`}: no forbidden value leaked, found ${found === null ? "none" : found}`,
        ).toBeNull();
      }

      // The planted trace context at every other inbound surface — the portal
      // API, the dev gateway's jobs route, the jobs listener and the edge's
      // callback receiver (both unauthenticated here). Each must open its own
      // root; the telemetry scan below proves none continued the planted trace.
      const traceHeaders = { traceparent: PLANTED_TRACEPARENT, tracestate: `vendor=${PLANT}` };
      const tracedProbes: Array<[string, Promise<HttpReply>]> = [
        [
          "the portal API",
          stack.request(`${stack.portalUrl}/api/v1/apps`, {
            headers: { Authorization: `Bearer ${bob.bearer}`, ...traceHeaders },
          }),
        ],
        [
          "the dev gateway's jobs read",
          dev.api("GET", `/_api/jobs/jobs/${randomUUID()}`, { headers: traceHeaders }),
        ],
        [
          "the jobs listener without an instruction",
          stack.request(
            `http://localhost:${stack.ports.jobs}/internal/jobs/v1/jobs/${randomUUID()}`,
            {
              headers: traceHeaders,
            },
          ),
        ],
        [
          "the edge callback receiver without an instruction",
          stack.request(`https://${stack.baseDomain}:${stack.ports.edge}/internal/jobs/v1/fetch`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...traceHeaders },
            body: JSON.stringify({ url: `${origin.origin}/never` }),
          }),
        ],
      ];
      for (const [what, pending] of tracedProbes) {
        const reply = seen(await pending);
        expect(reply.status, `${what}: answered the traced probe`).toBeGreaterThan(0);
      }

      // Every service stops, so each exporter's last batch is flushed before
      // the scans below read what the processes actually emitted.
      for (const name of [
        "edge",
        "devGateway",
        "jobsReplica",
        "jobs",
        "portal",
        "egress",
      ] as const) {
        await stack.stop(name);
      }

      // Logs: every service's own output, for the whole run.
      const logFiles = readdirSync(stack.logDir).filter((f) => f.endsWith(".log"));
      expect(logFiles.length, "the stack wrote service logs").toBeGreaterThan(0);
      for (const file of logFiles) {
        const found = leakIn(readFileSync(path.join(stack.logDir, file), "utf8"), baseSealed);
        expect(
          found,
          `the log file ${file}: no forbidden value leaked, found ${found === null ? "none" : found}`,
        ).toBeNull();
      }

      // Exported signals: the positive control first — the exporters really
      // shipped traces naming the edge's jobs submit span and the jobs
      // service's own identity, so a clean scan below is evidence, not an
      // empty capture.
      const telemetry = must(stack.telemetry ?? undefined, "the stack's telemetry capture");
      const payloads = telemetry.payloads;
      expect(
        payloads.some((p) => p.signal === "traces"),
        "the stack exported at least one traces payload",
      ).toBe(true);
      const joined = payloads.map((p) => p.body).join("\n");
      expect(joined, "the exported traces carry the edge's jobs submit span").toContain(
        SPAN_JOBS_SUBMIT_EDGE,
      );
      expect(joined, "the exported signals carry the jobs service's identity").toContain(
        JOBS_SERVICE_NAME,
      );
      // Ids are exported in the same hex form the planted one would take: the
      // edge's own injected trace id from test 3 is there.
      expect(joined, "the exported traces carry the edge's own S1 trace id").toContain(
        must(edgeSubmitTraceId, "the edge's S1 trace id"),
      );
      // Nothing was refused by the capture's size cap — a dropped payload
      // would make the clean scan below evidence of nothing.
      expect(telemetry.dropped, "the telemetry capture dropped nothing").toBe(0);

      // The exported scan adds what only telemetry could leak: the grafted
      // trace id, the planted marker in any form, the callers' oids (personal
      // identity is never a dimension), and a whole-URL attribute key.
      const telemetrySealed: readonly SealedValue[] = [
        ...baseSealed,
        { label: "the planted trace id", value: PLANTED_TRACE_ID },
        { label: "a planted marker value", value: PLANT },
        { label: "bob's owner oid", value: claimString("ownerOid") },
        { label: "dana's owner oid", value: must(danaOwnerOid, "dana's owner oid") },
      ];
      for (const [i, payload] of payloads.entries()) {
        const found = leakIn(payload.body, telemetrySealed) ?? urlAttributeLeak(payload.body);
        expect(
          found,
          `the ${payload.signal} payload #${i}: no forbidden value leaked, found ${found === null ? "none" : found}`,
        ).toBeNull();
      }
    },
  );
});
