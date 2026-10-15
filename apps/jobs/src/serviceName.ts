/**
 * The jobs service's own name, in its own module — see
 * `apps/edge/src/serviceName.ts` for why this is not a constant in `app.ts`
 * (ADR-0037 decision 3).
 *
 * One value, three consumers that must never disagree: the OTel `service.name`
 * resource attribute, the `/health` `service` field, and the boot log line.
 *
 * **Not** a job-server id. The configured server this instance runs as is
 * `JOBS_SERVER_ID` (`config.ts`) — a deployment-map name the signing and
 * routing contracts consume — while this is the process's display name.
 */
export const SERVICE_NAME = "helix-jobs";
