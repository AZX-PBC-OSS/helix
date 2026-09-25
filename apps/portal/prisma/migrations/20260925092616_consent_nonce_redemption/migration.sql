-- T-0016 (I-02) — the dev journey's single-use nonce redemption marker.
--
-- The nonce entry page (auth host, portal-served through the `/connections/*`
-- proxy) redeems the dev consult's handoff nonce with ONE conditional UPDATE:
-- `nonceRedeemedAt` is both the claim and the record, so exactly one
-- concurrent redemption can ever win and a replayed popup URL is refused
-- after first use (the indivisible claim rule). The row itself survives —
-- the callback still redeems the attempt by `state` — until claim, expiry,
-- or the sweep, all unchanged.
--
-- No grant change: `helix_portal` already holds full DML on the table, and
-- the data-plane roles hold none (ADR-0006 part 2 — asserted by
-- role-split.integration.test.ts).

ALTER TABLE "connection_consent_attempts" ADD COLUMN "nonceRedeemedAt" TIMESTAMP(3);
