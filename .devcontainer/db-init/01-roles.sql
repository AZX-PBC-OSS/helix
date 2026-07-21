-- App-data design §2.1 / Appendix A.1 — the database-role split.
--
-- Dev only. In prod these are Terraform-managed with real/IAM credentials.
-- `helix` (POSTGRES_USER) is the object owner == the §2.1 `helix_migrate` role
-- in dev; Prisma migrations already run as it. We add the two least-privilege
-- runtime roles beside it. NOINHERIT + no role membership => neither runtime
-- role can SET ROLE up to the owner; the boundary lives entirely in the GRANTs.
--
-- Postgres runs every *.sql in /docker-entrypoint-initdb.d exactly ONCE, on an
-- empty data dir. Applying this to an existing dev container needs a db volume
-- reset (`pnpm --filter @azx-pbc/portal db:reset` re-seeds schema, but role
-- creation needs the volume recreated: `docker compose down -v` / rebuild).

-- NOBYPASSRLS is the CREATE ROLE default, but we state it explicitly on every
-- runtime role: it is the property the app_data / gateway_calls / sessions /
-- app_collection_items RLS backstop leans on (a BYPASSRLS role would sail past
-- every partition policy), and the control plane's cross-app reads deliberately
-- route through the permissive `*_portal_all` policies rather than a bypass — so
-- helix_portal must not bypass either. Explicit here so a future edit can't
-- silently flip the attribute (ADR-0002). None of these roles is a superuser.
CREATE ROLE helix_portal LOGIN PASSWORD 'helix_portal' NOINHERIT NOBYPASSRLS;
CREATE ROLE helix_edge   LOGIN PASSWORD 'helix_edge'   NOINHERIT NOBYPASSRLS;
-- The mechanism plane (azx-egress): resolves & injects connection secrets. It is
-- the only runtime role with SELECT on app_secrets.material; like helix_edge it
-- gets NO blanket grant (fail-closed) — every table is explicit in a migration.
CREATE ROLE helix_egress LOGIN PASSWORD 'helix_egress' NOINHERIT NOBYPASSRLS;

-- All runtime roles connect to the same database and need the schema on their
-- search_path. The test database is created later (vitest global setup) as the
-- owner; grant there happens in the migration GRANTs that track the schema.
GRANT CONNECT ON DATABASE helix TO helix_portal, helix_edge, helix_egress;
GRANT USAGE   ON SCHEMA public  TO helix_portal, helix_edge, helix_egress;

-- helix_portal: full DML runtime (control plane — collection drain, usage
-- reads, registry writes). Table grants are reissued by migrations as tables
-- appear; this default keeps existing + future tables reachable.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO helix_portal;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA public TO helix_portal;
ALTER DEFAULT PRIVILEGES FOR ROLE helix
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO helix_portal;
ALTER DEFAULT PRIVILEGES FOR ROLE helix
  GRANT USAGE, SELECT ON SEQUENCES TO helix_portal;

-- helix_edge: NO blanket grant, NO default privileges. Every table is
-- owner-only until a migration grants it explicitly (fail-closed, §2.1). Do
-- NOT add ALTER DEFAULT PRIVILEGES for helix_edge — that would silently grant
-- new tables and defeat the whole point. The §3.2 collection write-only
-- property IS the absence of a SELECT grant here.
