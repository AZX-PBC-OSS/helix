import { defineConfig } from "vitest/config";

// One node-environment project covering every workspace package. When the React
// SPA lands (portal-web, v1) it will need its own jsdom project — split then via
// the `projects` field. https://vitest.dev/guide/projects
export default defineConfig({
  test: {
    include: ["{apps,packages}/*/src/**/*.test.ts"],
    environment: "node",
    // Ensure the test database exists + is migrated before any suite runs.
    globalSetup: ["./vitest.globalSetup.ts"],
  },
});
