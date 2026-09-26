# Roll out the provider instruction field, and operate connection providers

Two procedures from the OAuth-connections work (I-02): the one-time **roll
order** the strict-parsed `provider` field requires, and the day-to-day
**provider administration** operations (edit/deletion impact, credential
rotation, environment separation). The feature behavior is documented in
[`docs/features/connection-providers.md`](../features/connection-providers.md);
the decision is I-02 ADR-0005, recorded in the
[ADR-0031 amendment](../adr/0031-connection-providers-delegated-auth.md).

## Part A — the roll order (consumers before producers)

### When you need this

Any release that carries the I-02 schema change — the attested instruction
gains a strict-parsed `provider` sibling field (XOR'd with `connection`), and
the instruction and manifest origin schemas become **strict**: unknown keys are
rejected, not stripped. On Azure this is any image roll from the release that
landed I-02 ADR-0005 forward; the same ordering applies to a local compose
bring-up, which restarts everything at once and is fine.

### The order: egress, then portal, then edge

```bash
TAG=<the sha- tag to deploy>   # see "Deploying updates" — resolve once
az containerapp update -g <rg> -n <namePrefix>-egress --image ghcr.io/<owner>/helix-egress:$TAG
# verify egress is Running on the new tag, then:
az containerapp update -g <rg> -n <namePrefix>-portal --image ghcr.io/<owner>/helix-portal:$TAG
# verify, then — the dev gateway runs the edge image and rolls with it:
az containerapp update -g <rg> -n <namePrefix>-edge    --image ghcr.io/<owner>/helix-edge:$TAG
az containerapp update -g <rg> -n <namePrefix>-dev-gateway --image ghcr.io/<owner>/helix-edge:$TAG
```

**Do not loop all four in one command for this release** — the ordinary
"roll the apps" one-liner in
[Deploying updates](../../apps/docs/src/deploy/updates.md) is fine for most
releases, but this one has a real ordering constraint. Run migrations first,
as always.

### Why the order is binding

The instruction schema's evolution is the hazard. Before this change the
instruction schema was **non-strict** — an unknown key was silently stripped.
During a version skew, a new-form instruction (carrying `provider`) that an
**old egress** verifies would lose that field silently and go out
**unauthenticated** — the one direction that is worse than failing the call,
and the reason the schema became strict at the same time the field landed.

Rolling consumers first means every plane that can meet the new field already
verifies it strictly before any plane emits it:

- **New egress + old edge/portal** — safe. Old producers send old-form
  instructions (a `connection` secret name), which the new egress still
  verifies.
- **New edge + old egress** — the failure direction. The edge mints a
  `provider`-bearing instruction; the old egress strips the field and the call
  goes out without the injected credential. The vendor answers 401 and the app
  sees the upstream failure.

That bad direction self-heals at the **instruction TTL** — 30 seconds, the
signed claim's lifetime — so the exposure is bounded by how long an old egress
keeps serving after the edge rolls. It is only *reachable* if a provider
binding is approved mid-deploy (a human step on a fresh feature), and its
failure mode is a degraded unauthenticated vendor call — visible as vendor
401s — never credential exposure. The ratified residual is the minutes-long
mid-rollout window while replicas converge, accepted in I-02 ADR-0005 rather
than closed with a wire-format migration.

### Verify after the roll

1. The active revisions carry the new tag (the check in
   [Deploying updates](../../apps/docs/src/deploy/updates.md)).
2. A delegated journey through a provider-bound app: Connect → approved → the
   app's call reaches the vendor with the token. The
   `helix.egress.exchange` / `helix.egress.resolution` spans answer
   (`docs/features/observability.md`).
3. During the roll itself, watch for a burst of vendor 401s on
   provider-bound calls — the skew window's signature if the order was
   violated. The egress `helix.credential_source="delegated"` attribute on the
   proxy span distinguishes these calls from ordinary secret-bound traffic.

## Part B — provider administration operations

### Editing or deleting a provider (impact, confirmation)

A **sensitive** edit — client identity, authorize/token endpoints, requested
permissions, API destinations, token placement — invalidates every existing
user connection and pending consent attempt for the provider, in one
all-or-nothing transaction, and blocks affected apps' bindings until their
owners re-save the manifest. Display-name changes and client-secret rotations
are not sensitive and invalidate nothing.

The platform refuses a sensitive delta that arrives without an explicit
invalidation acknowledgement: 409 `confirmation_required` carrying the impact
payload (bound apps, live connections, pending attempts). The SPA's review
panel shows the same counts and the field diff before the confirm. Read the
counts before confirming — they are the blast radius, and deletion's
confirmation is never optional.

Deletion answers `already_removed` on a repeat and cannot touch a provider
recreated under the same ref. Nothing about a deletion is restorable by
recreating: old approvals and old consent stay gone.

### Rotating a provider's client credential

Rotate **at the vendor first**, then paste the new value into the provider
edit form (or the import's update mode). Supplying a client secret is a
non-sensitive rotation: connections stay live, no invalidation, no
reapproval. The edit is CAS'd on the loaded revision *and* on the stored
credential, so two concurrent rotations arbitrate — the loser's sealed
material is released, and a stale save is a 409, not a silent overwrite.

Leave the secret field **blank** on any edit that is not a rotation: the
stored material is never read back, so blank is the only way to say
"unchanged".

The same flow rotates the client ID — but supplying a client *ID* **is** a
sensitive change (it changes who the users consented to) and takes the full
confirmation path above.

### Environment separation

A provider is configured per environment and never moves: `env` is chosen at
create and immutable, and the same ref may exist once per environment. To
"move" a provider, configure the other environment as its own row — the JSON
export carries no environment, so the import's create mode asks for one. Dev
connections and prod connections never resolve each other's providers, and a
dev-tier connection keys to the developer identity of the dev caller.

## Related

- [`docs/features/connection-providers.md`](../features/connection-providers.md) — the operator feature doc.
- [Deploying updates](../../apps/docs/src/deploy/updates.md) — the routine update procedure this runbook overlays.
- [ADR-0031](../adr/0031-connection-providers-delegated-auth.md), the 2026-09-25 amendment — the decision letters this rollout discipline implements.
