-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "ownerId" TEXT;

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "risk" TEXT NOT NULL,
    "deltas" JSONB NOT NULL,
    "baseSnapshot" JSONB NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "reason" TEXT,
    "decidedBy" TEXT,
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "approval_requests_status_createdAt_idx" ON "approval_requests"("status", "createdAt");

-- CreateIndex
CREATE INDEX "approval_requests_appId_idx" ON "approval_requests"("appId");

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Approvals are a control-plane gate (docs/design/approvals.md §1): the portal
-- reads/writes the queue; the edge has NO grant on approval_requests — it never
-- learns an approval happened, only sees the resulting `apps` row change via the
-- registry trigger. Guarded by role existence (fail-soft, like the other grant
-- migrations); no grant to helix_edge by design.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON approval_requests TO helix_portal;
  END IF;
END $$;
