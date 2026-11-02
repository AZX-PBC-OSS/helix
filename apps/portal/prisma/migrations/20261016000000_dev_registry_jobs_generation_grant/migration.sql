-- The dev-gateway's registry projection now selects `apps.jobsGeneration` (the
-- jobs lifecycle generation the projection carries as its canonical decimal
-- string) — the same column the production edge reads through helix_edge's
-- table-wide SELECT. helix_dev holds a COLUMN-scoped grant on `apps`
-- (20260722225628_dev_registry_grant_columns, reissued by 20260821183000 when
-- the group column was renamed), and an ungranted column is a runtime
-- `permission denied` on a query that type-checks and passes every unit test —
-- the exact failure 20260821183000's step 4 documents. Re-issue the grant with
-- the column added; the password columns stay excluded, which is the grant's
-- entire purpose (dev-mode §5.3).
--
-- Guarded `IF EXISTS (pg_roles …)` like the other grant migrations: on a
-- cluster whose bootstrap never created the runtime roles (some CI) this is a
-- clean no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    REVOKE SELECT ON apps FROM helix_dev;
    GRANT SELECT (
      id, slug, "visibilityMode", "visibilityGroupIds", capabilities,
      "archivedAt", "currentVersionId", "jobsGeneration"
    ) ON apps TO helix_dev;
  END IF;
END $$;
