import { z } from "zod";

/**
 * Admin-facing views of live app-user sessions (`GET /api/v1/sessions`, the
 * portal Sessions screen). The portal reads the edge-owned `sessions` table
 * here; it never writes a session and never mints one — the read exists to aim
 * the one write it does hold, the user-level revoke.
 *
 * The kinds a session row can carry are narrower than `PrincipalKind` on
 * purpose: `anon` never gets a session row (public apps serve without one) and
 * `dev` is resolved per request from `app_dev_token`, so neither can appear
 * here — but a row predating the `userKind` column can carry null.
 */
const SessionPrincipalKindSchema = z.enum(["user", "password"]);

/**
 * One live session row (architecture Appendix A.4): who, on which app, until
 * when, carrying which group snapshot. `groups` is the snapshot as the edge
 * will re-check it per request — the *authorization fact*, not a label, which
 * is why it rides per session (a user's snapshots can differ across apps until
 * each one's silent refresh) rather than per user.
 *
 * Never includes `tokenHash`: it is not needed to aim a revoke, and the hash of
 * a live session cookie is exactly the artifact an admin list should not be
 * able to screenshot.
 */
export const SessionSummarySchema = z.object({
  id: z.uuid(),
  appId: z.uuid(),
  /** App slug at read time; the FK guarantees the app row exists. */
  slug: z.string(),
  /**
   * The identity half — Entra's `oid` claim since ADR-0048 (a pairwise `sub`
   * on rows that predate the re-base; a `pw_*` pseudonym for shared-password
   * visitors). Compared and joined on, never rendered except as a last
   * resort: the platform deliberately holds no Graph `/users` grant, so no
   * principal id it stores resolves to a name.
   */
  userOid: z.string(),
  /**
   * The display half, captured at login. Render, never compare. Null for
   * shared-password visitors (each login is a fresh pseudonym) and for rows
   * predating the columns.
   */
  userName: z.string().nullable(),
  userEmail: z.string().nullable(),
  userKind: SessionPrincipalKindSchema.nullable(),
  /** Group-id snapshot as of this session's login/refresh. */
  groups: z.array(z.string()),
  createdAt: z.iso.datetime(),
  /** Null while the handoff is un-redeemed — impossible here (live rows only). */
  activatedAt: z.iso.datetime().nullable(),
  /** When silent re-auth (`prompt=none`) becomes due; past = overdue. */
  refreshDueAt: z.iso.datetime(),
  /** Hard cap — the session is dead at this instant regardless of activity. */
  expiresAt: z.iso.datetime(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

/**
 * The sessions list. `rows` is flat; the SPA groups it by `userOid` (the
 * revoke operation is user-level — one click, every app).
 *
 * `groupNames` resolves the union of the rows' group ids to display names via
 * the directory seam (`getGroups`) — the same primitive the my-groups route
 * uses, so no new directory capability. It is a map rather than per-session
 * names so one resolution serves every row; an id missing from the map (or
 * mapped to null) renders as the raw id, which is always correct — the id is
 * the fact and the name is a courtesy. `groupsResolved` is false when the
 * directory was unavailable or refused, so the UI can say "names unavailable"
 * once instead of rendering a page of bare GUIDs with no explanation.
 */
export const SessionListResponseSchema = z.object({
  rows: z.array(SessionSummarySchema),
  groupNames: z.record(z.string(), z.string().nullable()),
  groupsResolved: z.boolean(),
});
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;

/** Body of `POST /api/v1/sessions/revoke` — kill every session of one user. */
export const SessionRevokeRequestSchema = z.object({
  /**
   * A session's principal id as seen in the list — the `oid` claim, a `pw_*`
   * pseudonym, or a pre-re-base pairwise `sub`. Opaque to the admin; copied
   * from the row they clicked, so its shape is whatever the session rows
   * hold — bounded only against abuse, not parsed.
   */
  userOid: z.string().min(1).max(200),
});
export type SessionRevokeRequest = z.infer<typeof SessionRevokeRequestSchema>;

/**
 * Revoke result. `removed` counts rows deleted (including any never-redeemed
 * pending of the same user — collateral of the same kill). Idempotent by
 * design: revoking a user whose last session expired between list and click
 * returns `{ removed: 0 }` rather than an error, because "no live sessions" is
 * the desired end state, not a failure.
 */
export const SessionRevokeResultSchema = z.object({
  removed: z.int().nonnegative(),
  /** Slugs of the apps the removed sessions lived on; empty when none. */
  apps: z.array(z.string()),
});
export type SessionRevokeResult = z.infer<typeof SessionRevokeResultSchema>;
