-- AlterTable
ALTER TABLE "apps" ADD COLUMN     "passwordEnc" TEXT,
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "passwordSalt" TEXT,
ADD COLUMN     "passwordSetAt" TIMESTAMP(3);
