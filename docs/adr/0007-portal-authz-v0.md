# 0007. Portal authorization v0: authenticated == authorized

**Status:** Accepted — the v0 "authenticated == authorized" gap (#9) is **closed** by the `ownsApp` owner-or-admin gate; see Resolution.
**Related:** `apps/portal/src/plugins/auth.ts`; ADR [0028](0028-deployment-model-customer-deployed.md); review DEC-01

## Context

The portal began (M1) with a single shared dev token: anyone holding it could do anything. M3 replaced the token with verified OIDC/bearer identity but kept the same authorization level, now attributed to a real actor. Per-app RBAC (owner/editor/viewer) is scoped as a v1 feature.

## Decision

Any authenticated portal-audience principal may perform any mutating action on any app (archive, retarget, set password, grant origins) and manage any app's secrets. Reads are sign-in-gated (since `cba50cf`); admin-only screens are gated by `requireAdmin` on the configured `platform-admin` group claim. Per-app ownership checks are deferred to v1 RBAC.

## Consequences

- Simple and correct for the pilot, where the portal serves a single trusted operator.
- **The moment the portal serves more than one app owner, this contradicts the platform's per-app containment thesis** — any signed-in owner can mutate or read-manage another owner's app and secrets.
- The app-scoped **secrets** routes are the sharp edge of this gap.

## Open question

Land an `ownsApp` / ownership check on app-scoped mutating + secret routes before the portal is opened beyond a single operator. Decide whether the interim gate is "owner-only" or "platform-admin-only" until full RBAC lands.

## Review notes (2026-06-25)

A reviewer flagged this as Critical (BOLA/IDOR); verified it is the **documented** v0 model, not an accidental bug — hence Accepted-with-revisit rather than a defect. Tracked as DEC-01.

## Challenge outcome (2026-06-26)

WEAKEN — confirmed live and **filed as #9**. The app-scoped secrets routes (`secrets.ts` list/create/rotate/delete) perform **no** ownership check — any authenticated principal can rotate (pin attacker plaintext) or delete (DoS) another app's secrets. The "v1 RBAC effort" framing overstates the cost: `ownerId` already exists (`schema.prisma:49`) and the owner-or-admin idiom already ships (`approvals.ts:42-44`), so the interim gate is a ~3-line `ownsApp` preHandler on the secret + app-mutating routes. Make it an **M5 exit criterion** (test: a second operator cannot write another's app); handle nullable legacy `ownerId` (admin-only or backfill).

## Resolution (2026-07-24, #9 closed)

The `ownsApp` gate landed (`dc2aacf`; extended to the secrets *list* route in
`844a863`; #9 marked closed in `1701bdf`). `ownsApp` (`auth.ts:204`) allows the
request only if the actor is the app's **owner** (`app.ownerId === actor.sub`)
**or a platform-admin**, and it is enforced as a `preHandler` on every app-scoped
mutating + secret route (`secrets.ts`, `data.ts`, `versions.ts`, `apps.ts`).
Adversarial coverage in `ownership.test.ts` asserts a non-owner is rejected on
each. So the model is **no longer "authenticated == authorized"** for app-scoped
resources — it is owner-or-admin. The broad-mutation BOLA that #9 named is gone;
full owner/editor/viewer RBAC remains the v1 item.

## Access posture for customer-deployed installs (2026-07-24)

Under ADR [0028](0028-deployment-model-customer-deployed.md) the customer **runs**
the portal themselves — it is the control plane and the `azx-cli` target, so it
must be reachable by a (possibly remote) operator team. The infra therefore
exposes it as an **opt-in** flag, `portalExternal` (default **false** = internal
ingress, secure by default): when set, the portal is served at
`portal.<appsDomain>` on the public LB, **gated by Entra OIDC** (portal audience +
the `platform-admin` App Role) with per-app authz by `ownsApp`. The perimeter is
**identity + device posture** (Entra Conditional Access), not network location —
IP-allowlisting / bastions are deliberately avoided as they don't fit a remote
team. Pre-auth surface is the small Fastify/OIDC endpoint behind ACA ingress.
This is sound for a single trusted org (ADR-0023); revisit the pre-auth exposure
and add owner/editor/viewer RBAC before any multi-tenant / untrusted-owner use.
