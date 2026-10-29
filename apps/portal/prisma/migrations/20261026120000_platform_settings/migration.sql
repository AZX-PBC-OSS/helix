-- Platform Settings: the operator identity shown on the edge's anonymous pages,
-- and the app-name terms the portal refuses at creation.

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "operatorName" TEXT,
    "operatorDescription" TEXT,
    "operatorContactUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_settings_single_row" CHECK ("id" = 1)
);

INSERT INTO "platform_settings" ("id") VALUES (1);

-- CreateTable
CREATE TABLE "blocked_slug_terms" (
    "id" UUID NOT NULL,
    "term" TEXT NOT NULL,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "blocked_slug_terms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "blocked_slug_terms_term_key" ON "blocked_slug_terms"("term");

-- The edge renders the operator identity on anonymous pages, so it may read
-- those three columns and nothing else: not who changed them, and no write.
-- blocked_slug_terms is portal-only — helix_edge, helix_egress and helix_dev get
-- no grant. helix_portal is covered by db-init's default privileges.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    GRANT SELECT ("operatorName", "operatorDescription", "operatorContactUrl")
      ON platform_settings TO helix_edge;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE ON platform_settings TO helix_portal;
    GRANT SELECT, INSERT, UPDATE, DELETE ON blocked_slug_terms TO helix_portal;
  END IF;
END $$;

-- A settings change reloads the edge's registry projection, which carries the
-- operator identity (helix_registry_notify, migration 20260612183907).
CREATE TRIGGER platform_settings_registry_notify
AFTER INSERT OR UPDATE ON platform_settings
FOR EACH STATEMENT EXECUTE FUNCTION helix_registry_notify();
