-- App-data design §2.1 (Layer 1) — least-privilege grants for the edge runtime
-- role on the tables that already existed before the role split. The edge now
-- connects as `helix_edge` (EDGE_DATABASE_URL) instead of the `helix` owner, so
-- it needs an explicit grant for every table it touches: the absence of a grant
-- is the containment boundary that survives an edge RCE.
--
-- GRANTs track the schema, so they live in a migration. They are guarded by a
-- role-existence check: the runtime roles are created by db-init/01-roles.sql
-- (dev) or Terraform (prod), NOT by migrations — so on a database whose cluster
-- never ran the bootstrap (some CI setups) this migration is a clean no-op
-- rather than a hard failure. `current_database()` keeps it correct whether it
-- runs against `helix` or `helix_test`.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO helix_edge', current_database());
    GRANT USAGE ON SCHEMA public TO helix_edge;
    -- gate + handoff burn: read/write its own session rows.
    GRANT SELECT, INSERT, UPDATE, DELETE ON sessions     TO helix_edge;
    -- registry projection: read-only.
    GRANT SELECT                         ON apps, versions TO helix_edge;
    -- meter: append a row per call + SUM today's tokens for the budget check.
    GRANT SELECT, INSERT                 ON gateway_calls TO helix_edge;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO helix_portal', current_database());
    GRANT USAGE ON SCHEMA public TO helix_portal;
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON sessions, apps, versions, gateway_calls, audit_events TO helix_portal;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO helix_portal;
  END IF;
END $$;
