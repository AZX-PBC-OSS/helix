import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  JobAcceptedSchema,
  JobCancellationAcceptedSchema,
  JobRequestErrorSchema,
  JobSnapshotSchema,
  type App,
  type JobAccepted,
  type JobSnapshot,
} from "@azx-pbc/shared";
import {
  deriveJobsInstructionKey,
  mintJobsInstruction,
  type JobsInstructionClaims,
} from "@azx-pbc/shared/jobsSigning";

import {
  FIXTURE_LOCAL_TYPE,
  type FixtureExchange,
  type JobsContractFixture,
} from "./test/jobsContractFixture.js";
import {
  createLiveApp,
  startRealStack,
  waitFor,
  type AppSession,
  type HttpReply,
  type PortalClient,
  type RealStack,
} from "./test/realStack.js";

/**
 * Named-server isolation through the REAL running platform: two configured
 * jobs servers — the in-process contract fixtures `alpha` and `beta` — behind
 * the real edge and portal processes, with only the jobs runner itself
 * replaced (the fixtures are contract testing, not a second production
 * runner). The edge's routing and signing and the portal's lifecycle delivery
 * are the code under test; the fixtures record exactly what reached them.
 *
 * What the suite proves: equal local job ids and retry keys on two servers
 * never alias (the reference is the whole `{server, jobId}` pair, the retry
 * key lives only in the store that accepted it, and the edge narrows every
 * instruction's grants to the addressed server's own types); a grant names one
 * server's qualified type and each server rechecks the forwarded grants
 * itself; signatures and callbacks cannot cross servers (an instruction minted
 * for one server verifies nowhere else, a spent token replays nowhere, and the
 * fetch callback accepts only a correctly bound jobs→edge token); the
 * submission throttle spans every configured server; unknown servers and
 * outages keep distinct answers with no fallback between servers, while
 * lifecycle delivery is independent per server (one server's acknowledgement
 * never acknowledges another); and retirement keeps original routing, retry
 * keys and saved grants until the cleanup barrier removes the server.
 */

// ── shared suite state ───────────────────────────────────────────────────────

type Purpose = "iso" | "grant" | "throttle" | "life";
type SubmitClaims = Extract<JobsInstructionClaims, { operation: "submit" }>;
type SnapshotClaims = Extract<JobsInstructionClaims, { operation: "snapshot" }>;

let stack: RealStack;
let bob: PortalClient;
let platformDb: Pool;
let alpha: JobsContractFixture;
let beta: JobsContractFixture;

const apps = {} as Record<Purpose, { readonly app: App; readonly slug: string }>;
const sessions = {} as Record<Purpose, AppSession>;
/** The app id behind each slug — `waitForEdgeGrant` starts from a session. */
const appIdBySlug = new Map<string, string>();

const ISO_ALPHA_BODY = '{"n":"alpha"}';
const ISO_BETA_BODY = '{"n":"beta"}';

let isoKey = "";
let isoAlphaFirstClaims: SubmitClaims | undefined;
let lifeArchiveGeneration: number | undefined;
let lifeAlphaJobId = "";
let lifeBetaJobId = "";

const must = <T>(value: T | null | undefined, what: string): T => {
  if (value === null || value === undefined) throw new Error(`the suite never produced ${what}`);
  return value;
};

// ── small drivers over the harness clients ───────────────────────────────────

const submitPath = (server: string): string => `/_api/jobs/${server}/types/${FIXTURE_LOCAL_TYPE}`;
const statusPath = (server: string, jobId: string): string => `/_api/jobs/${server}/${jobId}`;
const resultPath = (server: string, jobId: string): string =>
  `/_api/jobs/${server}/${jobId}/result`;

/** Every jobs response from the edge is uncacheable — success and refusal alike. */
function expectNoStore(res: HttpReply, what: string): void {
  expect(res.headers["cache-control"], `${what}: the cache-control header`).toBe("no-store");
}

/** The error code of a jobs error reply, parsed against the wire schema. */
function errorCode(res: HttpReply): string {
  return JobRequestErrorSchema.parse(res.json()).code;
}

/** One submission attempt — no retry. The attempt is charged to the app's window. */
function submitOnce(
  session: AppSession,
  server: string,
  key: string,
  body: string,
): Promise<HttpReply> {
  return session.api("POST", submitPath(server), {
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body,
  });
}

/** Assert a 202 and parse the acceptance. */
function parseAccepted(res: HttpReply, what: string): JobAccepted {
  expect(res.status, `${what}: the status`).toBe(202);
  expectNoStore(res, what);
  return JobAcceptedSchema.parse(res.json());
}

/** One snapshot read through the edge, parsed against the wire schema. */
async function readSnapshot(
  session: AppSession,
  server: string,
  jobId: string,
  what: string,
): Promise<JobSnapshot> {
  const res = await session.api("GET", statusPath(server, jobId));
  expect(res.status, `${what}: the status`).toBe(200);
  expectNoStore(res, what);
  return JobSnapshotSchema.parse(res.json());
}

// ── fixture-exchange readers ─────────────────────────────────────────────────

/** Every verified submit instruction a fixture received for one app, in arrival order. */
function submitExchangesFor(fixture: JobsContractFixture, appId: string): SubmitClaims[] {
  const found: SubmitClaims[] = [];
  for (const exchange of fixture.exchanges) {
    if (exchange.operation !== "submit" || !exchange.verified) continue;
    const claims = exchange.claims;
    if (claims?.operation === "submit" && claims.appId === appId) found.push(claims);
  }
  return found;
}

