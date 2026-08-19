# Adopt ownerless apps

Assign an owner to `apps` rows that have none, so they appear on the apps page.

## When you need this

`App.ownerId` is nullable: it arrived with the approvals work, and rows created
before it carry no owner. That was invisible while every read was unscoped, but
the apps page now defaults to `?scope=mine`, which filters on `ownerId`. An
ownerless app therefore shows up for **nobody** under Mine — only under All.

Symptom: an app you know exists is missing from Apps until you switch the scope
control to **All**, where it renders with `—` in the Owner column.

Check for them:

```sql
SELECT slug, "displayName", "createdAt"
FROM apps WHERE "ownerId" IS NULL ORDER BY "createdAt";
```

Note this is a **display** problem, not an access one. `ownsApp` fails closed on a
null `ownerId`, so an ownerless app is already admin-only to mutate — adopting it
is what makes it mutable by its owner again.

## What to pass

The value the portal would see as `actor.sub`. The verifier collapses the subject
to `email ?? preferred_username ?? sub` (`apps/portal/src/auth/verifier.ts`), so
for an ordinary Entra user that is **their email address**. Getting this wrong
assigns the apps to a principal who will never sign in as it; re-running with the
right value will not fix it, because the rows are no longer ownerless — see
_Correcting a bad run_ below.

Confirm what a given operator's subject looks like by having them hit
`GET /api/v1/me` (the portal's user chip shows the same value).

## Run it

Dry run first — it lists what it would touch and writes nothing:

```bash
pnpm --filter @azx-pbc/portal db:backfill-owners -- ops@example.com --dry-run
```

Then for real:

```bash
pnpm --filter @azx-pbc/portal db:backfill-owners -- ops@example.com
```

Options:

| Flag / env             | Effect                                                                       |
| ---------------------- | ---------------------------------------------------------------------------- |
| `--dry-run`            | List the ownerless apps and exit without writing.                            |
| `--name "Ops Team"`    | Also set the display name shown in the Owner column.                         |
| `--email a@b.com`      | Set the display email explicitly. Defaults to the principal if it looks like an address. |
| `BACKFILL_OWNER_ID`    | Supply the principal via the environment instead of an argument.             |

Without `--name`, only the identity is set and the portal renders `ownerId`
itself — the same thing it already showed for these rows.

**Idempotent.** It only ever touches `ownerId IS NULL`, so a second run reports
`no ownerless apps — nothing to do.` and changes nothing. It never reassigns an
app that already has an owner.

Against a deployed environment, point `DATABASE_URL` at that database; the script
uses the same client the portal does.

## Correcting a bad run

There is deliberately no `--force`: reassigning apps that already have owners is
not a backfill, and a flag for it would make a typo destructive. To move apps to a
different principal, do it explicitly and narrowly:

```sql
UPDATE apps SET "ownerId" = 'right@example.com', "ownerName" = NULL, "ownerEmail" = NULL
WHERE "ownerId" = 'wrong@example.com';
```

## Afterwards

- Sign in as that principal; the apps appear under **Mine** on `/`.
- New apps need none of this: `POST /api/v1/apps` records `ownerId` plus the
  actor's display claims at create.
