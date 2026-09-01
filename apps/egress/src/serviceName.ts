/**
 * Egress's own name, in its own module — see `apps/edge/src/serviceName.ts` for
 * why this is not a constant in `app.ts` (ADR-0037 decision 3).
 *
 * One value, three consumers that must never disagree: the OTel `service.name`
 * resource attribute, the `/health` `service` field, and the boot log line.
 *
 * **Not** the instruction audience. `INSTRUCTION_AUDIENCE` (`@azx-pbc/shared`)
 * is still `azx-egress` and stays that way: it is a verified claim on a
 * coordinated-deploy path, not a display name (ADR-0032).
 */
export const SERVICE_NAME = "helix-egress";