/** The last verified snapshot exchange a fixture received for one app. */
function lastVerifiedSnapshotExchange(
  fixture: JobsContractFixture,
  appId: string,
): FixtureExchange | undefined {
  return [...fixture.exchanges].reverse().find((exchange): boolean => {
    if (exchange.operation !== "snapshot" || !exchange.verified) return false;
    const claims = exchange.claims;
    return claims?.operation === "snapshot" && claims.appId === appId;
  });
}

/** The grants the edge last forwarded for one app on one fixture's snapshot route. */
function lastSnapshotClaimsFor(
  fixture: JobsContractFixture,
  appId: string,
): SnapshotClaims | undefined {
  const exchange = lastVerifiedSnapshotExchange(fixture, appId);
  const claims = exchange?.claims;
  return claims?.operation === "snapshot" ? claims : undefined;
}

/** The exchange in which a fixture answered one exact presented token. */
function exchangeForToken(
  fixture: JobsContractFixture,
  token: string,
): FixtureExchange | undefined {
  return [...fixture.exchanges].reverse().find((exchange) => exchange.instruction === token);
}

/** The last verified portal lifecycle delivery a fixture received for one app. */
function lastVerifiedLifecycleExchange(
  fixture: JobsContractFixture,
  appId: string,
): FixtureExchange | undefined {
  return [...fixture.exchanges]
    .reverse()
    .find(
      (exchange) =>
        exchange.operation === "lifecycle" &&
        exchange.verified &&
        exchange.path === `/internal/jobs/v1/lifecycle/${appId}`,
    );
}

// ── grants and their waits ───────────────────────────────────────────────────

/**
 * Write the app's jobs grant where the portal's own apply path keeps it — the
 * app row's `capabilities` JSON — through the platform owner DSN. The fixture
 * type `<server>:echo` is synthetic and no catalogue advertises it, so the
 * manifest PUT cannot express it. The UPDATE fires the registry NOTIFY the
 * edge's projection reloads on.
 */
async function setJobsGrant(slug: string, types: readonly string[]): Promise<void> {
  if (types.length === 0) {
    await platformDb.query(`UPDATE apps SET capabilities = capabilities - 'jobs' WHERE slug = $1`, [
      slug,
    ]);
    return;
  }
  await platformDb.query(
    `UPDATE apps SET capabilities = jsonb_set(capabilities, '{jobs}', $2::jsonb) WHERE slug = $1`,
    [slug, JSON.stringify({ types })],
  );
}

function fixtureNamed(server: string): JobsContractFixture {
  if (server === "alpha") return must(alpha, "the alpha contract fixture");
  if (server === "beta") return must(beta, "the beta contract fixture");
  throw new Error(`no contract fixture named ${server}`);
}

/**
 * Wait — bounded — for the edge's grant projection to carry a change to the
 * server, WITHOUT spending submission budget: the probe polls a job that does
 * not exist, the fixture answers 404, and the exchange still records the
 * claims (and their `allowedTypes`) the edge just forwarded for this app.
 */
async function waitForEdgeGrant(
  session: AppSession,
  server: string,
  type: string,
  present: boolean,
): Promise<void> {
  const fixture = fixtureNamed(server);
  const appId = must(appIdBySlug.get(session.slug), "the app id behind the session");
  let last: string[] | undefined;
  await waitFor(
    stack,
    () =>
      `the edge's forwarded grants for ${session.slug} on ${server} to ` +
      `${present ? "include" : "exclude"} "${type}" — last forwarded allowedTypes: ` +
      (last === undefined ? "<none>" : JSON.stringify(last)),
    { timeoutMs: 90_000 },
    async () => {
      await session.api("GET", `/_api/jobs/${server}/probe-grant`);
      const claims = lastSnapshotClaimsFor(fixture, appId);
      if (claims === undefined) return undefined;
      last = claims.allowedTypes;
      return claims.allowedTypes.includes(type) === present ? true : undefined;
    },
  );
}

// ── the lifecycle outbox (the portal's per-server delivery ledger) ───────────

interface OutboxRow {
  server: string;
  generation: number;
  deliveredAt: Date | null;
}

async function archivedOutboxRows(appId: string): Promise<OutboxRow[]> {
  const res = await platformDb.query<OutboxRow>(
    `SELECT "server", "generation", "deliveredAt"
       FROM jobs_lifecycle_outbox
      WHERE "appId" = $1 AND "archived" = true
      ORDER BY "server" ASC`,
    [appId],
  );
  return res.rows;
}

async function outboxDelivered(
  appId: string,
  generation: number,
  server: string,
): Promise<boolean> {
  const res = await platformDb.query<{ deliveredAt: Date | null }>(
    `SELECT "deliveredAt" FROM jobs_lifecycle_outbox
      WHERE "appId" = $1 AND "generation" = $2 AND "server" = $3`,
    [appId, generation, server],
  );
  return (res.rows[0]?.deliveredAt ?? null) !== null;
}

