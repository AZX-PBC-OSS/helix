/**
 * The `jobs_*` health-check vocabulary (ADR-0009) — the stable check names the
 * health producers report and body-aware alert rules key on.
 *
 * **Each service reports only its owned checks, never all of them**: the jobs
 * service owns storage, worker, sweeper, capacity, cleanup, intake and
 * lifecycle recovery; the edge owns the bounded reachability probe; the
 * portal owns lifecycle delivery. A name absent from a body means that service
 * does not hold that dependency — it is never read as healthy, because the
 * shared rule is that missing or stale evidence never reports `ok`.
 */

/** The jobs service's store: reachable, at the pinned schema, carrying the platform queue policy. */
export const JOBS_DATABASE_CHECK = "jobs_database";
/** The jobs service's worker execution: the runner started and a worker is registered on it. */
export const JOBS_WORKER_CHECK = "jobs_worker";
/** The jobs service's recovery sweeper: the loop that reconciles interrupted work (its pass freshness is what is graded). */
export const JOBS_SWEEPER_CHECK = "jobs_sweeper";
/** The edge's bounded jobs-reachability probe, independent of user requests. */
export const JOBS_REACHABILITY_CHECK = "jobs_reachability";
/** The jobs service's retained/unfinished storage capacity posture (saturation degrades). */
export const JOBS_CAPACITY_CHECK = "jobs_capacity";
/** The portal's lifecycle-delivery backlog (outbox delivery to jobs servers). */
export const JOBS_LIFECYCLE_DELIVERY_CHECK = "jobs_lifecycle_delivery";
/** The jobs service's lifecycle-cancellation recovery backlog (older than 60 s degrades). */
export const JOBS_LIFECYCLE_RECOVERY_CHECK = "jobs_lifecycle_recovery";
/** The jobs service's cleanup loop lag (overdue record/result cleanup degrades). */
export const JOBS_CLEANUP_CHECK = "jobs_cleanup";
/** The jobs service's intake: the configured accepting state applied durably, and the closed intake's drain progress. */
export const JOBS_INTAKE_CHECK = "jobs_intake";

/**
 * Every check name in the vocabulary, as a bounded set — the inventory an
 * alert rule may key on. A producer emitting a name outside it has drifted
 * from ADR-0009; a consumer keying on a name outside it has invented one.
 */
export const JOBS_HEALTH_CHECK_NAMES = [
  JOBS_DATABASE_CHECK,
  JOBS_WORKER_CHECK,
  JOBS_SWEEPER_CHECK,
  JOBS_REACHABILITY_CHECK,
  JOBS_CAPACITY_CHECK,
  JOBS_LIFECYCLE_DELIVERY_CHECK,
  JOBS_LIFECYCLE_RECOVERY_CHECK,
  JOBS_CLEANUP_CHECK,
  JOBS_INTAKE_CHECK,
] as const;
export type JobsHealthCheckName = (typeof JOBS_HEALTH_CHECK_NAMES)[number];
