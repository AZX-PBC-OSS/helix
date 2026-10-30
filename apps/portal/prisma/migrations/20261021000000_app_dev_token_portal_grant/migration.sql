-- The portal mints, lists and revokes dev tokens (routes/devTokens.ts) as
-- helix_portal, but `app_dev_token` was the one portal-owned table whose
-- portal grant came only from the dev `helix` database's default privileges
-- (02-portal-bootstrap-grants.sql). A database prepared from the roles file
-- and the migrations alone — every resolved local stack and the test
-- databases — left the portal with `permission denied` on every dev-token
-- route. Grant it here like every other portal table.
--
-- Guarded `IF EXISTS (pg_roles …)` like the other grant migrations: on a
-- cluster whose bootstrap never created the runtime roles this is a clean
-- no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_dev_token TO helix_portal;
  END IF;
END $$;
