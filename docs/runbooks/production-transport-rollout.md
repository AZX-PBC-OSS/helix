# Production transport rollout — discovery and execution

Use this runbook for ADR [0055](../adr/0055-production-transport.md). Part 1 gathers
installation-specific evidence. Part 2 describes the rollout and is completed
from that evidence before any production changes. This is an upgrade of an
existing deployment, not the bootstrap procedure.

The code and local tests are complete. Live Azure verification remains outstanding.
A clean repository gate and Bicep build do not establish the state of an Azure
installation. No schema migration, role change, or signing-key rotation is needed.

## Part 1 — collect the inputs for Part 2

These Azure commands are read-only. Run from the repository root in an authenticated
Azure environment. Replace placeholders; do not assume the checked-in example
resource names or parameter defaults describe this installation.

Keep the worksheet and output in an access-controlled location outside the repo.
Return the completed worksheet and sanitized results to prepare the executable
Part 2. Do not return credentials, database URLs, token-bearing URLs, connection
strings, secret values, or raw environment dumps. Do not enable shell tracing,
Azure `--debug`, or publish raw deployment parameters/outputs.

### 1. Identify the installation and deployment source

```bash
az account show --query '{subscription:id,tenant:tenantId,name:name}' -o json
az version
az bicep version

git rev-parse HEAD
git status --short
```

Set the resource group explicitly. Supply `--subscription` on Azure commands if
there is any ambiguity about the active subscription.

```bash
TRANSPORT_RG='<existing resource group>'
az group show -n "$TRANSPORT_RG" --query '{name:name,location:location,id:id}' -o json
az deployment group list -g "$TRANSPORT_RG" \
  --query '[].{name:name,time:properties.timestamp,state:properties.provisioningState}' -o json
```

Record the exact pipeline or manual deployment entrypoint, parameter-file path,
last successful deployment, and source commit. Identify the effective values of
`deployApps`, `deployJobs`, `deployDevGateway`, `deployTelemetry`,
`wildcardTlsBound`, `portalExternal`, and networking/firewall flags from the
operator's deployment configuration. Record values individually; do not export
an entire parameter file that contains secrets.

The example parameter files default several deployed features to false. In
particular, do not turn `deployApps` off as a shortcut for an upgrade or apply
bootstrap defaults to a running installation. Preserve wildcard certificate
bindings and all existing topology flags.

### 2. Inventory environments, services, revisions, and jobs

```bash
az resource list -g "$TRANSPORT_RG" \
  --resource-type Microsoft.App/managedEnvironments \
  --query '[].{name:name,id:id,location:location}' -o json
az containerapp list -g "$TRANSPORT_RG" \
  --query '[].{name:name,environment:properties.managedEnvironmentId,fqdn:properties.configuration.ingress.fqdn,external:properties.configuration.ingress.external,insecure:properties.configuration.ingress.allowInsecure,mode:properties.configuration.activeRevisionsMode}' -o json
az containerapp job list -g "$TRANSPORT_RG" \
  --query '[].{name:name,environment:properties.environmentId,images:properties.template.containers[].image}' -o json
```

For **each** environment and app, substitute its discovered name:

```bash
TRANSPORT_ENV='<environment name>'
az resource show -g "$TRANSPORT_RG" -n "$TRANSPORT_ENV" \
  --resource-type Microsoft.App/managedEnvironments --api-version 2024-03-01 \
  --query '{name:name,internal:properties.vnetConfiguration.internal,peerEncryption:properties.peerTrafficConfiguration.encryption.enabled}' -o json

TRANSPORT_APP='<container app name>'
az containerapp revision list -g "$TRANSPORT_RG" -n "$TRANSPORT_APP" \
  --query '[].{name:name,active:properties.active,created:properties.createdTime,health:properties.healthState,provisioning:properties.provisioningState,images:properties.template.containers[].image}' -o json
az containerapp show -g "$TRANSPORT_RG" -n "$TRANSPORT_APP" \
  --query '{containers:properties.template.containers[].{name:name,image:image,envReferences:env[].{name:name,secretRef:secretRef}},secrets:properties.configuration.secrets[].{name:name,keyVaultUrl:keyVaultUrl,identity:identity},domains:properties.configuration.ingress.customDomains[].{name:name,certificateId:certificateId,bindingType:bindingType}}' -o json
```

