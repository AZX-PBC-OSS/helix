-- CreateTable
CREATE TABLE "csp_reports" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "directive" TEXT NOT NULL,
    "blockedUri" TEXT NOT NULL,
    "documentUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "csp_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "csp_reports_appId_createdAt_idx" ON "csp_reports"("appId", "createdAt");

-- Approvals design §6.2 — the CSP-violation sink. Same write-only posture as
-- app_collection_items: the edge role gets INSERT only, so a compromised edge
-- can append reports but can NEVER enumerate them; the portal reads them for the
-- Violations screen. Guarded by role existence (fail-soft, like the other grant
-- migrations). No RLS: there is no edge read path to scope.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    GRANT INSERT ON csp_reports TO helix_edge;  -- NO SELECT/UPDATE/DELETE
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON csp_reports TO helix_portal;
  END IF;
END $$;
