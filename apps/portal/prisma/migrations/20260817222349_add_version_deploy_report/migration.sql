-- Client-asserted salvage provenance for an uploaded bundle (ADR-0038).
-- Nullable: CLI uploads and every existing version carry no report.
ALTER TABLE "versions" ADD COLUMN "deployReport" JSONB;
