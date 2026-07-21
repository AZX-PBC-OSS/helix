-- 01-roles.sql — PROD analog of .devcontainer/db-init/01-roles.sql (ADR-0002).
--
-- Creates the three least-privilege runtime roles beside the `helixadmin`
-- object owner. This is data-plane, NOT infrastructure: postgres.bicep
-- provisions the server + `helix` DB only, and these roles + their table GRANTs
-- come from role SQL + Prisma `db:deploy` run post-deploy as the admin (see the
-- infra README, step 4). Run this ONCE, from inside the VNet, connected as the
-- admin, BEFORE `db:deploy` — the migration GRANTs are guarded by an
-- `IF EXISTS (pg_roles …)` check, so the roles must exist first.
--
-- Passwords are passed as psql variables so no secret lives in this file — use
-- the SAME passwords fed to the Bicep deploy (HELIX_*_DB_PASSWORD):
--
--   psql "$ADMIN_URL" \
--     -v edge_password="$HELIX_EDGE_DB_PASSWORD" \
--     -v portal_password="$HELIX_PORTAL_DB_PASSWORD" \
--     -v egress_password="$HELIX_EGRESS_DB_PASSWORD" \
--     -v ON_ERROR_STOP=1 \
--     -f infra/azure/sql/01-roles.sql
--
-- NOINHERIT + no role membership => no runtime role can SET ROLE up to the owner;
-- the boundary lives entirely in the GRANTs.
--
-- NOBYPASSRLS is the CREATE ROLE default, but we state it explicitly on every
-- runtime role: it is the property the app_data / gateway_calls / sessions /
-- app_collection_items RLS backstop leans on (a BYPASSRLS role would sail past
-- every partition policy), and the control plane's cross-app reads deliberately
-- route through the permissive `*_portal_all` policies rather than a bypass — so
-- helix_portal must not bypass either. Explicit here so a future edit can't
-- silently flip the attribute. None of these roles is a superuser; on Azure
-- Postgres Flexible Server no role can be granted BYPASSRLS by the admin anyway,
-- but we assert the intent regardless.

CREATE ROLE helix_portal LOGIN PASSWORD :'portal_password' NOINHERIT NOBYPASSRLS;
CREATE ROLE helix_edge   LOGIN PASSWORD :'edge_password'   NOINHERIT NOBYPASSRLS;
-- The mechanism plane (azx-egress): resolves & injects connection secrets. It is
-- the only runtime role with SELECT on app_secrets.material; like helix_edge it
-- gets NO blanket grant (fail-closed) — every table is explicit in a migration.
CREATE ROLE helix_egress LOGIN PASSWORD :'egress_password' NOINHERIT NOBYPASSRLS;

-- All runtime roles connect to the same database and need the schema on their
-- search_path.
GRANT CONNECT ON DATABASE helix TO helix_portal, helix_edge, helix_egress;
GRANT USAGE   ON SCHEMA public  TO helix_portal, helix_edge, helix_egress;

-- helix_portal: full DML runtime (control plane — collection drain, usage
-- reads, registry writes). Table grants are reissued by migrations as tables
-- appear; this default keeps existing + future tables reachable.
-- NB: edge/egress-written ledgers are carved back to portal SELECT-only by their
-- migrations (gateway_calls in 20260721120000; rate_counters + instruction_jti in
-- 20260721215912) — append-only / write-isolation binds every writer role by
-- grant, not just the runtime role (ADR-0021, issue #17/#13/#3).
-- NB: `FOR ROLE helixadmin` must name the object owner that runs `db:deploy` —
-- i.e. the `postgresAdminLogin` Bicep param (default `helixadmin`). If you
-- overrode that param, substitute it in the two ALTER DEFAULT PRIVILEGES below.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO helix_portal;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO helix_portal;
ALTER DEFAULT PRIVILEGES FOR ROLE helixadmin
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helix_portal;
ALTER DEFAULT PRIVILEGES FOR ROLE helixadmin
  GRANT USAGE, SELECT ON SEQUENCES TO helix_portal;

-- helix_edge / helix_egress: NO blanket grant, NO default privileges. Every
-- table is owner-only until a migration grants it explicitly (fail-closed,
-- ADR-0002). Do NOT add ALTER DEFAULT PRIVILEGES for them — that would silently
-- grant new tables and defeat the whole point. The collection write-only
-- property and the app_secrets deny ARE the absence of a SELECT grant here.
