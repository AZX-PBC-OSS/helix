-- Rename the visibility mode `private` → `internal`, step 3 of 3 (contract).
--
-- Release 1 added `internal` and taught reads to translate the old label;
-- release 2 moved every row and every pending approval payload onto it. Nothing
-- has read, written or stored `private` since. This removes the label itself, so
-- the Postgres enum and `VISIBILITY_MODES` in @azx-pbc/shared are back in exact
-- correspondence — which is what lets the read-side alias and the relaxed
-- enum-drift guard be deleted in the same commit.
--
-- Postgres has no `ALTER TYPE ... DROP VALUE`. The only way to remove a label is
-- to build a new type and move the column onto it, which is why the rename was
-- worth doing over three releases rather than paying this cost up front on a
-- guess. Sequence below is the standard one; it is safe because no row can carry
-- `private` (release 2 backfilled them) — if one somehow did, the USING cast
-- would fail loudly and the migration would roll back rather than silently
-- dropping the value.
--
-- Ordering: unconstrained, like release 2, because after the backfill nothing on
-- either side of a rollout references `private` — old code merely knows a label
-- it never encounters, and new code needs one that is already there. Prefer
-- images-first only on the general principle that code tolerant of both schemas
-- should lead.
--
-- Lock note: `ALTER COLUMN ... TYPE` between two enum types rewrites the table
-- under ACCESS EXCLUSIVE, so reads and writes to `apps` block for its duration.
-- The registry is a small table by design (tens of rows), so this is
-- milliseconds — worth knowing, not worth scheduling around.
ALTER TYPE "VisibilityMode" RENAME TO "VisibilityMode_old";

CREATE TYPE "VisibilityMode" AS ENUM ('internal', 'group', 'password', 'public');

ALTER TABLE "apps"
  ALTER COLUMN "visibilityMode" TYPE "VisibilityMode"
  USING "visibilityMode"::text::"VisibilityMode";

DROP TYPE "VisibilityMode_old";
