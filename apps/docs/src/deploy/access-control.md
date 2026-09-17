---
title: Access control
---

# Access control

Who can get into a Helix install at all, and who can administer it. What an
allowed user may then _do_ — budgets, capabilities, per-app visibility — is
enforced by the platform, not by Entra.

## The three audiences

| Audience | What they can do | Where the gate lives |
| --- | --- | --- |
| **App users** | Sign in to hosted apps (`<slug>.<appsDomain>`) | The `helix-edge` registration |
| **Portal users** | Sign in to the portal; create, deploy and update their own apps | The `helix-portal` registration |
| **Platform admins** | Everything portal users can do, plus approvals, secrets and the admin pages | The `platform-admin` app role on `helix-portal` |

Admin is an exact-value match on the `platform-admin` string in the token's
`roles` claim — there is no second definition to drift.

## The recommended shape: one security group per audience

Curate three security groups in your tenant and assign access through them,
so membership churn is a directory edit, not a redeploy:

| Group (example name) | Purpose | Parameter it feeds |
| --- | --- | --- |
| `helix-users` | People who can sign in to hosted apps | `edgeAccessPrincipalIds` |
| `helix-portal` | People who can create, deploy and update apps | `portalAccessPrincipalIds` |
| `helix-admins` | Full portal control: approvals, secrets, admin pages | `adminPrincipalId` |

An admin does not also need to be in the portal group — the admin assignment
alone satisfies sign-in. Assigning a **group** to an app role needs a paid
Entra tier (P1 or above); assigning individual users works on the free tier.

## What gating actually does

The registrations are single-tenant, and by default **any member of your
tenant can sign in** — on the edge, guests included. Setting an access list
non-empty flips `appRoleAssignmentRequired` on that registration's service
principal: from then on, sign-in is by explicit assignment only.

Two things to know before you gate:

- **Admin consent becomes required, not optional.** Assignment-required
  disables user self-consent, so without a pre-grant a first-time user gets
  "admin approval required" and cannot proceed. Set `grantAdminConsent=true`
  in the same change.
- **Being allowed in confers nothing.** Portal sign-in assignments ride on a
  dedicated `user` app role that grants no privilege — admin stays the
  exact-value `platform-admin` match. A principal in both lists simply holds
  both assignments.

## Wiring it in the Bicep deploy

The `infra/entra` module takes the object ids as parameters; the checked-in
`main.bicepparam` reads them (and the admin principal) from the environment:

```bash
export HELIX_ADMIN_PRINCIPAL_ID=<helix-admins group object id>
export HELIX_EDGE_ACCESS_PRINCIPAL_IDS=<helix-users group object id>
export HELIX_PORTAL_ACCESS_PRINCIPAL_IDS=<helix-portal group object id>
# ...and set grantAdminConsent = true in main.bicepparam, then deploy the
# Entra stack as in Entra ID setup.
```

Multiple ids per list are comma-separated. Leaving a list empty keeps that
audience open to the whole tenant — the out-of-box default.

Doing it by hand instead: _Enterprise applications → \<registration\> →
Properties → Assignment required → Yes_, then _Users and groups → Add_.

## Rolling out

Seed the admin group with the people running the deployment, so the platform
is operable on day one. Once the tenant's own admins are in and verified,
rescind the deployers' access. Because every gate here is a group assignment,
the whole handover is directory edits, not redeploys.

## What this page is not

- **Per-app visibility.** Restricting one app to specific Entra groups is a
  separate, later step — security-group claims on the tokens, plus the
  `GroupMember.Read.All` grant that powers the portal's group picker. See
  [Entra ID setup](/deploy/entra-setup) and the
  [group-claims runbook](https://github.com/AZX-PBC-OSS/helix/blob/main/docs/runbooks/entra-group-claims-rollout.md).
- **Directory search posture.** Once the picker is live, who among signed-in
  users may resolve group names (`PORTAL_DIRECTORY_SEARCH`) is its own
  decision — the same runbook, §8.5.
