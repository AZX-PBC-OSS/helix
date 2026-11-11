-- Keep material-only inserts working during a rolling egress upgrade, and make
-- the database derive the key rather than trusting a caller-supplied digest.
CREATE FUNCTION service_oauth_retirement_key() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  NEW."materialHash" := sha256(convert_to(NEW.material, 'UTF8'));
  RETURN NEW;
END $$;
CREATE TRIGGER service_oauth_retirement_key
BEFORE INSERT OR UPDATE OF material ON service_oauth_retirements
FOR EACH ROW EXECUTE FUNCTION service_oauth_retirement_key();
REVOKE ALL ON FUNCTION service_oauth_retirement_key() FROM PUBLIC;
