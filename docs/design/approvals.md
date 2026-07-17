# AZX App Platform — Approvals (design doc)

**Status:** Design draft v1 · June 2026
**Companion to:** `platform-architecture.md` (the _what & why_; §5.1 names preview/promote, §6 the gateway), `platform-project-plan.md` (§5 v1 backlog items #2 capabilities + approvals, #4 CSP feedback loop, #6 public visibility), `app-data-storage.md` (the prior design doc this mirrors in shape), and the feature doc `docs/features/capabilities-and-manifests.md`.
**Why this exists:** Three separate v1 backlog items — capability-manifest approvals (#2), CSP origin grants (#4), and public-visibility mode (#6) — are the *same problem* wearing three hats. If we model them separately we build three half-overlapping mini-workflows that drift. This doc names the one shape under all three, proposes the data model + policy + state machine, and grounds it in the existing edge/portal trust split. It does **not** require building all three at once — it requires designing them so they share one spine.

> **Related ADRs:** [ADR-0016](../adr/0016-capability-manifest-approval-classifier.md) (approval classifier) · [ADR-0009](../adr/0009-relaxed-csp.md) (relaxed CSP) · [ADR-0014](../adr/0014-same-origin-api-gateway.md) (same-origin `/_api/*` gateway) · [ADR-0007](../adr/0007-portal-authz-v0.md) (portal authz v0).

---

## 1. The unifying insight: the edge stays dumb; approvals gate *writes*

All three concerns reduce to one sentence:

> **A privileged actor must bless a change to an app's effective policy before the edge will enforce it.**

The differences between them — which JSON field changes, how risky it is — are *data*, not structure. The load-bearing observation is how the edge already works (architecture §3, decision 12):

- The edge reads **only the live effective state** — the `apps.capabilities` JSON column plus the `visibilityMode` / `visibilityGroupId` columns — projected into an in-memory map via LISTEN/NOTIFY (`apps/edge/src/registry/projection.ts`, `registry/listener.ts`) and enforced at request time (`gateway/llm.ts` model allowlist + token budget, `gateway/data-handler.ts` data scopes, `auth/gate.ts` + `auth/validate.ts` visibility).
- The edge has **no notion of a "requested" or "pending" state**, and it should never grow one.

So the design is forced:

> **Approvals are a control-plane gate on *writes* to the effective state the edge already reads. The entire approvals system ships without touching `apps/edge`** — except the one genuinely-missing enforcement (`externalOrigins` → CSP, §6.2), which is an independent gap.

This is a real containment win: the most security-sensitive code (the trusted data plane) is untouched by the most policy-heavy feature. It also rules out the tempting "add a `capabilitiesRequested` column next to `capabilities`" approach, which (a) splits effective state two ways, (b) can't generalize across the three storage shapes (a JSON sub-field for capabilities, flat columns for visibility), and (c) can hold only one pending change at a time.

---

## 2. Data model: a typed request, applied on approval

One new table holds a structured, typed change. The `apps` row keeps **only effective state** — exactly as today. "Requested state" is just the set of open request rows for an app.

```prisma
model ApprovalRequest {
  id           String    @id @default(uuid()) @db.Uuid
  appId        String    @db.Uuid
  app          App       @relation(fields: [appId], references: [id], onDelete: Cascade)

  status       String    // pending | approved | denied | withdrawn | needs_changes
  risk         String    // low | med | high  — max risk across the deltas; stored for queue sort
  deltas       Json      // the *elevated* subset of a change: typed deltas (see §3)
  baseSnapshot Json      // effective values of the touched paths at request time (conflict detect + diff render)

  requestedBy  String    // actor.sub of the requester
  reason       String?   // requester's justification
  decidedBy    String?   // actor.sub of the admin who decided
  decisionNote String?   // reviewer note (required on deny / needs_changes)

  createdAt    DateTime  @default(now())
  decidedAt    DateTime?

  @@index([status, createdAt])   // the admin queue
  @@index([appId])               // the app-detail "pending" banner
  @@map("approval_requests")
}
```

**Apply-on-approve** (one portal transaction):

1. Re-classify `deltas` against *current* effective state — still elevated? (a baseline change may have moved the field meanwhile).
2. **Conflict check:** if any touched path's current effective value ≠ `baseSnapshot`, the diff is stale → flip to `needs_changes` with a note, don't apply (optimistic concurrency, §5).
3. Apply the `deltas` to the `apps` columns (`capabilities` JSON merge / `visibilityMode` set).
4. Set `status = approved`, `decidedBy`, `decidedAt`.
5. Write **two** audit events: the existing effective-mutation action (`app.manifest.set` / a new `app.visibility.set`) **and** an `approval.approve`.

The `apps` UPDATE trigger (`apps_registry_notify`) fires `pg_notify('helix_registry_changed', …)` on commit → the edge debounces and re-projects (`listener.ts`, 100 ms). **No edge code path knows an approval happened** — it just sees the effective row change, identically to a direct write today.

Approvals layer *on top of* the append-only `AuditEvent` table (`{appId, actor, action, metadata}`) — they don't replace it. The live audit read-side (`/api/v1/gateway/audit`, the portal Audit page) keeps working unchanged; approval lifecycle adds new `action` values (`approval.request`, `approval.approve`, `approval.deny`, `approval.withdraw`).

This is exactly the shape the mock UI already assumes — `PreviewApproval` carries `kind` / `risk` / `owner` / `diff: [key, from, to]` and Approve · Request-changes · Deny actions (`apps/portal-web/src/preview/previewData.ts`, `pages/admin/ApprovalsPage.tsx`). Building this turns those mocks real without redrawing them.

---

## 3. The classifier: baseline vs. elevated (the heart of it)

This is where the schema comment "grants above a baseline … require admin approval; that policy lives in the control plane, not in this shape" (`packages/shared/src/manifest.ts`) becomes code.

A **pure function in `@azx-pbc/shared`** — testable, and callable by the SPA to warn "this will need approval" *before* submit:

```
classifyChange(effective, requested) → {
  baselineDeltas: Delta[],   // apply immediately (within the PUT txn, as today)
  elevatedDeltas: Delta[],   // bundle into one ApprovalRequest
}
```

A `Delta` is a typed, path-keyed change: `{ path: "llm.tokensPerDay", from, to }`, `{ path: "mcp[+pagerduty]" }`, `{ path: "externalOrigins[+https://api.foo.com]" }`, `{ path: "visibility", from: "group", to: "public" }`. Each delta is classified independently; the elevated ones bundle into a single request (one per submission), the baseline ones commit now.

| Area | Baseline (applies immediately) | Elevated (becomes a request) | Risk |
|---|---|---|---|
| **LLM** | models ⊆ curated default set; `tokensPerDay ≤ BASELINE_TOKENS` | non-default models; budget above threshold | med |
| **data** | user store, collections, shared keys; writes/bytes ≤ thresholds | budgets above thresholds | low / med |
| **mcp** | empty (or a curated low-risk server allowlist) | any arbitrary MCP server | high |
| **externalOrigins** | empty | any origin added | med |
| **visibility** | private / group / password | **public** | **high** |

Two invariants keep this safe *and* non-annoying:

- **Reducing privilege is always baseline.** Removing a grant, shrinking a budget, public→private — never needs approval. Only *increases* gate.
- **Disjoint application.** Because we chose split semantics, a single `PUT /manifest` can both commit baseline deltas *and* open a request for the elevated ones. The route response tells the owner exactly which: `{ applied: [...], pending: <requestId> }`. The SPA shows the applied part live and a "pending approval" banner for the rest.

The threshold constants (`BASELINE_TOKENS`, write/byte ceilings, the default-model set, the low-risk MCP allowlist) are platform policy — they live beside the classifier in `@azx-pbc/shared` so portal-gating and SPA-preview read the identical numbers.

> **Bundling tradeoff (v1 choice):** one request per submission, even if it carries several elevated deltas of different kinds; the request's `risk` is the max across them; the reviewer approves/denies the bundle (or `needs_changes`). Per-delta partial approval is a deliberate future refinement, not v1 — it complicates the state machine for a rare case.

---

## 4. Authz: an admin role from a group claim

Approvals are meaningless without a privileged actor distinct from the requester — self-approval defeats the purpose. **Decision: gate on a group/role claim in the verified bearer token**, not an env allowlist. This is the more realistic posture and rides the mechanism the platform already uses for visibility (the IdP `groups` snapshot the edge keys group-visibility off).

Concretely:

- **Portal verifier** (`apps/portal/src/auth/verifier.ts`): extract the `groups` (or Entra `roles`) claim into a new `Actor.groups: string[]` field. Today `Actor` is `{ sub, via, name?, email? }` and drops group claims on the floor — this adds one field and one claim read; standard-claims-only verification is unchanged, so Entra tokens still validate (the doc's existing "Entra swap is env-only" promise holds).
- **Admin check:** membership in a configured admin group id (`PORTAL_ADMIN_GROUP_ID`). A `requireAdmin(req)` guard mirrors the existing `requireActor(req)`.
- **dev-idp** (`apps/dev-idp`): **already done.** Alice's fixture already carries `GROUP_PLATFORM_ADMINS` (`fixtures.ts`), and `extraTokenClaims` already emits `groups` into the JWT access token the portal verifies (`provider.ts`). No dev-idp change is needed — the claim is already on the wire; the portal just isn't reading it yet.
- **Separation of duty:** `decidedBy.sub ≠ requestedBy` enforced by default, with a `PORTAL_ALLOW_SELF_APPROVE` dev flag (refused in production, same posture as `PORTAL_DEV_TOKEN`) so a solo operator can drive the whole loop.

> **Prod note (no local blocker):** locally there is nothing to wire — dev-idp already ships the `platform-admin` claim. The only prod dependency is that the **Entra app registration surface a group or app-role claim** in its access token — config on the registration, deferred to the Entra tail (M3/M5), and it blocks *nothing* in local development of #2.

`App` needs an owner field for the admin queue's "owner" column and "who may request": add `App.ownerId` (= creator's `actor.sub`, set at `app.create`). Cheap, and several v1 surfaces want it anyway. _(Since built: `App.ownerId` now exists and is set at create — but note ADR-0007: v0 authz is still **flat** (authenticated == authorized). Any authenticated principal may mutate any app and manage any app's secrets; the app-scoped mutating + secret routes do **no `ownsApp` check**. That flatness is a deliberate v0 choice for the single-operator pilot, but the missing ownership check is a live BOLA/IDOR to close before M5, issue #9 — the `ownerId` above is already the hook for the interim owner-or-admin gate.)_

---

## 5. Lifecycle & concurrency

```
            request            approve
   (none) ─────────────▶ pending ─────────▶ approved   (deltas applied to apps row)
                          │  ▲      deny
                          │  │   ─────────▶ denied      (reason required)
                          │  │ needs_changes
                          │  └── ◀───────── (reviewer note; owner edits & resubmits)
                          │ withdraw
                          └──────────────▶ withdrawn    (requester cancels)
```

- **Who:** `pending → approved | denied | needs_changes` requires `requireAdmin` + separation-of-duty. `→ withdrawn` is the requester only. `needs_changes` is a soft bounce — the owner edits the manifest and resubmits (a fresh request; the old one stays `needs_changes` for the audit trail).
- **Concurrency (optimistic):** the request stores `baseSnapshot` of the touched paths. At approve time, if current effective ≠ snapshot for any path, the underlying value moved (a baseline write or another approval) → auto-flip to `needs_changes` rather than clobber. This is the split model's one sharp edge: baseline writes commit freely while a request is open, so the snapshot check is what keeps an approval from resurrecting a stale value. Cheap alternative if we want stricter: a monotonically-increasing `App.policyVersion` bumped on every effective write, compared at approve.
- **Idempotency:** approve/deny are guarded on `status = pending` (a second click is a no-op, not a double-apply).

---

## 6. The three concerns, mapped onto the spine

### 6.1 Capability changes (#2) — already enforced
The edge already enforces the model allowlist, token budget, and data scopes from the projected `capabilities`. So #2 is *purely* the write-gate: route `PUT /api/v1/apps/:slug/manifest` through `classifyChange`, commit baseline deltas (as today), open a request for elevated ones. The "v0 trusts any authenticated principal" comment in `routes/apps.ts` is the exact line that changes. **No edge work.**

### 6.2 CSP origin grants (#4) — the only one needing edge work
This is the most interesting because it exercises the whole loop *and* surfaces the one real edge gap:

1. App references `api.foo.com` → **deploy-time lint** already warns (`apps/portal/src/deploy/csp-lint.ts`). ✅ today
2. At runtime the static CSP blocks it → **edge `report-to` / `report-uri` sink** receives the violation. *(new — `serving/csp.ts` is static; the "report-to … is v1" comment marks this.)*
3. Portal stores the violation → the **Violations screen** (`pages/admin/ViolationsPage.tsx`, currently a mock) surfaces it as one-click **"request this origin."**
4. That mints an `ApprovalRequest` with an `externalOrigins[+…]` delta (med risk) → admin approves → `capabilities.externalOrigins` updated via the §2 path.
5. Projection fires → **the edge reads `externalOrigins` and widens that app's CSP** `connect-src` / `img-src`. *(new — the second edge gap.)*

So origin grants need **two small additions inside the trusted edge** that the other two concerns don't: the report sink (step 2) and `externalOrigins`→CSP (step 5). Both are within the edge dependency budget (no new packages) and should be designed now, built with #4. Everything between — the request, the queue, the approval — is the shared spine.

### 6.3 Public visibility (#6) — free once the spine exists
Going public is just a request: `{ deltas: [{ path: "visibility", from: "group", to: "public" }], risk: "high" }`. The edge already short-circuits the session gate for `visibilityMode === "public"` (`auth/gate.ts`) — no edge change. #6's only *new* edge work is the **anonymous-tier per-IP limits** (deferred knob noted in `data-handler.ts`), which is orthogonal to approvals. The approval half is one classifier rule + one risk level, already in the §3 table.

---

## 7. What actually has to change, by surface

| Surface | Change | Backlog item |
|---|---|---|
| `@azx-pbc/shared` | `classifyChange` + policy thresholds; `ApprovalRequest`/`Delta` zod types | #2 |
| `apps/portal` schema | `ApprovalRequest` table; `App.ownerId`; `Actor.groups` | #2 |
| `apps/portal` routes | write-gate on `PUT /manifest` + visibility; `GET/POST /api/v1/approvals*`; `requireAdmin` | #2 |
| `apps/portal-web` | turn **Approvals** mock real; "pending" banner on app detail | #2 |
| `apps/dev-idp` | _nothing_ — already emits `platform-admin` in the access token | — |
| **`apps/edge`** | `report-to` sink; read `externalOrigins` → per-app CSP | **#4 only** |
| `apps/portal` + web | store CSP reports; turn **Violations** mock real → origin-grant requests | #4 |
| `apps/edge` | anonymous-tier per-IP limits (orthogonal to approvals) | #6 |

**The whole of #2 and #6's approval half touches zero edge code.** Only #4 reaches into the trusted path, and only for the two CSP additions.

---

## 8. Suggested phasing (matches the backlog order)

1. **Spine + capabilities + go-public** (backlog #2, pulls #6's approval half along for free): the `ApprovalRequest` table, `classifyChange` in shared, `Actor.groups` + `requireAdmin` + dev-idp admin fixture, `App.ownerId`, the write-gate chokepoint, and the real Approvals queue. At the end of this, capability increases *and* public visibility both flow through one table.
2. **CSP loop** (backlog #4): the edge `report-to` sink + `externalOrigins`→CSP enforcement, and the real Violations screen feeding origin-grant requests into the phase-1 table.

Anonymous per-IP limits (#6) and audit-to-blob (#8) are independent and can land whenever.

---

## 9. Open questions / deliberately deferred

- **Per-delta partial approval** — deferred; v1 approves/denies the whole submission bundle (§3).
- **`needs_changes` as edit-in-place vs. resubmit** — proposed resubmit (old row frozen for audit); revisit if reviewers want a threaded back-and-forth.
- **Notifications** — who gets told when a request is filed / decided? Out of scope here; the queue is pull-based for v1.
- **MCP grant enforcement** — the classifier treats any MCP server as high-risk elevated, but MCP-as-a-capability isn't enforced at the edge yet (v1.x, architecture §12). Approving an MCP grant writes the manifest; enforcement lands with the MCP gateway.
