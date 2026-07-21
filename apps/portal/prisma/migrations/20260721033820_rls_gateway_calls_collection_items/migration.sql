-- ADR-0002 (review ISSUE-12 / ISSUE-13) — extend the app_data RLS pattern to the
-- other two edge-written tables so a partition mistake fails CLOSED instead of
-- crossing apps.
--
--   * gateway_calls        — helix_edge has table-wide SELECT (per-app budget
--                            SUMs) + INSERT (one row per call). Without RLS a
--                            metering-query bug, or a naive no-GUC `SELECT *`,
--                            reads EVERY app's usage history (ISSUE-12).
--   * app_collection_items — helix_edge has INSERT only. Without RLS nothing
--                            constrains which app's partition a row lands in, so
--                            an appId-confusion bug pollutes another app's
--                            collection (ISSUE-13).
--
-- The control we add is exactly app_data's (migration 20260616231036): FORCE RLS
-- + a policy keyed on the `app.app_id` GUC, which the edge sets per request from
-- the VERIFIED session via set_config (see apps/edge/src/db/partition.ts). A
-- missing GUC → current_setting(..., true) is NULL → the predicate matches zero
-- rows and an INSERT fails the WITH CHECK. This is a fail-closed backstop against
-- application bugs and a no-GUC smash-and-grab — NOT RCE containment: an RCE owns
-- the connection and can set the GUC itself. The RCE boundary in this system is
-- grant-absence (no SELECT on app_secrets, no registry write), which is unchanged.
--
-- Unlike app_data (which the portal never reads), the control plane reads BOTH
-- of these cross-app — the usage rollups/audit log over gateway_calls and the
-- owner-facing collection drain over app_collection_items (apps/portal/src/routes/
-- {usage,data}.ts). helix_portal is NOT the table owner and has no BYPASSRLS, so
-- it needs its own permissive policy or FORCE RLS would scope it to zero rows.
-- Policies are permissive and OR-combined, so a role-scoped policy per role gives
-- each exactly its own rule.
--
-- RLS is enabled unconditionally; the policies name roles, so they are guarded by
-- a pg_roles existence check (same fail-soft stance as the grant migrations — on
-- a cluster without the runtime roles this is a clean no-op, and the only access
-- there is the superuser owner, which bypasses RLS regardless).

-- gateway_calls -------------------------------------------------------------
ALTER TABLE gateway_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE gateway_calls FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    -- The edge: scoped to the request's app. Metering is per-app, so the policy
    -- reads only app.app_id (no app.user_oid).
    CREATE POLICY gateway_calls_edge_partition ON gateway_calls
      TO helix_edge
      USING      ("appId" = current_setting('app.app_id', true)::uuid)
      WITH CHECK ("appId" = current_setting('app.app_id', true)::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    -- The control plane reads cross-app (usage rollups, audit log) and never
    -- writes here; a permissive pass keeps those reads working under FORCE RLS.
    CREATE POLICY gateway_calls_portal_all ON gateway_calls
      TO helix_portal
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- app_collection_items ------------------------------------------------------
ALTER TABLE app_collection_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_collection_items FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    -- The edge: INSERT-only (the grant is the §3.2 write-only containment); the
    -- WITH CHECK pins the row to the request's app. The USING clause is present
    -- for completeness but the edge has no SELECT/UPDATE/DELETE grant to exercise
    -- it. app.user_oid is not read — the collection is app-scoped.
    CREATE POLICY app_collection_items_edge_partition ON app_collection_items
      TO helix_edge
      USING      ("appId" = current_setting('app.app_id', true)::uuid)
      WITH CHECK ("appId" = current_setting('app.app_id', true)::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    -- The owner-facing drain/export/delete runs cross-app on the portal role.
    CREATE POLICY app_collection_items_portal_all ON app_collection_items
      TO helix_portal
      USING (true) WITH CHECK (true);
  END IF;
END $$;
