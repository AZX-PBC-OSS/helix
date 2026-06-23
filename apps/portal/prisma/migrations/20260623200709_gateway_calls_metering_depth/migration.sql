-- AlterTable
ALTER TABLE "gateway_calls" ADD COLUMN     "cacheCreationInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "cacheReadInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "durationMs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "errorDetail" TEXT,
ADD COLUMN     "statusCode" INTEGER,
ADD COLUMN     "stopReason" TEXT;
