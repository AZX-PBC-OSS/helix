/**
 * The jobs service's own name, in its own module — see
 * `apps/edge/src/serviceName.ts` for why this is not a constant in `app.ts`
 * (ADR-0037 decision 3).
 *
 * One value, four consumers that must never disagree: the OTel `service.name`
 * resource attribute, the `/health` `service` field, the boot log line, and —
 * derived from the shared authority this imports — the edge's reachability
 * probe, which verifies a `/health` body was answered by THIS service and
 * not by another helix process sharing the wire contract.
 *
 * **Not** a job-server id. The configured server this instance runs as is
 * `JOBS_SERVER_ID` (`config.ts`) — a deployment-map name the signing and
 * routing contracts consume — while this is the process's display name.
 */
export { JOBS_SERVICE_NAME as SERVICE_NAME } from "@azx-pbc/shared";
