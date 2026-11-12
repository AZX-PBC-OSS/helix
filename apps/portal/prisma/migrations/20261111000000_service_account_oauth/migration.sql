ALTER TABLE app_secrets ADD COLUMN "credentialGeneration" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE service_oauth_tokens (
  "secretId" UUID PRIMARY KEY REFERENCES app_secrets(id) ON DELETE CASCADE,
  "credentialGeneration" INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  access TEXT,
  refresh TEXT,
  "expiresAt" TIMESTAMP(3),
  status TEXT NOT NULL DEFAULT 'unconfigured',
  "retryAfter" TIMESTAMP(3),
  attempt UUID,
  CHECK (status IN ('unconfigured', 'ready', 'recovering', 'temporary_failure', 'needs_attention'))
);
-- No FK to the secret: deleting it must not erase its cleanup ledger or approval fence.
CREATE TABLE service_oauth_retirements (
  material TEXT PRIMARY KEY,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE secret_connection_bindings (
  "appId" UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  name TEXT NOT NULL,
  env TEXT NOT NULL,
  "secretId" UUID NOT NULL,
  PRIMARY KEY ("appId", origin, name, env)
);

CREATE FUNCTION service_oauth_retire() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.access IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.access IS DISTINCT FROM NEW.access) THEN
    INSERT INTO public.service_oauth_retirements(material) VALUES (OLD.access) ON CONFLICT DO NOTHING;
  END IF;
  IF OLD.refresh IS NOT NULL AND (TG_OP = 'DELETE' OR OLD.refresh IS DISTINCT FROM NEW.refresh) THEN
    INSERT INTO public.service_oauth_retirements(material) VALUES (OLD.refresh) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER service_oauth_retire AFTER UPDATE OR DELETE ON service_oauth_tokens
FOR EACH ROW EXECUTE FUNCTION service_oauth_retire();
REVOKE ALL ON FUNCTION service_oauth_retire() FROM PUBLIC;

CREATE FUNCTION service_oauth_rotate() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.material IS DISTINCT FROM NEW.material THEN
    NEW."credentialGeneration" := OLD."credentialGeneration" + 1;
    DELETE FROM public.service_oauth_tokens WHERE "secretId" = OLD.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_oauth_rotate BEFORE UPDATE OF material ON app_secrets
FOR EACH ROW EXECUTE FUNCTION service_oauth_rotate();
REVOKE ALL ON FUNCTION service_oauth_rotate() FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE, DELETE ON service_oauth_tokens TO helix_egress;
GRANT SELECT, INSERT, DELETE ON service_oauth_retirements TO helix_egress;
GRANT SELECT ON secret_connection_bindings TO helix_egress;
GRANT SELECT, INSERT, UPDATE, DELETE ON secret_connection_bindings TO helix_portal;
-- Portal serves status only; issued token references stay in the mechanism plane.
REVOKE ALL ON service_oauth_tokens, service_oauth_retirements FROM helix_portal;
GRANT SELECT ("secretId", status, "expiresAt", "retryAfter") ON service_oauth_tokens TO helix_portal;
