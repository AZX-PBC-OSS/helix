-- Envelope ciphertext can exceed PostgreSQL's btree entry limit. Index only its
-- fixed-size digest; keep the full material for idempotent destruction.
ALTER TABLE service_oauth_retirements DROP CONSTRAINT IF EXISTS service_oauth_retirements_pkey;
ALTER TABLE service_oauth_retirements ADD COLUMN "materialHash" BYTEA;
UPDATE service_oauth_retirements SET "materialHash" = sha256(convert_to(material, 'UTF8'));
ALTER TABLE service_oauth_retirements ADD PRIMARY KEY ("materialHash");

CREATE OR REPLACE FUNCTION service_oauth_retire() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.access IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.access IS DISTINCT FROM NEW.access) THEN
    INSERT INTO public.service_oauth_retirements("materialHash", material)
      VALUES (sha256(convert_to(OLD.access, 'UTF8')), OLD.access) ON CONFLICT DO NOTHING;
  END IF;
  IF OLD.refresh IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.refresh IS DISTINCT FROM NEW.refresh) THEN
    INSERT INTO public.service_oauth_retirements("materialHash", material)
      VALUES (sha256(convert_to(OLD.refresh, 'UTF8')), OLD.refresh) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

-- Only the owner-run rotation trigger and FK cascades delete token state.
REVOKE DELETE ON service_oauth_tokens FROM helix_egress;

-- Earlier approvals also pinned static recipes. Preserve OAuth fences, including
-- deleted identities whose former recipe cannot be determined.
DELETE FROM secret_connection_bindings b USING app_secrets s
WHERE b."secretId" = s.id AND s.injection->>'kind' <> 'oauth-service-account';