The last query intentionally omits environment and secret values. Vault-reference
URLs identify secret names/versions, not values; keep that metadata restricted too.
Record immutable image digests separately if revisions use mutable tags. A tag
alone is not a reliable rollback artifact. Include edge, portal, egress, jobs,
dev gateway, collectors, and portal/jobs migration jobs; mark absent optional
components explicitly rather than guessing.

### 3. Inventory database and storage enforcement

```bash
az postgres flexible-server list -g "$TRANSPORT_RG" \
  --query '[].{name:name,host:fullyQualifiedDomainName,state:state,version:version}' -o json
TRANSPORT_PG='<PostgreSQL server name>'
az postgres flexible-server parameter show -g "$TRANSPORT_RG" \
  --server-name "$TRANSPORT_PG" -n require_secure_transport \
  --query '{name:name,value:value,source:source}' -o json
az postgres flexible-server parameter show -g "$TRANSPORT_RG" \
  --server-name "$TRANSPORT_PG" -n ssl_min_protocol_version \
  --query '{name:name,value:value,source:source}' -o json
az storage account list -g "$TRANSPORT_RG" \
  --query '[].{name:name,https:enableHttpsTrafficOnly,tls:minimumTlsVersion,publicNetwork:publicNetworkAccess}' -o json
```

Fill one row per **consuming client**, including runtime services, migration jobs,
and role-provisioning psql. Inspect DSNs only in the authorized runtime or secret
management context; report these derived facts, never the DSN itself:

| Client / image digest | Database role | Source: vault secret name/version or direct ACA secret | TLS mode | CA option/file | Hostname verification | Update/restart mechanism |
| --- | --- | --- | --- | --- | --- | --- |
| Edge | | | | | | |
| Portal runtime | | | | | | |
| Egress | | | | | | |
| Jobs | | | | | | |
| Dev gateway | | | | | | |
| Portal migration (native Prisma) | | | | | | |
| Jobs migration (pg) | | | | | | |
| Role provisioning (psql) | | | | | | |

Also record where the **steady-state deployment reads each DSN**. The new template
only generates `verify-full` when a complete DSN was not supplied. Existing
vault-sourced DSNs remain unchanged until deliberately updated. Do not regenerate
passwords to change a URL option.

Node pg clients require `sslmode=verify-full`; custom root CAs use `sslrootcert`.
Native Prisma requires `sslmode=require&sslaccept=strict`; its custom CA option is
`sslcert`. Record the CA bundle present in each actual image. A successful Node
connection does not establish that native Prisma or psql trusts the same chain.

Classify each DSN by **how it reaches its client**, because that decides the Part 2
mechanism. The reference template delivers DSNs in these ways:

| Shape | Typical clients | What changes it |
| --- | --- | --- |
| Template-composed (no `*DatabaseUrl` parameter supplied) | any | The next template apply writes `verify-full` |
| Supplied parameter, delivered as an ACA Key Vault reference | edge, portal, egress, dev gateway | A new vault version, then a configuration write that re-resolves the reference |
| Supplied parameter, delivered as an inline ACA secret | jobs runtime | A template apply (the app has no identity to read the vault) |
| Read from the vault at run time | jobs migration | A new vault version; picked up on the next run |
| Composed in code | portal migration (native Prisma) | The image |
| Operator tooling (psql in a throwaway job) | role provisioning, ad-hoc SQL | The tool's own DSN and root-certificate options |

The current Node `pg` connection-string parser already treats `sslmode=require` as
`verify-full` (it verifies the chain and hostname against Node's bundled roots
unless `uselibpqcompat=true` is set). A Node client that connects today with
`require` is therefore already verifying. That is useful evidence for the Node rows
but proves nothing about psql or native Prisma, which do implement libpq's weaker
`require`.

