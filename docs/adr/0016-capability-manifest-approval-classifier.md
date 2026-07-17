# 0016. Capability manifest + baseline/elevated approval classifier

**Status:** Accepted _(recorded retroactively 2026-06-26 — coverage audit; shipped in M4)_
**Related:** `docs/design/approvals.md`; `docs/features/capabilities-and-manifests.md`; ADR [0007](0007-portal-authz-v0.md); `packages/shared/src/approval.ts` (`classifyChange`); `apps/portal/src/routes/approvals.ts`

## Context

Untrusted apps acquire capabilities (LLM models, token budgets, proxied fetch origins, visibility, MCP servers). Granting these needs governance — but the public-facing **edge must stay ignorant of pending approvals** (it only reads effective state), and routine self-service changes must not require a human for everything.

## Decision

Each app carries a **capability manifest**. The portal's `classifyChange` (a pure function in `@azx-pbc/shared`) splits a requested manifest change into:

- **Baseline deltas** — committed immediately (including any privilege *reduction*).
- **Elevated deltas** — a non-curated LLM model, a budget above threshold, a new proxied origin, a secret-bound origin, going `public`, any MCP server — bundled into a pending `ApprovalRequest` and applied **only** on platform-admin approval.

The `apps` row holds only the **effective** state, so the edge never sees a pending change. An optimistic-concurrency `baseSnapshot` guards against lost updates. This one classifier spine governs capabilities, CSP origins, and visibility.

## Consequences

- The edge is dumb about governance; all policy lives in the control plane.
- Privilege reductions are free; increases gate — the safe default.
- Who *may* approve is ADR-0007 (v0: any authenticated principal; → owner/admin gate); this ADR is the *classification* model, independent of that.
- Reshaping the classifier (e.g. to policy-as-code, or per-org policy) is a multi-surface change — it is the platform's governance contract.
