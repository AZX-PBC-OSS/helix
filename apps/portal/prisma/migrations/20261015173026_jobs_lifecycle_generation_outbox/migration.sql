-- The jobs lifecycle generation and per-target delivery outbox
-- (background-jobs-plane design §5, ADR-0007): the portal app model is the
-- generation authority, and each archive/unarchive transition (and app
-- creation) commits the generation and one outbox intent per configured
-- lifecycle target with the app-state write, all-or-nothing.

-- The generation authority. Existing rows start at 1 — the initial
-- generation every current app synchronizes from when a server is first
-- enabled (ADR-0007: "Initial generation is 1"), including already-archived
-- apps, whose archived state the enablement sync delivers.
ALTER TABLE "apps" ADD COLUMN "jobsGeneration" INTEGER NOT NULL DEFAULT 1;

-- Schema alignment, not behavior: the 20260821183000 migration created
-- "visibilityGroupIds" with DEFAULT '{}' and the schema never declared it, so
-- every re-diff wanted to DROP it — but direct row seeds (tests, raw-SQL
-- fixtures) legitimately omit the column and rely on the empty-array default.
-- The schema now declares that default; the SET DEFAULT below is the same
-- empty text array in Prisma's canonical spelling.
ALTER TABLE "apps" ALTER COLUMN "visibilityGroupIds" SET DEFAULT ARRAY[]::TEXT[];

-- One intent per (app, generation, target server), appended in the same
-- transaction as the transition that produced it. No FK to "apps" on purpose:
-- the rows are durable delivery/cancellation intent, and a future hard-delete
-- flow must retain and deliver the tombstone before discarding app metadata
-- (design §5) — the schema must be unable to drop a pending intent because
-- the app row went away.
CREATE TABLE "jobs_lifecycle_outbox" (
    "appId" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "server" TEXT NOT NULL,
    "archived" BOOLEAN NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jobs_lifecycle_outbox_pkey" PRIMARY KEY ("appId","generation","server")
);

-- The sender's pending scan: undelivered intents, oldest first.
CREATE INDEX "jobs_lifecycle_outbox_deliveredAt_createdAt_idx" ON "jobs_lifecycle_outbox"("deliveredAt", "createdAt");

-- Portal-only, like the rest of the control plane's registry state: the
-- portal writes the intents and its lifecycle sender marks acknowledgement.
-- The edge holds no grant (it reads the generation through the registry
-- projection's own apps grant when the routing tickets land); the dev gateway
-- never sees lifecycle state.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON jobs_lifecycle_outbox TO helix_portal;
  END IF;
END $$;
