/**
 * The edge's own name, in its own module.
 *
 * Extracted out of `app.ts` so `telemetry.ts` can name the tracer and meter
 * without importing the module that builds the app — `app.ts` pulls in the
 * gateway, which pulls in `telemetry.ts`, so a constant living in `app.ts`
 * would close that loop (ADR-0037 decision 3).
 *
 * One value, three consumers that must never disagree: the OTel `service.name`
 * resource attribute, the `/health` `service` field, and the boot log line.
 */
export const SERVICE_NAME = "helix-edge";
