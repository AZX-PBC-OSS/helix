-- The edge's jobs-callback nonce-burn table (background-jobs-plane design §3):
-- "The edge gets a new, separately granted jobs-instruction burn table in
-- `helix`; it gets no grant on the egress burn table. The existing dev role
-- needs its own environment-scoped grants."
--
-- The jobs→edge callback instruction (ADR-0002) is a bearer capability a
-- signature alone cannot make single-use: within the signed validity window
-- (30 s lifetime ± 5 s tolerance) an on-path party can re-present a captured
-- token. The receiving edge burns the verified `jti` before any side effect,
-- and the burn must survive a receiver restart and hold across replicas — so
-- the table lives here, in the platform database both edge processes use,
-- NOT in `instruction_jti`, which stays the egress burn set (the edge has no
-- grant on it and must never gain one).
--
-- Env scoping: one physical table serves both callback tiers. The `prod` edge
-- process (helix_edge) burns prod rows; the dev-gateway process (helix_dev)
-- burns dev rows. The env-literal RLS policies below are the same mechanism
-- the app-data partition uses (20260722192440_dev_env_partition): the database
-- itself refuses to cross the env line — neither tier can consume, read, or
-- delete the other's nonces — independent of anything the process does.
--
-- Retention floor: `JOBS_INSTRUCTION_BURN_RETENTION_SECONDS` (60 s ≥ the 40 s
-- tolerance+lifetime+tolerance bound) — enforced by the store's writer, not
-- here; the index on "burnUntil" is the sweep's only filter.
CREATE TABLE "jobs_callback_jti" (
    "env" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "burnUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_callback_jti_pkey" PRIMARY KEY ("env", "jti"),
    CONSTRAINT "jobs_callback_jti_env_check" CHECK ("env" IN ('prod', 'dev'))
);

-- CreateTable
CREATE INDEX "jobs_callback_jti_burnUntil_idx" ON "jobs_callback_jti"("burnUntil");

-- Burn = INSERT … ON CONFLICT DO NOTHING (SELECT for the arbiter), sweep =
-- DELETE … WHERE "burnUntil" < now() (SELECT for the WHERE) — the same verb
-- set `instruction_jti` grants `helix_egress`. No UPDATE: a burn is never
-- rewritten. Role-guarded like every grant migration: on a cluster whose
-- bootstrap never created the runtime roles this is a clean no-op, and it
-- runs AFTER db-init so it is the last word.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    GRANT SELECT, INSERT, DELETE ON jobs_callback_jti TO helix_edge;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    GRANT SELECT, INSERT, DELETE ON jobs_callback_jti TO helix_dev;
  END IF;
END $$;

-- Env-literal RLS — the isolation invariant. Each runtime role's policy
-- hardcodes its tier, so the two processes cannot consume, enumerate, or
-- clear each other's nonces even by raw SQL; the CHECK above keeps an
-- off-value row from being written into a partition no policy can see.
ALTER TABLE "jobs_callback_jti" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    CREATE POLICY jobs_callback_jti_edge_prod ON jobs_callback_jti
      TO helix_edge
      USING ("env" = 'prod')
      WITH CHECK ("env" = 'prod');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    CREATE POLICY jobs_callback_jti_dev_only ON jobs_callback_jti
      TO helix_dev
      USING ("env" = 'dev')
      WITH CHECK ("env" = 'dev');
  END IF;
END $$;

-- Carve-out: helix_portal never touches this table, but the db-init blanket
-- grant + ALTER DEFAULT PRIVILEGES would hand it full DML on every
-- owner-created table. Revoke writes here — the same pattern
-- 20260721215912_shared_rate_counters_and_jti_burn established for
-- rate_counters/instruction_jti. The bootstrap re-run re-asserts this revoke
-- (both 02-portal-bootstrap-grants.sql copies), so the re-run ends in this
-- posture too.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    REVOKE INSERT, UPDATE, DELETE ON jobs_callback_jti FROM helix_portal;
  END IF;
END $$;