**libpq `verify-full` needs a root file.** Without `sslrootcert`, psql looks for
`~/.postgresql/root.crt` and refuses to connect when it is missing. Operator tooling
that reads a shared DSN must set `PGSSLROOTCERT` (or pass
`sslrootcert=/etc/ssl/certs/ca-certificates.crt`, or `sslrootcert=system` on
libpq 16+) and confirm the bundle exists in the image it actually runs.

### 4. Check service destinations without exposing credentials

Run the supplied configuration verifier and retain its output and exit status:

```bash
bash infra/azure/scripts/verify-transport.sh "$TRANSPORT_RG"
```

A nonzero result before rollout is expected if encryption is not yet enabled.
The verifier also reports jobs configuration held in secret references as
incomplete: it intentionally does not retrieve secret values. Record which
checks are **insecure**, **unknown**, or **not applicable**; do not treat all
nonzero results as the same condition.

For each service's actual running environment, have an authorized operator inspect
only the destination fields and return this table. For jobs JSON inspect
`servers[*].endpoint`, not roots or the whole JSON. Confirm values in the running
revision, not just the desired deployment configuration.

| Caller → destination | Scheme | Destination app/resource | Config key / secret reference | Running value checked? |
| --- | --- | --- | --- | --- |
| Edge/dev gateway → egress | | | `EDGE_EGRESS_URL` | |
| Edge/dev gateway → portal | | | `EDGE_PORTAL_URL` | |
| Edge/dev gateway → jobs | | | `EDGE_JOBS_CONFIG` endpoints | |
| Portal → egress | | | `PORTAL_EGRESS_URL` | |
| Portal → jobs | | | `PORTAL_JOBS_CONFIG` endpoints | |
| Jobs → edge/dev gateway | | | `JOBS_EDGE_PROD_URL`, `JOBS_EDGE_DEV_URL` | |
| Each service → collector | | | Base and signal-specific OTLP endpoints | |
| Each collector → Application Insights | | | Ingestion destination only | |

Record transport mode, whether any mesh exception exists, and whether
`NODE_TLS_REJECT_UNAUTHORIZED=0` is set. Azure should use HTTPS mode without mesh
exceptions. Include Blob and vault endpoint schemes. Do not include OAuth URLs
with codes, tokens, or query strings in returned evidence.

The verifier does not cover scheduled/manual jobs (for example a jobs health relay)
or collector exporter configuration. Inventory those by hand.

The following in-container probe answers both the jobs-endpoint rows and the
database-client `TLS mode` column for runtime apps. It prints configuration
**names**, the database role and name, query-option names, the value of `sslmode`
only, and endpoint schemes with the first host label. It never prints a password,
a full host, or a whole JSON document. `az containerapp exec` splits `--command` on
whitespace and carries it in a URL capped near 2 KB, so the program is base64-encoded.
Read the program before running it. It needs exec rights on the app
(`Microsoft.App/containerApps/getAuthToken/action`), which RG Reader lacks.

```bash
cat > transport-probe.js <<'EOF'
const o={};for(const[k,v]of Object.entries(process.env)){if(/DATABASE_URL$/.test(k)){try{const u=new URL(v);o[k]={user:u.username,db:u.pathname.slice(1),q:[...u.searchParams.keys()].map(x=>x==='sslmode'?x+'='+u.searchParams.get(x):x)}}catch(e){o[k]='unparseable'}}else if(/JOBS_CONFIG$/.test(k)){const eps=[];const w=x=>{if(x&&typeof x==='object')for(const[n,c]of Object.entries(x)){if(n==='endpoint'&&typeof c==='string'){const u=new URL(c);eps.push(u.protocol+'//'+u.hostname.split('.')[0]+'.*')}else w(c)}};try{w(JSON.parse(v))}catch(e){eps.push('unparseable')}o[k]=eps}else if(/^(NODE_TLS_REJECT_UNAUTHORIZED|HELIX_INTERNAL_TRANSPORT_MODE|HELIX_MESH_HTTP_ORIGINS|NODE_EXTRA_CA_CERTS|PGSSL.*)$/.test(k))o[k]=v}o.node=process.version;console.log('PROBE '+JSON.stringify(o))
EOF
probe="node -e eval(Buffer.from('$(base64 < transport-probe.js | tr -d '\n')','base64').toString())"
script -q /dev/null az containerapp exec -g "$TRANSPORT_RG" -n "$TRANSPORT_APP" \
  --command "$probe" </dev/null | tr -d '\r' | grep '^PROBE'
```

