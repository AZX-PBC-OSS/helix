-- The app description (portal UX review, Aug 2026): an optional plain-text
-- summary rendered as a subtitle under the app's name in the portal.
--
-- Additive and nullable, with no default: existing rows keep no description
-- and no backfill is possible or wanted. Nullable TEXT costs nothing to add
-- (metadata-only DDL — no table rewrite), and the 500-char cap lives in zod
-- (`AppSchema.description`), so re-tuning it needs no migration.
--
-- No grant change: `helix_portal` already holds full DML on the table, and
-- the data-plane roles hold none (ADR-0006 part 2 — asserted by
-- role-split.integration.test.ts). The edge's registry projection selects
-- explicit columns and does not read this one — the description is
-- portal/UI-only state.

ALTER TABLE "apps" ADD COLUMN "description" TEXT;
