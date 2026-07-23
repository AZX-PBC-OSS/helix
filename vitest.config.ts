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
          // The open-surface flags now default off (opt-in) — suites exercising the
          // public/password paths assume them on, so enable both here; the disallow
          // suites still flip the relevant flag to "false" explicitly.
          env: {
            PORTAL_OIDC_ALLOW_INSECURE: "true",
            PORTAL_ALLOW_PUBLIC_APPS: "true",
            PORTAL_ALLOW_PASSWORD_APPS: "true",
          },
          // Ensure the test database exists + is migrated before any suite runs.
          globalSetup: ["./vitest.globalSetup.ts"],
        },
      },
      "./apps/portal-web/vite.config.ts",
    ],
  },
});
