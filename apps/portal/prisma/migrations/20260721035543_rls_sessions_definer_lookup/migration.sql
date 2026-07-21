-- ADR-0002 (review ISSUE-12) — RLS on `sessions`, the last of the three edge-
-- written tables. Under an edge bug / naive compromise, `SELECT * FROM sessions`
-- enumerates EVERY app's sessions (cross-app userOid/groups/displayName/tokenHash
-- leak) and a forged INSERT could mint a session for any app. RLS makes both fail
-- closed. Same framing as gateway_calls/app_collection_items: a backstop against
-- bugs + a no-GUC smash-and-grab, NOT RCE containment (an RCE sets the GUC
-- itself); the RCE boundary is grant-absence, unchanged.
--
-- Two things make `sessions` different from the other two tables:
--
--  1. THE HOT READ PATH. `PgSessionStore.lookup` runs in the session gate on
--     EVERY request of a gated app (apps/edge/src/serving/assets.ts). Wrapping it
--     in a set_config transaction like the write paths would add round-trips to
--     the edge's busiest path — for the LEAST valuable RLS check, since the lookup
--     keys on `tokenHash` (a random 256-bit, globally-unique token: a cross-app
--     read needs a hash collision, i.e. never). So the edge reads through a
--     SECURITY DEFINER function instead (see `session_lookup` below): one
--     round-trip, no transaction, and the raw table stays locked to helix_edge.
--
--  2. THE GLOBAL SWEEPER. `PgSessionStore.sweep` GCs expired rows + stale pendings
--     across ALL apps (no appId in scope), so it can't be partition-scoped. A
--     FOR DELETE carve-out policy can't do it either: the sweep's WHERE reads
--     columns, so SELECT-applicable policies also apply to the DELETE, and the
--     partition SELECT policy hides every row when no GUC is set — the delete
--     matches nothing. So the sweeper runs through a SECURITY DEFINER function too
--     (`session_sweep` below, owner-exempt like the lookup), which also makes the
--     GC predicate single-sourced in the DB rather than duplicated in a policy.
--
-- ENABLE, not FORCE (unlike the other two tables): under FORCE the table owner is
-- also subject to RLS, and since every policy here is role-scoped to the runtime
-- roles, an owner-run query (the SECURITY DEFINER function) would match no policy
-- and be denied. ENABLE leaves the owner exempt, so the definer function — owned
-- by the migration/owner role — reads unimpeded while helix_edge (non-owner) is
-- fully constrained. This does not weaken helix_edge containment: the threat is an
-- edge compromise (helix_edge), not the owner, which holds DDL regardless.

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    -- The per-request write/read partition: a session belongs to exactly one app
    -- (appId-only, like gateway_calls). Covers the INSERT (createPending/
    -- createActive), UPDATE (redeem) and DELETE (logout) paths, which set
    -- app.app_id via withPartition; and it scopes any direct SELECT to zero rows
    -- when no GUC is set (the naive-dump backstop) — the edge's real reads go
    -- through session_lookup, not the raw table.
    CREATE POLICY sessions_edge_partition ON sessions
      TO helix_edge
      USING      ("appId" = current_setting('app.app_id', true)::uuid)
      WITH CHECK ("appId" = current_setting('app.app_id', true)::uuid);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    -- The control plane does not read sessions in v0, but keep the same permissive
    -- shape as the other two tables so a future portal read isn't silently scoped
    -- to zero rows (helix_portal is non-owner / no BYPASSRLS).
    CREATE POLICY sessions_portal_all ON sessions
      TO helix_portal
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- The gate's read path. SECURITY DEFINER so it runs as the owner (exempt from RLS
-- under ENABLE) and returns the row in a single round-trip with no transaction —
-- the perf reason this function exists. It is NOT a broad read primitive: it takes
-- the exact (tokenHash, appId) pair (the caller already holds the cookie hash) and
-- returns at most that one row, applying the same freshness filter the inline
-- query used. search_path is pinned and `sessions` is schema-qualified so a
-- shadowing object on a caller-controlled search_path can't hijack it (the classic
-- SECURITY DEFINER footgun). EXECUTE is revoked from PUBLIC and granted only to
-- helix_edge — no other role can invoke it.
CREATE OR REPLACE FUNCTION session_lookup(p_token_hash text, p_app_id uuid)
  RETURNS SETOF sessions
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.sessions
  WHERE "tokenHash" = p_token_hash
    AND "appId" = p_app_id
    AND "expiresAt" > now()
$$;

REVOKE EXECUTE ON FUNCTION session_lookup(text, uuid) FROM PUBLIC;

-- The sweeper's GC, as a definer function so it runs owner-exempt and deletes
-- across all apps in one round-trip — the partition policy would otherwise scope
-- it to zero rows (see note 2 above). This is the single source of truth for the
-- GC predicate (previously inline in PgSessionStore.sweep): expired rows linger a
-- day for debuggability; never-redeemed pendings (tokenHash NULL) die after 10
-- minutes — a handoff is 30 s, so a 10-minute-old pending is necessarily junk.
-- Returns the number of rows removed.
CREATE OR REPLACE FUNCTION session_sweep()
  RETURNS bigint
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public
AS $$
DECLARE
  removed bigint;
BEGIN
  DELETE FROM public.sessions
  WHERE ("expiresAt" < now() - interval '1 day')
     OR ("tokenHash" IS NULL AND "createdAt" < now() - interval '10 minutes');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

REVOKE EXECUTE ON FUNCTION session_sweep() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    GRANT EXECUTE ON FUNCTION session_lookup(text, uuid) TO helix_edge;
    GRANT EXECUTE ON FUNCTION session_sweep() TO helix_edge;
  END IF;
END $$;
