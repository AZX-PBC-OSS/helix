-- ADR-0050 — hosted-app page loads for the owner's Visitors view.
-- CreateTable
CREATE TABLE "app_visits" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "env" TEXT NOT NULL DEFAULT 'prod',
    "visitorHash" TEXT,
    "ipPrefix" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "app_visits_appId_env_createdAt_idx" ON "app_visits"("appId", "env", "createdAt");

-- Same write-only posture as csp_reports and app_collection_items: the edge can
-- append a visit but can never enumerate them. The portal reads them for the
-- Visitors view and deletes rows past retention. helix_dev gets no grant — the
-- dev surfaces do not serve app documents.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    GRANT INSERT ON app_visits TO helix_edge;  -- NO SELECT/UPDATE/DELETE
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON app_visits TO helix_portal;
  END IF;
END $$;

-- FORCE RLS pins an edge write to the request's app and to prod, the same
-- fail-closed backstop as app_collection_items (migration 20260721033820).
ALTER TABLE app_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_visits FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    CREATE POLICY app_visits_edge_partition ON app_visits
      TO helix_edge
      USING      ("env" = 'prod' AND "appId" = current_setting('app.app_id', true)::uuid)
      WITH CHECK ("env" = 'prod' AND "appId" = current_setting('app.app_id', true)::uuid);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    CREATE POLICY app_visits_portal_all ON app_visits
      TO helix_portal
      USING (true) WITH CHECK (true);
  END IF;
END $$;
