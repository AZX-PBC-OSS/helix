-- The portal reads and writes repo bindings (routes/repoBinding.ts and the CI
-- deploy route) as helix_portal, but `repo_bindings` relied on the
-- bootstrap's default privileges for that grant, the same gap
-- `app_dev_token` had. A database prepared from the roles file and the
-- migrations alone (every resolved local stack and the test databases) left
-- the portal with `permission denied` on every repo-binding route. Grant it
-- here like every other portal table.
--
-- Guarded `IF EXISTS (pg_roles …)` like the other grant migrations: on a
-- cluster whose bootstrap never created the runtime roles this is a clean
-- no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON repo_bindings TO helix_portal;
  END IF;
END $$;
