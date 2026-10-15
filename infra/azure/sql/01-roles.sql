-- 01-roles.sql — PROD analog of .devcontainer/db-init/01-roles.sql (ADR-0002),
-- plus background-jobs design §8 — the private jobs database and its
-- identities.
--
-- Creates the least-privilege runtime roles beside the `helixadmin`
-- object owner. This is data-plane, NOT infrastructure: postgres.bicep
-- provisions the server + `helix` DB only, and these roles + their table GRANTs
-- come from role SQL + Prisma `db:deploy`, run post-deploy as the admin (see the
-- infra README, step 4). Run this from inside the VNet, connected as the
-- admin, BEFORE `db:deploy` — the migration GRANTs are guarded by an
-- `IF EXISTS (pg_roles …)` check, so the roles must exist first. On the first
-- run the jobs database (`helix_jobs`) is created here too. `scripts/create-roles.sh`
-- is the wrapper that runs both sql files (01, then 02-portal-bootstrap-grants.sql)
-- as a throwaway job; the direct form is:
--
--   for f in infra/azure/sql/*.sql; do
--     psql "$ADMIN_URL" \
--       -v edge_password="$HELIX_EDGE_DB_PASSWORD" \
--       -v portal_password="$HELIX_PORTAL_DB_PASSWORD" \
--       -v egress_password="$HELIX_EGRESS_DB_PASSWORD" \
--       -v dev_password="$HELIX_DEV_DB_PASSWORD" \
--       -v jobs_password="$HELIX_JOBS_DB_PASSWORD" \
--       -v jobs_migrate_password="$HELIX_JOBS_MIGRATE_DB_PASSWORD" \
--       -v ON_ERROR_STOP=1 -f "$f"
--   done
--
-- `dev_password` is only used when the opt-in dev-gateway is deployed
-- (deployDevGateway=true). Pass a throwaway value even if you are not deploying
-- it — the role is created regardless (harmless, unreachable without the app),
-- and creating it later needs the whole migration re-run to pick up its guarded
-- grants. Its grants + the env-literal RLS come from the migration (guarded by
-- an `IF EXISTS (pg_roles …)` check, so the role must exist first).
--
-- This file is IDEMPOTENT: roles/databases already present are left untouched
-- (re-running does not rotate passwords — ALTER ROLE through the
-- create-roles.sh job shape for that), so applying the current ACL posture to
-- an install that predates a role or the jobs database is a re-run, not a
-- rebuild.
--
-- NOINHERIT + no role membership => no runtime role can SET ROLE up to the owner;
-- the boundary lives entirely in the GRANTs.
--
-- Database names are psql variables with the platform defaults (the dev file
-- overrides them for the test databases; prod always runs the defaults).
\if :{?platform_db}
\else
\set platform_db 'helix'
\endif
\if :{?jobs_db}
\else
\set jobs_db 'helix_jobs'
\endif

-- NOBYPASSRLS is the CREATE ROLE default, but we state it explicitly on every
-- role: it is the property the app_data / gateway_calls / sessions /
-- app_collection_items RLS backstop leans on (a BYPASSRLS role would sail past
-- every partition policy), and the control plane's cross-app reads deliberately
-- route through the permissive `*_portal_all` policies rather than a bypass — so
-- helix_portal must not bypass either. Explicit here so a future edit can't
-- silently flip the attribute. None of these roles is a superuser; on Azure
-- Postgres Flexible Server no role can be granted BYPASSRLS by the admin anyway,
-- but we assert the intent regardless.
-- `helix_jobs_migrate` is a migration identity, not a runtime role: it owns the
-- jobs schema-creation step and is never installed in a runtime image.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT NOBYPASSRLS', name, pw)
FROM (VALUES
  ('helix_portal',       :'portal_password'),
  ('helix_edge',         :'edge_password'),
  ('helix_egress',       :'egress_password'),
  ('helix_dev',          :'dev_password'),
  ('helix_jobs',         :'jobs_password'),
  ('helix_jobs_migrate', :'jobs_migrate_password')
) AS roles(name, pw)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = roles.name) \gexec

-- Platform database: the four existing runtime roles keep CONNECT explicitly —
-- and only they (plus the owner): PUBLIC loses CONNECT, so a role with no
-- explicit grant cannot reach the platform database at all. helix_jobs and
-- helix_jobs_migrate are deliberately absent here; their absence is the
-- jobs→platform boundary.
GRANT CONNECT ON DATABASE :"platform_db" TO helix_portal, helix_edge, helix_egress, helix_dev;
REVOKE CONNECT ON DATABASE :"platform_db" FROM PUBLIC;
GRANT USAGE   ON SCHEMA public  TO helix_portal, helix_edge, helix_egress, helix_dev;

-- The jobs database, created if this install predates the jobs plane (new
-- databases inherit template1's PUBLIC CONNECT, revoked below). CREATE
-- DATABASE cannot run inside a DO block, hence \gexec. Until the deployment
-- definitions land their own `helix_jobs` databases resource, this
-- create-if-missing is the only declarant; provisioning-parity.test.ts holds
-- the two names together, so the resource cannot arrive under a different
-- name than the one hardened here.
SELECT 'CREATE DATABASE ' || quote_ident(:'jobs_db')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'jobs_db') \gexec

\connect :"jobs_db"

-- Jobs database: only the jobs runtime and the jobs migration identity may
-- connect — no platform runtime role, and no PUBLIC.
REVOKE CONNECT ON DATABASE :"jobs_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"jobs_db" TO helix_jobs, helix_jobs_migrate;

-- helix_jobs: reach the tables a jobs migration explicitly grants it, nothing
-- more. NO default privileges are set here — fail-closed like helix_edge:
-- every table grant arrives by migration, and a table the migrations have not
-- granted is invisible to the runtime.
GRANT USAGE ON SCHEMA public TO helix_jobs;

-- helix_jobs_migrate: schema creation (CREATE on the database) and table
-- creation (CREATE on public) — the whole of its migration authority, confined
-- to this database. Runtime roles get neither.
GRANT CREATE ON DATABASE :"jobs_db" TO helix_jobs_migrate;
GRANT USAGE, CREATE ON SCHEMA public TO helix_jobs_migrate;

-- The helix_portal dev/prod-database bootstrap grants live in
-- 02-portal-bootstrap-grants.sql (create-roles.sh applies every sql/*.sql in
-- order), mirroring .devcontainer/db-init's split: 01 is the idempotent
-- role/database ACL authority — the only file the test databases re-apply —
-- and 02 is the portal blanket that must never reach the test databases.

-- helix_edge / helix_egress / helix_dev / helix_jobs: NO blanket grant, NO
-- default privileges. Every table is owner-only until a migration grants it
-- explicitly (fail-closed, ADR-0002). Do NOT add ALTER DEFAULT PRIVILEGES for
-- them — that would silently grant new tables and defeat the whole point. The
-- collection write-only property and the app_secrets deny ARE the absence of a
-- SELECT grant here. helix_dev additionally never gets a prod row: its
-- env='dev' RLS literal (the migration) confines it regardless of any grant.
-- helix_jobs' grants live in the jobs database's own migrations, never here.
