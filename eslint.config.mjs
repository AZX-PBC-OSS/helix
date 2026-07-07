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
    "**/.pnpm-store/**",
    "**/coverage/**",
    "**/*.tsbuildinfo",
    "apps/portal/src/db/generated/**",
    // Example apps are standalone projects, not part of the platform source
    // tree — they have their own build and aren't subject to platform lint.
    "examples/**",
    // The "Lovable at home" prototype overlay + its gitignored bolt.diy clone —
    // a standalone external project, not platform source (see builder/README.md).
    "builder/**",
  ]),
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
  {
    // The SPA is browser code: hooks rules on, browser globals instead of node.
    files: ["apps/portal-web/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: { globals: globals.browser },
  },
]);
