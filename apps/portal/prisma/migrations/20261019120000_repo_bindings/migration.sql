-- ADR-0051 — repo-backed apps. `repo_bindings` holds each app's GitHub binding
-- (portal-only: helix_portal is covered by db-init's default privileges, and
-- helix_edge, helix_egress and helix_dev get no grant). `versions` gains the
-- verified CI provenance of a version. Those columns are readable by the roles
-- that already have a table-wide SELECT on versions (helix_edge, helix_dev);
-- nothing in them is a credential. `sourceTokenJti` is the id of a token that
-- has already been spent, and it is unique so a token produces one version.

-- CreateTable
CREATE TABLE "repo_bindings" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'github',
    "repoFullName" TEXT NOT NULL,
    "branch" TEXT NOT NULL,
    "repositoryId" TEXT,
    "repositoryOwnerId" TEXT,
    "pinnedAt" TIMESTAMP(3),
    "workflowRef" TEXT,
    "environment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repo_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "repo_bindings_appId_key" ON "repo_bindings"("appId");

-- AddForeignKey
ALTER TABLE "repo_bindings" ADD CONSTRAINT "repo_bindings_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "versions" ADD COLUMN     "sourceActor" TEXT,
ADD COLUMN     "sourceCommitSha" TEXT,
ADD COLUMN     "sourceProvider" TEXT,
ADD COLUMN     "sourceRef" TEXT,
ADD COLUMN     "sourceRepoFullName" TEXT,
ADD COLUMN     "sourceRepositoryId" TEXT,
ADD COLUMN     "sourceRunAttempt" INTEGER,
ADD COLUMN     "sourceRunId" TEXT,
ADD COLUMN     "sourceTokenJti" TEXT,
ADD COLUMN     "sourceWorkflowRef" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "versions_sourceTokenJti_key" ON "versions"("sourceTokenJti");