Migration jobs cannot be probed this way. Record their DSN shape from how they are
built (see the table in step 3) and mark them unverified until Part 2 runs them.

### 5. Gather rehearsal, baseline, and recovery inputs

Collect at least 30 minutes of representative baseline traffic, recording UTC
start/end, request volume, 5xx rate, p95 request latency, streaming completion and
time-to-first-byte, jobs queue/running counts and health, and telemetry freshness.
For quiet installations, record synthetic measurements and mark the low sample
size; do not interpret zero traffic as successful operation.

Return these additional inputs:

- Separate Azure rehearsal environment, or the location and identity for isolated
  candidate-image connectivity checks inside the production VNet.
- Candidate image digests, their commit, and the last known-good digests.
- Safe disposable app, test users, OAuth provider/test account, and permitted
  upstream test calls. Define any cost or data limits.
- Access method for body-aware health checks, private endpoints, and telemetry.
- Maintenance window, decision maker, operator, observer, and communication path.
- Existing alarms/SLOs and proposed stop thresholds; expected jobs drain duration.
- Where previous secret versions/configuration are retained and how to restore
  them without printing values. Verify that old images remain pullable.
- Whether peer encryption and secret-update rollback have been rehearsed.

### Part 1 handoff

Return the tables above plus the following summary. Use identifiers or redacted
aliases if necessary; do not attach raw Azure configuration dumps.

```text
Installation / subscription / tenant / resource group:
Discovery timestamp and source commit:
Deployment pipeline, parameter source, last successful deployment:
Effective topology flags and certificate-binding state:
Service → environment → active revision → immutable image mapping:
Candidate and rollback image availability:
Database client matrix completed / unresolved rows:
Service-destination matrix completed / unresolved rows:
Verifier output and exit status:
Baseline time window, measurements, and sample size:
Rehearsal environment or isolated connectivity-check location:
Disposable app/users/provider and allowed test operations:
Secret/configuration restore procedure and access confirmed:
Maintenance window and operator/decision-maker:
Proposed stop thresholds and observation periods:
Unknowns requiring resolution before rollout:
```

**Stop after discovery.** Part 1 authorizes no secret writes, service restarts,
worker launches, migrations, infrastructure updates, or image deployments.

## Part 2 — staged rollout

This is the execution specification. Copy it into the installation's private
operations record, fill every placeholder from the Part 1 handoff, and have a
reviewer confirm that each row names the affected resources and its recovery before
the window opens. Nothing installation-specific belongs in this repository.

### Why this order

Three facts fix the sequence:

1. **Candidate images refuse to start** unless every database URL they receive
   carries exactly one `sslmode=verify-full` and no `ssl` or `uselibpqcompat` option
   (`packages/shared/src/transport.ts`). The migration scripts apply the same
   check. Database URLs must therefore change **before** any candidate image runs.
2. **Old images accept `verify-full`.** Node `pg` already verifies under `require`
   (Part 1, step 3), so for Node clients the URL change is a no-op on the wire. That
   lets the configuration change run, and be proven, under the old images.
3. **The template shares one `imageTag` and uses single-revision mode.** A full apply
   is not a canary. Stage with scoped commands, then reconcile with one full apply
   per image state.

The resulting order is: rehearse, rewrite the database URLs, roll the old images
onto them, turn on encryption one environment at a time, reconcile under old images,
move the images one service at a time, and reconcile at the candidate tag.

If an image pipeline deploys a floating tag such as `latest`, publishing the candidate
images is itself a hazard: the next release would ship images that refuse the
current URLs. Finish B and C (which need only the old images and the new template)
before the candidate images are published, or pause that pipeline until D.

