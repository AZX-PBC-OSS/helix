import { defineConfig } from "prisma/config";

/**
 * Prisma 7 config. The datasource URL lives here (consumed by Prisma Migrate);
 * the runtime client connects via the pg driver adapter in src/db/client.ts.
 * DATABASE_URL is provided by the dev container at migrate time.
 *
 * Read via `process.env` rather than the `env()` helper from prisma/config:
 * env() throws (PrismaConfigEnvError) the instant the config loads if the var
 * is absent — for EVERY command, including the offline `prisma generate` that
 * runs in the Docker image build where no DATABASE_URL exists. process.env is
 * lazy: generate ignores the url, and migrate/db push still read the real value
 * at deploy time. See prisma/prisma#28869.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
  },
});