// ── suite setup ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  stack = await startRealStack({ label: "named", jobsFixtures: ["alpha", "beta"] });
  alpha = must(stack.jobsFixtures.alpha, "the alpha contract fixture");
  beta = must(stack.jobsFixtures.beta, "the beta contract fixture");

  bob = await stack.portalAs("bob@azx.dev");
  platformDb = new Pool({ connectionString: stack.platformOwnerDsn, max: 3 });

  for (const purpose of ["iso", "grant", "throttle", "life"] as const) {
    const slug = `ns-${purpose}-${randomBytes(3).toString("hex")}`;
    const app = await createLiveApp(stack, bob, {
      slug,
      files: {
        "index.html":
          '<!doctype html><html><head><meta charset="utf-8"><title>named servers</title></head>' +
          `<body><p>named-${purpose}</p></body></html>`,
      },
    });
    apps[purpose] = { app, slug };
    appIdBySlug.set(slug, app.id);
  }

  await setJobsGrant(apps.iso.slug, ["alpha:echo", "beta:echo"]);
  await setJobsGrant(apps.grant.slug, ["alpha:echo"]);
  await setJobsGrant(apps.throttle.slug, ["alpha:echo", "beta:echo"]);
  await setJobsGrant(apps.life.slug, ["alpha:echo", "beta:echo"]);

  // A fixture admits nothing for an app whose lifecycle it has not received:
  // wait once, after all the grants, for the portal's synchronization to
  // deliver every app's current generation to both fixtures.
  const everyAppId = (["iso", "grant", "throttle", "life"] as const).map(
    (purpose) => apps[purpose].app.id,
  );
  await waitFor(
    stack,
    "the portal's lifecycle synchronization to deliver every app's current generation to both fixtures",
    { timeoutMs: 90_000 },
    async () => {
      for (const fixture of [alpha, beta]) {
        for (const appId of everyAppId) {
          if (!fixture.lifecycle.has(appId)) return undefined;
        }
      }
      return true;
    },
  );

  for (const purpose of ["iso", "grant", "throttle", "life"] as const) {
    sessions[purpose] = await stack.appSession(apps[purpose].slug, "bob@azx.dev");
  }

  // The edge reloads its projection asynchronously after every grant write:
  // confirm every grant on its server before the suite spends any submission
  // budget (probes cost none).
  await waitForEdgeGrant(sessions.iso, "alpha", "alpha:echo", true);
  await waitForEdgeGrant(sessions.iso, "beta", "beta:echo", true);
  await waitForEdgeGrant(sessions.grant, "alpha", "alpha:echo", true);
  await waitForEdgeGrant(sessions.throttle, "alpha", "alpha:echo", true);
  await waitForEdgeGrant(sessions.throttle, "beta", "beta:echo", true);
  await waitForEdgeGrant(sessions.life, "alpha", "alpha:echo", true);
  await waitForEdgeGrant(sessions.life, "beta", "beta:echo", true);
}, 420_000);

afterAll(async () => {
  await platformDb?.end();
  if (stack) await stack.close();
}, 120_000);

// ── the suite ────────────────────────────────────────────────────────────────

