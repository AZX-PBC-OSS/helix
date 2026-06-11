import { z } from "zod";

/**
 * How an app gates access at the edge (architecture §4.2).
 *
 * Modeled as a discriminated union rather than a flat enum because `group`
 * carries a payload (which Entra group may open the app). The manifest's
 * `group:<id>` shorthand (§6.3) maps onto `{ mode: "group", groupId }`.
 */
export const VisibilitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("private") }),
  z.object({ mode: z.literal("group"), groupId: z.string().min(1) }),
  z.object({ mode: z.literal("password") }),
  z.object({ mode: z.literal("public") }),
]);
export type Visibility = z.infer<typeof VisibilitySchema>;

/** The bare mode names, useful for enums/columns that don't need the payload. */
export const VISIBILITY_MODES = ["private", "group", "password", "public"] as const;
export const VisibilityModeSchema = z.enum(VISIBILITY_MODES);
export type VisibilityMode = z.infer<typeof VisibilityModeSchema>;
