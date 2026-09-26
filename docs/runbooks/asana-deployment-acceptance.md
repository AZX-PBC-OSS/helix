# Asana deployment acceptance — the I-02 exercise record

**Status: PENDING — this exercise has not been performed.** It is I-02
T-0034, the execution and record of spec criterion 55: the deployment
acceptance that fixtures cannot substitute for. This file is the checklist
the operator fills in while performing it; until every observation below is
filled with observed fact, the record makes no claim.

The prerequisite configuration steps live in
[`connection-provider-rollout.md`](./connection-provider-rollout.md); the
feature behavior is
[`docs/features/connection-providers.md`](../features/connection-providers.md).
Record observed behavior and configuration prerequisites only — **no
credentials, tokens, or secret-bearing tenant identifiers** (criterion 55;
the security concern's secrets-hygiene rule).

## Prerequisites

- [ ] The deployed platform carries the I-02 topology: the delegated-custody
      vault provisioned (T-0004) with egress as its only Secrets Officer, and
      the two internal secrets (`helix-internal-secret`,
      `helix-exchange-secret`) present in kv-platform.
- [ ] A real Asana app registered out-of-band with the platform's fixed
      callback (`https://auth.<base>/connections/callback`). Record the
      registration steps actually required, not the ones documented from
      memory.
- [ ] The provider configured through the portal admin UI, in the `prod`
      environment, with the scopes the exercise needs. Record the scope
      names granted.
- [ ] Organization allowlisting set as the operator docs describe (if Asana
      requires it for the registration kind used).

## The exercise (criterion 55's list)

Perform in order; record observed vendor behavior under each step. Where
Asana's documented behavior ([developers.asana.com/docs/oauth](https://developers.asana.com/docs/oauth))
differs from what happens, record the difference as observed fact — the
rotation-behavior question (research.md §Gaps, question 10) is exactly what
this step answers.

1. **Connect** — a real user connects through an approved hosted app's
   explicit Connect action; the popup completes.
   - Observed: _(fill in — redirect shape, consent screen, timing)_
2. **Delegated call** — the app makes a delegated API call that succeeds with
   the user's token in the configured placement.
   - Observed: _(fill in)_
3. **Renewal** — demonstrate renewal (arrange an expired access token), and
   record the observed rotation behavior: Asana issued a replacement refresh
   token, or omitted one (retain semantics).
   - Observed: _(fill in — this is the open question the fixtures could not
     answer)_
4. **Disconnect** — disconnect in My Connections; the next Helix use of that
   connection is refused (`connection_required`).
   - Observed: _(fill in)_

## Findings

- Defects observed (filed against the owning ticket, not fixed in passing):
  _(fill in or "none")_
- Deviations between documented and actual vendor behavior: _(fill in or
  "none")_
- Date completed and by whom: _(fill in)_
