-- T-0007 (I-02) — the connection data substrate, in ONE migration so no partial
-- state can exist (explore.md §Gaps): the provider catalog, the per-user
-- connections, and the control-plane-owned consent-flow table, plus the
-- ADR-0006 part-2 grant block, the env-literal RLS partition (first commit),
-- and ADR-0011's NOTIFY trigger.
--
-- Column conventions follow AppSecret (camelCase, UUID surrogate ids,
-- TIMESTAMP(3), sealed `*Material` columns). Deliberate absences:
--   * no FK from user_connections / connection_consent_attempts to
--     connection_providers — provider deletion invalidates those rows (status
--     flips portal-side in the same transaction) but leaves them dangling
--     against a nonexistent id; delete+recreate under the same ref mints a new
--     id and restores nothing (ADR-0004). The GatewayCall→App precedent: the
--     referencing rows outlive the referenced one by design.
--   * no appId on user_connections — a connection is platform-wide
--     (userOid, providerId, env), reused by every approved app (Q2/Q10).
--
-- Roles are created by .devcontainer/db-init/01-roles.sql (dev) / Terraform
-- (prod), never by migrations; every grant/policy below is guarded by a
-- pg_roles existence check (the fail-soft stance of the other grant
-- migrations — on a cluster without the runtime roles this is a clean no-op,
-- and the superuser owner bypasses RLS regardless).

