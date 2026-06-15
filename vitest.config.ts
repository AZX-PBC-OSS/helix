import { defineConfig } from "vitest/config";

// Two projects: the node suite covering every backend package, and the
// portal-web jsdom suite (defined in the package's own vite config, which
// carries the React plugin + setup files). https://vitest.dev/guide/projects
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["{apps,packages}/*/src/**/*.test.ts"],
          exclude: ["**/node_modules/**", "apps/portal-web/**"],
          environment: "node",
          // The portal's env-built verifier chain requires an https issuer unless
          // this dev flag is set; tests inherit the container's http dev-IdP issuer.
          env: { PORTAL_OIDC_ALLOW_INSECURE: "true" },
          // Ensure the test database exists + is migrated before any suite runs.
          globalSetup: ["./vitest.globalSetup.ts"],
        },
      },
      "./apps/portal-web/vite.config.ts",
    ],
  },
});