### Execution ledger

Use one row per environment or service change. Never put secret values in the
ledger or alongside it. Vault secret versions, revision names and image digests are
the identifiers to record.

| Step | Resource(s) | Previous state / digest / version | Reviewed command | Verification and stop threshold | Recovery | Operator / UTC / outcome |
| --- | --- | --- | --- | --- | --- | --- |
| A rehearsal | | | | | | |
| B1 vault DSN rewrite | | | | | | |
| B2 runtime refresh (per app) | | | | | | |
| B3 operator tooling | | | | | | |
| C1 egress environment encryption | | | | | | |
| C2 apps environment encryption | | | | | | |
| C3 reconcile at old tag | | | | | | |
| D1 egress image | | | | | | |
| D2 portal image | | | | | | |
| D3 portal migration job | | | | | | |
| D4 edge, then dev gateway images | | | | | | |
| D5 jobs image, then jobs jobs | | | | | | |
| F reconcile at candidate tag | | | | | | |

### A. Rehearse and establish rollback

Run the sequence first on a non-production installation built from the same
template, with the same optional planes. If none exists, record that
environment-level behaviour (peer encryption in particular) is unrehearsed and
lengthen the C1 and C2 observation windows.

Before the window:

- Confirm candidate **and** previous images are pullable and record their digests.
  A tag is not a rollback artifact. Pin `image@sha256:…` in recovery commands.
- Confirm the operator holds what each step needs. Scoped app/environment updates
  need Contributor. A full template apply also writes role assignments (Owner in
  effect). `containerapp exec` needs `getAuthToken`. Activate elevation before
  signing in, not after.
- Record each target vault secret's current version from ARM metadata, which
  needs no data-plane access and returns no value:

  ```bash
  az rest --method get --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$TRANSPORT_RG/providers/Microsoft.KeyVault/vaults/$VAULT/secrets/$SECRET?api-version=2023-07-01" \
    --query 'properties.secretUriWithVersion' -o tsv
  ```

- Confirm whether any schema migration is pending for the candidate commit. This
  change adds none. If one is pending, it is a separate change and must not ride
  along.

Connectivity checks must not start an application server or a jobs worker, and must
not run `prisma migrate deploy`, jobs migrations or provisioning merely to test
TLS. The one deliberate exception is D3 below.

### B. Database URLs, under the old images

**B1: rewrite the authoritative copy.** Change only the `sslmode` option. Do not
regenerate passwords, and do not change roles, hosts or database names.

- *Template-composed DSNs:* nothing to do here; C3 writes `verify-full`.
- *Vault-supplied DSNs:* write a new version whose only difference is the option.
  When the vault's data plane is private, do it in ARM so that no value reaches a
  shell. A one-off deployment sources each DSN with `az.getSecret()` in a
  `.bicepparam`, rewrites it with `replace()`, and PUTs the secret through the
  control plane, which ignores the vault's network rules. The rewrite should fail
  the whole deployment, naming only the secret, unless the DSN carries exactly one
  `sslmode`. The reverse rewrite is the recovery path. A secret that the steady-state
  apply round-trips (`getSecret` in, vault write-back out) then carries the new
  option forward on every later apply.

Verify the result through ARM metadata (a new version exists) and, after B2, with
the Part 1 probe. Never verify by reading the value.

**B2: make each runtime consume it.** A Key Vault reference is resolved when the
app's configuration is written. A revision restart reuses the previously resolved
value. Use one scoped configuration write per app, which creates a new revision with
freshly resolved secrets. The value to write is the new template's own environment
setting, so the patch converges toward IaC and is harmless to old images:

```bash
az containerapp update -g "$TRANSPORT_RG" -n "$APP" \
  --set-env-vars HELIX_INTERNAL_TRANSPORT_MODE=https
```

Order: egress, portal, edge, dev gateway. After each one, run the probe (expect
`sslmode=verify-full`), check body-aware health, run that service's database-touching
smoke probe, and check its logs for TLS or connection errors. Inline-secret clients
(the jobs runtime) are not refreshed by this. They move at C3.

