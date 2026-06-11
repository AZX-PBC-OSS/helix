import { z } from "zod";

/**
 * Liveness response shape, shared by every service's `/health` endpoint so the
 * contract is identical across edge and portal. Readiness checks (DB, Blob)
 * arrive with the dependencies that need them in M1/M2.
 */
export const HealthStatusSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  /** Process uptime in seconds. */
  uptime: z.number().nonnegative(),
});
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
