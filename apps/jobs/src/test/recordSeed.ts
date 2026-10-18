import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";

import { sha256BodyDigest } from "@azx-pbc/shared/jobsSigning";

import { JOBS_JOB_RECORD_QUALIFIED, JOBS_QUEUE_NAME, jobsAppEnvGroupId } from "../policy.js";
import { TEST_IDENTITY } from "./instructions.js";

/**
 * Seed one job the way the acceptance transaction would commit it — a runner
 * row with the leg's own retry/claim options, and its wrapper record — so an
 * integration leg can arrange exact runner-side conditions (a retriable job,
 * a short claim bound, a delayed start) that the platform's own admission
 * never produces. The acceptance instant is now; a leg backdating it does so
 * on the record (the way elapsed time actually reaches the deadline's
 * input). Returns the job's public id.
 */
export async function seedRunnerJobWithRecord(
  boss: PgBoss,
  direct: Pool,
  options: {
    appId: string;
    data: object;
    retryLimit?: number;
    expireInSeconds?: number;
    retryDelay?: number;
    startAfterSeconds?: number;
    /** The environment tier the record carries — both tiers' work is real for the lifecycle legs. */
    env?: "prod" | "dev";
    /** The lifecycle generation the record is admitted under (the current one by default). */
    generation?: string;
  },
): Promise<string> {
  const env = options.env ?? "prod";
  const runnerJobId = await boss.send(JOBS_QUEUE_NAME, options.data, {
    retryLimit: options.retryLimit ?? 0,
    expireInSeconds: options.expireInSeconds ?? 300,
    ...(options.retryDelay !== undefined ? { retryDelay: options.retryDelay } : {}),
    ...(options.startAfterSeconds !== undefined ? { startAfter: options.startAfterSeconds } : {}),
    group: { id: jobsAppEnvGroupId(options.appId, env) },
  });
  if (runnerJobId === null) throw new Error("the seeded runner job was not enqueued");
  const jobId = randomUUID();
  await direct.query(
    `INSERT INTO ${JOBS_JOB_RECORD_QUALIFIED}
       (server, job_id, runner_job_id, app_id, env, owner_kind, owner_oid, type,
        generation, status, retry_key, body_sha256, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', NULL, $10, $11)`,
    [
      "jobs",
      jobId,
      runnerJobId,
      options.appId,
      env,
      "user",
      TEST_IDENTITY.ownerOid,
      "jobs:fetch",
      options.generation ?? "1",
      sha256BodyDigest(new TextEncoder().encode(JSON.stringify(options.data))),
      new Date().toISOString(),
    ],
  );
  return jobId;
}
