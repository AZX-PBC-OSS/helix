-- Dev-mode design §5 (review hardening) — constrain the `env` partition label to
-- its two valid tiers at the database level. `env` is a security-partition label:
-- the env-literal RLS policies key off it, so a row written with an off-value
-- (e.g. 'DEV', 'staging') would be orphaned — invisible to BOTH env-literal
-- runtime roles (helix_edge='prod', helix_dev='dev') yet visible to helix_portal's
-- permissive policy. A CHECK closes that: any write outside {'prod','dev'} fails
-- fast regardless of the writer (owner SQL, Prisma, future control-plane code) —
-- the TS `Env` type only guards the edge. Existing rows are all 'prod' (the column
-- default from 20260722192440_dev_env_partition), so validation passes.
ALTER TABLE "app_data"             ADD CONSTRAINT "app_data_env_check"             CHECK ("env" IN ('prod', 'dev'));
ALTER TABLE "app_collection_items" ADD CONSTRAINT "app_collection_items_env_check" CHECK ("env" IN ('prod', 'dev'));
ALTER TABLE "gateway_calls"        ADD CONSTRAINT "gateway_calls_env_check"        CHECK ("env" IN ('prod', 'dev'));
ALTER TABLE "app_secrets"          ADD CONSTRAINT "app_secrets_env_check"          CHECK ("env" IN ('prod', 'dev'));
