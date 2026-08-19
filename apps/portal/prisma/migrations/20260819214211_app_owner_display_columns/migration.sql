-- Display-only owner claims, captured at `app.create` from the actor's token.
-- `ownerId` stays the identity column (compared, never rendered); these two are
-- the display half (rendered, never compared) so every owner cell in the portal
-- survives `ownerId` being re-based onto an opaque directory id.
-- Nullable: rows created before this migration carry no captured claims and fall
-- back to `ownerId` at render time.
ALTER TABLE "apps" ADD COLUMN "ownerName" TEXT;
ALTER TABLE "apps" ADD COLUMN "ownerEmail" TEXT;