-- CreateTable
CREATE TABLE "connection_providers" (
    "id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "authorizeEndpoint" TEXT NOT NULL,
    "tokenEndpoint" TEXT NOT NULL,
    "requestedScopes" JSONB NOT NULL,
    "apiOrigins" JSONB NOT NULL,
    "tokenPlacement" JSONB NOT NULL,
    "env" TEXT NOT NULL DEFAULT 'prod',
    "clientIdMaterial" TEXT NOT NULL,
    "clientSecretMaterial" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connection_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_connections" (
    "id" UUID NOT NULL,
    "userOid" TEXT NOT NULL,
    "providerId" UUID NOT NULL,
    "providerRevision" INTEGER NOT NULL,
    "env" TEXT NOT NULL DEFAULT 'prod',
    "status" TEXT NOT NULL,
    "material" TEXT NOT NULL,
    "grantedScopes" JSONB NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "renewBeforeNext" BOOLEAN NOT NULL DEFAULT false,
    "pendingRetire" TEXT,
    "lastRenewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_consent_attempts" (
    "id" UUID NOT NULL,
    "state" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "userOid" TEXT NOT NULL,
    "providerId" UUID NOT NULL,
    "providerRevision" INTEGER NOT NULL,
    "appId" UUID NOT NULL,
    "env" TEXT NOT NULL DEFAULT 'prod',
    "openerOrigin" TEXT NOT NULL,
    "nonce" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connection_consent_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connection_providers_ref_env_key" ON "connection_providers"("ref", "env");

-- CreateIndex
CREATE UNIQUE INDEX "user_connections_userOid_providerId_env_key" ON "user_connections"("userOid", "providerId", "env");

-- CreateIndex
CREATE INDEX "user_connections_pendingRetire_idx" ON "user_connections"("pendingRetire");

-- CreateIndex
CREATE UNIQUE INDEX "connection_consent_attempts_state_key" ON "connection_consent_attempts"("state");

-- CreateIndex
CREATE UNIQUE INDEX "connection_consent_attempts_nonce_key" ON "connection_consent_attempts"("nonce");

-- CreateIndex
CREATE INDEX "connection_consent_attempts_expiresAt_idx" ON "connection_consent_attempts"("expiresAt");

-- 1) Partition-label CHECKs — same hardening 20260722204543_env_check_constraints
-- added to the other env-partitioned tables: `env` is a security-partition
-- label the RLS policies key off, so an off-value row would be orphaned —
-- invisible to every policy yet visible to a permissive pass. Fail fast
-- regardless of writer.
--
-- user_connections.status gets the same treatment for its vocabulary: the
-- @azx-pbc/shared CONNECTION_STATUSES enum is the single definition every
-- writer parses (ADR-0006 §Shared ground); the CHECK makes an unknown status
-- fail closed at the lowest level too, so no writer can invent a fourth state.
ALTER TABLE "connection_providers" ADD CONSTRAINT "connection_providers_env_check" CHECK ("env" IN ('prod', 'dev'));
ALTER TABLE "user_connections" ADD CONSTRAINT "user_connections_env_check" CHECK ("env" IN ('prod', 'dev'));
ALTER TABLE "connection_consent_attempts" ADD CONSTRAINT "connection_consent_attempts_env_check" CHECK ("env" IN ('prod', 'dev'));
ALTER TABLE "user_connections" ADD CONSTRAINT "user_connections_status_check" CHECK ("status" IN ('live', 'reconnect-needed', 'invalidated'));

-- 2) Env-literal RLS on every table, first commit (ADR-0006 part 2; dev-mode
-- §5.3's pattern, migration 20260722192440). FORCE so even a non-superuser
-- owner runs through the policies. The two data-plane roles get the env
-- LITERAL policies — helix_edge pinned to 'prod', helix_dev to 'dev' — inert
-- today because neither role holds any grant on these tables (that grant
-- absence, asserted by the role-split suite, is the containment; the literal
-- policy is the second layer that already stands if a future migration ever
-- grants a verb). helix_portal operates cross-env by design (provider CRUD in
-- both tiers, My Connections listing both), helix_egress likewise (resolution
-- is keyed (userOid, providerId, env) by the VERIFIED attested instruction —
-- the same letter app_secrets' no-RLS docblock records), so both get a
-- permissive pass; no literal can pin a role that legitimately serves both
-- tiers, and their env scoping is enforced by grant shape + instruction
-- signature, not by a spoofable GUC.
ALTER TABLE "connection_providers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_providers" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "user_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_connections" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "connection_consent_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connection_consent_attempts" FORCE  ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_edge') THEN
    CREATE POLICY connection_providers_edge_prod ON connection_providers
      TO helix_edge USING ("env" = 'prod') WITH CHECK ("env" = 'prod');
    CREATE POLICY user_connections_edge_prod ON user_connections
      TO helix_edge USING ("env" = 'prod') WITH CHECK ("env" = 'prod');
    CREATE POLICY connection_consent_attempts_edge_prod ON connection_consent_attempts
      TO helix_edge USING ("env" = 'prod') WITH CHECK ("env" = 'prod');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    CREATE POLICY connection_providers_dev_only ON connection_providers
      TO helix_dev USING ("env" = 'dev') WITH CHECK ("env" = 'dev');
    CREATE POLICY user_connections_dev_only ON user_connections
      TO helix_dev USING ("env" = 'dev') WITH CHECK ("env" = 'dev');
    CREATE POLICY connection_consent_attempts_dev_only ON connection_consent_attempts
      TO helix_dev USING ("env" = 'dev') WITH CHECK ("env" = 'dev');
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_egress') THEN
    -- The mechanism plane serves both tiers (the instruction's env selects);
    -- no env literal can pin it. Its reach is bounded by the grant block below.
    CREATE POLICY connection_providers_egress_all ON connection_providers
      TO helix_egress USING (true) WITH CHECK (true);
    CREATE POLICY user_connections_egress_all ON user_connections
      TO helix_egress USING (true) WITH CHECK (true);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    -- The control plane operates cross-env (criterion 5 keeps the tiers
    -- separate; the administrator works in both) under FORCE RLS.
    CREATE POLICY connection_providers_portal_all ON connection_providers
      TO helix_portal USING (true) WITH CHECK (true);
    CREATE POLICY user_connections_portal_all ON user_connections
      TO helix_portal USING (true) WITH CHECK (true);
    CREATE POLICY connection_consent_attempts_portal_all ON connection_consent_attempts
      TO helix_portal USING (true) WITH CHECK (true);
  END IF;
END $$;

-- 3) Grants — the ADR-0006 part-2 matrix, exactly. The CONTAINMENT is the
-- asymmetry, and it is the strictest role split the platform has:
--
--   helix_edge  : NOTHING on any of the three tables. The edge consults the
--                 portal over HTTP (ADR-0002) — an edge RCE reaches no
--                 provider row, no user's connection, no consent-flow state.
--   helix_egress: SELECT on connection_providers (opens the sealed client
--                 credentials, builds the vendor client per revision);
--                 SELECT + narrowly-scoped UPDATE on user_connections (the
--                 renewal writer — material swap, expiry, granted scopes, the
--                 status the renewal outcome records, the ADR-0008
--                 renewal/retirement ledger fields, and criterion 40's
--                 renew-before-next flag); NOTHING on the flow table.
--                 Advisory-lock functions (ADR-0007) need no table grant.
--   helix_portal: full DML on all three — the control-plane CRUD, the
--                 callback's CAS upsert, invalidation, disconnect, the sweep.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_egress') THEN
    GRANT SELECT ON connection_providers TO helix_egress;
    GRANT SELECT ON user_connections TO helix_egress;
    -- Column-scoped: enumerates the renewal writer's exactly-narrow surface.
    -- The column list is asserted by role-split.integration.test.ts — an
    -- UPDATE touching anything else must fail. Identity (userOid, providerId,
    -- providerRevision, env), the key (id) and provenance (grantedAt,
    -- createdAt) are deliberately absent: only the portal may set those.
    GRANT UPDATE (
      "material", "expiresAt", "grantedScopes", "status",
      "renewBeforeNext", "pendingRetire", "lastRenewedAt"
    ) ON user_connections TO helix_egress;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_portal') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON connection_providers, user_connections, connection_consent_attempts
      TO helix_portal;
  END IF;
END $$;

-- 4) Provider-config distribution (ADR-0011) — a statement-level NOTIFY
-- trigger on provider mutations pings egress's revision-keyed cache; egress is
-- the channel's only listener (the edge holds no provider rows and listens to
-- nothing new; the portal does not cache its own table). The channel name is
-- constant-defined once as PROVIDERS_CHANNEL in @azx-pbc/shared
-- (packages/shared/src/connections.ts); this migration embeds the same literal
-- — the registry channel's keep-in-sync convention
-- (apps/edge/src/registry/listener.ts duplicates 'helix_registry_changed').
--
-- Statement-level: the cache reconciles from current state, so one ping per
-- statement is enough. NOTIFY delivers on COMMIT, so the listener never sees
-- uncommitted state (the role-split suite asserts exactly that).
CREATE OR REPLACE FUNCTION helix_providers_notify() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('helix_providers_changed', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;

CREATE TRIGGER connection_providers_notify
AFTER INSERT OR UPDATE OR DELETE ON connection_providers
FOR EACH STATEMENT EXECUTE FUNCTION helix_providers_notify();
