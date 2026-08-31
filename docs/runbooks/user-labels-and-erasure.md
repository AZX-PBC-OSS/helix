# App-user labels: where they are, and what erasure can reach

Answer a "delete my data" request about a **hosted app's users** — and know, before
you promise anything, which of it the platform can actually erase.

## When you need this

Someone asks what Helix holds about an app user, or asks for it to be deleted.
Since 2026-08-31 the platform captures a display half — `userName` / `userEmail`,
the directory claims as they read at the time of the call — alongside the opaque
`userOid`. That was added because `userOid` is Entra's pairwise `sub` and
identifies nobody, which made the audit log unreadable. The cost is that real
names and addresses now sit in three tables, and **one of them cannot be deleted
from by any role.**

Read this before answering, not while drafting the reply.

## Where the labels are

| Table | Erasable? | By what |
| --- | --- | --- |
| `sessions` | **Yes, automatically** | `session_sweep()` deletes at `expiresAt < now() - 1 day`; with the 8 h TTL nothing survives ~32 h. No action needed. |
| `app_collection_items` | **Yes** | Owner-scoped submitted data. The portal's Data tab already exports and deletes it, and `helix_portal` holds `DELETE`. |
| `gateway_calls` | **No** | See below. |

## The ledger cannot be erased, and that is deliberate

`gateway_calls` is append-only **by grant**, not by convention (ADR-0021):
`helix_edge` holds `INSERT` (plus `SELECT` for budget sums) and `helix_portal`
was explicitly `REVOKE`d from `INSERT`/`UPDATE`/`DELETE` in migration
`20260721120000`. There is no application role that can delete a ledger row, and
no pruning job. That grant set is exactly what makes an audit row trustworthy —
a component able to edit the audit log retroactively is what "integrity rests on
the DB grant set" promises does not exist.

So the honest answer today is: **an erasure request against the metering ledger
cannot currently be honoured**, and the reason is a property we chose on purpose,
not an oversight or a missing feature.

Confirm the exposure for a specific person before replying:

```sql
-- As the schema owner. Read-only; do not attempt an UPDATE or DELETE here.
SELECT count(*), min("createdAt"), max("createdAt")
FROM gateway_calls WHERE "userEmail" = 'person@example.com';
```

Do **not** work around this by connecting as the schema owner to delete rows. It
would succeed, and it would silently retire the property the whole ledger design
rests on. If a deletion is genuinely required, that is an incident-level decision
with a written record, not a maintenance task.

## What to say, and what is being built

- Sessions: already gone, within ~32 hours of their last activity.
- Collection data: erasable now, by the app owner, from the Data tab.
- Ledger: retained; state plainly that it is retained and why.

The planned fix is **crypto-shredding** for content/PII rows plus a documented
Art. 17(3) retention basis for the metering tuple — tracked in `TODO.md` under
the GDPR item. It is the reason the labels were accepted onto an unerasable table
rather than an argument that they do not need erasing.

## Who can read the labels

`GET /api/v1/gateway/audit` is `requireAdmin`. It was open to any authenticated
portal principal while its subject column identified nobody; capturing the labels
removed that premise and the gate was added with them. If you are triaging "who
could have seen this", the answer is platform admins — plus each app's owner for
their own collection data, via `ownsApp`.
