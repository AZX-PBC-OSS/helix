// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

// Flat config per the typescript-eslint quick-start.
// https://typescript-eslint.io/getting-started/

// `no-restricted-syntax` selectors, hoisted to consts because they are shared by
// two config blocks below. Flat config replaces a rule's options WHOLESALE for
// overlapping `files`, so a later block that re-declares this rule must re-state
// every selector that still applies — otherwise it silently deletes the others.
const RLS_MESSAGE =
  "Raw SQL against an RLS-partitioned table (app_data / gateway_calls / app_collection_items / sessions) must run inside a `withPartition` client (apps/edge/src/db/partition.ts), which sets the app.app_id GUC the RLS policy needs — otherwise it fails closed. Move the query into the store module for that table (ADR-0002).";
const RLS_TABLES = "(app_data|gateway_calls|app_collection_items|sessions)";
const RLS_LITERAL = {
  selector: `Literal[value=/\\b(from|into|update|join)\\s+"?${RLS_TABLES}\\b/i]`,
  message: RLS_MESSAGE,
};
const RLS_TEMPLATE = {
  selector: `TemplateElement[value.raw=/\\b(from|into|update|join)\\s+"?${RLS_TABLES}\\b/i]`,
  message: RLS_MESSAGE,
};

const POOL_CONNECT_MESSAGE =
  "Bare `pool.connect()`: pg-pool REMOVES the client's 'error' listener for the duration of a checkout (_acquireClient), and pg emits 'error' SYNCHRONOUSLY on a socket death while deferring the query rejection to nextTick — so a mid-transaction connection drop is an unhandled 'error' event that kills the edge before your `await client.query()` ever rejects. Use `withPooledClient` (or `withPartition`, which composes it) from apps/edge/src/db/pool.ts: it covers the window and destroys the dead client instead of returning it to the pool.";
// Two selectors for the two shapes a pool reference takes: a bare identifier
// (`pool.connect()`) and a member/private field (`this.#pool.connect()`).
// Deliberately matched on the NAME, not the type — same coarseness the RLS rule
// above documents, so a pool variable not named `*pool` slips through.
const POOL_CONNECT_IDENT = {
  selector: 'CallExpression[callee.property.name="connect"][callee.object.name=/[Pp]ool$/]',
  message: POOL_CONNECT_MESSAGE,
};
const POOL_CONNECT_FIELD = {
  selector:
    'CallExpression[callee.property.name="connect"][callee.object.property.name=/[Pp]ool$/]',
  message: POOL_CONNECT_MESSAGE,
};

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
    //
    // The same block also bans bare `pool.connect()` (ADR-0025 review finding 1),
    // for a structurally identical reason: the checkout window is a hole the
    // pool-level `'error'` listener cannot cover, so `withPooledClient`
    // (apps/edge/src/db/pool.ts) is the only sanctioned way to check a client out.
    files: ["apps/edge/src/**/*.ts"],
    ignores: [
      "apps/edge/src/**/*.test.ts",
      "apps/edge/src/gateway/data.ts",
      "apps/edge/src/gateway/usage.ts",
      "apps/edge/src/auth/sessions.ts",
      "apps/edge/src/test/**",
      // The one sanctioned `pool.connect()` lives here, inside the helper that
      // makes it safe. (Tests are exempt too, as with the RLS rule: they check
      // out raw clients to `SET ROLE` and prove the RLS boundary, and a crash
      // there is a test failure, not an outage.)
      "apps/edge/src/db/pool.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        RLS_LITERAL,
        RLS_TEMPLATE,
        POOL_CONNECT_IDENT,
        POOL_CONNECT_FIELD,
      ],
    },
  },
  {
    // The three store modules are exempt from the RLS-SQL ban (they are the
    // files that wrap those queries in `withPartition`) but NOT from the
    // checkout ban — they are its primary audience. Flat config replaces a
    // rule's options wholesale for overlapping files, so re-state what applies.
    files: [
      "apps/edge/src/gateway/data.ts",
      "apps/edge/src/gateway/usage.ts",
      "apps/edge/src/auth/sessions.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", POOL_CONNECT_IDENT, POOL_CONNECT_FIELD],
    },
  },
]);
