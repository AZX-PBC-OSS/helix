-- ADR-0021 (challenge outcome, issue #17) — make `gateway_calls` append-only for
-- EVERY writer role, not just the edge.
--
-- `helix_edge` is already INSERT+SELECT only (20260616000001_edge_role_grants),
-- so the edge cannot rewrite metering/audit history. But `helix_portal` was
-- granted full DML on `gateway_calls` (same migration, line 30-31; and the
-- blanket `ON ALL TABLES` grant in db-init/01-roles.sql), which means the
-- control-plane role — or a portal RCE — could UPDATE or DELETE ledger rows.
-- That contradicts ADR-0021's "append-only by grant" decision (integrity rests
-- on the grant set, not a hash chain) and the schema.prisma comment claiming the
-- portal "never writes" these rows.
--
-- The portal only ever READS this table (apps/portal/src/routes/usage.ts —
-- `gatewayCall.findMany`); no runtime path inserts, updates, or deletes. So we
-- reduce helix_portal to SELECT only, aligning the grant with the documented
-- contract. This closes the append-only-by-grant gap; it is NOT tamper-evidence
-- (the schema owner / migration role can still write as owner or re-GRANT) —
-- hash chain + Merkle + external anchoring remains the deferred fast-follow
-- (TODO.md, ADR-0021 consequence 1).
--
-- Guarded by a role-existence check like the other grant migrations: on a
-- cluster whose bootstrap never created the runtime roles (some CI setups) this
-- is a clean no-op. Migrations run AFTER db-init on every cluster bring-up, so
-- this REVOKE is the last word even on a freshly-initialized dev volume.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    REVOKE INSERT, UPDATE, DELETE ON gateway_calls FROM helix_portal;
  END IF;
END $$;