describe("named-server isolation through the real stack", () => {
  test(
    "equal local ids and retry keys on two servers never alias",
    { timeout: 120_000 },
    async () => {
      const isoApp = apps.iso.app;
      const isoSession = sessions.iso;
      alpha.queueJobIds("shared-1");
      beta.queueJobIds("shared-1");

      isoKey = randomUUID();
      const alphaAccepted = parseAccepted(
        await submitOnce(isoSession, "alpha", isoKey, ISO_ALPHA_BODY),
        "the submission to alpha",
      );
      expect(alphaAccepted, "alpha's acceptance names alpha's own reference").toEqual({
        server: "alpha",
        jobId: "shared-1",
        status: "queued",
      });
      // The same key on the other server is NOT a replay: the key lives only
      // in the store that accepted it.
      const betaAccepted = parseAccepted(
        await submitOnce(isoSession, "beta", isoKey, ISO_BETA_BODY),
        "the submission to beta with the same key",
      );
      expect(betaAccepted, "beta's acceptance names beta's own reference").toEqual({
        server: "beta",
        jobId: "shared-1",
        status: "queued",
      });
      const alphaReplay = parseAccepted(
        await submitOnce(isoSession, "alpha", isoKey, ISO_ALPHA_BODY),
        "the keyed replay to alpha",
      );
      expect(alphaReplay, "the replay recovers alpha's original job").toEqual(alphaAccepted);

      expect(alpha.jobs(), "the alpha fixture holds exactly one job").toHaveLength(1);
      expect(alpha.job("shared-1")?.type, "alpha's job type").toBe("alpha:echo");
      expect(beta.jobs(), "the beta fixture holds exactly one job").toHaveLength(1);
      expect(beta.job("shared-1")?.type, "beta's job type").toBe("beta:echo");
      expect(submitExchangesFor(alpha, isoApp.id), "alpha's submit exchanges for iso").toHaveLength(
        2,
      );
      expect(submitExchangesFor(beta, isoApp.id), "beta's submit exchanges for iso").toHaveLength(
        1,
      );

      for (const claims of submitExchangesFor(alpha, isoApp.id)) {
        expect(claims.server, "every verified alpha exchange is bound to alpha").toBe("alpha");
        expect(claims.type, "alpha's submissions carry alpha's type only").toBe("alpha:echo");
        expect(
          claims.allowedTypes,
          "the edge narrows iso's grants to alpha's own types on alpha's instructions",
        ).toEqual(["alpha:echo"]);
      }
      for (const claims of submitExchangesFor(beta, isoApp.id)) {
        expect(claims.server, "every verified beta exchange is bound to beta").toBe("beta");
        expect(claims.type, "beta's submissions carry beta's type only").toBe("beta:echo");
        expect(
          claims.allowedTypes,
          "the edge narrows iso's grants to beta's own types on beta's instructions",
        ).toEqual(["beta:echo"]);
      }
      isoAlphaFirstClaims = must(
        submitExchangesFor(alpha, isoApp.id)[0],
        "alpha's first verified submit claims for iso",
      );

      alpha.complete("shared-1", { from: "alpha" });

      const alphaSnap = await readSnapshot(isoSession, "alpha", "shared-1", "alpha's job poll");
      expect(alphaSnap.status, "alpha's job completed").toBe("succeeded");
      expect(alphaSnap.type, "alpha's job type").toBe("alpha:echo");
      expect(alphaSnap.server, "alpha's job server").toBe("alpha");
      const betaSnap = await readSnapshot(isoSession, "beta", "shared-1", "beta's job poll");
      expect(betaSnap.status, "beta's equal id is an independent job").toBe("queued");
      expect(betaSnap.type, "beta's job type").toBe("beta:echo");

      const alphaResult = await isoSession.api("GET", resultPath("alpha", "shared-1"));
      expect(alphaResult.status, "alpha's result read").toBe(200);
      expectNoStore(alphaResult, "alpha's result read");
      expect(JSON.parse(alphaResult.text), "alpha's job result").toEqual({ from: "alpha" });

      const betaResult = await isoSession.api("GET", resultPath("beta", "shared-1"));
      expect(betaResult.status, "beta's job is not done").toBe(409);
      expectNoStore(betaResult, "beta's result read");
      expect(errorCode(betaResult), "beta's unfinished result read").toBe("job_not_ready");

      const betaCancel = await isoSession.api("DELETE", statusPath("beta", "shared-1"));
      expect(betaCancel.status, "beta's cancellation").toBe(202);
      expectNoStore(betaCancel, "beta's cancellation");
      expect(JobCancellationAcceptedSchema.parse(betaCancel.json())).toEqual({
        server: "beta",
        jobId: "shared-1",
        cancellationRequested: true,
      });

      const alphaSnapAgain = await readSnapshot(
        isoSession,
        "alpha",
        "shared-1",
        "alpha's job poll after beta's cancellation",
      );
      expect(alphaSnapAgain.status, "alpha's job is untouched by beta's cancellation").toBe(
        "succeeded",
      );
      expect(alphaSnapAgain.cancellationRequested, "no cancellation intent crossed servers").toBe(
        false,
      );
      const betaSnapAgain = await readSnapshot(
        isoSession,
        "beta",
        "shared-1",
        "beta's job poll after its cancellation",
      );
      expect(betaSnapAgain.status, "beta's job cancelled").toBe("cancelled");
    },
  );

  test(
    "a grant names one server's type, and each server rechecks the forwarded grants itself",
    { timeout: 180_000 },
    async () => {
      const grantApp = apps.grant.app;
      const grantSession = sessions.grant;

      // The grant names alpha only, and the edge refuses before any
      // instruction exists: beta sees no exchange at all for this app.
      await waitForEdgeGrant(grantSession, "alpha", "alpha:echo", true);
      const ungranted = await submitOnce(
        grantSession,
        "beta",
        `ns-grant-${randomUUID()}`,
        ISO_BETA_BODY,
      );
      expect(ungranted.status, "the submission for a type beta is not granted").toBe(403);
      expectNoStore(ungranted, "the ungranted submission");
      expect(errorCode(ungranted), "the ungranted submission").toBe("forbidden");
      expect(
        submitExchangesFor(beta, grantApp.id),
        "beta's exchanges for the grant app",
      ).toHaveLength(0);

      const alphaAccepted = parseAccepted(
        await submitOnce(grantSession, "alpha", `ns-grant-${randomUUID()}`, ISO_ALPHA_BODY),
        "the granted submission to alpha",
      );
      expect(alphaAccepted.server, "the granted submission's server").toBe("alpha");

      await setJobsGrant(apps.grant.slug, ["alpha:echo", "beta:echo"]);
      await waitForEdgeGrant(grantSession, "beta", "beta:echo", true);
      const betaAccepted = parseAccepted(
        await submitOnce(grantSession, "beta", `ns-grant-${randomUUID()}`, ISO_BETA_BODY),
        "the newly granted submission to beta",
      );
      expect(betaAccepted.server, "the newly granted submission's server").toBe("beta");

      await setJobsGrant(apps.grant.slug, ["alpha:echo"]);
      await waitForEdgeGrant(grantSession, "beta", "beta:echo", false);

      // The revoked poll reaches the server, which rechecks the forwarded
      // grants itself — the refusal is the receiver's, not an edge guess.
      const revoked = await grantSession.api("GET", statusPath("beta", betaAccepted.jobId));
      expect(revoked.status, "the poll after the beta grant's revocation").toBe(403);
      expectNoStore(revoked, "the revoked poll");
      expect(errorCode(revoked), "the revoked poll").toBe("forbidden");
      const revokedExchange = must(
        lastVerifiedSnapshotExchange(beta, grantApp.id),
        "beta's last verified snapshot exchange for the grant app",
      );
      expect(revokedExchange.verified, "the revoked refusal is the server's own recheck").toBe(
        true,
      );
      expect(revokedExchange.status, "the server's own status for the revoked poll").toBe(403);
      expect(
        lastSnapshotClaimsFor(beta, grantApp.id)?.allowedTypes,
        "the grants the edge forwarded after the revocation",
      ).toEqual([]);

      const alphaPoll = await readSnapshot(
        grantSession,
        "alpha",
        alphaAccepted.jobId,
        "the alpha job's poll after the revocation",
      );
      expect(alphaPoll.status, "the alpha grant still serves its job").toBe("queued");

      // Ownership: the job belongs to the grant app, not to iso — beta
      // answers the foreign poll itself.
      const foreign = await sessions.iso.api("GET", statusPath("beta", betaAccepted.jobId));
      expect(foreign.status, "the iso session's poll of the grant app's beta job").toBe(404);
      expectNoStore(foreign, "the foreign poll");
      expect(errorCode(foreign), "the foreign poll").toBe("job_not_found");
      const foreignExchange = must(
        lastVerifiedSnapshotExchange(beta, apps.iso.app.id),
        "beta's last verified snapshot exchange for iso",
      );
      expect(foreignExchange.verified, "the foreign refusal is the server's own comparison").toBe(
        true,
      );
      expect(foreignExchange.status, "the server's own status for the foreign poll").toBe(404);
    },
  );

  test("signatures and callbacks cannot cross servers", { timeout: 120_000 }, async () => {
    const isoApp = apps.iso.app;
    const claims = must(isoAlphaFirstClaims, "alpha's recorded submit claims for iso");

    // Instructions expire 30 s after minting, so capture a fresh one: poll
    // once, then take the token the edge just minted for the poll.
    await readSnapshot(sessions.iso, "alpha", "shared-1", "the capture poll of alpha's job");
    const captured = must(
      lastVerifiedSnapshotExchange(alpha, isoApp.id),
      "alpha's last verified snapshot exchange for iso",
    );
    expect(captured.path, "the captured snapshot resource").toBe("/internal/jobs/v1/jobs/shared-1");
    const token = must(captured.instruction, "the captured instruction token");

    // The same resource exists on beta — the token does not verify there.
    const cross = await fetch(`${beta.endpoint}${captured.path}`, {
      method: "GET",
      headers: { "x-helix-instruction": token },
    });
    expect(cross.status, "the alpha token presented to beta").toBe(401);
    expect(JobRequestErrorSchema.parse(await cross.json()).code, "the cross-server refusal").toBe(
      "unauthorized",
    );
    const crossExchange = must(
      exchangeForToken(beta, token),
      "beta's exchange for the presented alpha token",
    );
    expect(crossExchange.verified, "the cross-server presentation is unverified").toBe(false);
    expect(crossExchange.rejectReason, "the cross-server rejection reason").toBe("signature");

    // The edge's token was spent on its first use: presenting it again to
    // alpha is a replay.
    const replay = await fetch(`${alpha.endpoint}${captured.path}`, {
      method: "GET",
      headers: { "x-helix-instruction": token },
    });
    expect(replay.status, "the spent alpha token presented to alpha again").toBe(401);
    const replayExchange = must(
      [...alpha.exchanges].reverse().find((e) => e.instruction === token && !e.verified),
      "alpha's refused exchange for the spent token",
    );
    expect(replayExchange.rejectReason, "the replay rejection reason").toBe("replayed");

    // A portal-minted lifecycle instruction is equally server-bound.
    const lifecycleExchange = must(
      lastVerifiedLifecycleExchange(alpha, isoApp.id),
      "alpha's verified lifecycle exchange for iso",
    );
    const lifecycleBefore = beta.lifecycle.get(isoApp.id);
    const lifecycleRes = await fetch(`${beta.endpoint}${lifecycleExchange.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-helix-instruction": must(lifecycleExchange.instruction, "the captured lifecycle token"),
      },
      body: new Uint8Array(lifecycleExchange.body),
    });
    expect(lifecycleRes.status, "the alpha lifecycle token presented to beta").toBe(401);
    expect(
      must(
        exchangeForToken(beta, must(lifecycleExchange.instruction, "the captured lifecycle token")),
        "beta's exchange for the presented lifecycle token",
      ).rejectReason,
      "the cross-server lifecycle rejection reason",
    ).toBe("signature");
    expect(beta.lifecycle.get(isoApp.id), "beta's applied lifecycle for iso is unchanged").toBe(
      lifecycleBefore,
    );

    // The fetch callback: only a jobs→edge token bound to the addressed
    // server's own root and identity reaches the policy at all.
    const callbackUrl = `https://${stack.baseDomain}:${stack.ports.edge}/internal/jobs/v1/fetch`;
    const callbackBody = new TextEncoder().encode('{"url":"https://example.invalid/x"}');
    const presentCallback = async (minted: string): Promise<HttpReply> =>
      stack.request(callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-helix-instruction": minted },
        body: Buffer.from(callbackBody),
      });
    const mintFetchToken = (key: Uint8Array, server: string, type: string): Promise<string> =>
      mintJobsInstruction(
        {
          operation: "fetch",
          server,
          identity: {
            appId: claims.appId,
            env: claims.env,
            ownerKind: claims.ownerKind,
            ownerOid: claims.ownerOid,
            type,
          },
          jobId: "shared-1",
          generation: claims.generation,
          body: callbackBody,
          iatS: Math.floor(Date.now() / 1000),
        },
        key,
      );

    // The positive control: a correctly bound token verifies, burns, and is
    // refused by the fetch policy (the origin is not granted) — proving the
    // 401s below are about the server binding, not the route.
    const positive = await presentCallback(
      await mintFetchToken(
        deriveJobsInstructionKey(alpha.roots.jobsToEdge, "jobsToEdge"),
        "alpha",
        "alpha:echo",
      ),
    );
    expect(positive.status, "the correctly signed alpha callback").toBe(403);
    expect(errorCode(positive), "the correctly signed alpha callback").toBe("outbound_forbidden");

    const wrongServer = await presentCallback(
      await mintFetchToken(
        deriveJobsInstructionKey(alpha.roots.jobsToEdge, "jobsToEdge"),
        "beta",
        "beta:echo",
      ),
    );
    expect(wrongServer.status, "an alpha-signed token addressed to beta").toBe(401);
    expect(errorCode(wrongServer), "an alpha-signed token addressed to beta").toBe("unauthorized");

    const wrongRoot = await presentCallback(
      await mintFetchToken(
        deriveJobsInstructionKey(beta.roots.jobsToEdge, "jobsToEdge"),
        "alpha",
        "alpha:echo",
      ),
    );
    expect(wrongRoot.status, "a beta-signed token addressed to alpha").toBe(401);
    expect(errorCode(wrongRoot), "a beta-signed token addressed to alpha").toBe("unauthorized");

    const wrongDirection = await presentCallback(
      await mintFetchToken(
        deriveJobsInstructionKey(alpha.roots.edgeToJobs, "edgeToJobs"),
        "alpha",
        "alpha:echo",
      ),
    );
    expect(wrongDirection.status, "an edge→jobs key presented as a jobs→edge token").toBe(401);
    expect(errorCode(wrongDirection), "an edge→jobs key presented as a jobs→edge token").toBe(
      "unauthorized",
    );
  });

  test("the submission throttle spans every configured server", { timeout: 120_000 }, async () => {
    const throttleApp = apps.throttle.app;
    const throttleSession = sessions.throttle;
    const throttleBody = '{"n":"throttle"}';
    const submit = (server: string, key: string): Promise<HttpReply> =>
      submitOnce(throttleSession, server, key, throttleBody);

    // Ten distinct-key submissions, interleaved across the two servers, fill
    // the app's window exactly (the buckets carry no server id).
    for (let i = 0; i < 5; i++) {
      const alphaAccepted = parseAccepted(
        await submit("alpha", `ns-throttle-a${i}-${randomUUID()}`),
        `alpha throttle submission ${i}`,
      );
      expect(alphaAccepted.server, `alpha throttle submission ${i} server`).toBe("alpha");
      const betaAccepted = parseAccepted(
        await submit("beta", `ns-throttle-b${i}-${randomUUID()}`),
        `beta throttle submission ${i}`,
      );
      expect(betaAccepted.server, `beta throttle submission ${i} server`).toBe("beta");
    }

    // The window is spent: every server prefix answers the same 429 —
    // including a server that is not configured at all (the charge precedes
    // the server resolution).
    const betaRefused = await submit("beta", `ns-throttle-x-${randomUUID()}`);
    expect(betaRefused.status, "the 11th attempt, on beta").toBe(429);
    expectNoStore(betaRefused, "the 11th attempt, on beta");
    expect(errorCode(betaRefused), "the 11th attempt, on beta").toBe("rate_limited");
    const alphaRefused = await submit("alpha", `ns-throttle-x-${randomUUID()}`);
    expect(alphaRefused.status, "the 12th attempt, on alpha").toBe(429);
    expect(errorCode(alphaRefused), "the 12th attempt, on alpha").toBe("rate_limited");
    const gammaRefused = await submit("gamma", `ns-throttle-x-${randomUUID()}`);
    expect(gammaRefused.status, "the 13th attempt, on the unconfigured gamma").toBe(429);
    expect(errorCode(gammaRefused), "the 13th attempt, on the unconfigured gamma").toBe(
      "rate_limited",
    );

    expect(
      submitExchangesFor(alpha, throttleApp.id),
      "alpha's submit exchanges for the throttle app",
    ).toHaveLength(5);
    expect(
      submitExchangesFor(beta, throttleApp.id),
      "beta's submit exchanges for the throttle app",
    ).toHaveLength(5);
  });

  test(
    "unknown servers and outages keep distinct answers with no fallback, and lifecycle delivery is independent",
    { timeout: 300_000 },
    async () => {
      // An unconfigured server has its own answer per operation.
      const unknownSubmit = await submitOnce(
        sessions.iso,
        "gamma",
        `ns-iso-gamma-${randomUUID()}`,
        ISO_BETA_BODY,
      );
      expect(unknownSubmit.status, "the submission to the unconfigured gamma").toBe(400);
      expectNoStore(unknownSubmit, "the submission to the unconfigured gamma");
      expect(errorCode(unknownSubmit), "the submission to the unconfigured gamma").toBe(
        "job_server_unknown",
      );
      const unknownPoll = await sessions.iso.api("GET", statusPath("gamma", "shared-1"));
      expect(unknownPoll.status, "the poll on the unconfigured gamma").toBe(404);
      expect(errorCode(unknownPoll), "the poll on the unconfigured gamma").toBe("job_not_found");
      const unknownCancel = await sessions.iso.api("DELETE", statusPath("gamma", "shared-1"));
      expect(unknownCancel.status, "the cancel on the unconfigured gamma").toBe(404);
      expect(errorCode(unknownCancel), "the cancel on the unconfigured gamma").toBe(
        "job_not_found",
      );

      // life submits to both servers before the outage.
      const lifeAlpha = parseAccepted(
        await submitOnce(sessions.life, "alpha", `ns-life-a-${randomUUID()}`, '{"n":"life-alpha"}'),
        "life's alpha submission",
      );
      const lifeBeta = parseAccepted(
        await submitOnce(sessions.life, "beta", `ns-life-b-${randomUUID()}`, '{"n":"life-beta"}'),
        "life's beta submission",
      );
      lifeAlphaJobId = lifeAlpha.jobId;
      lifeBetaJobId = lifeBeta.jobId;

      await beta.stop();
      const alphaCount = alpha.exchanges.length;
      const betaCount = beta.exchanges.length;

      // During the outage every beta route answers the retryable 503 —
      // observation, result, cancellation and submission alike.
      const outagePoll = await sessions.iso.api("GET", statusPath("beta", "shared-1"));
      expect(outagePoll.status, "the poll during beta's outage").toBe(503);
      expectNoStore(outagePoll, "the poll during beta's outage");
      expect(errorCode(outagePoll), "the poll during beta's outage").toBe("jobs_unavailable");
      const outageResult = await sessions.iso.api("GET", resultPath("beta", "shared-1"));
      expect(outageResult.status, "the result read during beta's outage").toBe(503);
      expect(errorCode(outageResult), "the result read during beta's outage").toBe(
        "jobs_unavailable",
      );
      const outageCancel = await sessions.iso.api("DELETE", statusPath("beta", "shared-1"));
      expect(outageCancel.status, "the cancel during beta's outage").toBe(503);
      expect(errorCode(outageCancel), "the cancel during beta's outage").toBe("jobs_unavailable");
      const outageSubmit = await submitOnce(
        sessions.iso,
        "beta",
        `ns-iso-outage-${randomUUID()}`,
        ISO_BETA_BODY,
      );
      expect(outageSubmit.status, "the submission during beta's outage").toBe(503);
      expect(errorCode(outageSubmit), "the submission during beta's outage").toBe(
        "jobs_unavailable",
      );

      // No fallback: alpha neither saw nor served beta's traffic.
      expect(alpha.exchanges.length, "alpha's exchange count during beta's outage").toBe(
        alphaCount,
      );
      expect(beta.exchanges.length, "beta saw nothing during its outage").toBe(betaCount);

      const alphaPoll = await readSnapshot(
        sessions.iso,
        "alpha",
        "shared-1",
        "alpha's poll during beta's outage",
      );
      expect(alphaPoll.status, "alpha kept serving through beta's outage").toBe("succeeded");

      // Archive life while beta is down: alpha applies it, beta cannot.
      const archived = await bob.post(`/api/v1/apps/${apps.life.slug}/archive`);
      expect(archived.status, "the archive while beta is down").toBe(200);
      await waitFor(
        stack,
        "alpha to apply life's archive and cancel life's alpha job",
        { timeoutMs: 60_000 },
        async () => {
          const applied = alpha.lifecycle.get(apps.life.app.id);
          const job = alpha.job(lifeAlphaJobId);
          return applied?.archived === true && job?.status === "cancelled" ? true : undefined;
        },
      );

      const rows = await archivedOutboxRows(apps.life.app.id);
      expect(rows, "the archive's outbox rows, one per configured server").toHaveLength(2);
      const archiveGeneration = must(rows[0], "the first archive outbox row").generation;
      expect(
        must(rows[1], "the second archive outbox row").generation,
        "both rows carry the archive generation",
      ).toBe(archiveGeneration);
      lifeArchiveGeneration = archiveGeneration;
      const alphaRow = rows.find((row) => row.server === "alpha");
      const betaRow = rows.find((row) => row.server === "beta");
      expect(alphaRow?.deliveredAt, "the alpha row is delivered").not.toBeNull();
      expect(
        betaRow?.deliveredAt,
        "the beta row is not delivered — one server's acknowledgement never acknowledges another",
      ).toBeNull();

      expect(beta.job(lifeBetaJobId)?.status, "beta's job for life is still queued").toBe("queued");

      await beta.start();
      await waitFor(
        stack,
        "beta to apply the archive, acknowledge it, and cancel life's beta job",
        { timeoutMs: 60_000 },
        async () => {
          const applied = beta.lifecycle.get(apps.life.app.id);
          const delivered = await outboxDelivered(apps.life.app.id, archiveGeneration, "beta");
          const job = beta.job(lifeBetaJobId);
          return applied?.archived === true && delivered && job?.status === "cancelled"
            ? true
            : undefined;
        },
      );
    },
  );

  test(
    "retirement keeps original routing, retry keys and saved grants until the cleanup barrier",
    { timeout: 300_000 },
    async () => {
      const isoApp = apps.iso.app;
      const isoSession = sessions.iso;

      beta.accepting = false;
      stack.configureJobsFixtures({ alpha: "serving", beta: "retiring" });
      await stack.restart("portal");

      // The retained key is recovered on the server that accepted it — never
      // re-driven to another server.
      const beforeAlphaSubmits = submitExchangesFor(alpha, isoApp.id).length;
      const replay = await submitOnce(isoSession, "beta", isoKey, ISO_BETA_BODY);
      const replayAccepted = parseAccepted(
        replay,
        "the keyed replay of beta's original submission",
      );
      expect(replayAccepted.server, "the replay recovered beta's own job").toBe("beta");
      expect(replayAccepted.jobId, "the replay's job id").toBe("shared-1");
      expect(replayAccepted.status, "the replayed job's current status").toBe("cancelled");
      expect(
        submitExchangesFor(alpha, isoApp.id).length,
        "alpha received no submit exchange for beta's retained key",
      ).toBe(beforeAlphaSubmits);

      const disabled = await submitOnce(
        isoSession,
        "beta",
        `ns-iso-retired-${randomUUID()}`,
        ISO_BETA_BODY,
      );
      expect(disabled.status, "a new submission to the retiring server").toBe(503);
      expect(errorCode(disabled), "a new submission to the retiring server").toBe("jobs_disabled");

      const retiringPoll = await readSnapshot(
        isoSession,
        "beta",
        "shared-1",
        "the poll of the retiring server's retained job",
      );
      expect(retiringPoll.status, "the retiring server still serves its retained job").toBe(
        "cancelled",
      );

      // Saved grants survive retirement: no automatic grant rewriting.
      const manifest = await bob.get(`/api/v1/apps/${apps.iso.slug}/manifest`);
      expect(manifest.status, "the iso manifest read").toBe(200);
      const manifestBody = manifest.json() as {
        capabilities?: { jobs?: { types?: string[] } };
      };
      expect(
        manifestBody.capabilities?.jobs?.types?.includes("beta:echo"),
        "the saved grant still names the retiring server's type",
      ).toBe(true);

      const catalogue = await bob.get("/api/v1/capabilities");
      expect(catalogue.status, "the capability catalogue read").toBe(200);
      const secrets: ReadonlyArray<[string, string]> = [
        ["the alpha fixture's endpoint", alpha.endpoint],
        ["the beta fixture's endpoint", beta.endpoint],
        ["alpha's edgeToJobs root", alpha.roots.edgeToJobs],
        ["alpha's jobsToEdge root", alpha.roots.jobsToEdge],
        ["alpha's portalToJobs root", alpha.roots.portalToJobs],
        ["beta's edgeToJobs root", beta.roots.edgeToJobs],
        ["beta's jobsToEdge root", beta.roots.jobsToEdge],
        ["beta's portalToJobs root", beta.roots.portalToJobs],
        ["the qualified type alpha:echo", "alpha:echo"],
        ["the qualified type beta:echo", "beta:echo"],
      ];
      for (const [what, value] of secrets) {
        expect(catalogue.text.includes(value), `the capability catalogue carries ${what}`).toBe(
          false,
        );
      }

      // Lifecycle still reaches the retiring server: every configured server,
      // serving and retiring alike, learns the new generation.
      const unarchived = await bob.post(`/api/v1/apps/${apps.life.slug}/unarchive`);
      expect(unarchived.status, "the unarchive of life").toBe(200);
      const archiveGeneration = must(lifeArchiveGeneration, "life's archive generation");
      await waitFor(
        stack,
        "both fixtures to apply life's unarchive generation, unarchived",
        { timeoutMs: 60_000 },
        async () => {
          for (const fixture of [alpha, beta]) {
            const applied = fixture.lifecycle.get(apps.life.app.id);
            if (
              applied === undefined ||
              applied.archived ||
              Number(applied.generation) <= archiveGeneration
            ) {
              return undefined;
            }
          }
          return true;
        },
      );

      // The operator's cleanup barrier, then the removal: the purge proves
      // the drain, the config rewrite drops the server from every document,
      // and the restarts make the services read it.
      expect(beta.purge(), "the cleanup barrier removed beta's records").toBeGreaterThan(0);
      stack.configureJobsFixtures({ alpha: "serving" });
      await stack.restart("edge");
      await stack.restart("devGateway");
      await stack.restart("portal");

      const betaExchangesBefore = beta.exchanges.length;
      const removedPoll = await isoSession.api("GET", statusPath("beta", "shared-1"));
      expect(removedPoll.status, "the poll of the removed server").toBe(404);
      expectNoStore(removedPoll, "the poll of the removed server");
      expect(errorCode(removedPoll), "the poll of the removed server").toBe("job_not_found");
      const removedSubmit = await submitOnce(
        isoSession,
        "beta",
        `ns-iso-removed-${randomUUID()}`,
        ISO_BETA_BODY,
      );
      expect(removedSubmit.status, "the submission to the removed server").toBe(400);
      expect(errorCode(removedSubmit), "the submission to the removed server").toBe(
        "job_server_unknown",
      );
      expect(
        beta.exchanges.length,
        "beta's exchange count did not move — the edge no longer routes there",
      ).toBe(betaExchangesBefore);

      const alphaPoll = await readSnapshot(
        isoSession,
        "alpha",
        "shared-1",
        "the alpha job's poll after the removal",
      );
      expect(alphaPoll.status, "the original server kept serving").toBe("succeeded");

      const manifestAfter = await bob.get(`/api/v1/apps/${apps.iso.slug}/manifest`);
      expect(manifestAfter.status, "the iso manifest read after the removal").toBe(200);
      const manifestAfterBody = manifestAfter.json() as {
        capabilities?: { jobs?: { types?: string[] } };
      };
      expect(
        manifestAfterBody.capabilities?.jobs?.types?.includes("beta:echo"),
        "the manifest still lists the removed server's type — no automatic grant rewriting",
      ).toBe(true);
    },
  );
});
