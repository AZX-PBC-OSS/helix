-- ADR-0040 decision 5 — `visibilityGroupId` (one nullable group) becomes
-- `visibilityGroupIds text[]` (N groups, any-of, cap 10 in zod).
--
-- WHY THIS IS ONE MIGRATION AND NOT THREE. The `private` → `internal` rename
-- (20260812224500 / 20260812233500 / 20260812235920) took the full expand →
-- backfill → contract dance across three releases, because it changed a column
-- that live traffic was reading through the edge's cached projection: a replica
-- running the old image had to keep working against the new schema, and vice
-- versa. That reasoning does not apply here, and the reason is specific rather
-- than convenient: **there are no live `group` apps to be compatible with.**
-- Until 4915489 the deployed install set EDGE_OIDC_GROUPS_CLAIM=roles against a
-- registration that declared no app roles, so the claim was empty for every user
-- and a `group` app denied 100% of them including its own owner. Nobody can have
-- been depending on the old column's value, so the rewrite has no reader to
-- stage around. If that assumption is ever wrong, the `SELECT` below is the
-- audit: it reports what it moved.
--
-- The table is tens of rows, so the ACCESS EXCLUSIVE lock an ADD/DROP COLUMN
-- takes is milliseconds (same note as 20260812235920).

-- 1) Expand. NOT NULL DEFAULT '{}' so every existing row is immediately valid
--    and the projection's array read never sees a NULL.
ALTER TABLE apps ADD COLUMN "visibilityGroupIds" text[] NOT NULL DEFAULT '{}';

-- 2) Backfill. A `group` app with a non-null scalar becomes a one-element array;
--    everything else keeps the empty array. Note the empty array is a LEGAL
--    `group` state meaning "nobody" — it is what the old NULL meant, and
--    `visibilityAllows` (apps/edge/src/auth/validate.ts) fails closed on it — so
--    a row that somehow held mode='group' with a NULL id keeps its exact prior
--    (deny-everyone) behaviour rather than being silently widened.
UPDATE apps
   SET "visibilityGroupIds" = ARRAY["visibilityGroupId"]
 WHERE "visibilityGroupId" IS NOT NULL;

-- 3) Contract.
ALTER TABLE apps DROP COLUMN "visibilityGroupId";

-- 4) Re-issue the dev role's COLUMN-SCOPED grant.
--
-- This is the step that is easy to miss and fails at runtime rather than here.
-- 20260722225628_dev_registry_grant_columns narrowed helix_dev from a table-wide
-- SELECT on `apps` to an explicit column list (so the dev-gateway's role cannot
-- read the `password*` credential columns), and that list NAMED
-- "visibilityGroupId". Dropping the column above silently drops it from the
-- grant, and the replacement column is not covered by anything — so the dev
-- registry projection would start failing with `permission denied for table
-- apps` on a query that type-checks and passes every unit test.
--
-- helix_edge needs nothing: it holds a table-wide SELECT on `apps`
-- (20260616000001_edge_role_grants), so a new column is covered automatically.
-- That asymmetry is the whole reason only one role appears below.
--
-- Guarded `IF EXISTS (pg_roles …)` like the other grant migrations: on a cluster
-- whose bootstrap never created the runtime roles (some CI) this is a clean
-- no-op, and migrations run after db-init so this is the last word.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    REVOKE SELECT ON apps FROM helix_dev;
    GRANT SELECT (
      id, slug, "visibilityMode", "visibilityGroupIds", capabilities,
      "archivedAt", "currentVersionId"
    ) ON apps TO helix_dev;
  END IF;
END $$;

-- 5) Migrate the enum's two JSONB mirrors.
--
-- Visibility values are duplicated outside the `apps` row in `approval_requests`
-- (`deltas[].from`/`.to` and `baseSnapshot.visibility`), which is why
-- 20260812233500 had to touch them too. Those now carry the canonical
-- `visibilityLabel` form (`group:<sorted,ids>`) rather than a bare mode, so any
-- OPEN request whose visibility delta or snapshot says plain `group` is
-- comparing against a shape that no longer occurs — `snapshotConflicts` would
-- read it as a conflict and bounce the request to needs_changes.
--
-- Scoped to `status = 'pending'` on purpose, exactly as 20260812233500 was:
-- decided rows and `audit_events.metadata` are immutable history and record what
-- was true when they were written. Bouncing a pending request is the safe
-- outcome (the requester refiles against current state), so this is a courtesy,
-- not a correctness fix — hence a report rather than a rewrite.
DO $$
DECLARE
  stale int;
BEGIN
  SELECT count(*) INTO stale
    FROM approval_requests
   WHERE status = 'pending'
     AND ("baseSnapshot" ->> 'visibility' = 'group'
          OR deltas::text LIKE '%"visibility"%');
  IF stale > 0 THEN
    RAISE NOTICE 'ADR-0040: % pending approval request(s) carry a visibility snapshot in the '
                 'pre-label form; they will bounce to needs_changes on approve and must be '
                 'refiled. This is fail-safe, not data loss.', stale;
  END IF;
END $$;
