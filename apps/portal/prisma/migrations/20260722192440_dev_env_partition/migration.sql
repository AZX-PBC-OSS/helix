-- Dev-mode design §5 — add the `env` ('prod' | 'dev') partition dimension to the
-- app-data tables, the metering ledger, and connection secrets, and introduce the
-- `helix_dev` data-plane role isolated *by the RLS policy literal* (§5.3):
-- helix_edge may see ONLY env='prod' rows and helix_dev ONLY env='dev' rows, each
-- pinned by a hardcoded env literal in its own policy — independent of the
-- app.env GUC, so the boundary holds even if that GUC is forged. This is the whole
-- security thesis of dev mode: the database itself refuses to cross the env line.
--
-- Roles are created in .devcontainer/db-init/01-roles.sql (dev) / Terraform (prod);
-- every grant/policy here is guarded by a pg_roles existence check, so on a cluster
-- without helix_dev this is a clean no-op (same fail-soft stance as the other role
-- migrations). The superuser owner bypasses RLS regardless.

-- 1) Columns — DEFAULT 'prod' backfills every existing row as production. --------
ALTER TABLE "app_data"             ADD COLUMN "env" TEXT NOT NULL DEFAULT 'prod';
ALTER TABLE "app_collection_items" ADD COLUMN "env" TEXT NOT NULL DEFAULT 'prod';
ALTER TABLE "gateway_calls"        ADD COLUMN "env" TEXT NOT NULL DEFAULT 'prod';
ALTER TABLE "app_secrets"          ADD COLUMN "env" TEXT NOT NULL DEFAULT 'prod';

-- 2) Partition keys / indexes gain env. ---------------------------------------
-- app_data: (appId, userOid, key) uniqueness becomes per-env, and the partial
-- unique index for shared rows (userOid IS NULL) likewise — the ON CONFLICT
-- targets in apps/edge/src/gateway/data.ts now name env.
DROP INDEX "app_data_appId_userOid_key_key";
CREATE UNIQUE INDEX "app_data_appId_env_userOid_key_key"
  ON "app_data" ("appId", "env", "userOid", "key");
DROP INDEX "app_data_shared_key";
CREATE UNIQUE INDEX "app_data_shared_key"
  ON "app_data" ("appId", "env", "key") WHERE "userOid" IS NULL;

DROP INDEX "app_collection_items_appId_collection_createdAt_idx";
CREATE INDEX "app_collection_items_appId_env_collection_createdAt_idx"
  ON "app_collection_items" ("appId", "env", "collection", "createdAt");

DROP INDEX "gateway_calls_appId_createdAt_idx";
CREATE INDEX "gateway_calls_appId_env_createdAt_idx"
  ON "gateway_calls" ("appId", "env", "createdAt");

DROP INDEX "app_secrets_appId_name_key";
CREATE UNIQUE INDEX "app_secrets_appId_env_name_key"
  ON "app_secrets" ("appId", "env", "name");

-- 3) helix_dev grants — mirror helix_edge's verbs, confined by the policies below.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO helix_dev', current_database());
    GRANT USAGE ON SCHEMA public TO helix_dev;
    -- Same grant set as helix_edge's data plane (INSERT-only collections keeps the
    -- write-only property in dev too; app-data design §3.2).
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_data             TO helix_dev;
    GRANT INSERT                         ON app_collection_items  TO helix_dev;
    GRANT SELECT, INSERT                 ON gateway_calls         TO helix_dev;
    -- The dev fetch path burns its own instruction jti (§6); used from step 3.
    GRANT SELECT, INSERT                 ON instruction_jti       TO helix_dev;
  END IF;
END $$;

-- 4) Env-literal RLS — the isolation invariant (§5.3). Each runtime role's policy
-- hardcodes its env, so a forged app.env GUC cannot cross the boundary; the GUC in
-- withPartition is convenience / defense-in-depth, the literals are the guarantee.

-- app_data: the single {public} partition policy is replaced by per-role policies.
DROP POLICY IF EXISTS "app_data_partition" ON "app_data";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    -- The production data plane: prod rows only, plus the app/user partition.
    CREATE POLICY app_data_edge_prod ON app_data
      TO helix_edge
      USING (
        "env" = 'prod'
        AND "appId" = current_setting('app.app_id', true)::uuid
        AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
      )
      WITH CHECK (
        "env" = 'prod'
        AND "appId" = current_setting('app.app_id', true)::uuid
        AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
      );
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    -- The dev surfaces' data plane: dev rows only — env literal, not the GUC.
    CREATE POLICY app_data_dev_only ON app_data
      TO helix_dev
      USING (
        "env" = 'dev'
        AND "appId" = current_setting('app.app_id', true)::uuid
        AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
      )
      WITH CHECK (
        "env" = 'dev'
        AND "appId" = current_setting('app.app_id', true)::uuid
        AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
      );
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    -- The control plane operates cross-env (owner-facing dev-data reset/drain,
    -- §7.3) and never needs the GUC; a permissive pass keeps it working under
    -- FORCE RLS (mirrors gateway_calls / app_collection_items).
    CREATE POLICY app_data_portal_all ON app_data
      TO helix_portal
      USING (true) WITH CHECK (true);
  END IF;
END $$;

-- gateway_calls: pin the edge policy to prod, add the dev policy. portal_all stays.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    DROP POLICY IF EXISTS gateway_calls_edge_partition ON gateway_calls;
    CREATE POLICY gateway_calls_edge_partition ON gateway_calls
      TO helix_edge
      USING      ("env" = 'prod' AND "appId" = current_setting('app.app_id', true)::uuid)
      WITH CHECK ("env" = 'prod' AND "appId" = current_setting('app.app_id', true)::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    CREATE POLICY gateway_calls_dev_only ON gateway_calls
      TO helix_dev
      USING      ("env" = 'dev' AND "appId" = current_setting('app.app_id', true)::uuid)
      WITH CHECK ("env" = 'dev' AND "appId" = current_setting('app.app_id', true)::uuid);
  END IF;
END $$;

-- app_collection_items: same env pin (INSERT-only for both runtime roles).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    DROP POLICY IF EXISTS app_collection_items_edge_partition ON app_collection_items;
    CREATE POLICY app_collection_items_edge_partition ON app_collection_items
      TO helix_edge
      USING      ("env" = 'prod' AND "appId" = current_setting('app.app_id', true)::uuid)
      WITH CHECK ("env" = 'prod' AND "appId" = current_setting('app.app_id', true)::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    CREATE POLICY app_collection_items_dev_only ON app_collection_items
      TO helix_dev
      USING      ("env" = 'dev' AND "appId" = current_setting('app.app_id', true)::uuid)
      WITH CHECK ("env" = 'dev' AND "appId" = current_setting('app.app_id', true)::uuid);
  END IF;
END $$;

-- app_secrets has no RLS (the boundary is grant-absence: only helix_egress reads
-- material). Env scoping for connection secrets is enforced in the egress resolver
-- (apps/egress/src/secrets.ts), which filters on the env carried in the verified,
-- signed attested instruction — never app input. `platform` (LLM vendor) secrets
-- resolve by name only and stay env-agnostic.
