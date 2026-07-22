import { z } from "zod";

/**
 * The environment tier a gateway call is scoped to (dev-mode design §5). `prod`
 * is the live app; `dev` is the isolated develop-against-the-platform partition
 * reached through the dev surfaces. It is a partition dimension on every
 * app-data table, the metering ledger, and connection secrets — never a value
 * an app or request may choose. The production path defaults to `prod`
 * everywhere; only the dev surfaces (a `DevTokenResolver`) ever set `dev`.
 */
export const ENVS = ["prod", "dev"] as const;
export const EnvSchema = z.enum(ENVS);
export type Env = z.infer<typeof EnvSchema>;
