-- App-data design §2.1 / Appendix A.1 — the database-role split — plus
-- background-jobs design §8 — the private jobs database and its identities.
--
-- Dev passwords are well-known; prod is infra/azure/sql/01-roles.sql (same
-- statements, secret passwords passed as psql variables). This file is
-- IDEMPOTENT: it creates what is missing and never touches what exists
-- (re-running it does not rotate passwords — ALTER ROLE for that), so it is
-- both the fresh-volume bootstrap and the upgrade path for an install that
-- predates a given role or database. Apply it to an existing dev container
-- without a volume reset:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f .devcontainer/db-init/01-roles.sql
--
-- The test suite applies the same file with the test databases substituted
-- (vitest.globalSetup.ts), so dev, CI and tests all run the one provisioning
-- definition. docker-entrypoint-initdb.d runs it on an empty data dir with no
-- variables; the \if defaults below are the initdb path.
--
-- `helix` (POSTGRES_USER) is the object owner == the §2.1 `helix_migrate` role
-- in dev; Prisma migrations already run as it. NOINHERIT + no role membership
-- => no runtime role can SET ROLE up to the owner; the boundary lives entirely
-- in the GRANTs.
--
-- The jobs plane gets its own database (background-jobs design §8: "one
-- private database per job server on the existing Postgres server"): runtime
-- role `helix_jobs` and a separate migration identity `helix_jobs_migrate`.
-- Neither holds CONNECT on the platform database — an absent connection is the
-- stronger property the role split buys there (no REVOKE list to maintain) —
-- and CONNECT is revoked from PUBLIC on both databases so default privileges
-- cannot admit a stranger.

-- Database names are psql variables so the test databases (helix_test /
-- helix_jobs_test) run the identical file. Defaults are the dev names.
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
-- silently flip the attribute (ADR-0002). None of these roles is a superuser.
-- `helix_jobs_migrate` is a migration identity, not a runtime role: it owns the
-- jobs schema-creation step and is never installed in a runtime image.
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT NOBYPASSRLS', name, pw)
FROM (VALUES
  ('helix_portal',       'helix_portal'),
  ('helix_edge',         'helix_edge'),
  ('helix_egress',       'helix_egress'),
  ('helix_dev',          'helix_dev'),
  ('helix_jobs',         'helix_jobs'),
  ('helix_jobs_migrate', 'helix_jobs_migrate')
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
-- DATABASE cannot run inside a DO block, hence \gexec.
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
