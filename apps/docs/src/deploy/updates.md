---
title: Deploying updates
---

# Deploying updates

[Getting started](/deploy/getting-started) covers the first deploy. This page
covers every one after it: shipping a new build, running migrations, rotating
a secret, and the rarer case where a change needs the whole template
re-applied.

## Two ways to change a running install

Almost every update is the first kind. Use the second only when the change is
something no scoped command can express.

| | Scoped update | Full template apply |
| --- | --- | --- |
| Command | `az containerapp update` / `job update` | `az deployment group create` |
| Touches | Only what you name | Every resource in the template |
| Needs | Resource-group Contributor | Owner / User Access Administrator |
| Preserves | Env vars, secrets, TLS bindings | Only what the params file re-declares |
| Use for | New image tag, one env var, a restart | Topology, params, roles, new resources |

**Prefer the scoped update.** The reason is the secrets: the template reads
them from environment variables, and an absent variable renders as `''` and
overwrites the live value. A full apply therefore needs every deploy secret on
hand and correct, while a scoped update touches only what you name.

::: warning Don't run the platform Bicep from CI
A release pipeline should hold resource-group Contributor and roll image tags.
Keep the full apply a rare, high-privilege operation run by hand — see
[when you need one](#when-you-do-need-a-full-apply).
:::

## What CI publishes

Every push to the default branch and every `v*` tag builds four images and
pushes them to `ghcr.io/<owner>`:

| Image | Runs as |
| --- | --- |
| `helix-edge` | `<namePrefix>-edge`, and `<namePrefix>-dev-gateway` (same image, different command) |
| `helix-portal` | `<namePrefix>-portal`, and the `<namePrefix>-migrate` job |
| `helix-egress` | `<namePrefix>-egress` |
| `helix-certbot` | `<namePrefix>-certbot` job |

Each build is tagged four ways: `sha-<short>`, the branch name, `latest` (on
the default branch), and the semver for a `v*` tag.

**Deploy the immutable `sha-` tag, not `latest`.** A floating tag makes "what
is running" unanswerable, and that is the first question in an incident.
Resolve it once and reuse it:

```bash
TAG=$(crane ls ghcr.io/<owner>/helix-edge | grep '^sha-' | tail -1)
# or, from the repo:
TAG=sha-$(git rev-parse --short=7 HEAD)
```

Before rolling, confirm all four tags exist — a partially-published build is
the normal result of a CI run that failed in the `images` matrix:

```bash
for img in edge portal egress certbot; do
  docker manifest inspect "ghcr.io/<owner>/helix-$img:$TAG" >/dev/null \
    && echo "ok   $img" || echo "MISSING $img"
done
```

## The routine update

Migrate first, then roll the apps. Both steps are scoped commands.

### 1. Run migrations

Migrations run through the `<namePrefix>-migrate` job, which reads the Postgres
admin password from Key Vault with its own managed identity. Nobody handles
that password after the install's first migration.

```bash
az containerapp job update -g <rg> -n <namePrefix>-migrate \
  --image ghcr.io/<owner>/helix-portal:$TAG
az containerapp job start  -g <rg> -n <namePrefix>-migrate

# then read the result — a job that starts is not a job that succeeded
az containerapp job execution list -g <rg> -n <namePrefix>-migrate \
  --query "[0].{name:name,status:properties.status,start:properties.startTime}"
```

**Run it before the apps, on every update, even when you expect nothing
pending.** Migrations are forward-only, and a new image can carry code that
requires one — rolling the apps first works until the first release that does.

Two things that look like reasons to skip it, and are not:

- **`/health` returning 200 does not prove the schema is current.** The edge
  opens its database pool lazily, so a missing column surfaces at query time —
  under a real user, not at boot.
- **Running it when nothing is pending is free.** `prisma migrate deploy` is a
  no-op with nothing to apply, so it doubles as a cheap proof that the
  credential path still works.

### 2. Roll the apps

```bash
for app in edge portal egress; do
  az containerapp update -g <rg> -n "<namePrefix>-$app" \
    --image "ghcr.io/<owner>/helix-$app:$TAG"
done

# if the dev gateway is deployed — it runs the edge image
az containerapp update -g <rg> -n <namePrefix>-dev-gateway \
  --image "ghcr.io/<owner>/helix-edge:$TAG"
```

The certbot job is rolled the same way, with `job update`. It is a scheduled
job, so a new image takes effect at its next run.

### 3. Confirm the new code is actually live

Do not skip this step: a failed rollout is silent on this platform (the next
section explains why), and this check is what catches it.

```bash
az containerapp revision list -g <rg> -n <namePrefix>-edge \
  --query "[?properties.active].{rev:name,image:properties.template.containers[0].image,\
state:properties.runningState,replicas:properties.replicas}" -o table
```

The active revision's image must be the tag you just deployed, and its running
state must be `Running`. Two active revisions means the new one has not become
ready and the old one is still serving.

## What a rollout actually does

These behaviours were measured on a live install, polling an app every ~2 s
while it was pointed at a deliberately broken image. Read this section before
building any release automation.

1. **A bad tag fails the CLI call.** Container Apps validates the image
   manifest synchronously, so `--image <unpullable-tag>` returns an error and
   creates no revision. The app is untouched. "Bad tag" is not a rollout
   failure; it is a failed API call.
2. **A broken rollout causes no downtime.** In `Single` revision mode the old
   revision keeps serving until the new one is `Running`/`Healthy`, and is
   deprovisioned only then. Pointed at an image that exits immediately:
   **0 non-200 responses out of 116 samples.** Note that `ingress.traffic` was
   `latestRevision: true, weight: 100` throughout — traffic config expresses
   intent, not what happens before readiness.
3. **There is no automatic rollback.** The broken revision just sits there.
4. **So a failed rollout is silent.** The app stays up serving the *previous*
   code and nothing surfaces it.

::: warning The failure mode to design against
Points 3 and 4 plus migrate-first give the real hazard: **new schema, apps
quietly running old code.** Nothing is down, nothing alerts, and the install
looks healthy.
:::

For a release pipeline the consequence is: health verification is not there to
prevent an outage — Container Apps already prevents it. Its only job is to
answer one question: did the new code go live? Report that, but do not gate on
it — failing the workflow neither rolls back nor holds traffic.

## Rolling back

Roll forward to the previous tag. It is the same scoped command, and it is why
`sha-` tags are worth deploying:

```bash
az containerapp update -g <rg> -n <namePrefix>-edge \
  --image ghcr.io/<owner>/helix-edge:<previous-sha-tag>
```

**Migrations do not roll back** — they are forward-only by design. A schema
change that the old code cannot tolerate has to be rolled forward with a fix,
so keep migrations backward-compatible with the release before them and the
rollback stays a one-liner.

## Rotating a secret

Changing a secret **value** does not restart anything. Container Apps secrets
are app-level, not part of the revision template, so the running containers
keep the old value — and a revision that is already failing on it will keep
failing. Force a new revision after rotating:

```bash
az containerapp update -g <rg> -n <app> --revision-suffix <something-new>
```

One exception worth knowing: **never rotate the Postgres admin password out of
band.** `az postgres flexible-server update --admin-password` drifts from the
copy in Key Vault that the migrate job reads, and migrations start failing.
Change the Bicep parameter and re-apply.

## When you do need a full apply

Anything the template owns and no scoped command can reach:

- Adding or removing a resource — a feature gate like `deployFoundry`,
  `deployAlerts`, `deployDevGateway`, `deployFirewall`.
- Changing a role assignment, an identity, or the network shape.
- Changing a secret that other resources derive from.
- Adding a hostname that needs a TLS binding. **The declared set is an
  allowlist**: a hostname bound by hand is deleted by the next apply with no
  self-heal, so a host that needs a binding gets a row in `main.bicep`.

A full apply is a documented operation, not a blocker. But it has hazards no
preview will show you — read the rest of this section before running one.

### Reconcile the image tag, or the apply rolls you back

`imageTag` is a template parameter, so **the apply deploys whatever your params
file says** — including a tag older than what is running. Params files drift
behind installs, and this is how a routine apply silently downgrades every
workload. Check what is live before you apply:

```bash
az containerapp list -g <rg> \
  --query "[].{app:name,image:properties.template.containers[0].image}" -o table
```

### Have every secret on hand

Secure parameters render as `[unknown()]` in a what-if, so **the preview
cannot see the one failure mode that blanks a live credential**. An
environment variable that is unset — or set but empty — renders as `''` and
overwrites the secret. Source the environment file; do not assume the shell
inherited it.

### Read the what-if, knowing what it cannot tell you

```bash
az deployment group what-if -g <rg> -f main.bicep -p main.bicepparam \
  --no-pretty-print
```

Capture the raw JSON — the pretty output cannot be filtered.

**The rule of thumb for false positives: if the `after` side is a literal
`[...]` ARM expression, it is noise.** What-if cannot resolve `reference()`
across nested modules, so it prints the unevaluated expression and reports a
Modify. On a typical install that is roughly a quarter of all leaf deltas,
including every cross-module URL and identity id, DNS record addresses, and
role-assignment principal ids. A second noise class is read-only system
properties the template omits, which show as `Delete` and are never removed.

What the preview genuinely cannot answer:

- **Secure parameters**, as above.
- **Cross-module env values.** A value like the edge's egress URL reports
  Modify unconditionally, so a stale value and a correct one produce the same
  line — one more entry in a large set of lookalike false positives. Verify
  the egress hop against live state after the apply, not against the diff.
- **Rules that gate on cross-module outputs may be omitted entirely** — no
  `Create`, no `Unsupported`, nothing. A defect there surfaces at apply time,
  so count the deployed alert rules afterwards rather than trusting the preview
  in either direction.
- **`deployFoundry=true` makes the whole diff look clean when it is not.** The
  Foundry module takes a `reference()` input, so ARM short-circuits it, and
  the skip cascades: storage, Key Vault, Postgres, DNS and every container app
  drop out of the diff. **Read `diagnostics` before `changes`, and treat a
  container app listed under `Ignore` as a reason to stop.** To get a real
  preview, run the what-if with `-p deployFoundry=false` to see the damage
  surface, then validate the Foundry resources separately as a standalone
  template.

### The TLS canary

On an install with `wildcardTlsBound: true`, the what-if must **not** show a
delete of `properties.configuration.ingress.customDomains`.

**If it does, the gate is off — stop, do not apply.** With the gate on, the
template declares the bindings and an apply preserves them (verified by an
external TLS poll across both apply windows: no strip-then-add gap exists,
because the property is set by the same PUT that reconciles the app). With it
off, the apply strips every bound hostname and browsers immediately fail TLS.

Likely causes, in order: someone edited the params file, someone re-pointed
`using` at an older template, or the parameter got sourced from an environment
variable. It must be a **literal** in the params file — a set-but-blank
variable renders as `''`, which reads as false, and false is the direction
that wipes the bindings.

Do **not** trigger the certbot job as a routine post-apply step. Inside the
renewal window it spends one of Let's Encrypt's five duplicate certificates per
seven days. The job is the fresh-install bootstrap path and the self-heal for an
ungated apply — both exceptional.

### Hand-made role assignments collide

The template names role assignments with a deterministic `guid()`, and ARM
cannot know about a differently-named duplicate — so a hand-made assignment
fails the apply with `RoleAssignmentExists`. It is detectable, because ARM's
`guid()` emits UUIDv5 while `az role assignment create` without `--name` emits a
random UUIDv4, and the version is the first character of the third group:

```bash
for id in $(az identity list -g <rg> --query "[].principalId" -o tsv); do
  az role assignment list --assignee "$id" --all \
    --query "[].{name:name,role:roleDefinitionName,scope:scope}" -o tsv
done | while IFS=$'\t' read -r name role scope; do
  ver=$(echo "$name" | cut -d- -f3 | cut -c1)
  [ "$ver" = "5" ] || printf 'HAND-MADE  %s  %s  %s\n' "$name" "$role" "${scope##*/}"
done
```

Delete the hand-made one and re-apply; the template recreates it identically.
Env-var patches made with `az containerapp update --set-env-vars` are not
affected — env vars are overwritten, not conflicted. Only role assignments
collide.

## After any update

**Control-plane status is not evidence.** `Succeeded`, `Running`,
`runningStatus`, `healthState` and a plausible FQDN have all been green over
real outages. Check the things that fail silently:

- **The active revision carries the tag you deployed** — see
  [step 3](#_3-confirm-the-new-code-is-actually-live).
- **TLS is verified from outside**, which is a different claim from the binding
  existing:

  ```bash
  curl -s -o /dev/null -w '%{http_code} tls=%{ssl_verify_result}\n' \
    https://auth.<appsDomain>/health
  ```

  `tls=0` is a verified chain.
- **The edge→egress hop resolves**, after any full apply. The apply rewrites
  that URL on every caller from a `reference()` the diff could never resolve,
  so an apply is exactly when this hop breaks. Probe it from inside the
  calling container — it has failed on real applies.
- **Alert rules still exist**, after a full apply — a rule that failed to deploy
  looks exactly like a healthy platform.
- **A request traces end to end.** Drive a real request through a deployed app
  and check it lands in Application Insights. Wait out ingestion latency
  before concluding anything: an empty result is not evidence of failure until
  the latency has passed. When a query comes back empty, suspect the query
  first — wrong workspace, wrong table, wrong schema. There are two Log
  Analytics workspaces per install, so **never index them by position**.
