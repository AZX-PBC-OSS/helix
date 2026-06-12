import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 config. The datasource URL lives here (consumed by Prisma Migrate);
 * the runtime client connects via the pg driver adapter in src/db/client.ts.
 * DATABASE_URL is provided by the dev container.
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
