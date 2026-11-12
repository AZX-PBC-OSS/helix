import type { Pool } from "pg";
import { HealthStatusSchema, JOBS_SWEEPER_CHECK, JOB_TERMINAL_STATUSES } from "@azx-pbc/shared";
import {
  ATTR_JOBS_JOB_ID,
  ATTR_OUTCOME,
  SPAN_JOBS_EXECUTE,
  type JobsExecuteOutcome,
} from "@azx-pbc/shared/telemetry";

import {
  JOBS_JOB_RECORD_QUALIFIED,
  JOBS_PGBOSS_SCHEMA,
  JOBS_QUEUE_NAME,
  jobsRuntimeBossOptions,
} from "../policy.js";
import { newTestBoss } from "./boss.js";
import { waitFor, type RealStack } from "./realStack.js";

/**
 * Exercise the runner's expiry/retry supervision and the service's recovery
 * loop twice before asserting that terminal work stayed terminal. Only the
 * queue's scheduling timestamps move; job state, deadlines and heartbeat
 * timestamps remain untouched. The supervisor uses the real pinned adapter.
 */
export async function runRecoveryBarrier(
  stack: RealStack,
  db: Pool,
  jobIds: readonly string[],
): Promise<void> {
  const boss = newTestBoss({
    connectionString: stack.jobsRuntimeDsn,
    ...jobsRuntimeBossOptions(),
    supervise: false,
    max: 1,
  });
  await boss.start();
  try {
    // A terminal wrapper alone is insufficient: a still-live runner claim
    // could retry after the barrier. Observe both durable states first.
    await waitFor(
      stack,
      "the observed jobs' runner claims to settle",
      { timeoutMs: 30_000 },
      async () => {
        const records = await db.query<{ status: string; runner_job_id: string | null }>(
          `SELECT status, runner_job_id FROM ${JOBS_JOB_RECORD_QUALIFIED} WHERE job_id = ANY($1::text[])`,
          [jobIds],
        );
        if (records.rows.length !== jobIds.length || records.rows.length === 0) {
          throw new Error("the recovery barrier must observe existing jobs");
        }
        for (const row of records.rows) {
          if (
            !(JOB_TERMINAL_STATUSES as readonly string[]).includes(row.status) ||
            !row.runner_job_id
          ) {
            throw new Error(
              "the recovery barrier requires terminal wrapper records with runner identities",
            );
          }
          const job = await boss.getJobById(JOBS_QUEUE_NAME, row.runner_job_id);
          if (!job) throw new Error("an observed job lost its runner row");
          if (!["completed", "cancelled", "failed"].includes(job.state)) return undefined;
        }
        return true;
      },
    );
    // Expiry and lost-heartbeat detection run in the monitor arm. The
    // separate deletion arm is disabled by this queue's retention policy.
    for (let pass = 0; pass < 2; pass++) {
      const scheduled = await db.query<{ since: Date }>(
        `UPDATE ${JOBS_PGBOSS_SCHEMA}.queue
            SET monitor_claim_on = now() - interval '1 minute',
                monitor_on = now() - interval '1 minute'
          WHERE name = $1 RETURNING now() AS since`,
        [JOBS_QUEUE_NAME],
      );
      const since = scheduled.rows[0]?.since;
      if (!since) throw new Error("the test stack's runner queue is missing");
      await boss.supervise(JOBS_QUEUE_NAME, { reindex: false });
      await waitFor(stack, "runner supervision to complete", { timeoutMs: 10_000 }, async () => {
        const result = await db.query<{ completed: boolean }>(
          `SELECT monitor_on >= $2 AS completed
             FROM ${JOBS_PGBOSS_SCHEMA}.queue WHERE name = $1`,
          [JOBS_QUEUE_NAME, since],
        );
        return result.rows[0]?.completed ? true : undefined;
      });

      const passes = async (): Promise<number> => {
        const reply = await stack.request(`http://localhost:${stack.ports.jobs}/health`);
        const health = HealthStatusSchema.parse(reply.json());
        const check = health.checks?.find((c) => c.name === JOBS_SWEEPER_CHECK);
        if (reply.status !== 200 || check?.status !== "ok" || check.metrics?.passes === undefined) {
          throw new Error("the recovery barrier requires a healthy jobs sweeper");
        }
        return check.metrics.passes;
      };
      const before = await passes();
      await waitFor(stack, "a recovery pass after supervision", { timeoutMs: 10_000 }, async () =>
        (await passes()) > before ? true : undefined,
      );
    }
  } finally {
    await boss.stop({ graceful: true, timeout: 5_000 });
  }
}

/** An exported execution span proves the attempt returned through its settlement fence. */
export async function waitForExecutionOutcome(
  stack: RealStack,
  jobId: string,
  outcome: JobsExecuteOutcome,
): Promise<void> {
  const capture = stack.telemetry;
  if (!capture) throw new Error("execution completion requires the test stack's telemetry capture");
  await waitFor(
    stack,
    `job ${jobId}'s execution to finish as ${outcome}`,
    { timeoutMs: 30_000 },
    async () => {
      for (const payload of capture.payloads) {
        if (payload.signal !== "traces") continue;
        const parsed = JSON.parse(payload.body) as {
          resourceSpans?: Array<{
            scopeSpans?: Array<{
              spans?: Array<{
                name?: string;
                attributes?: Array<{ key: string; value?: { stringValue?: string } }>;
              }>;
            }>;
          }>;
        };
        for (const resource of parsed.resourceSpans ?? []) {
          for (const scope of resource.scopeSpans ?? []) {
            for (const span of scope.spans ?? []) {
              if (span.name !== SPAN_JOBS_EXECUTE) continue;
              const value = (key: string) =>
                span.attributes?.find((a) => a.key === key)?.value?.stringValue;
              if (value(ATTR_JOBS_JOB_ID) === jobId && value(ATTR_OUTCOME) === outcome) return true;
            }
          }
        }
      }
      return undefined;
    },
  );
}