**B3: operator tooling.** Any psql job that reads a shared DSN now receives
`verify-full` and fails without a root file (Part 1, step 3). Set `PGSSLROOTCERT` in
the job definition, or put `sslrootcert` in the tool's own DSN, and confirm the
bundle path exists in the job image. Run one read-only statement through each tool.

**Recovery for B:** rerun B1 in reverse to write a `require` version, then repeat B2
for the affected apps. Restoring an old image does not restore an application
secret.

### C. Infrastructure protection, under the old images

**C1 and C2: peer encryption, one environment at a time.** Start with the
environment that holds egress, because its callers (fetch, LLM, OAuth exchange) are
the narrowest set:

```bash
az containerapp env update -g "$TRANSPORT_RG" -n "$ENV" --enable-peer-to-peer-encryption true
az resource show -g "$TRANSPORT_RG" -n "$ENV" --resource-type Microsoft.App/managedEnvironments \
  --api-version 2024-03-01 --query properties.peerTrafficConfiguration.encryption.enabled
```

After C1, exercise secret-backed fetch, streaming LLM and an OAuth exchange, and
compare latency and time-to-first-byte with the baseline. After C2, exercise every
path in the smoke matrix. These are environment-wide changes, so no app canary
isolates them. Recovery is the same command with `false`, which is independent of
any revision rollback.

**PostgreSQL enforcement.** The template sets `require_secure_transport` and
`ssl_min_protocol_version` explicitly. On Azure Flexible Server both already default
to `on` and `TLSv1.2` (source `system-default`), so the explicit setting changes the
parameter source, not the effective policy. If Part 1 found a weaker effective
value, prove every client from B first and give the server change its own ledger
row. Azure reports these values in lower case. Compare without regard to case.

**C3: reconcile at the old tag.** Run the full template apply from the candidate
commit with the steady-state parameters, overriding `imageTag` to the **currently
running** tag. Review `what-if` first and stop on any change to certificates or
custom domains, ingress scope, identities, storage access, routing or firewalls,
optional services, or any replacement. Note that what-if cannot preview every
module (alert rules in particular), so count those resources after the apply. The
apply rewrites the inline jobs DSN from the vault, adds `HELIX_INTERNAL_TRANSPORT_MODE`
where B2 has not, and confirms peer encryption and PostgreSQL settings as declared.
Afterwards, probe the jobs runtime for `sslmode=verify-full` and prove queue progress.

An installation whose last full apply predates other template changes will pick
those up here as well. Read the template diff from the deployed commit and decide
whether to land those changes in a separate apply first.

### D. Candidate images, one service at a time

Move each service with a scoped image update pinned by digest, and wait for its
latest **ready** revision to run that digest before moving on:

```bash
az containerapp update -g "$TRANSPORT_RG" -n "$APP" --image "$REGISTRY/$IMAGE@$DIGEST"
```

The order is egress (D1), then portal (D2), then edge and the dev gateway (D4), then
jobs (D5). Advance only after the previous service shows all of the following:

- the startup log has `transport.policy` with `outcome: accepted` (`refused` means
  the boot guard rejected the configuration, so stop);
- body-aware health is good;
- that service's rows of the smoke matrix pass;
- fresh telemetry from it reaches the backend.

There is no new wire format, so mixed old and new services interoperate.

**D3: portal migration job.** The new image composes
`sslmode=require&sslaccept=strict` for native Prisma, which is the only client no
earlier step has exercised. With no pending migration (confirmed in A), point the
job at the candidate image and run it once. `migrate deploy` then reports nothing to
apply and exits 0, and that run is the native-Prisma TLS proof. If a migration
**is** pending, stop. Do not run it under cover of a TLS check.

**D5: jobs.** Account for queued and running work, and preserve replica and revision
limits. After the app moves, update the jobs migration and any jobs-image scheduled
jobs to the candidate digest. Do not start the migration job merely because its
image changed. Verify worker registration, queue progress, and a complete
submit → callback → result path.

