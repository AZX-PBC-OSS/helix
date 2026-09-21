-- Admin session revocation (portal Sessions screen) — least-privilege carve-out.
--
-- The portal now READS live `sessions` rows (the admin list) and DELETEs them
-- (the user-level revoke). Those are the only two operations the control plane
-- has ever needed on this table: it never mints, refreshes or rebinds a
-- session — the edge is the sole writer of sessions (ADR-0002's "edge-owned
-- data" framing), and the handoff's atomic redeem UPDATE must stay edge-only
-- by grant, not just by convention, so a portal bug or RCE cannot forge or
-- rebind a session credential.
--
-- Precedent: this is the same carve-out mechanism as migration
-- 20260721120000 (which revoked helix_portal's UPDATE/DELETE on gateway_calls
-- to make the ledger append-only for every runtime role). The bootstrap
-- default (db-init/01-roles.sql, Terraform in prod) grants helix_portal full
-- DML on ALL TABLES; migrations are where the exceptions live, so this file is
-- the boundary and role-split.integration.test.ts is what holds it.
--
-- What remains, deliberately:
--   SELECT — the admin list.
--   DELETE — the revoke; it rides the existing `sessions_portal_all` RLS
--            policy (TO helix_portal USING (true), migration
--            20260721035543), which was left permissive for exactly this
--            future ("so a future portal read isn't silently scoped to zero
--            rows").
-- What goes: INSERT and UPDATE. Neither has a caller; both are dangerous —
-- INSERT could mint a session for any app/user, UPDATE could rebind a
-- tokenHash (i.e. steal a session by pointing the row at an attacker's cookie
-- hash) or resurrect an expired one.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    REVOKE INSERT, UPDATE ON sessions FROM helix_portal;
  END IF;
END $$;
