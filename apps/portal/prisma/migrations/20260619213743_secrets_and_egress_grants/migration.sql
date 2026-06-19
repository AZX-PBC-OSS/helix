-- CreateTable
CREATE TABLE "app_secrets" (
    "id" UUID NOT NULL,
    "scope" TEXT NOT NULL,
    "appId" UUID,
    "name" TEXT NOT NULL,
    "material" TEXT NOT NULL,
    "injection" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotatedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "app_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_secret_grants" (
    "secretId" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "grantedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_secret_grants_pkey" PRIMARY KEY ("secretId","appId")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_secrets_appId_name_key" ON "app_secrets"("appId", "name");

-- CreateIndex
CREATE INDEX "app_secret_grants_appId_idx" ON "app_secret_grants"("appId");

-- AddForeignKey
ALTER TABLE "app_secrets" ADD CONSTRAINT "app_secrets_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_secret_grants" ADD CONSTRAINT "app_secret_grants_secretId_fkey" FOREIGN KEY ("secretId") REFERENCES "app_secrets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_secret_grants" ADD CONSTRAINT "app_secret_grants_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Least-privilege grants on the new secret tables (secrets-and-connections §4).
-- Guarded by role existence: the runtime roles are created by db-init/01-roles.sql
-- (dev) or Terraform (prod), not by migrations, so this is a clean no-op on a
-- cluster that never ran the bootstrap. The CONTAINMENT is the asymmetry:
--   helix_egress: SELECT material (+ grants) + UPDATE("lastUsedAt") — resolves &
--                 injects the secret; nothing else.
--   helix_edge  : NOTHING here — the policy edge must never read a secret.
--   helix_portal: full DML — the control-plane CRUD + rotation surface.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_egress') THEN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO helix_egress', current_database());
    GRANT USAGE ON SCHEMA public TO helix_egress;
    GRANT SELECT ON app_secrets, app_secret_grants TO helix_egress;
    GRANT UPDATE ("lastUsedAt") ON app_secrets TO helix_egress;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_secrets, app_secret_grants TO helix_portal;
  END IF;
END $$;
