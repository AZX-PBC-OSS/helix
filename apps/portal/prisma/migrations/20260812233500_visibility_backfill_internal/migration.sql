-- Rename the visibility mode `private` → `internal`, step 2 of 3 (backfill).
--
-- Release 1 (20260812224500_visibility_add_internal) added the `internal` label
-- and taught every read path to translate the old one. Now that all replicas run
-- that code, the stored values can move. Nothing here changes behaviour: reads
-- already normalise `private` to `internal`, so this migration makes the column
-- agree with what every caller has been seeing.
--
-- No deploy window and no image change. This is migration-only: release-1 code
-- reads BOTH labels, so it is correct before, during and after these statements.
-- Trigger the migrate job on its own; there is nothing to roll alongside it.
--
-- Release 3 removes the read-side alias and drops the label (see TODO.md).

-- 1. The column itself. Reads already translate these rows; this makes it real.
UPDATE apps
   SET "visibilityMode" = 'internal'
 WHERE "visibilityMode" = 'private';

-- 2 & 3. The enum lives in a column, but two JSONB payloads *mirror* it, and a
-- rename that reaches only the column silently invalidates every open approval
-- request. `captureSnapshot` stores the bare mode string for the `visibility`
-- area and `snapshotConflicts` compares it by JSON.stringify equality
-- (packages/shared/src/approval.ts), so a request filed before release 1 holds
--     baseSnapshot = {"visibility": "private"}
--     deltas       = [{"path":"visibility","from":"private","to":"public"}]
-- against an app now labelled `internal` → mismatch → the approve path bounces
-- it to `needs_changes` with a reason that is factually wrong: nothing about the
-- app changed, the platform renamed a label underneath it. The owner has to
-- notice and re-file. Fail-safe in direction, silent and misattributed in
-- practice — so the payloads move with the column.
--
-- Scoped to `pending` deliberately. Decided rows are a historical record of what
-- was requested and approved at the time, and should keep the spelling that was
-- current then — the same reason `audit_events.metadata` is left untouched.

-- 2. The conflict-detection snapshot.
UPDATE approval_requests
   SET "baseSnapshot" = jsonb_set("baseSnapshot", '{visibility}', '"internal"')
 WHERE status = 'pending'
   AND "baseSnapshot" -> 'visibility' = '"private"';

-- 3. The rendered diff. Only `from` can carry the old label: a delta becomes a
-- *request* only when elevated, and `classifyVisibilityChange` elevates solely
-- on `to === "public"` — so no pending row can hold `"to": "private"`, and
-- rewriting `to` would be guarding a state that cannot exist.
--
-- WITH ORDINALITY + ORDER BY keeps the rebuilt array in its original order.
-- jsonb_agg over a set has no inherent ordering guarantee, and these arrays are
-- rendered to a reviewer as the change list.
UPDATE approval_requests
   SET deltas = (
         SELECT jsonb_agg(
                  CASE
                    WHEN d ->> 'path' = 'visibility' AND d ->> 'from' = 'private'
                    THEN jsonb_set(d, '{from}', '"internal"')
                    ELSE d
                  END
                  ORDER BY ord)
           FROM jsonb_array_elements(approval_requests.deltas) WITH ORDINALITY AS t(d, ord))
 WHERE status = 'pending'
   AND deltas @> '[{"path": "visibility", "from": "private"}]';
