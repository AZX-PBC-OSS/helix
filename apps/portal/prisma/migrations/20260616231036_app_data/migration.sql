-- CreateTable
CREATE TABLE "app_data" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "userOid" TEXT,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_data_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_data_appId_userOid_key_key" ON "app_data"("appId", "userOid", "key");

-- App-data design §2.1/§3.1/§3.3 — scoped KV grants + row-level security.
--
-- The edge does full DML on app_data, but only within its own partition. The
-- hand-written `WHERE appId = $1 AND userOid = $2` is the first line; RLS makes
-- the partition a database invariant that holds even if that WHERE is wrong or
-- missing. Grants are guarded by role existence (same fail-soft stance as the
-- role-split migration); the policy is unconditional.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_data TO helix_edge;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_data TO helix_portal;
  END IF;
END $$;

-- The predicate is set per request from the VERIFIED session via SET LOCAL /
-- set_config (never from app input). FORCE so the table owner is subject too
-- in dev; helix_edge has no BYPASSRLS. current_setting(..., true) => a missing
-- GUC returns NULL (not an error), so a query that forgot to set it matches
-- zero rows and an INSERT fails the WITH CHECK — the policy fails closed.
ALTER TABLE app_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_data FORCE  ROW LEVEL SECURITY;

CREATE POLICY app_data_partition ON app_data
  USING (
    "appId" = current_setting('app.app_id', true)::uuid
    AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
  )
  WITH CHECK (
    "appId" = current_setting('app.app_id', true)::uuid
    AND ("userOid" IS NULL OR "userOid" = current_setting('app.user_oid', true))
  );
