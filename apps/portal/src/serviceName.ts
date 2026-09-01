/**
 * The portal's own name, in its own module — see `apps/edge/src/serviceName.ts`
 * for why this is not a constant in `app.ts` (ADR-0037 decision 3).
 *
 * One value, three consumers that must never disagree: the OTel `service.name`
 * resource attribute, the `/health` `service` field, and the boot log line.
 */
export const SERVICE_NAME = "helix-portal";
