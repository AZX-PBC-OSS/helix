// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

// Flat config per the typescript-eslint quick-start.
// https://typescript-eslint.io/getting-started/
export default defineConfig([
  globalIgnores([
    "**/dist/**",
    "**/node_modules/**",
    "**/coverage/**",
    "**/*.tsbuildinfo",
    "apps/portal/src/db/generated/**",
    // Example apps are standalone projects, not part of the platform source
    // tree — they have their own build and aren't subject to platform lint.
    "examples/**",
  ]),
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    // Plain JS/mjs (build + dev scripts) run on Node. typescript-eslint turns
    // off `no-undef` for .ts files, but .mjs needs the node globals declared.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: { globals: globals.node },
  },
  {
    // The SPA is browser code: hooks rules on, browser globals instead of node.
    files: ["apps/portal-web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: globals.browser },
  },
  {
    // ADR-0002 partition-RLS backstop (TODO.md). The RLS-guarded tables the edge
    // touches — app_data / gateway_calls / app_collection_items / sessions — are
    // partitioned by the `app.app_id` (+ `app.user_oid`) GUC, and the ONLY place
    // that GUC is set is `withPartition` (apps/edge/src/db/partition.ts). A query
    // against one of those tables outside a `withPartition` client runs with no
    // GUC and fails closed (zero rows / WITH CHECK fails) — a silent correctness
    // bug. This is the cheap, coarse enforcement (Option A): the SQL for these
    // tables is allowed ONLY in the store modules that wrap it in withPartition
    // (see `ignores`); anywhere else in the edge it fails the build. It trusts
    // those files internally rather than proving each query sits inside a
    // withPartition call — a stronger structural fix (encapsulate the pool) is
    // deferred until this area grows.
    files: ["apps/edge/src/**/*.ts"],
    ignores: [
      "apps/edge/src/**/*.test.ts",
      "apps/edge/src/gateway/data.ts",
      "apps/edge/src/gateway/usage.ts",
      "apps/edge/src/auth/sessions.ts",
      "apps/edge/src/test/**",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'Literal[value=/\\b(from|into|update|join)\\s+"?(app_data|gateway_calls|app_collection_items|sessions)\\b/i]',
          message:
            "Raw SQL against an RLS-partitioned table (app_data / gateway_calls / app_collection_items / sessions) must run inside a `withPartition` client (apps/edge/src/db/partition.ts), which sets the app.app_id GUC the RLS policy needs — otherwise it fails closed. Move the query into the store module for that table (ADR-0002).",
        },
        {
          selector:
            'TemplateElement[value.raw=/\\b(from|into|update|join)\\s+"?(app_data|gateway_calls|app_collection_items|sessions)\\b/i]',
          message:
            "Raw SQL against an RLS-partitioned table (app_data / gateway_calls / app_collection_items / sessions) must run inside a `withPartition` client (apps/edge/src/db/partition.ts), which sets the app.app_id GUC the RLS policy needs — otherwise it fails closed. Move the query into the store module for that table (ADR-0002).",
        },
      ],
    },
  },
]);
