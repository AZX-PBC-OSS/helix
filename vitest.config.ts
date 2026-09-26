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
            // The internal-JWT keys (I-02 ADR-0003). The portal's boot check
            // requires the edge↔portal key and egress's config the
            // portal↔egress one; the same dev-only well-known values the
            // devcontainer and CI set.
            HELIX_INTERNAL_SECRET: "aGVsaXgtZGV2LWludGVybmFsLXNlY3JldC0zMmItbWluIQ==",
            HELIX_EXCHANGE_SECRET: "aGVsaXgtZGV2LWV4Y2hhbmdlLXNlY3JldC0zMmItbWluIQ==",
            // Separation of duty stays ON for the suite whatever the ambient env
            // says — the devcontainer sets this true so a solo operator can drive
            // the whole approval loop locally, and inheriting that silently waived
            // the guard the approvals tests are asserting. The one test that wants
            // the flag opts in with `vi.stubEnv`.
            PORTAL_ALLOW_SELF_APPROVE: "false",
          },
          // Ensure the test database exists + is migrated before any suite runs.
          globalSetup: ["./vitest.globalSetup.ts"],
        },
      },
      "./apps/portal-web/vite.config.ts",
    ],
  },
});
