-- ADR-0040 §4 — a per-actor rate limit for the directory search endpoint, on the
-- portal's OWN counter table.
--
-- WHY NOT `rate_counters`. That table already exists with exactly these three
-- columns, and reusing it looks obviously right. It is not:
--
--   * `20260721215912_shared_rate_counters_and_jti_burn` explicitly REVOKEd
--     INSERT/UPDATE/DELETE on it from `helix_portal`. That revoke was hygiene
--     rather than a threat model — `db-init/01-roles.sql` hands the portal a
--     blanket `ON ALL TABLES` grant plus ALTER DEFAULT PRIVILEGES, so the revoke
--     is what keeps least-privilege honest on a table the portal never touched.
--
--   * But the table is SHARED with the edge, which keys the shared-password
--     login throttle (`apps/edge/src/auth/loginThrottle.ts`, `login:<…>`) and the
--     anonymous IP limiter (`ipRateLimiter.ts`, `anon:<ip>:<appId>`) in it. Handing
--     the portal UPDATE/DELETE there means the control plane — or a portal RCE —
--     can zero the edge's brute-force protection on every `password` app.
--     Postgres cannot scope a grant by key prefix, and the migration above
--     deliberately keeps RLS off this table because the edge reads it on every
--     anonymous request. So there is no narrow version of that grant.
--
-- A second table costs one migration and keeps the two planes' abuse-control
-- state disjoint, which is the property worth having.
CREATE TABLE "portal_rate_counters" (
    "bucketKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portal_rate_counters_pkey" PRIMARY KEY ("bucketKey")
);

-- Sweeping deletes elapsed windows, so the index earns itself under a flood.
CREATE INDEX "portal_rate_counters_resetAt_idx" ON "portal_rate_counters"("resetAt");

-- Grants. The portal owns this table outright: bump is an atomic
-- INSERT … ON CONFLICT upsert (SELECT + INSERT + UPDATE) and the sweep is a
-- DELETE. The blanket db-init grant already covers it, so this is belt-and-
-- braces for clusters where that grant is absent — but the REVOKEs are the
-- load-bearing half: no other runtime role has any business here, and stating
-- that explicitly is what stops the next `ON ALL TABLES` bootstrap from quietly
-- widening it.
--
-- Guarded `IF EXISTS (pg_roles …)` like every other grant migration: on a cluster
-- whose bootstrap never created the runtime roles (some CI) this is a clean
-- no-op, and migrations run after db-init so this is the last word.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON portal_rate_counters TO helix_portal;
  END IF;

  -- The edge and egress must not reach the control plane's counters, in either
  -- direction: this is the mirror image of the portal being kept out of
  -- `rate_counters`, and the reason that separation is worth a whole table.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    REVOKE ALL ON portal_rate_counters FROM helix_edge;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_egress') THEN
    REVOKE ALL ON portal_rate_counters FROM helix_egress;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    REVOKE ALL ON portal_rate_counters FROM helix_dev;
  END IF;
END $$;
