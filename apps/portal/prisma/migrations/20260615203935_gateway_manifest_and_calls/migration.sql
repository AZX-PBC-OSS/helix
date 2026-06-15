-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "capabilities" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "gateway_calls" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "userOid" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gateway_calls_appId_createdAt_idx" ON "gateway_calls"("appId", "createdAt");
