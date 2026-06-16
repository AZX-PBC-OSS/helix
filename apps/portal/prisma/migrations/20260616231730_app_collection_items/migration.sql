-- CreateTable
CREATE TABLE "app_collection_items" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "collection" TEXT NOT NULL,
    "userOid" TEXT,
    "item" JSONB NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_collection_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_collection_items_appId_collection_createdAt_idx" ON "app_collection_items"("appId", "collection", "createdAt");

-- App-data design §3.2 — the write-only collection property, made concrete.
-- The edge role gets INSERT only: the ABSENCE of SELECT/DELETE is what survives
-- an edge RCE — a compromised edge or malicious app can append junk but can
-- never enumerate the collection. The owner-facing drain/export/delete is a
-- portal-role operation. Guarded by role existence (fail-soft, like the other
-- grant migrations). No RLS: there is no read path to scope.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    GRANT INSERT ON app_collection_items TO helix_edge;  -- NO SELECT/UPDATE/DELETE
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_collection_items TO helix_portal;
  END IF;
END $$;