**Recovery for D:** run the same `az containerapp update --image` with the recorded
previous digest. Keep the B and C changes, which the old images have already been
proven against.

### Smoke matrix

Fill in the exact command, the disposable resource and the expected result before the
window. Run the matrix in rehearsal, after B2, after C1, after C2, after C3, and after
each D step (limited to the rows the step touches).

| Probe | Required evidence |
| --- | --- |
| Login and app load | Successful login; assets served; no new authorization errors |
| Secret-backed fetch | Expected response through edge → egress with no credential exposed |
| Streaming LLM | First byte and complete stream within agreed baseline bounds |
| Disposable OAuth connection | Portal → egress exchange succeeds; secrets stay server-side |
| Jobs | Submit, status, callback, result, cancellation, and disposable-app lifecycle delivery |
| Private storage | Blob and vault operations succeed under intended identities |
| Health | Body roll-up and checks inspected, not HTTP status alone |
| Telemetry | Fresh spans/metrics from every changed service reach the backend |
| Revision/configuration | Intended digest active; `transport.policy` accepted; probe shows `verify-full` |

Helix `/health` returns 200 even when degraded, and telemetry can disable itself
while requests keep working. Neither a 200 response nor a successful deployment
operation is enough acceptance evidence. Allow for ingestion latency before
treating missing telemetry as a failure.

### E. Stop conditions and recovery

Before the window, replace the placeholders with installation-specific thresholds:
observation time per step `[minutes]`, acceptable 5xx change `[value]`, p95 latency
increase `[value]`, stream failure and time-to-first-byte limits `[values]`, jobs
progress deadline `[duration]`, and telemetry freshness deadline `[duration]`. Use
existing stricter SLOs where they apply. A quiet traffic window calls for repeated
synthetic probes, not a shorter observation period.

Stop immediately on certificate errors, `transport.policy` `refused`, degraded
required health checks, lost credentials or permissions, broken streams, stalled
jobs, telemetry missing past the agreed deadline, or unexpected resource changes.
Do not advance to another service to see whether the problem clears.

| Failure | Recovery | Does not undo |
| --- | --- | --- |
| Application (D) | Previous digest via scoped image update | URLs, encryption |
| Database URL (B) | Reverse B1 rewrite, then B2 refresh of affected apps | Images |
| Environment encryption (C1/C2) | `--enable-peer-to-peer-encryption false` on that environment | Revisions |
| Server TLS policy | Restore recorded parameter, only with the decision maker's approval; track as open | — |
| Reconcile apply (C3/F) | Fix forward with scoped commands; do not apply an older template | — |

Do not run a broad historical template rollback. It can undo unrelated
infrastructure and certificate bindings. After recovery, repeat the health,
functional and telemetry checks, and record the configuration that actually
resulted.

### F. Accept and reconcile

After the agreed observation period, run the full apply at the candidate tag with
the steady-state parameters. Its `what-if` should show no change to anything the
staged steps already set, so treat any difference as drift to explain before
applying. Then run the verifier and resolve each remaining line:

- peer encryption, PostgreSQL parameters, ingress and Blob checks: `PASS`;
- `*_JOBS_CONFIG needs in-container endpoint verification`: expected, by design.
  Close it with the probe output (`https://` endpoints only).

Record expected resource counts and confirm that no optional plane was omitted.
Save the image, revision and secret-version map, the smoke results, the baseline
comparison, the verifier output and the rollback rehearsal result in the
installation's private record.

Close issue #5 only when the deployed protection and the functional checks are
recorded for at least one installation. If live access or a required check is
unavailable, mark rollout verification incomplete rather than claim that the
repository tests established it.

## References

- [Azure operational reference](../../infra/azure/README.md)
- [Transport decision and connection inventory](../adr/0055-production-transport.md)
- [ACA secret changes require revision refresh](https://learn.microsoft.com/azure/container-apps/manage-secrets)
- [ACA peer encryption and performance considerations](https://learn.microsoft.com/en-us/azure/container-apps/ingress-environment-configuration)
- [ACA revision behavior](https://learn.microsoft.com/en-us/azure/container-apps/revisions)
