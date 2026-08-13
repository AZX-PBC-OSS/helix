# 0039. Pending approval requests do not expire

**Status:** Accepted _(recorded 2026-08-13 — issue #27)_
**Related:** `docs/design/approvals.md` (§5 lifecycle); ADR [0016](0016-capability-manifest-approval-classifier.md) (the classifier this governs); `apps/portal/prisma/schema.prisma` (`ApprovalRequest`); `apps/portal/src/routes/approvals.ts`

## Context

An `ApprovalRequest` filed today and never decided stays `pending` forever: there is no `expiresAt` column, no sweep, no startup job, and no timer-driven transition in the §5 state machine. It keeps showing on the app-detail banner and in the admin queue indefinitely.

That absence reads as an oversight rather than a choice, because the two neighbouring tables both *do* expire — `Session` and `AppDevToken` each carry an `expiresAt`. Someone comparing the models reasonably concludes approvals forgot one, and re-files the question. It has been asked once already.

## Decision

**Explicit non-goal: approval expiry.** A pending request stays pending until a *human* decides it — approve, deny, `needs_changes`, or withdraw by the requester. We are not adding an `expiresAt` column, a sweep job, or an auto-close transition unless someone asks for one with a concrete need.

What we are declining to build is the obvious version: a TTL on the row plus a periodic job that flips lapsed requests to `expired` (or deletes them), sold as queue hygiene. It is declined because the problem it solves is not a platform problem. A long queue means requests are not being reviewed, which is a staffing and ownership question; auto-closing them makes the queue shorter without anyone having reviewed anything, so it removes the *signal* rather than the backlog.

The safe-by-default reflex that makes expiry feel right for sessions and tokens does not transfer here — see the first two consequences.

## Consequences

- **A request is not a credential, so there is no security clock.** An unexpired session is standing access; an unexpired approval request is a standing *question*. Nothing is granted while it sits there. Letting it lapse silently would be strictly worse than leaving it visible: it converts an unanswered question into an implicit "no" that no one recorded and no one can audit.
- **Safety at approve time comes from `baseSnapshot`, not from age.** The conflict check in `apps/portal/src/routes/approvals.ts` (ADR-0016) compares each touched path's current effective value against the snapshot taken at request time; a request whose underlying value has moved auto-flips to `needs_changes` rather than applying a stale value. A six-month-old request is therefore no more dangerous to approve than a six-minute-old one — it is just more likely to bounce.
- **Age is surfaced instead of enforced.** The admin queue shows how long each request has been pending and sorts oldest-first, so a stale request becomes *more* visible over time rather than drifting to the bottom of a newest-first list. That addresses the real failure mode — requests quietly stopping being looked at — without adding a lifecycle state.
- **Unbounded row growth on `approval_requests` is accepted.** At approvals volume it is not a meaningful cost, and rows are cascade-deleted with their `App`. Revisit only if the table becomes a real operational problem, which is a retention decision, not an expiry one.
- **The tripwire.** If expiry is ever built, it must be a conscious re-decision — an explicit ask, naming what should happen to a lapsed request and why silence should count as a decision — not drift from someone noticing the missing column and adding it for symmetry with `Session`. Recording it here is what makes that a re-decision.
