// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

// Flat config per the typescript-eslint quick-start.
// https://typescript-eslint.io/getting-started/
export default defineConfig([
  globalIgnores(["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/*.tsbuildinfo"]),
  {
    files: ["**/*.{js,mjs,ts}"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
  },
]);
