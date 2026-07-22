-- Dev-mode design §3 / §5.4 — the dev-gateway runs as helix_dev and serves the
-- same apps' manifests/capabilities as the edge (but for env=dev), so it needs to
-- read the registry projection. helix_edge already has SELECT on apps/versions
-- (20260616000001_edge_role_grants); grant helix_dev the same read-only access.
-- Guarded like every runtime-role grant (clean no-op on a cluster without the role).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    GRANT SELECT ON apps, versions TO helix_dev;
  END IF;
END $$;
