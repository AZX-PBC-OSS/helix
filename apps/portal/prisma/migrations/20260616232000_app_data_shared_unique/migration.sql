-- App-data design §3.3 — shared keys (userOid IS NULL) need their own
-- uniqueness. The model's @@unique([appId, userOid, key]) does NOT enforce it
-- for shared rows: Postgres treats NULLs as distinct in a unique index, so two
-- shared rows with the same (appId, key) would both be allowed and putShared's
-- upsert would never fire. A partial unique index closes that — and gives the
-- edge's `ON CONFLICT ("appId", key) WHERE "userOid" IS NULL` a target.
--
-- Raw migration (Prisma can't express a partial unique index in the schema),
-- same precedent as the registry_notify_trigger migration.
CREATE UNIQUE INDEX "app_data_shared_key" ON "app_data" ("appId", "key") WHERE "userOid" IS NULL;
