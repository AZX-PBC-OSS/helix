-- Dev-mode design §5.3 (review hardening) — narrow the dev-gateway's registry
-- read to non-secret columns. The prior migration granted helix_dev a table-wide
-- SELECT on `apps`, which drags in the `password*` credential columns
-- (passwordHash/passwordSalt/passwordEnc) — readable by the internet-facing
-- dev-gateway's role for EVERY prod app, contradicting "a compromise here can't
-- touch a prod secret". `apps`/`versions` are env-agnostic (no `env` column), so
-- the fix is column scope, not RLS: grant only the columns the dev registry
-- projection needs to route `/_api/*` (slug, visibility, capabilities, the
-- version-pointer join). The dev projection selects NULL for the password columns
-- (registry/projection.ts, `includePasswords: false`), so it touches none of them.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'helix_dev') THEN
    REVOKE SELECT ON apps FROM helix_dev;
    GRANT SELECT (
      id, slug, "visibilityMode", "visibilityGroupId", capabilities,
      "archivedAt", "currentVersionId"
    ) ON apps TO helix_dev;
    -- versions holds no secrets; a table-wide read is fine (the projection joins
    -- v.id / v."blobPrefix").
    GRANT SELECT ON versions TO helix_dev;
  END IF;
END $$;
