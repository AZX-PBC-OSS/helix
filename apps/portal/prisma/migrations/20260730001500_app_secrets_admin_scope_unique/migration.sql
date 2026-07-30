-- Secrets design §5 — the admin-managed scopes ('global', 'platform') carry
-- appId IS NULL, and Postgres treats NULLs as distinct in a unique index, so the
-- model's @@unique([appId, env, name]) does NOT constrain them at all. Uniqueness
-- was enforced only in application code, as a non-atomic findFirst-then-create.
--
-- That race is not merely a duplicate row. `seal()` writes the credential to Key
-- Vault *before* the DB insert, so two concurrent admin POSTs both create a vault
-- entry and only one gets referenced. The loser is live plaintext under a
-- deliberately opaque random name, with nothing to correlate it back to an app or
-- secret name, unpurgeable for 90 days under purge protection — and invisible in
-- dev, where destroy() is a no-op and material is the ciphertext in the row.
--
-- With this index the insert raises P2002, the route's rollback releases the vault
-- entry, and the behaviour matches the app-scoped twin that already had it.
--
-- Raw migration (Prisma can't express a partial unique index in the schema), same
-- precedent as 20260616232000_app_data_shared_unique.
CREATE UNIQUE INDEX "app_secrets_admin_scope_name_key"
  ON "app_secrets" ("scope", "env", "name") WHERE "appId" IS NULL;
