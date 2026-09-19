---
title: Database & migrations
description: "The private-endpoint Postgres behind every install: its access model, how schema migrations run without anyone holding the admin password, and what to do when either misbehaves."
---

# Database & migrations

Every install has one Postgres Flexible Server with one `helix` database,
reachable only over a private endpoint. This page is the reference for how its
access model works, how schema migrations run without anyone holding the admin
password, and what to do when either misbehaves. The step-by-step for a fresh
install is in [Getting started](/deploy/getting-started); the routine
roll-forward is in [Deploying updates](/deploy/updates).

## The roles

Five roles, split by trust level. The boundary is deliberate and worth
understanding before you touch any of it:

| Role | Used by | Can do |
| --- | --- | --- |
| `helixadmin` | the migrate job, and the one-time roles bootstrap | Everything — it owns the schema. **Never used by a running service.** |
| `helix_portal` | the portal (control plane) | Full DML on every table. No DDL, no ownership. |
| `helix_edge` | the edge (data plane) | Only the tables a migration explicitly grants — and it has **no grant at all on `app_secrets`**, so a compromised edge cannot read a single app secret. |
| `helix_egress` | the egress service (mechanism plane) | Its own short list of tables — it is the only runtime role with `SELECT` on `app_secrets`, the connection-secret material it injects. |
| `helix_dev` | the opt-in dev gateway | The edge's verbs, plus a row-security policy that pins it to dev data so it cannot read a single production row. |

Three properties make this hold:

- **Fail-closed grants.** The edge, egress, and dev roles get no blanket grant.
  Every table is owner-only until a migration names it. The migrations do this
  with `IF EXISTS (pg_roles …)` guards — which is why the roles must exist
  **before** the first migration runs, and why creating a role later means
  re-running the migration to pick up its grants.
- **No privilege escalation.** All four runtime roles are `NOINHERIT
  NOBYPASSRLS`: none can `SET ROLE` up to the owner, and none can walk past the
  row-level-security policies that partition app data.
- **The admin DSN never reaches a container.** The portal actively refuses the
  schema-owner connection string in production, so the owner credential exists
  in exactly two places: your secrets store, and Key Vault.

## The migrate job

Schema migrations are Prisma migrations, applied as the schema owner. Since
Postgres is private-endpoint-only, they run as a Container Apps job inside the
VNet — `<namePrefix>-migrate`, declared by the template the first time you
apply with `deployApps=true`.

The job's design means **no pipeline and no operator ever holds the admin
password**: the job carries only a vault URL and a client id, and reads the
`postgres-admin-password` secret from Key Vault at run time using its own
managed identity, whose single permission is Key Vault Secrets User on the
platform vault. The password lands in that vault from the same Bicep parameter
that provisions the server, so one apply sets both and they cannot drift.

Two behaviors to know before you run it:

- **Migrations are forward-only.** Re-running the job with an older image does
  not undo anything. Rolling back app code is a one-liner; rolling back a
  schema is not — keep each migration backward-compatible with the release
  before it.
- **A failure does not retry.** The job runs with `replicaRetryLimit: 0` on
  purpose: a failed migration should be read and understood, not blindly
  re-attempted against a possibly half-applied schema.

### Running it

Pin the job to the image tag you are deploying (migrations are only as current
as the image the job runs), start it, and check the result:

```bash
az containerapp job update -g <rg> -n <namePrefix>-migrate \
  --image ghcr.io/azx-pbc-oss/helix-portal:<tag>
az containerapp job start  -g <rg> -n <namePrefix>-migrate

# a job that starts is not a job that succeeded — check the execution
az containerapp job execution list -g <rg> -n <namePrefix>-migrate \
  --query "[0].{name:name,status:properties.status,start:properties.startTime}"
```

Run it **before** rolling the apps, on every update, even when you expect
nothing pending. `prisma migrate deploy` with nothing to apply is a no-op, so
the run doubles as a cheap proof that the credential path still works. And
`/health` returning 200 proves nothing about the schema: the services open
their database pools lazily, so a missing column surfaces at query time, under
a real user — not at boot.

### Reading the migrate job's output

On a failure, the Prisma output is the explanation, and it is in the job's
logs:

```bash
# <execution> is the name from the execution-list output above
az containerapp job logs show -g <rg> -n <namePrefix>-migrate \
  --container migrate --execution <execution> --tail 300
```

Fix the cause, then start the job again. A migration that failed partway is
recorded in the `_prisma_migrations` table as failed, and Prisma refuses to
apply anything further until you resolve it — the Prisma docs on [production
deployments](https://www.prisma.io/docs/orm/prisma-migrate/workflows/development-and-production)
walk through the `migrate resolve` flow.

## The bootstrap, in context

On a fresh install the order is constrained by two facts: the migrate job does
not exist until the first `deployApps=true` apply, and the migrations' grants
need the roles to exist first. So:

1. **Infra-only apply** (`deployApps=false`) — server and database exist.
2. **Roles** — `infra/azure/scripts/create-roles.sh`, a throwaway job that
   carries the admin DSN and **deletes itself afterwards**. This is the one
   time the admin password is placed on a resource. Run it once: `CREATE ROLE`
   is not idempotent, and a second run fails with "role already exists".
3. **Apps apply** (`deployApps=true`) — creates the apps and the migrate job.
   The apps boot before the schema exists and answer only `/health` until the
   next step lands; that is expected.
4. **First migration** — the migrate job, exactly as above.

## Troubleshooting

**An app crash-loops or 500s with `password authentication failed for role
"helix_…"`.** The role's password in Postgres does not match the DSN held in
the platform vault — usually because the role password was never captured when
the install was created. The vault is the source of truth, so fix the **role**,
not the DSN. Read the DSN back off the app — this resolves the reference over
the control plane, so it works even while the app is crash-looping:

```bash
az containerapp secret show -g <rg> -n <namePrefix>-edge \
  --secret-name edge-database-url --query value -o tsv
```

Extract the password from the DSN and `ALTER ROLE` to it in a throwaway
in-VNet job — the same shape `create-roles.sh` uses (admin DSN as a job
secret, deleted afterwards). Do not "fix" it by writing a different DSN to the
vault: every app holding the reference follows the vault within ~30 minutes,
so that just moves the mismatch.

**`create-roles.sh` fails with "role already exists".** Expected on anything
but a fresh install — the script is run-once by design. If what you actually
need is a password change, see the `ALTER ROLE` note above.

**The migrate job fails with a Key Vault error.** The job's identity is created
by the template with exactly one role assignment; if the apply that created the
job was interrupted, that assignment can be missing. Re-apply with
`deployApps=true` (the gate that owns the job module) rather than granting by
hand: a hand-made role assignment collides with the template's deterministic
name and fails the *next* apply with `RoleAssignmentExists`.

**Never rotate the admin password out of band.** `az postgres flexible-server
update --admin-password` changes the server but not the copy in Key Vault that
the migrate job reads — migrations start failing on the next run. The
`postgresAdminPassword` parameter sources from the vault via `az.getSecret()`,
so override it for one apply instead, which updates the server and the vault
copy in the same pass:
`az deployment group create -g <rg> -f main.bicep -p main.bicepparam --parameters postgresAdminPassword="$NEW"`.
