-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('preview', 'live', 'archived');

-- CreateEnum
CREATE TYPE "VisibilityMode" AS ENUM ('private', 'group', 'password', 'public');

-- CreateTable
CREATE TABLE "apps" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "visibilityMode" "VisibilityMode" NOT NULL,
    "visibilityGroupId" TEXT,
    "currentVersionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "versions" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "blobPrefix" TEXT NOT NULL,
    "status" "VersionStatus" NOT NULL DEFAULT 'preview',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "appId" UUID,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "apps_slug_key" ON "apps"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "apps_currentVersionId_key" ON "apps"("currentVersionId");

-- CreateIndex
CREATE INDEX "versions_appId_status_idx" ON "versions"("appId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "versions_appId_number_key" ON "versions"("appId", "number");

-- CreateIndex
CREATE INDEX "audit_events_appId_createdAt_idx" ON "audit_events"("appId", "createdAt");

-- AddForeignKey
ALTER TABLE "apps" ADD CONSTRAINT "apps_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "versions" ADD CONSTRAINT "versions_appId_fkey" FOREIGN KEY ("appId") REFERENCES "apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;
