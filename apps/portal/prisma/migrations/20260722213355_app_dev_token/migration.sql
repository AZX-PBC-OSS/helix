-- Dev-mode design §4 / Appendix A.3 — the portal-owned dev-token table. A scoped,
-- opaque credential (stored only as a SHA-256 hash) for developing an app against
-- its env=dev partition from a registered foreign origin. Minted/rotated/revoked
-- by the portal (owner-gated); read by the step-3 dev-gateway (role helix_dev) to
-- validate a presented bearer. helix_portal is covered by db-init's default
-- privileges; the helix_dev SELECT grant is added here (guarded) so step 3 is
-- resolver-only.

-- CreateTable
CREATE TABLE "app_dev_token" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "developerOid" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "origins" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_dev_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_dev_token_tokenHash_key" ON "app_dev_token"("tokenHash");

-- CreateIndex
CREATE INDEX "app_dev_token_appId_idx" ON "app_dev_token"("appId");

-- AddForeignKey
ALTER TABLE "app_dev_token" ADD CONSTRAINT "app_dev_token_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The step-3 dev-gateway (role helix_dev) validates a presented dev token by
-- hashing it and looking the row up by tokenHash. Read-only; guarded like every
-- other runtime-role grant so it's a clean no-op on a cluster without the role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    GRANT SELECT ON app_dev_token TO helix_dev;
  END IF;
END $$;
