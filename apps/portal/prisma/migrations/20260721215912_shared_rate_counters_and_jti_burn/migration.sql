-- CreateTable
CREATE TABLE "rate_counters" (
    "bucketKey" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rate_counters_pkey" PRIMARY KEY ("bucketKey")
);

-- CreateTable
CREATE TABLE "instruction_jti" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instruction_jti_pkey" PRIMARY KEY ("jti")
);

-- CreateIndex
CREATE INDEX "rate_counters_resetAt_idx" ON "rate_counters"("resetAt");

-- CreateIndex
CREATE INDEX "instruction_jti_expiresAt_idx" ON "instruction_jti"("expiresAt");

-- Least-privilege grants for the two runtime roles that own these tables, plus a
-- portal write carve-out. Same guarded `IF EXISTS (pg_roles …)` idiom as the
-- other grant migrations (20260616000001_edge_role_grants,
-- 20260619213743_secrets_and_egress_grants): on a cluster whose bootstrap never
-- created the runtime roles (some CI) this is a clean no-op, and it runs AFTER
-- db-init so it is the last word.
--
-- Why these grants:
--   rate_counters (issue #13) — the edge does an atomic INSERT … ON CONFLICT
--     upsert (bump), a point DELETE (login clear-on-success), and a sweep DELETE.
--     So helix_edge needs SELECT, INSERT, UPDATE, DELETE. No RLS: the key already
--     embeds appId and this is not app-data.
--   instruction_jti (issue #3, ADR-0013 Step 1) — egress fully manages this
--     ephemeral set: burn = INSERT … ON CONFLICT DO NOTHING (needs SELECT for the
--     arbiter), sweep = DELETE … WHERE "expiresAt" < now() (needs SELECT for the
--     WHERE), so helix_egress needs SELECT, INSERT, DELETE. These are its first
--     write grants (it had only SELECT / column-UPDATE on secrets); it still has
--     no registry / app_data / gateway_calls access. The jti set is opaque one-
--     time request ids — no non-enumerability boundary worth protecting.
--
-- Carve-out: helix_portal never touches either table, but the db-init blanket
-- grant + ALTER DEFAULT PRIVILEGES would hand it full DML on every owner-created
-- table. Revoke writes here to keep least-privilege honest — the same pattern
-- 20260721120000_gateway_calls_portal_readonly established for gateway_calls, and
-- exactly what db-init/01-roles.sql's "carve it out the same way" note points at.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON rate_counters TO helix_edge;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_egress') THEN
    GRANT SELECT, INSERT, DELETE ON instruction_jti TO helix_egress;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    REVOKE INSERT, UPDATE, DELETE ON rate_counters, instruction_jti FROM helix_portal;
  END IF;
END $$;
