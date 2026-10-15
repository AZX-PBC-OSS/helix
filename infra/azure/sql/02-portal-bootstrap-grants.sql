-- 02-portal-bootstrap-grants.sql — the prod `helix` database's bootstrap
-- grants for the portal (the PROD analog of the dev file of the same name in
-- .devcontainer/db-init): full DML (control plane — collection drain, usage
-- reads, registry writes). Table grants are reissued by migrations as tables
-- appear; this default keeps existing + future tables reachable.
--
-- Like its dev twin this file is the platform-database bootstrap ONLY: it is
-- never applied to the jobs database, where the role-conditional jobs
-- migrations are the sole source of table access.
--
-- Exception: `gateway_calls` is the append-only metering/audit ledger, and the
-- same pattern covers the edge/egress abuse-control tables `rate_counters` +
-- `instruction_jti` (ADR-0021, issue #17 / #13 / #3). Append-only binds every
-- writer role by grant, not just the edge.
--
-- The carve-outs are re-asserted below, not left to the migrations alone. The
-- blanket is additive and migrations are once-only — while this file is the
-- last word on every re-run, which is the supported upgrade path (create-roles.sh
-- applies every sql file on each invocation). A re-run over a migrated database
-- must end in the migrated posture, so the bootstrap carries the same revokes
-- the carve-out migrations apply. On a fresh database the ledgers do not exist
-- yet, the guard skips, and the migrations' own revokes are the first word. A
-- future ledger carve-out lands in its migration AND here — so far:
-- 20260721120000_gateway_calls_portal_readonly (gateway_calls),
-- 20260721215912_shared_rate_counters_and_jti_burn (rate_counters,
-- instruction_jti), 20260921120000_portal_sessions_least_privilege (sessions —
-- INSERT/UPDATE revoked; SELECT and DELETE deliberately kept for the admin
-- session list and the user-level revoke).
--
-- NB: `FOR ROLE helixadmin` must name the object owner that runs `db:deploy` —
-- i.e. the `postgresAdminLogin` Bicep param (default `helixadmin`). If you
-- overrode that param, substitute it in the two ALTER DEFAULT PRIVILEGES below.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO helix_portal;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO helix_portal;
ALTER DEFAULT PRIVILEGES FOR ROLE helixadmin
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helix_portal;
ALTER DEFAULT PRIVILEGES FOR ROLE helixadmin
  GRANT USAGE, SELECT ON SEQUENCES TO helix_portal;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'gateway_calls') THEN
    REVOKE INSERT, UPDATE, DELETE ON gateway_calls FROM helix_portal;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('rate_counters', 'instruction_jti')) THEN
    REVOKE INSERT, UPDATE, DELETE ON rate_counters, instruction_jti FROM helix_portal;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'sessions') THEN
    REVOKE INSERT, UPDATE ON sessions FROM helix_portal;
  END IF;
END $$;
